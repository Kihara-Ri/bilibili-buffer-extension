import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import {
  SOURCE_LIMIT, SOURCE_READ_LIMIT, SOURCE_ROWS,
  createSourceRepository, createSourceService, sourceFacts
} from '../src/source-range-store.js';

const DEADLINE = () => Math.floor(Date.now() / 1000) + 3600;
const media = (host = 'a.bilivideo.com', path = '/upgcxcode/1/2/3-1-30280.m4s', deadline = DEADLINE()) =>
  `https://${host}${path}?deadline=${deadline}&platform=pc`;
const bytes = (start, end) => Uint8Array.from({ length: end - start }, (_, index) => (start + index) & 0xff);
const encode = (value) => Buffer.from(value).toString('base64');

function load({ account = async () => 'account-a', database = new Map() } = {}) {
  const repository = createSourceRepository(createFakeIndexedDB(database));
  return { repository, service: createSourceService({ repository, account }), database };
}

async function write(service, { url, start, end, total, contentType = 'video/mp4' }) {
  return service.handle({ op: 'write', url, start, end, total, contentType, body: encode(bytes(start, end)) }, 'writer');
}

async function read(service, { url, start, end, total }) {
  const result = await service.handle({ op: 'read', url, start, end, total }, 'reader');
  return result.hit ? { ...result, body: new Uint8Array(Buffer.from(result.body, 'base64')) } : result;
}

function assertBytes(actual, start, end) {
  assert.equal(actual.length, end - start);
  for (let index = 0; index < actual.length; index += 1) assert.equal(actual[index], (start + index) & 0xff, `第 ${start + index} 字节不一致`);
}

test('写入校验过的范围后，同一媒体文件可按连续覆盖读回，含跨主机', async () => {
  const { service } = load();
  const total = 4096;
  await write(service, { url: media('a.bilivideo.com'), start: 0, end: 100, total });
  await write(service, { url: media('b.bilivideo.com'), start: 100, end: 300, total });

  const hit = await read(service, { url: media('c.bilivideo.com'), start: 0, end: 300, total });
  assert.equal(hit.hit, true);
  assert.equal(hit.total, total);
  assert.equal(hit.end, 300);
  assert.equal(hit.contentType, 'video/mp4');
  assertBytes(hit.body, 0, 300);
});

test('中间有洞或总长不同一律未命中，不返回不完整范围', async () => {
  const { service } = load();
  const total = 4096;
  await write(service, { url: media(), start: 0, end: 100, total });
  await write(service, { url: media(), start: 200, end: 300, total });
  assert.deepEqual(await read(service, { url: media(), start: 0, end: 300, total }), {});
  assert.deepEqual(await read(service, { url: media(), start: 0, end: 100, total: total + 1 }), {});
  assert.deepEqual(await read(service, { url: media('a.bilivideo.com', '/other.m4s'), start: 0, end: 100, total }), {});
});

test('签名过期、非媒体主机或越界请求都不写入不读取', async () => {
  const { service, database } = load();
  const past = Math.floor(Date.now() / 1000) - 10;
  assert.deepEqual(await write(service, { url: media('a.bilivideo.com', '/x.m4s', past), start: 0, end: 10, total: 4096 }), {});
  assert.deepEqual(await write(service, { url: 'https://evil.example/x.m4s?deadline=99999999999', start: 0, end: 10, total: 4096 }), {});
  assert.deepEqual(await write(service, { url: media(), start: 10, end: 10, total: 4096 }), {});
  assert.deepEqual(await write(service, { url: media(), start: 0, end: 4 * 1024 * 1024 + 1, total: 8 * 1024 * 1024 }), {});
  assert.equal(database.get('bili-buffer-source-ranges-v1')?.stores.get('ranges')?.size || 0, 0);
  assert.equal(sourceFacts({ url: media('a.bilivideo.com', '/x.m4s', past), start: 0, end: 1, total: 2 }), null);
});

test('正文与服务端身份不一致时拒绝写入', async () => {
  const { service, database } = load();
  const total = 4096;
  const bad = await service.handle({ op: 'write', url: media(), start: 0, end: 50, total, body: encode(bytes(0, 49)) }, 'writer');
  assert.deepEqual(bad, {});
  assert.deepEqual(await service.handle({ op: 'write', url: media(), start: 0, end: 50, total, body: 'not-base64!!' }, 'writer'), {});
  assert.equal(database.get('bili-buffer-source-ranges-v1')?.stores.get('ranges')?.size || 0, 0);
});

test('页面不能写入，只能读；账户隔离使旧账户的镜像失效', async () => {
  const total = 4096;
  const first = load();
  await write(first.service, { url: media(), start: 0, end: 100, total });
  // 页面（reader 身份）调用 write 必须被拒绝。
  assert.deepEqual(await first.service.handle({ op: 'write', url: media(), start: 100, end: 200, total, body: encode(bytes(100, 200)) }, 'reader'), {});
  assert.equal((await read(first.service, { url: media(), start: 0, end: 100, total })).hit, true);

  const other = load({ account: async () => 'account-b', database: first.database });
  assert.deepEqual(await read(other.service, { url: media(), start: 0, end: 100, total }), {});
  // 切回原账户仍可读，说明隔离而不是删除。
  assert.equal((await read(first.service, { url: media(), start: 0, end: 100, total })).hit, true);
});

test('读取上限与有界回收：超过消息上限直接未命中，行数按最旧优先淘汰', async () => {
  const { service, database } = load();
  assert(SOURCE_READ_LIMIT <= SOURCE_LIMIT);
  const total = 8 * 1024 * 1024;
  await write(service, { url: media(), start: 0, end: 1024, total });
  assert.deepEqual(await read(service, { url: media(), start: 0, end: SOURCE_READ_LIMIT + 1, total }), {});

  for (let index = 0; index < SOURCE_ROWS + 8; index += 1) {
    await write(service, { url: media('a.bilivideo.com', `/seg-${index}.m4s`), start: 0, end: 16, total });
  }
  const rows = database.get('bili-buffer-source-ranges-v1').stores.get('ranges');
  assert.equal(rows.size, SOURCE_ROWS);
  assert.equal([...rows.values()].some((row) => row.source.startsWith('/seg-0.m4s')), false);
});

// 合成字节隔离：镜像只从 onVerifiedRange 进入，而该回调只挂在源范围下载路径上。
test('镜像入口只连到源范围下载，不接触合并与抽音轨写入', async () => {
  const [downloader, offscreen] = await Promise.all([
    import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/range-downloader.js', import.meta.url), 'utf8')),
    import('node:fs/promises').then(({ readFile }) => readFile(new URL('../src/offscreen.js', import.meta.url), 'utf8'))
  ]);
  assert.match(downloader, /options\.onVerifiedRange\?\.\(/);
  const callSites = offscreen.split('downloadByteRanges({').length - 1;
  const hooks = offscreen.split('onVerifiedRange: mirror.onVerifiedRange').length - 1;
  assert.equal(hooks, callSites, '每个源范围下载都必须镜像，且不得新增未接线的下载入口');
  assert.equal(/onVerifiedRange[\s\S]{0,400}(MERGED_TRACK|"merged")/.test(offscreen), false);
});
