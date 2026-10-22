import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/playback-network.js';
const { createNetwork, mediaUrl, BACKGROUND_PIECE } = globalThis.BiliPlaybackNetwork;
const KiB = 1024, MiB = 1024 * KiB;
const primary = 'https://a.bilivideo.com/video.m4s?sign=secret';
const backup = 'https://b.bilivideo.com/video.m4s?sign=secret';
const manifest = { data: { dash: { video: [{ baseUrl: primary, backupUrl: [backup, 'https://evil.example/media.m4s'] }] } } };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const byteAt = i => (i * 7 + 3) & 0xff;
const bodyFor = (a, b) => Uint8Array.from({ length: b - a + 1 }, (_, i) => byteAt(a + i));
const rangeOf = init => { const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range); return [+a, +b]; };
const reply = (a, b, total) => new Response(bodyFor(a, b), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${total}`, 'content-type': 'video/mp4' } });
const hang = init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
const signal = () => new AbortController().signal;
function assertBytes(bytes, start) { for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], byteAt(start + i), `第 ${start + i} 字节`); }

/** 记录每个真实请求，并发计数只算正在等待响应/正文的请求。 */
function server(total, { wait = 5, onRequest } = {}) {
  const log = { requests: [], active: 0, peak: 0 };
  const fetch = async (url, init) => {
    const [a, b] = rangeOf(init);
    log.requests.push({ url, a, b, priority: init.priority });
    log.active++; log.peak = Math.max(log.peak, log.active);
    try {
      const custom = await onRequest?.(url, init, a, b);
      if (custom) return custom;
      await delay(wait);
      if (init.signal.aborted) throw init.signal.reason;
      return reply(a, Math.min(b, total - 1), total);
    } finally { log.active--; }
  };
  return { fetch, log };
}

test('只接受权限内的 HTTPS 媒体地址；清单里的非法备用地址被丢弃，统计不泄露签名', async () => {
  assert.equal(mediaUrl('https://evil.example/media.m4s'), null);
  assert.equal(mediaUrl('http://a.bilivideo.com/v.m4s'), null);
  assert.equal(mediaUrl(primary), primary);
  const { fetch, log } = server(4, { onRequest: url => url === primary ? new Response('x', { status: 403 }) : null });
  const network = createNetwork({ fetch });
  network.register(manifest);
  const result = await network.get(primary, 0, 4, { signal: signal() });
  assertBytes(result.bytes, 0);
  assert.deepEqual(log.requests.map(r => r.url), [primary, backup]);
  assert(!JSON.stringify(network.snapshot()).includes('secret'));
});

test('播放器急需范围拆成约 16 片并行下载，按位置重组，每片落地即回调写缓存', async () => {
  const total = 4 * MiB, pieces = [];
  const { fetch, log } = server(total);
  const network = createNetwork({ fetch, onPiece: (url, start, bytes, size) => pieces.push([start, bytes.length, size]) });
  const result = await network.get(primary, 0, 2 * MiB, { signal: signal(), total });
  assert.equal(result.bytes.length, 2 * MiB); assertBytes(result.bytes, 0);
  assert.equal(log.requests.length, 16);
  assert.equal(log.peak, 16);
  assert(log.requests.every(r => r.priority === 'high'));
  assert.equal(pieces.length, 16);
  assert(pieces.every(([, length, size]) => length === 128 * KiB && size === total));
});

test('后台分片受槽位约束；播放器请求不排在后台之后', async () => {
  const total = 64 * MiB;
  const { fetch, log } = server(total, { wait: 30 });
  const network = createNetwork({ fetch, backgroundSlots: 4 });
  assert.equal(network.prefetch(primary, 0, 8 * BACKGROUND_PIECE, { total }), 8);
  await delay(5);
  assert.equal(log.active, 4, '后台最多占 4 个槽位');
  const urgent = network.get(primary, 32 * MiB, 32 * MiB + 256 * KiB, { signal: signal(), total });
  await delay(5);
  assert(log.active > 4, '急需请求不受后台槽位约束');
  assertBytes((await urgent).bytes, 32 * MiB);
  await delay(200);
  assert.equal(log.requests.filter(r => r.priority === 'low').length, 8);
  assert.equal(network.backgroundPending(), 0);
});

test('播放器请求复用在途后台分片：不重复下载，后台分片升为急需', async () => {
  const total = 4 * MiB;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { fetch, log } = server(total, { onRequest: async () => { await gate; } });
  const network = createNetwork({ fetch });
  network.prefetch(primary, 0, BACKGROUND_PIECE, { total });
  await delay(5);
  const demand = network.get(primary, 1000, 3000, { signal: signal(), total });
  assert.deepEqual(network.inflightRanges(primary), [[0, BACKGROUND_PIECE]]);
  release();
  const result = await demand;
  assertBytes(result.bytes, 1000);
  assert.equal(log.requests.length, 1, '同一段只请求一次');
});

test('播放器放弃后：只为它新建的分片立即取消，后台分片继续填充前方窗口', async () => {
  const total = 4 * MiB;
  const aborted = [];
  const { fetch } = server(total, { onRequest: (url, init, a) => hang(init).catch(error => { aborted.push(a); throw error; }) });
  const network = createNetwork({ fetch });
  network.prefetch(primary, 0, BACKGROUND_PIECE, { total });
  const controller = new AbortController();
  const demand = network.get(primary, 0, BACKGROUND_PIECE + 64 * KiB, { signal: controller.signal, total });
  await delay(5);
  controller.abort();
  await assert.rejects(demand, { name: 'AbortError' });
  await delay(5);
  assert.deepEqual(aborted, [BACKGROUND_PIECE], '只取消急需的新分片');
  assert.deepEqual(network.inflightRanges(primary), [[0, BACKGROUND_PIECE]]);
  network.reset();
});

test('慢节点触发对冲：备用地址先完成即胜出，原请求在胜负揭晓前不被取消', async () => {
  let primaryAbortedAt = null, hedgeStartedAt = null;
  const { fetch } = server(4, { onRequest: (url, init) => {
    if (url === backup) { hedgeStartedAt = performance.now(); return null; }
    return hang(init).catch(error => { primaryAbortedAt = performance.now(); throw error; });
  } });
  const network = createNetwork({ fetch, hedgeMs: 30 });
  network.register(manifest);
  const result = await network.get(primary, 0, 4, { signal: signal() });
  assertBytes(result.bytes, 0);
  await delay(5);
  assert(hedgeStartedAt !== null && primaryAbortedAt >= hedgeStartedAt, '对冲开始后原请求仍在途');
  assert.equal(network.snapshot().rescues, 1);
  assert.equal(network.snapshot().host, 'b.bilivideo.com');
  assert.equal(network.snapshot().active, 0);
});

test('正文停滞同样触发对冲，不必等到超时', async () => {
  const { fetch } = server(4, { onRequest: url => url === backup ? null
    : new Response(new ReadableStream({ start() {} }), { status: 206, headers: { 'content-range': 'bytes 0-3/4' } }) });
  const network = createNetwork({ fetch, hedgeMs: 30 });
  network.register(manifest);
  assertBytes((await network.get(primary, 0, 4, { signal: signal() })).bytes, 0);
});

test('只有一个地址时对冲仍可在同一地址再发一份', async () => {
  let calls = 0;
  const { fetch } = server(4, { onRequest: (url, init) => (++calls === 1 ? hang(init) : null) });
  const network = createNetwork({ fetch, hedgeMs: 30 });
  assertBytes((await network.get(primary, 0, 4, { signal: signal() })).bytes, 0);
  assert.equal(calls, 2);
});

test('范围或总长校验失败的响应不交付；全部节点失败后整体拒绝并计入后台错误', async () => {
  const { fetch } = server(4, { onRequest: (url, init, a, b) => reply(a, b, 5) });
  const errors = [];
  const network = createNetwork({ fetch, onPieceError: (url, urgent) => errors.push(urgent) });
  await assert.rejects(network.get(primary, 0, 4, { signal: signal(), total: 4 }), /校验/);
  network.prefetch(primary, 0, 4, { total: 4 });
  await delay(2000);
  assert.deepEqual(errors, [true, false]);
  assert.equal(network.snapshot().prefetchErrors, 1);
});

test('拖动后只取消不再需要且无人等待的后台分片', async () => {
  const total = 64 * MiB;
  const { fetch } = server(total, { onRequest: (url, init) => hang(init) });
  const network = createNetwork({ fetch });
  network.prefetch(primary, 0, 4 * BACKGROUND_PIECE, { total });
  network.pruneBackground((url, start) => start < 2 * BACKGROUND_PIECE);
  await delay(5);
  assert.deepEqual(network.inflightRanges(primary), [[0, BACKGROUND_PIECE], [BACKGROUND_PIECE, 2 * BACKGROUND_PIECE]]);
  network.reset();
});

test('reset 取消全部在途与排队请求，旧世代结果不回调、不计统计', async () => {
  const total = 64 * MiB, pieces = [];
  const { fetch } = server(total, { onRequest: (url, init) => hang(init) });
  const network = createNetwork({ fetch, maxSlots: 2, onPiece: () => pieces.push(1) });
  const jobs = [network.get(primary, 0, MiB, { signal: signal(), total })];
  network.prefetch(primary, 2 * MiB, 4 * MiB, { total });
  await delay(5);
  network.reset();
  assert((await Promise.allSettled(jobs)).every(r => r.status === 'rejected'));
  await delay(5);
  assert.deepEqual(pieces, []);
  assert.equal(network.snapshot().receivedBytes, 0);
  assert.equal(network.snapshot().active, 0);
  assert.equal(network.backgroundPending(), 0);
});

test('超过 16 MiB 或非法范围直接拒绝，交还原生请求', async () => {
  const network = createNetwork({ fetch: async () => { throw new Error('不应请求'); } });
  await assert.rejects(network.get(primary, 0, 17 * MiB, { signal: signal() }), /不支持/);
  await assert.rejects(network.get('https://evil.example/a.m4s', 0, 4, { signal: signal() }), /不支持/);
  assert.equal(network.prefetch('https://evil.example/a.m4s', 0, 4), 0);
});

test('分片在槽位授予后、尝试开始前被取消：立即归还槽位，不发出请求', async () => {
  const { fetch, log } = server(64 * MiB, { onRequest: (url, init) => hang(init) });
  const network = createNetwork({ fetch });
  network.prefetch(primary, 0, 2 * BACKGROUND_PIECE, { total: 64 * MiB });
  network.pruneBackground(() => false);
  await delay(5);
  assert.equal(log.requests.length, 0);
  assert.equal(network.snapshot().active, 0);
  assert.equal(network.backgroundPending(), 0);
});
