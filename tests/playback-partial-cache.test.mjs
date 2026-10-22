import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 本文件专门验收“部分命中”：播放器请求的范围内已有部分字节驻留时，
// 必须只向网络补齐缺口，然后把缓存快照与缺口正文拼成一条完整、经过校验的 206。
// 缓存适配器只负责把未完整命中的请求整体交给 loadRange（观察器），失败时回退原生；
// 驻留快照 + 缺口拆分 + 复用在途分片 由观察器与分片引擎完成，这里用真实链路验证。

const cacheSource = await readFile(new URL("../src/playback-cache.js", import.meta.url), "utf8");
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

/** 记录真实媒体 fetch 的 URL、Range 与优先级，并按字节位置返回 206。 */
function createMediaFetch(total, log) {
  return async (input, init = {}) => {
    const url = String(input?.url || input);
    const header = new Headers(init.headers || input?.headers).get("range") || "";
    const match = /^bytes=(\d+)-(\d+)$/.exec(header);
    if (!match) {
      log.push({ url, range: null, priority: init.priority });
      return new Response(bytesBetween(0, total), { status: 200, headers: { "content-type": "video/mp4", "content-length": String(total) } });
    }
    const start = Number(match[1]), end = Number(match[2]);
    log.push({ url, range: [start, end], priority: init.priority });
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
  vm.runInContext(networkSource, context);
  window.BiliPlaybackNetwork = context.BiliPlaybackNetwork;
  vm.runInContext(observerSource, context, { filename: "playback-observer.js" });
  return { window, document, internals: window.__biliBufferPlaybackAssistInternals, cache: window.__biliBufferCache, intervals, eventListeners };
}

// 播放器急需请求带 high 优先级；后台预热（low）会在请求之后补齐文件头，不属于本文件的断言对象。
const urgent = (log) => log.filter((entry) => entry.priority === "high").map((entry) => entry.range);
// 关闭辅助并清空分片表：否则规划器会在测试结束后继续排后台分片，进程无法退出。
const stop = (internals) => { internals.cfg.mode = "off"; internals.network.reset(); };
const result = (start, end, total = TOTAL, reused = 0) => ({ body: bytesBetween(start, end), start, end, total, contentType: "video/mp4", reused });

// ---------------------------------------------------------------------------
// 缓存适配器：未完整命中时整体交给 loadRange，失败回退原生
// ---------------------------------------------------------------------------

test("fetch 未完整命中时把整个原范围交给 loadRange，复用字节单独计为部分命中", async () => {
  const nativeCalls = [];
  const { cache, window } = loadCacheAdapter({ nativeFetch: async () => { nativeCalls.push("native"); return new Response(bytesBetween(0, 1), { status: 200 }); } });
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  const calls = [];
  cache.install({ enabled: () => true, loadRange: async (url, range) => { calls.push([url, range]); return result(0, 220, TOTAL, 100); } });

  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-219" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 0-219/${TOTAL}`);
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 220);
  assert.deepEqual(calls, [[MEDIA, "bytes=0-219"]]);
  assert.equal(nativeCalls.length, 0);
  assert.equal(cache.stats.hits, 0, "部分命中不等于完整本地命中");
  assert.equal(cache.stats.partialHits, 1);
  assert.equal(cache.stats.partialHitBytes, 100);
});

test("loadRange 失败或返回空时回退原生完整响应，不记部分命中", async () => {
  for (const loadRange of [async () => { throw new Error("节点失败"); }, async () => null]) {
    const nativeCalls = [];
    const { cache, window } = loadCacheAdapter({ nativeFetch: async () => { nativeCalls.push("native"); return new Response(bytesBetween(0, 220), { status: 206, headers: { "content-range": `bytes 0-219/${TOTAL}` } }); } });
    cache.install({ enabled: () => true, loadRange });
    const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-219" } });
    assert.equal(nativeCalls.length, 1);
    assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 220);
    assert.equal(cache.stats.partialHits, 0);
  }
});

test("loadRange 期间取消不回退原请求，也不交付字节", async () => {
  const nativeCalls = [];
  const { cache, window } = loadCacheAdapter({ nativeFetch: async () => { nativeCalls.push("native"); return new Response("x"); } });
  cache.install({
    enabled: () => true,
    loadRange: (_url, _range, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  });
  const controller = new AbortController();
  const pending = window.fetch(MEDIA, { headers: { Range: "bytes=0-299" }, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(nativeCalls.length, 0);
});

test("XHR 未完整命中同样交给 loadRange，事件序列与原生一致", async () => {
  FakeNativeXhr.sends = 0;
  const { cache, window } = loadCacheAdapter({ NativeXhr: FakeNativeXhr });
  cache.install({ enabled: () => true, loadRange: async () => result(0, 220, TOTAL, 100) });

  const xhr = new window.XMLHttpRequest();
  const events = [], states = [];
  xhr.open("GET", MEDIA);
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("Range", "bytes=0-219");
  for (const type of ["loadstart", "progress", "load"]) xhr.addEventListener(type, () => events.push(type));
  xhr.addEventListener("readystatechange", () => states.push(xhr.readyState));
  const done = new Promise((resolve) => xhr.addEventListener("loadend", () => { events.push("loadend"); resolve(); }));
  xhr.send();
  await done;

  assert.equal(xhr.status, 206);
  assert.equal(xhr.getResponseHeader("content-range"), `bytes 0-219/${TOTAL}`);
  assertBytes(new Uint8Array(xhr.response), 0, 220);
  assert.equal(FakeNativeXhr.sends, 0);
  assert.deepEqual(states, [2, 3, 4]);
  assert.deepEqual(events, ["loadstart", "progress", "load", "loadend"]);
  assert.equal(cache.stats.partialHits, 1);
});

test("XHR loadRange 返回空时回退原生 send", async () => {
  FakeNativeXhr.sends = 0;
  const { cache, window } = loadCacheAdapter({ NativeXhr: FakeNativeXhr });
  cache.install({ enabled: () => true, loadRange: async () => null });
  const xhr = new window.XMLHttpRequest();
  xhr.open("GET", MEDIA);
  xhr.responseType = "arraybuffer";
  xhr.setRequestHeader("Range", "bytes=0-299");
  xhr.send();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(FakeNativeXhr.sends, 1);
  assert.equal(cache.stats.partialHits, 0);
});

// ---------------------------------------------------------------------------
// 真实观察器 + 分片引擎：证明缺口就是实际 Range 请求
// ---------------------------------------------------------------------------

test("观察器 fetch 链路只对缺口发起真实媒体 Range 请求", async () => {
  const log = [];
  const { window, cache, internals } = loadPlaybackStack({ mediaFetch: createMediaFetch(TOTAL, log) });
  internals.cfg.mode = "always";
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.put(MEDIA, 190, bytesBetween(190, 220), TOTAL, { contentType: "video/mp4" });

  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-219" } });
  assert.equal(response.status, 206);
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 220);
  assert.deepEqual(urgent(log), [[100, 189]], "网络只应看到 [100,190) 缺口");
  assert(log.every((entry) => entry.url === MEDIA), "必须使用原始签名 URL");
  assert.equal(cache.stats.partialHits, 1);
  assert.equal(cache.stats.partialHitBytes, 130);
  stop(internals);
});

test("观察器 XHR 链路只对缺口发起真实媒体 Range 请求", async () => {
  const log = [];
  const { window, cache, internals } = loadPlaybackStack({ mediaFetch: createMediaFetch(TOTAL, log), NativeXhr: FakeNativeXhr });
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
  assert.deepEqual(urgent(log), [[100, 199]]);
  stop(internals);
});

test("缺口下载期间发生回收也不能污染已快照的缓存字节", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const log = [], serve = createMediaFetch(TOTAL, log);
  const { window, cache, internals } = loadPlaybackStack({ mediaFetch: async (input, init) => { await gate; return serve(input, init); } });
  internals.cfg.mode = "always";
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });
  cache.put(MEDIA, 190, bytesBetween(190, 220), TOTAL, { contentType: "video/mp4" });

  const pending = window.fetch(MEDIA, { headers: { Range: "bytes=0-219" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // 驻留字节已在规划时复制成快照，此时把缓存全部回收。
  cache.setLimit(0);
  assert.equal(cache.stats.bytes, 0);
  release();
  const response = await pending;
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 220);
  stop(internals);
});

test("一处缺口失败时取消其余缺口，再回退完整原生请求", async () => {
  const log = [], serve = createMediaFetch(TOTAL, log);
  let cancelled = 0;
  const mediaFetch = async (input, init) => {
    const header = new Headers(init?.headers).get("range") || "";
    if (init?.priority === "low") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })); // 后台预热挂起，不干扰断言
    if (header === "bytes=10-19") return new Response("no", { status: 503 });
    if (header === "bytes=30-39") return new Promise((_, reject) => init.signal.addEventListener("abort", () => { cancelled += 1; reject(init.signal.reason); }, { once: true }));
    return serve(input, init);
  };
  const { window, cache, internals } = loadPlaybackStack({ mediaFetch });
  internals.cfg.mode = "always";
  for (const [a, b] of [[0, 10], [20, 30], [40, 60]]) cache.put(MEDIA, a, bytesBetween(a, b), TOTAL);

  try {
    const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-59" } });
    assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 60);
    // 挂起的缺口在失败重试期间可能已被对冲出第二份请求；两份都必须被取消。
    assert(cancelled >= 1, "失败后取消仍在途的兄弟缺口");
    assert.equal(internals.network.inflightRanges(MEDIA).filter(([start]) => start === 30).length, 0);
    assert.deepEqual(log.at(-1).range, [0, 59], "最终回退完整原范围");
    assert.equal(cache.stats.partialHits, 0);
  } finally { stop(internals); }
});

test("缺口返回的文件总长与驻留缓存不一致时整条请求回退", async () => {
  const log = [];
  const wrong = createMediaFetch(TOTAL + 1, []), right = createMediaFetch(TOTAL, log);
  const mediaFetch = async (input, init) => (init?.priority === "high" ? wrong(input, init) : right(input, init));
  const { window, cache, internals } = loadPlaybackStack({ mediaFetch });
  internals.cfg.mode = "always";
  cache.put(MEDIA, 0, bytesBetween(0, 100), TOTAL, { contentType: "video/mp4" });

  const response = await window.fetch(MEDIA, { headers: { Range: "bytes=0-299" } });
  assertBytes(new Uint8Array(await response.arrayBuffer()), 0, 300);
  assert.deepEqual(log.at(-1).range, [0, 299], "总长不一致必须回退，不能拼出错误 206");
  assert.equal(cache.stats.partialHits, 0);
  stop(internals);
});

test("无驻留覆盖时整段走分片引擎；向后 seek 允许预热锚点回退", async () => {
  const log = [];
  const { internals } = loadPlaybackStack({ mediaFetch: createMediaFetch(TOTAL, log) });
  internals.cfg.mode = "always";
  const first = await internals.loadPlayerRange(MEDIA, "bytes=1000-1099", new AbortController().signal);
  assertBytes(first.body, 1000, 1100);
  assert.equal(first.reused, 0);
  assert.equal(internals.trackFor(MEDIA).anchor, 1100);
  await internals.loadPlayerRange(MEDIA, "bytes=100-149", new AbortController().signal);
  assert.equal(internals.trackFor(MEDIA).anchor, 150);
  stop(internals);
});
