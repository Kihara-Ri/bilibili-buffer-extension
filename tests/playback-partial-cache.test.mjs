import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 本文件专门验收“部分命中”：播放器请求的范围内已有部分字节驻留时，
// 必须只向网络补齐缺口，然后把缓存快照与缺口正文拼成一条完整、经过校验的 206。
// 测试不只要证明规划结果，还要证明 fetch/XHR 适配器和真实 loadRange/network
// 调用链确实只请求了缺口，并且返回的字节完整。

const cacheSource = await readFile(new URL("../src/playback-cache.js", import.meta.url), "utf8");
const routesSource = await readFile(new URL("../src/playback-routes.js", import.meta.url), "utf8");
const networkSource = await readFile(new URL("../src/playback-network.js", import.meta.url), "utf8");
const observerSource = await readFile(new URL("../src/playback-observer.js", import.meta.url), "utf8");

const MEDIA = "https://cache-test.bilivideo.com/video.m4s?sig=token";
const TOTAL = 4096;
const byteAt = (index) => index & 0xff;
const bytesBetween = (start, end) => Uint8Array.from({ length: Math.max(0, end - start) }, (_, index) => byteAt(start + index));
function assertBytes(actual, start, end) {
  assert.equal(actual.length, end - start, `长度应为 ${end - start}，实际 ${actual.length}`);
  for (let index = 0; index < actual.length; index += 1) assert.equal(actual[index], byteAt(start + index), `第 ${start + index} 字节不一致`);
}

// Node 没有 ProgressEvent，但缓存适配器会构造它；用 Event 兼容实现补齐。
class ProgressEventPoly extends Event {
  constructor(type, init = {}) {
    super(type);
    this.lengthComputable = Boolean(init.lengthComputable);
    this.loaded = init.loaded || 0;
    this.total = init.total || 0;
  }
}

// 原生 XHR 的替身：只保留缓存适配器需要读取/覆盖的接口，send 仅记录是否被回退使用。
class FakeNativeXhr extends EventTarget {
  static sends = 0;
  constructor() {
    super();
    this._responseType = "";
    this._timeout = 0;
  }
  open(method, url, async = true) { this.opened = { method, url, async }; }
  setRequestHeader() {}
  send() { FakeNativeXhr.sends += 1; }
  abort() {}
  get responseType() { return this._responseType; }
  set responseType(value) { this._responseType = value; }
  get timeout() { return this._timeout; }
  set timeout(value) { this._timeout = value; }
  get readyState() { return 1; }
  get status() { return 0; }
  get response() { return null; }
  get responseURL() { return ""; }
  getResponseHeader() { return null; }
  getAllResponseHeaders() { return ""; }
}

/** 只加载 playback-cache.js，注入可观测的原生 fetch/XHR。 */
function loadCacheAdapter({ nativeFetch, NativeXhr } = {}) {
  const window = {
    fetch: nativeFetch || (async () => { throw new Error("不应发起原生 fetch"); }),
    XMLHttpRequest: NativeXhr
  };
  vm.runInNewContext(cacheSource, {
    window, URL, Headers, Response, Request, ReadableStream, Uint8Array, DataView, ArrayBuffer, Blob,
    DOMException, setTimeout, clearTimeout, performance, AbortController, Event, EventTarget, ProgressEvent: ProgressEventPoly
  });
  return { cache: window.__biliBufferCache, window };
}

/** 记录真实媒体 fetch 的 URL 与 Range，并按字节位置返回 206。 */
function createMediaFetch(total, log) {
  return async (input, init = {}) => {
    const url = String(input?.url || input);
    const header = new Headers(init.headers || input?.headers).get("range") || "";
    const match = /^bytes=(\d+)-(\d+)$/.exec(header);
    if (!match) {
      log.push({ url, range: null });
      return new Response(bytesBetween(0, total), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(total) } });
    }
    const start = Number(match[1]), end = Number(match[2]);
    log.push({ url, range: [start, end] });
    return new Response(bytesBetween(start, end + 1), {
      status: 206,
      headers: { "content-type": "video/mp4", "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1) }
    });
  };
}

/** 加载完整的 缓存 + 路由 + 下载器 + 观察器 链路，媒体请求走注入的 fetch。 */
function loadPlaybackStack({ mediaFetch, NativeXhr } = {}) {
  const intervals = [];
  const eventListeners = new Map();
  const testVideo = { duration: 100, currentTime: 0, paused: true, buffered: { length: 0 }, addEventListener() {} };
  class FakeStorage {
    constructor(initial = {}) { this.values = new Map(Object.entries(initial)); }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
  }
  const document = {
    nodeType: 9,
    documentElement: { dataset: {} },
    hidden: false,
    addEventListener(type, listener) { eventListeners.set(`document:${type}`, listener); },
    querySelectorAll(selector) { return selector === "video" ? [testVideo] : []; }
  };
  const window = {
    Storage: FakeStorage,
    fetch: mediaFetch,
    XMLHttpRequest: NativeXhr,
    addEventListener(type, listener) { eventListeners.set(type, listener); },
    postMessage() {}
  };
  window.window = window;
  const location = { href: "https://www.bilibili.com/video/BVpartial/" };
  const context = vm.createContext({
    window, document, localStorage: new FakeStorage(), location, URL, Headers, AbortController, DOMException, Blob,
    performance, queueMicrotask, setTimeout, clearTimeout, Uint8Array, DataView, ArrayBuffer, ReadableStream, Request, Response,
    Event, EventTarget, ProgressEvent: ProgressEventPoly,
    setInterval: (callback, milliseconds) => { intervals.push({ callback, milliseconds }); return intervals.length; },
    clearInterval() {},
    MutationObserver: class { observe() {} }
  });
  vm.runInContext(cacheSource, context);
  vm.runInContext(routesSource, context);
  vm.runInContext(networkSource, context);
  window.BiliPlaybackNetwork = context.BiliPlaybackNetwork;
  vm.runInContext(observerSource, context, { filename: "playback-observer.js" });
  return { window, document, internals: window.__biliBufferPlaybackAssistInternals, cache: window.__biliBufferCache, intervals, eventListeners };
}

// ---------------------------------------------------------------------------
// fetch 适配器：只下载缺口并拼接
// ---------------------------------------------------------------------------

test("fetch 部分命中只请求缺口并返回完整拼接正文", async () => {
  const nativeCalls = [];
  const { cache, window } = loadCacheAdapter({ nativeFetch: async () => { nativeCalls.push("native"); return new Response(bytesBetween(0, 1), { status: 200 }); } });
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.put(MEDIA, 190, bytesBetween(190, 220), TOTAL, { contentType: "video/mp4" });
  const gapCalls = [];
  cache.install({
    enabled: () => true,
    loadRange: async (url, range) => {
      gapCalls.push([url, range]);
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
      return { body: bytesBetween(Number(start), Number(end) + 1), start: Number(start), end: Number(end) + 1, total: TOTAL, contentType: "video/mp4" };
    }
  });

  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-219" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 0-219/${TOTAL}`);
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 220);
  assert.deepEqual(gapCalls, [[MEDIA, "bytes=100-189"]], "只应下载 [100,190) 缺口");
  assert.equal(nativeCalls.length, 0, "部分命中不应落到原生网络");
  assert.equal(cache.stats.hits, 0, "部分命中不等于完整本地命中");
  assert.equal(cache.stats.partialHits, 1, "应单独记录部分命中");
});

test("缺口下载期间发生回收也不能污染已快照的缓存字节", async () => {
  const { cache, window } = loadCacheAdapter();
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.put(MEDIA, 190, bytesBetween(190, 220), TOTAL, { contentType: "video/mp4" });
  let release;
  cache.install({
    enabled: () => true,
    loadRange: (url, range) => new Promise((resolve) => {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
      release = () => resolve({ body: bytesBetween(Number(start), Number(end) + 1), start: Number(start), end: Number(end) + 1, total: TOTAL, contentType: "video/mp4" });
    })
  });

  const pending = window.fetch(MEDIA, { headers: { Range: "bytes=0-219" } });
  // 规划快照已同步完成，此时把驻留缓存全部回收。
  cache.setLimit(0);
  assert.equal(cache.stats.bytes, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  const response = await pending;
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 220);
});

test("超过单次重组上限时不做部分拼接，交还原请求路径", async () => {
  const nativeCalls = [];
  const { cache, window } = loadCacheAdapter({ nativeFetch: async () => { nativeCalls.push("native"); return new Response(bytesBetween(0, 1), { status: 200 }); } });
  const bigTotal = cache.maxReassembly + 1;
  cache.put(MEDIA, 0, bytesBetween(0, 64), bigTotal, { contentType: "video/mp4" });
  const gapCalls = [];
  cache.install({
    enabled: () => true,
    loadRange: async (url, range) => { gapCalls.push(range); return null; }
  });

  await window.fetch(MEDIA, { headers: { Range: "bytes=0-" } });
  assert.deepEqual(gapCalls, ["bytes=0-"], "超限时使用原请求范围，而不是拆分");
  assert.equal(nativeCalls.length, 1, "loadRange 返回空必须回退原生网络");
});

test("缺口失败不交付半成品，回退原生完整响应", async () => {
  const nativeCalls = [];
  const { cache, window } = loadCacheAdapter({ nativeFetch: async () => { nativeCalls.push("native"); return new Response(bytesBetween(0, 220), { status: 206, headers: { "content-range": `bytes 0-219/${TOTAL}` } }); } });
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.put(MEDIA, 190, bytesBetween(190, 220), TOTAL, { contentType: "video/mp4" });
  cache.install({ enabled: () => true, loadRange: async () => { throw new Error("节点失败"); } });

  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-219" } });
  assert.equal(nativeCalls.length, 1);
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 220);
  assert.equal(cache.stats.partialHits, 0);
});

test("缺口返回的文件总长与驻留缓存不一致时整条请求回退", async () => {
  const nativeCalls = [];
  const { cache, window } = loadCacheAdapter({ nativeFetch: async () => { nativeCalls.push("native"); return new Response(bytesBetween(0, 220), { status: 206, headers: { "content-range": `bytes 0-219/${TOTAL}` } }); } });
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.install({
    enabled: () => true,
    loadRange: async (_url, range) => {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
      return { body: bytesBetween(Number(start), Number(end) + 1), start: Number(start), end: Number(end) + 1, total: TOTAL + 1, contentType: "video/mp4" };
    }
  });

  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-299" } });
  assert.equal(nativeCalls.length, 1, "总长不一致必须回退，不能拼出错误 206");
  assert.equal(cache.stats.partialHits, 0);
});

test("两个缺口只补齐一个时整体回退，不返回半成品", async () => {
  const nativeCalls = [];
  const { cache, window } = loadCacheAdapter({ nativeFetch: async () => { nativeCalls.push("native"); return new Response(bytesBetween(0, 320), { status: 206, headers: { "content-range": `bytes 0-319/${TOTAL}` } }); } });
  cache.put(MEDIA, 0, bytesBetween(0, 50), TOTAL, { contentType: "video/mp4" });
  cache.put(MEDIA, 100, bytesBetween(100, 150), TOTAL, { contentType: "video/mp4" });
  cache.put(MEDIA, 200, bytesBetween(200, 250), TOTAL, { contentType: "video/mp4" });
  const gapCalls = [];
  cache.install({
    enabled: () => true,
    loadRange: async (_url, range) => {
      gapCalls.push(range);
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
      if (Number(start) === 50) throw new Error("第二个缺口失败");
      return { body: bytesBetween(Number(start), Number(end) + 1), start: Number(start), end: Number(end) + 1, total: TOTAL, contentType: "video/mp4" };
    }
  });

  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-299" } });
  assert.deepEqual(gapCalls.sort(), ["bytes=150-199", "bytes=250-299", "bytes=50-99"], "只对两个缺口发起下载");
  assert.equal(nativeCalls.length, 1);
  assert.equal(cache.stats.partialHits, 0, "任一缺口失败都不得记部分命中");
});

test("部分命中期间取消不回退原请求，也不交付旧字节", async () => {
  const { cache, window } = loadCacheAdapter();
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.install({
    enabled: () => true,
    loadRange: (_url, _range, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  });
  const controller = new AbortController();
  const pending = window.fetch(MEDIA, { headers: { Range: "bytes=0-299" }, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cache.stats.partialHits, 0);
});

test("无驻留覆盖时保持整段 loadRange 行为", async () => {
  const { cache, window } = loadCacheAdapter();
  const calls = [];
  cache.install({
    enabled: () => true,
    loadRange: async (_url, range) => {
      calls.push(range);
      return { body: bytesBetween(0, 100), start: 0, end: 100, total: TOTAL, contentType: "video/mp4" };
    }
  });
  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-99" } });
  assert.deepEqual(calls, ["bytes=0-99"]);
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 100);
});

test("范围内无驻留字节时不做部分规划，也不记部分命中", async () => {
  const { cache, window } = loadCacheAdapter();
  cache.put(MEDIA, 1000, bytesBetween(1000, 1100), TOTAL, { contentType: "video/mp4" });
  const calls = [];
  cache.install({
    enabled: () => true,
    loadRange: async (_url, range) => {
      calls.push(range);
      return { body: bytesBetween(0, 100), start: 0, end: 100, total: TOTAL, contentType: "video/mp4" };
    }
  });
  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-99" } });
  assert.deepEqual(calls, ["bytes=0-99"], "没有复用字节时应走整段路径");
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 100);
  assert.equal(cache.stats.partialHits, 0);
});

// ---------------------------------------------------------------------------
// XHR 适配器：部分命中同样只补齐缺口
// ---------------------------------------------------------------------------

test("XHR 部分命中只请求缺口并返回拼接后的 ArrayBuffer", async () => {
  FakeNativeXhr.sends = 0;
  const { cache, window } = loadCacheAdapter({ NativeXhr: FakeNativeXhr });
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.put(MEDIA, 190, bytesBetween(190, 220), TOTAL, { contentType: "video/mp4" });
  const gapCalls = [];
  cache.install({
    enabled: () => true,
    loadRange: async (url, range) => {
      gapCalls.push([url, range]);
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
      return { body: bytesBetween(Number(start), Number(end) + 1), start: Number(start), end: Number(end) + 1, total: TOTAL, contentType: "video/mp4" };
    }
  });

  const xhr = new window.XMLHttpRequest();
  const events = [], states = [];
  xhr.open("GET", MEDIA);
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("Range", "bytes=0-219");
  xhr.addEventListener("loadstart", () => events.push("loadstart"));
  xhr.addEventListener("progress", () => events.push("progress"));
  xhr.addEventListener("load", () => events.push("load"));
  xhr.addEventListener("readystatechange", () => states.push(xhr.readyState));
  const done = new Promise((resolve) => xhr.addEventListener("loadend", () => { events.push("loadend"); resolve(); }));
  xhr.send();
  await done;

  assert.equal(xhr.status, 206);
  assert.equal(xhr.getResponseHeader("content-range"), `bytes 0-219/${TOTAL}`);
  assertBytes(new Uint8Array(xhr.response), 0, 220);
  assert.deepEqual(gapCalls, [[MEDIA, "bytes=100-189"]]);
  assert.equal(FakeNativeXhr.sends, 0, "部分命中不应把请求交回原生 XHR");
  assert.deepEqual(states, [2, 3, 4]);
  assert.deepEqual(events, ["loadstart", "progress", "load", "loadend"]);
  assert.equal(cache.stats.partialHits, 1);
});

test("XHR 缺口失败回退原生 send，不交付半成品", async () => {
  FakeNativeXhr.sends = 0;
  const { cache, window } = loadCacheAdapter({ NativeXhr: FakeNativeXhr });
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.install({ enabled: () => true, loadRange: async () => null });

  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", MEDIA);
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("Range", "bytes=0-299");
  xhr.send();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(FakeNativeXhr.sends, 1, "loadRange 空结果必须回退原生 XHR");
  assert.equal(cache.stats.partialHits, 0);
});

// ---------------------------------------------------------------------------
// 真实观察器 + 下载器链路：证明缺口就是实际 Range 请求
// ---------------------------------------------------------------------------

test("观察器 fetch 链路只对缺口发起真实媒体 Range 请求", async () => {
  const log = [];
  const mediaFetch = createMediaFetch(TOTAL, log);
  const { window, cache, internals } = loadPlaybackStack({ mediaFetch });
  internals.cfg.mode = "always";
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.put(MEDIA, 190, bytesBetween(190, 220), TOTAL, { contentType: "video/mp4" });

  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-219" } });
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 220);
  assert.deepEqual(log.map((entry) => entry.range), [[100, 189]], "网络只应看到 [100,190) 缺口");
  assert(log.every((entry) => entry.url === MEDIA), "必须使用原始签名 URL，不能换成其他主机");
  assert.equal(response.status, 206);
});

test("观察器 XHR 链路只对缺口发起真实媒体 Range 请求", async () => {
  const log = [];
  const mediaFetch = createMediaFetch(TOTAL, log);
  const { window, cache, internals } = loadPlaybackStack({ mediaFetch, NativeXhr: FakeNativeXhr });
  internals.cfg.mode = "always";
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });

  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", MEDIA);
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("Range", "bytes=0-199");
  const done = new Promise((resolve) => xhr.addEventListener("loadend", resolve));
  xhr.send();
  await done;
  assertBytes(new Uint8Array(xhr.response), 0, 200);
  assert.deepEqual(log.map((entry) => entry.range), [[100, 199]]);
  assert(log.every((entry) => entry.url === MEDIA));
});

test("观察器网关失败后回退完整原生范围请求", async () => {
  const log = [];
  const mediaFetch = createMediaFetch(TOTAL, log);
  const failing = async (input, init) => {
    const header = new Headers(init?.headers).get("range") || "";
    if (/^bytes=100-/.test(header)) {
      log.push({ url: String(input), range: [100, 219], failed: true });
      return new Response("no", { status: 503 });
    }
    return mediaFetch(input, init);
  };
  const { window, cache, internals } = loadPlaybackStack({ mediaFetch: failing });
  internals.cfg.mode = "always";
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });

  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-219" } });
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 220);
  const full = log.at(-1);
  assert.deepEqual(full.range, [0, 219], "缺口失败后必须回退完整原范围");
  assert.equal(cache.stats.partialHits, 0);
});

test('一处缺口失败时取消其余缺口，再回退完整原请求',async()=>{
 let cancelled=0,fallbacks=0;
 const {cache,window}=loadCacheAdapter({nativeFetch:async()=>{fallbacks++;return new Response(bytesBetween(0,60));}});
 for(const [a,b] of [[0,10],[20,30],[40,50]])cache.put(MEDIA,a,bytesBetween(a,b),TOTAL);
 cache.install({loadRange:async(_url,range,signal)=>{
  if(range==='bytes=10-19')throw Error('failure');
  return new Promise((_,reject)=>signal.addEventListener('abort',()=>{cancelled++;reject(signal.reason);},{once:true}));
 }});
 const response=await window.fetch(MEDIA,{headers:{Range:'bytes=0-59'}});await response.arrayBuffer();
 assert.equal(fallbacks,1);assert.equal(cancelled,2);
});
test('父范围末端统一缺口锚点，但向后 seek 不被单调钳制',async()=>{
 const log=[],{internals}=loadPlaybackStack({mediaFetch:createMediaFetch(TOTAL,log)});internals.cfg.mode='always';
 await internals.loadPlayerRange(MEDIA,'bytes=1000-1099',new AbortController().signal);
 assert.equal(internals.trackFor(MEDIA).anchor,1100);
 await internals.loadPlayerRange(MEDIA,'bytes=100-149',new AbortController().signal,{start:0,end:200});
 assert.equal(internals.trackFor(MEDIA).anchor,200);
});

