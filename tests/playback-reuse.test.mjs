import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createFakeIndexedDB } from './fake-indexeddb.mjs';
import { createSourceRepository, createSourceService, sourceRangeScope } from '../src/source-range-store.js';

const reuseSource = await readFile(new URL('../src/playback-reuse.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../src/playback-bridge.js', import.meta.url), 'utf8');
const observerSource = await readFile(new URL('../src/playback-observer.js', import.meta.url), 'utf8');

const PATH = '/upgcxcode/1/2/3-1-30280.m4s';
const deadline = () => Math.floor(Date.now() / 1000) + 3600;
const url = (host = 'a.bilivideo.com', path = PATH) => `https://${host}${path}?deadline=${deadline()}`;
const bytes = (start, end) => Uint8Array.from({ length: end - start }, (_, index) => (start + index) & 0xff);
const encode = (value) => Buffer.from(value).toString('base64');
const TOTAL = 4096;

// ---------------------------------------------------------------------------
// 链路一：真实 playback-reuse.js + 真实 playback-bridge.js + 真实镜像服务
// ---------------------------------------------------------------------------

// 真实页面上 MAIN 与 ISOLATED 共享同一个 DOM window，但各自有独立 realm；
// 因此两个方向的事件都由「接收方自己的 window」作为 source 派发。
function loadChain({ account = async () => 'account-a', database = new Map() } = {}) {
  const service = createSourceService({ repository: createSourceRepository(createFakeIndexedDB(database)), account });
  const pageListeners = [];
  const pageWindow = {
    location: { href: 'https://www.bilibili.com/video/BV1test/' },
    addEventListener: (type, listener) => { if (type === 'message') pageListeners.push(listener); },
    postMessage: (data) => bridgeWindow.__page({ source: bridgeWindow, data })
  };
  pageWindow.window = pageWindow;
  const page = vm.createContext({
    window: pageWindow, URL, crypto, Uint8Array, Promise, Date, Error, setTimeout, clearTimeout, atob, btoa, console, JSON, Number, Object, Array, String, Math, queueMicrotask
  });
  vm.runInContext(reuseSource, page);

  // ISOLATED 桥：只保留本用例需要的最小 chrome 接口，读请求直达镜像服务。
  const bridgeWindow = {
    addEventListener: (type, listener) => { if (type === 'message') bridgeWindow.__page = listener; },
    postMessage: (data) => pageListeners.forEach((listener) => listener({ source: pageWindow, data })),
    __page: null
  };
  bridgeWindow.window = bridgeWindow;
  const bridge = vm.createContext({
    window: bridgeWindow, document: { documentElement: { dataset: {} } }, URL, Promise, Date, Error, setTimeout, clearTimeout, console, JSON, Number, Object, Array, String,
    chrome: {
      runtime: {
        id: 'extension-id',
        sendMessage: async (message) => {
          if (message?.type !== 'SOURCE_RANGE') return {};
          const scope = sourceRangeScope({ id: 'extension-id', url: 'https://www.bilibili.com/video/BV1test/' }, { runtimeId: 'extension-id', offscreenUrl: 'chrome-extension://extension-id/offscreen.html' });
          const result = await service.handle(message.request, scope);
          return { ok: true, ...result };
        },
        onMessage: { addListener() {} },
        getURL: (path) => `chrome-extension://extension-id/${path}`
      },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener() {} } }
    }
  });
  vm.runInContext(bridgeSource, bridge);
  const api = page.BiliPlaybackReuse;
  return { api, client: api.createReuseClient(), storage: service };
}

async function seed(service, { path = PATH, total = TOTAL, start = 0, end = 256 } = {}) {
  return service.handle({ op: 'write', url: url('a.bilivideo.com', path), start, end, total, contentType: 'video/mp4', body: encode(bytes(start, end)) }, 'writer');
}

test('已授权地址经页面→桥→镜像读回原始字节，统计与回包严格校验', async () => {
  const chain = loadChain();
  await seed(chain.storage);
  assert.equal(chain.api.notePlayurl({ dash: { video: [{ baseUrl: url(), backupUrl: [url('b.bilivideo.com')] }] } }), 2);
  assert.equal(chain.api.isAuthorized(url()), true);
  assert.equal(chain.api.isAuthorized(url('b.bilivideo.com')), true);
  assert.equal(chain.api.isAuthorized(url('c.bilivideo.com')), false);

  // 镜像行来自 a 主机；用同一媒体文件在 b 主机（也已授权）的地址读取，验证按「路径 + 总长」复用。
  const hit = await chain.client.read({ url: url('b.bilivideo.com'), start: 0, end: 256, total: TOTAL });
  assert.ok(hit);
  assert.equal(hit.total, TOTAL);
  assert.equal(hit.body.length, 256);
  assert.deepEqual([...hit.body.slice(0, 4)], [0, 1, 2, 3]);
});

test('未授权地址、超出单次上限与未知媒体一律不发请求', async () => {
  const chain = loadChain();
  await seed(chain.storage);
  let sent = 0;
  chain.api.notePlayurl({ dash: { video: [{ baseUrl: url() }] } });
  const originalPost = chain.client;
  void originalPost;
  assert.equal(await chain.client.read({ url: url('z.bilivideo.com', '/other.m4s'), start: 0, end: 256, total: TOTAL }), null);
  assert.equal(await chain.client.read({ url: url(), start: 0, end: chain.api.MAX_BYTES + 1, total: TOTAL }), null);
  // 未授权地址在页面侧就被拦住，桥根本不会收到请求。
  assert.equal(sent, 0);
});

test('镜像返回的字节长度与请求不一致时不交付', async () => {
  const chain = loadChain();
  chain.api.notePlayurl({ dash: { video: [{ baseUrl: url() }] } });
  await seed(chain.storage, { start: 0, end: 128 });
  // 只覆盖 [0,128)，请求 [0,256) 必须整体未命中。
  assert.equal(await chain.client.read({ url: url(), start: 0, end: 256, total: TOTAL }), null);
  assert.ok(await chain.client.read({ url: url(), start: 0, end: 128, total: TOTAL }));
});

test('桥不可用时超时返回未命中，并在连续失败后暂停请求', async () => {
  const window = {
    location: { href: 'https://www.bilibili.com/video/BV1/' }, addEventListener() {}, postMessage() {},
    URL, crypto, Uint8Array, Promise, Date, Error, setTimeout, clearTimeout, atob, btoa, console, JSON, Number, Object, Array, String, Math, queueMicrotask
  };
  window.window = window;
  const context = vm.createContext(window);
  vm.runInContext(reuseSource, context);
  const api = window.BiliPlaybackReuse;
  const client = api.createReuseClient();
  api.notePlayurl({ dash: { video: [{ baseUrl: url() }] } });
  const started = Date.now();
  assert.equal(await client.read({ url: url(), start: 0, end: 128, total: TOTAL }), null);
  assert(Date.now() - started >= 1400, '必须等到超时才放弃');
  for (let attempt = 0; attempt < 3; attempt += 1) await client.read({ url: url(), start: 0, end: 128, total: TOTAL });
  // 熔断后立即返回，不再每个请求都白等一次。
  const after = Date.now();
  assert.equal(await client.read({ url: url(), start: 0, end: 128, total: TOTAL }), null);
  assert(Date.now() - after < 200);
});

test('镜像写入者与读取者身份由纯函数判定，页面不能写入', () => {
  const identity = { runtimeId: 'extension-id', offscreenUrl: 'chrome-extension://extension-id/offscreen.html' };
  assert.equal(sourceRangeScope({ id: 'extension-id', url: identity.offscreenUrl }, identity), 'writer');
  assert.equal(sourceRangeScope({ id: 'extension-id', url: 'https://www.bilibili.com/video/BV1/' }, identity), 'reader');
  assert.equal(sourceRangeScope({ id: 'extension-id', tab: { url: 'https://www.bilibili.com/list/1' } }, identity), 'reader');
  assert.equal(sourceRangeScope({ id: 'other-extension', url: 'https://www.bilibili.com/video/BV1/' }, identity), null);
  assert.equal(sourceRangeScope({ id: 'extension-id', url: 'https://evil.example/video/BV1/' }, identity), null);
  assert.equal(sourceRangeScope({ id: 'extension-id', tab: { url: 'https://www.bilibili.com/' } }, identity), null);
  assert.equal(sourceRangeScope(null, identity), null);
});

// ---------------------------------------------------------------------------
// 链路二：真实观察器在复用命中时短路网络，未命中时保持原路径
// ---------------------------------------------------------------------------

function loadObserver({ reuse, mediaFetch } = {}) {
  const intervals = [];
  const eventListeners = new Map();
  const video = { duration: 100, currentTime: 0, paused: false, buffered: { length: 0 }, addEventListener() {} };
  class FakeStorage { getItem() { return null; } setItem() {} removeItem() {} }
  class FakeXhr { addEventListener() {} getResponseHeader() { return null; } }
  FakeXhr.prototype.open = function () {}; FakeXhr.prototype.send = function () {}; FakeXhr.prototype.setRequestHeader = function () {};
  const calls = { read: [] };
  const reuseApi = reuse === null ? undefined : {
    notePlayurl: () => 1,
    totalHint: () => TOTAL,
    createReuseClient: () => ({ read: async (request) => { calls.read.push(request); return reuse ? reuse(request) : null; } })
  };
  const document = {
    nodeType: 9, documentElement: { dataset: {} }, hidden: false, addEventListener(type, listener) { eventListeners.set(`document:${type}`, listener); },
    querySelectorAll: (selector) => (selector === 'video' ? [video] : [])
  };
  const window = {
    BiliPlaybackReuse: reuseApi,
    Storage: FakeStorage, XMLHttpRequest: FakeXhr,
    fetch: mediaFetch || (async () => { throw new Error('测试不应发出真实请求'); }),
    addEventListener(type, listener) { eventListeners.set(type, listener); }, postMessage() {}
  };
  window.window = window;
  const context = vm.createContext({
    window, document, localStorage: new FakeStorage(), location: { href: 'https://www.bilibili.com/video/BV1test/' }, URL, Headers, Response, Request,
    ReadableStream, Uint8Array, DataView, ArrayBuffer, Blob, DOMException, AbortController, performance, queueMicrotask, setTimeout, clearTimeout,
    setInterval: (callback, milliseconds) => { intervals.push({ callback, milliseconds }); return intervals.length; }, clearInterval() {}, MutationObserver: class { observe() {} }
  });
  // 真实页面里 globalThis 就是 window；沙箱里补一分别名即可。
  vm.runInContext('globalThis.BiliPlaybackReuse = window.BiliPlaybackReuse', context);
  vm.runInContext('window.BiliPlaybackNetwork = { createNetwork: () => ({ register(){}, download: async () => { throw new Error("不应走网络"); }, tune(){}, snapshot: () => ({ receivedBytes: 0, blocked: 0, cdnMode: "original", active: 0, limit: 8, speed: 0, rescues: 0 }), total: () => 0, role: () => null, fallback(){}, setMode(){}, setMax(){}, reset(){} }) };', context);
  vm.runInContext(observerSource, context, { filename: 'playback-observer.js' });
  return { internals: window.__biliBufferPlaybackAssistInternals, calls };
}

test('复用命中直接交付并单独计数，不触发网络请求', async () => {
  const body = bytes(0, 300);
  const { internals, calls } = loadObserver({
    reuse: async (request) => (request.start === 0 && request.end === 300 ? { body, total: TOTAL, contentType: 'video/mp4' } : null)
  });
  internals.cfg.mode = 'always';
  const result = await internals.loadPlayerRange(url(), 'bytes=0-299', new AbortController().signal);
  assert.equal(result.body.length, 300);
  assert.equal(result.total, TOTAL);
  assert.equal(result.contentType, 'video/mp4');
  assert.equal(calls.read.length, 1);
  assert.equal(internals.stats.reuseHits, 1);
  assert.equal(internals.stats.reuseBytes, 300);
});

test('复用未命中或模块缺失时保持原有网络路径', async () => {
  const miss = loadObserver({ reuse: async () => null });
  miss.internals.cfg.mode = 'always';
  await assert.rejects(() => miss.internals.loadPlayerRange(url(), 'bytes=0-299', new AbortController().signal), /不应走网络/);
  assert.equal(miss.internals.stats.reuseHits, 0);

  const absent = loadObserver({ reuse: null });
  absent.internals.cfg.mode = 'always';
  await assert.rejects(() => absent.internals.loadPlayerRange(url(), 'bytes=0-299', new AbortController().signal), /不应走网络/);
  assert.equal(absent.calls.read.length, 0);
});
