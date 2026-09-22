import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { createSourceRepository, createSourceService } from '../src/source-range-store.js';
import { ASSIST_DEFAULTS, sanitizeAssistConfig } from '../src/assist-config.js';
import { SOURCE_MIRROR_RANGE, createSourceMirror } from '../src/source-mirror.js';

const reuseSource = await readFile(new URL('../src/playback-reuse.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../src/playback-bridge.js', import.meta.url), 'utf8');
const cacheSource = await readFile(new URL('../src/playback-cache.js', import.meta.url), 'utf8');
const observerSource = await readFile(new URL('../src/playback-observer.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

const deadline = () => Math.floor(Date.now() / 1000) + 3600;
const mediaUrl = `https://a.bilivideo.com/upgcxcode/1/2/3-1-30280.m4s?deadline=${deadline()}`;
const body64 = Buffer.from(new Uint8Array(64)).toString('base64');

// ---------------------------------------------------------------------------
// 不支持能力：直接原生，不抛错、不阻塞
// ---------------------------------------------------------------------------

test('缺少 IndexedDB 时镜像服务整体停用，读写都返回未命中且不抛错', async () => {
  const repository = createSourceRepository(undefined);
  assert.equal(repository.disabled, true);
  const service = createSourceService({ repository, account: async () => 'a' });
  assert.deepEqual(await service.handle({ op: 'write', url: mediaUrl, start: 0, end: 64, total: 4096, body: body64 }, 'writer'), {});
  assert.deepEqual(await service.handle({ op: 'read', url: mediaUrl, start: 0, end: 64, total: 4096 }, 'reader'), {});
  await service.clear();

  // 存储可用但 open 抛错（例如隐私模式/配额异常）时同样只降级，不向上抛。
  const broken = createSourceService({ repository: { list: async () => { throw new Error('boom'); }, put: async () => { throw new Error('boom'); }, clear: async () => { throw new Error('boom'); } }, account: async () => 'a' });
  assert.deepEqual(await broken.handle({ op: 'write', url: mediaUrl, start: 0, end: 64, total: 4096, body: body64 }, 'writer'), {});
  assert.deepEqual(await broken.handle({ op: 'read', url: mediaUrl, start: 0, end: 64, total: 4096 }, 'reader'), {});
});

// 页面模块通过 globalThis 挂载；window 必须是嵌套对象（真实页面里 globalThis 才是 window），
// 这样 event.source === window 的身份判断才与浏览器一致。
// contextGlobals 用于模拟缺失某个浏览器 API 的环境。
function loadPage({ windowGlobals = {}, contextGlobals = {} } = {}) {
  const listeners = [];
  const window = {
    location: {}, postMessage: () => {},
    addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); },
    ...windowGlobals
  };
  const context = vm.createContext({
    window, atob, btoa, URL, crypto, Uint8Array, Promise, Date, Error, setTimeout, clearTimeout, Number, Object, Array, String, Math, JSON, queueMicrotask,
    ...contextGlobals
  });
  vm.runInContext(reuseSource, context);
  vm.runInContext('window.BiliPlaybackReuse = globalThis.BiliPlaybackReuse', context);
  const deliver = (data) => listeners.forEach((listener) => listener({ source: window, data }));
  return { api: window.BiliPlaybackReuse, window, deliver, listeners };
}

/** 只要能返回 Promise 即可，跨 realm 不能用 instanceof 判断。 */
const resolvesNull = async (value) => typeof value?.then === 'function' && (await value) === null;

test('页面缺少 base64 或消息通道时，复用读取器直接返回未命中', async () => {
  const withoutBase64 = loadPage({ contextGlobals: { atob: undefined, btoa: undefined } });
  withoutBase64.api.notePlayurl({ dash: { video: [{ baseUrl: mediaUrl }] } });
  assert.equal(await resolvesNull(withoutBase64.api.createReuseClient().read({ url: mediaUrl, start: 0, end: 64, total: 4096 })), true);

  const withoutChannel = loadPage({ windowGlobals: { postMessage: undefined } });
  assert.equal(await resolvesNull(withoutChannel.api.createReuseClient().read({ url: mediaUrl, start: 0, end: 64, total: 4096 })), true);
  assert.equal(withoutBase64.listeners.length, 0, '降级时不应注册消息监听');
});

test('缺少 randomUUID 时仍能完成读取（ID 回退）', async () => {
  const page = loadPage({ contextGlobals: { crypto: {} } });
  // 用固定回包代替桥：证明缺 randomUUID 时不会抛错，且严格校验仍然生效。
  page.window.postMessage = (data) => page.deliver({
    channel: 'bili-buffer-playback-assist-v1', dir: 'ext->page', type: 'reuseReply',
    payload: { rpcId: data.payload.rpcId, result: { hit: true, start: 0, end: 64, total: 4096, contentType: 'video/mp4', body: btoa(String.fromCharCode(...new Uint8Array(64))) } }
  });
  page.api.notePlayurl({ dash: { video: [{ baseUrl: mediaUrl }] } });
  const hit = await page.api.createReuseClient().read({ url: mediaUrl, start: 0, end: 64, total: 4096 });
  assert.ok(hit);
  assert.equal(hit.body.length, 64);
});

// ---------------------------------------------------------------------------
// 重复安装与重复写入
// ---------------------------------------------------------------------------

test('重复 install 不会替换已生效的 loadRange，重复写入同一范围是幂等的', async () => {
  const window = { fetch: async () => { throw new Error('测试不应发出真实请求'); } };
  vm.runInNewContext(cacheSource, { window, URL, Headers, Response, Request, ReadableStream, Uint8Array, DataView, ArrayBuffer, Blob, DOMException, setTimeout, clearTimeout, performance, AbortController, Event, EventTarget, ProgressEvent: class extends Event {} });
  const cache = window.__biliBufferCache;
  const calls = [];
  const enabled = () => true;
  cache.install({ loadRange: async () => { calls.push('first'); return null; }, enabled });
  cache.install({ loadRange: async () => { calls.push('second'); return null; }, enabled });
  // 只有第一次安装的回调会生效。
  assert.equal(cache.install({ loadRange: () => { calls.push('third'); return null; } }), undefined);
  assert.deepEqual(calls, []);

  const repository = createSourceRepository(createFakeIndexedDB(new Map()));
  const service = createSourceService({ repository, account: async () => 'a' });
  const row = { op: 'write', url: mediaUrl, start: 0, end: 64, total: 4096, body: body64, contentType: 'video/mp4' };
  assert.deepEqual(await service.handle(row, 'writer'), { stored: true });
  assert.deepEqual(await service.handle(row, 'writer'), { stored: true });
  const rows = await repository.list(`${new URL(mediaUrl).pathname}\n4096`);
  assert.equal(rows.length, 1);
});

// ---------------------------------------------------------------------------
// 镜像写入器：配额、熔断、串行与失败静默
// ---------------------------------------------------------------------------

const chunk = (size) => new Blob([new Uint8Array(size)]);
const entry = (start, size) => ({ url: mediaUrl, start, end: start + size, total: 4096, data: chunk(size), contentType: 'video/mp4' });

test('镜像写入器按任务配额跳过超额范围，且不阻塞调用方', async () => {
  const requests = [];
  const mirror = createSourceMirror({ send: async (request) => { requests.push(request); return { ok: true }; }, budget: 2 * SOURCE_MIRROR_RANGE });
  assert.equal(mirror.onVerifiedRange(entry(0, SOURCE_MIRROR_RANGE)), undefined);
  mirror.onVerifiedRange(entry(SOURCE_MIRROR_RANGE, SOURCE_MIRROR_RANGE));
  // 第三次超出配额：直接跳过，不再排队写入。
  mirror.onVerifiedRange(entry(2 * SOURCE_MIRROR_RANGE, 1024));
  await mirror.drain();
  assert.equal(requests.length, 2);
  assert.equal(mirror.sent, 2);
  assert.equal(mirror.skipped, 1);
  assert.deepEqual(requests.map((request) => request.start).sort((a, b) => a - b), [0, SOURCE_MIRROR_RANGE]);
});

test('镜像写入器串行发送，连续失败后熔断但绝不抛错', async () => {
  const order = [];
  let release = null;
  const mirror = createSourceMirror({
    send: async (request) => {
      order.push(request.start);
      if (request.start === 0) await new Promise((resolve) => { release = resolve; });
      return { ok: false };
    }
  });
  mirror.onVerifiedRange(entry(0, 64));
  mirror.onVerifiedRange(entry(64, 64));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, [0], '必须等前一次写入结束后再发下一次');
  release();
  await mirror.drain();
  assert.deepEqual(order, [0, 64]);
  // 两次失败后仍未熔断，第三次失败触发。
  mirror.onVerifiedRange(entry(128, 64));
  await mirror.drain();
  assert.equal(mirror.disabled, true);
  mirror.onVerifiedRange(entry(192, 64));
  await mirror.drain();
  assert.equal(order.length, 3);
});

test('镜像写入器拒绝超限范围与异常正文，下载流程不受影响', async () => {
  const requests = [];
  const mirror = createSourceMirror({ send: async (request) => { requests.push(request); return { ok: true }; } });
  mirror.onVerifiedRange({ url: mediaUrl, start: 0, end: SOURCE_MIRROR_RANGE + 1, total: 4096, data: chunk(16) });
  mirror.onVerifiedRange({ url: mediaUrl, start: 0, end: 0, total: 4096, data: chunk(16) });
  mirror.onVerifiedRange({ url: mediaUrl, start: 0, end: 16, total: 4096, data: null });
  await mirror.drain();
  assert.equal(requests.length, 0);
  assert.equal(mirror.skipped, 3);

  // 发送抛异常时同样只记账，不向上传播。
  const throwing = createSourceMirror({ send: async () => { throw new Error('后台不可用'); } });
  assert.equal(throwing.onVerifiedRange(entry(0, 64)), undefined);
  await throwing.drain();
  assert.equal(throwing.sent, 0);
});

// ---------------------------------------------------------------------------
// 桥接失败与迟到回包
// ---------------------------------------------------------------------------

function loadBridge({ sendMessage, pageWindow }) {
  const replies = [];
  const bridgeWindow = {
    addEventListener(type, listener) { if (type === 'message') bridgeWindow.__page = listener; },
    postMessage: (data) => replies.push(data)
  };
  bridgeWindow.window = bridgeWindow;
  const context = vm.createContext({
    window: bridgeWindow, document: { documentElement: { dataset: {} } }, URL, Promise, Date, Error, setTimeout, clearTimeout, console, JSON, Number, Object, Array, String,
    chrome: {
      runtime: { id: 'extension-id', sendMessage, onMessage: { addListener() {} }, getURL: (path) => `chrome-extension://extension-id/${path}` },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } }
    }
  });
  vm.runInContext(bridgeSource, context);
  return {
    replies,
    request: (payload) => bridgeWindow.__page({ source: pageWindow || bridgeWindow, data: { channel: 'bili-buffer-playback-assist-v1', dir: 'page->ext', type: 'reuseRead', payload } })
  };
}

const rpc = { rpcId: 'rpc-1', url: mediaUrl, start: 0, end: 64, total: 4096 };
// VM 里构造的对象与宿主对象原型不同，深比较前统一转成宿主值。
const plain = (value) => JSON.parse(JSON.stringify(value));

test('后台不可用时桥回未命中；迟到回包被丢弃', async () => {
  const failing = loadBridge({ sendMessage: async () => { throw new Error('service worker 不可用'); } });
  failing.request(rpc);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reuseReplies = (bridge) => bridge.replies.filter((message) => message.type === 'reuseReply');
  assert.equal(reuseReplies(failing).length, 1);
  assert.deepEqual(plain(reuseReplies(failing)[0].payload.result), {});

  const slow = loadBridge({ sendMessage: async () => { await new Promise((resolve) => setTimeout(resolve, 1500)); return { hit: true, start: 0, end: 64, total: 4096, body: body64 }; } });
  slow.request({ ...rpc, rpcId: 'rpc-2' });
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(reuseReplies(slow).length, 1);
  assert.deepEqual(plain(reuseReplies(slow)[0].payload.result), {}, '超时后的回包不能把过期字节交给页面');
});

test('桥只转发形状合法的请求，其余静默丢弃且不下发后台参数', async () => {
  const seen = [];
  const bridge = loadBridge({ sendMessage: async (message) => { seen.push(message); return { hit: true }; } });
  const replies = () => bridge.replies.filter((message) => message.type === 'reuseReply');
  bridge.request({ rpcId: 'bad id!', url: mediaUrl, start: 0, end: 64, total: 4096 });
  bridge.request({ rpcId: 'ok-1', url: 42, start: 0, end: 64, total: 4096 });
  bridge.request({ rpcId: 'ok-2', url: mediaUrl, start: 0, end: '64', total: 4096 });
  bridge.request({ rpcId: 'ok-3', url: mediaUrl, start: 0, end: 64, total: 4096, extra: 'ignored' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  // 非法请求既不回车也不打扰后台；只有完全合法的请求才转发，且只带白名单字段。
  assert.equal(seen.length, 1);
  assert.deepEqual(plain(seen[0].request), { op: 'read', url: mediaUrl, start: 0, end: 64, total: 4096 });
  assert.equal(replies().length, 1);
  assert.equal(replies()[0].payload.result.hit, true);
});

test('缺少 MutationObserver 等能力时观察器仍能加载并保持原生播放路径', () => {
  const intervals = [];
  const eventListeners = new Map();
  const video = { duration: 100, currentTime: 0, paused: false, buffered: { length: 0 }, addEventListener() {} };
  class FakeStorage { getItem() { return null; } setItem() {} removeItem() {} }
  class FakeXhr { addEventListener() {} getResponseHeader() { return null; } }
  FakeXhr.prototype.open = function () {}; FakeXhr.prototype.send = function () {}; FakeXhr.prototype.setRequestHeader = function () {};
  const document = {
    nodeType: 9, documentElement: { dataset: {} }, hidden: false,
    addEventListener(type, listener) { eventListeners.set(`document:${type}`, listener); },
    querySelectorAll: (selector) => (selector === 'video' ? [video] : [])
  };
  const window = {
    Storage: FakeStorage, XMLHttpRequest: FakeXhr, fetch: async () => { throw new Error('测试不应发出真实请求'); },
    addEventListener(type, listener) { eventListeners.set(type, listener); }, postMessage() {}
  };
  window.window = window;
  // 故意不提供 BiliPlaybackReuse / BiliPlaybackNetwork 与 MutationObserver：
  // 观察器必须只降级，而不是在注入时抛错导致整页脚本失效。
  window.BiliPlaybackNetwork = { createNetwork: () => ({ register() {}, download: async () => { throw new Error('不应走网络'); }, tune() {}, snapshot: () => ({}), total: () => 0, role: () => null, fallback() {}, setMode() {}, setMax() {}, reset() {} }) };
  const context = vm.createContext({
    window, document, localStorage: new FakeStorage(), location: { href: 'https://www.bilibili.com/video/BV1test/' }, URL, Headers, Response, Request,
    ReadableStream, Uint8Array, DataView, ArrayBuffer, Blob, DOMException, AbortController, performance, queueMicrotask, setTimeout, clearTimeout,
    setInterval: (callback, milliseconds) => { intervals.push({ callback, milliseconds }); return intervals.length; }, clearInterval() {}
  });
  vm.runInContext(observerSource, context, { filename: 'playback-observer.js' });
  assert.ok(window.__biliBufferPlaybackAssistInternals, '观察器必须完成加载');
  assert.ok(intervals.some((item) => item.milliseconds === 1000), '缺少 MutationObserver 时仍靠定时扫描兜底');
});

// ---------------------------------------------------------------------------
// 默认配置与权限不变
// ---------------------------------------------------------------------------

test('默认配置与权限保持既有值，新增模块不引入新权限', () => {
  assert.equal(ASSIST_DEFAULTS.mode, 'always');
  assert.equal(ASSIST_DEFAULTS.maxConcurrency, 32);
  assert.equal(ASSIST_DEFAULTS.cdnMode, 'original');
  assert.equal(ASSIST_DEFAULTS.networkPolicyVersion, 3);
  assert.deepEqual(sanitizeAssistConfig({}).maxConcurrency, 32);
  assert.deepEqual(manifest.permissions, [
    'activeTab', 'alarms', 'cookies', 'declarativeNetRequestWithHostAccess', 'downloads', 'offscreen', 'storage', 'unlimitedStorage'
  ]);
  assert.deepEqual(manifest.host_permissions, [
    'http://127.0.0.1/*', 'https://*.bilibili.com/*', 'https://*.bilivideo.com/*', 'https://*.bilivideo.cn/*', 'https://*.hdslb.com/*', 'https://*.akamaized.net/*'
  ]);
  assert.equal(manifest.content_scripts.some((entry) => entry.js.some((file) => file.includes('dev-reload'))), false);
  // 复用模块必须与缓存适配器、请求预算一起在 document_start 注入，且早于观察器。
  const main = manifest.content_scripts.find((entry) => entry.world === 'MAIN');
  assert.ok(main.js.indexOf('src/playback-cache.js') < main.js.indexOf('src/playback-reuse.js'));
  assert.ok(main.js.indexOf('src/playback-reuse.js') < main.js.indexOf('src/playback-observer.js'));
});

test('取消与关闭模式不发起复用读取', async () => {
  const reader = await readFile(new URL('../src/playback-observer.js', import.meta.url), 'utf8');
  // 结构化断言：复用分支必须位于 mode 校验与 in-flight 去重之后，且命中前不触发网络。
  const gate = reader.indexOf('cfg.mode !== "always"');
  const branch = reader.indexOf('reuseClient.read(');
  const network = reader.indexOf('const result = await network.download(');
  assert.ok(gate > 0 && branch > gate && network > branch);
  assert.match(reader, /if \(reuseClient\) \{/);
  assert.match(reader, /if \(!reused\)|if \(reused\) \{/);
});
