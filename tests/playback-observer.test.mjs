import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const networkSource = await readFile(new URL("../src/playback-network.js", import.meta.url), "utf8");
const source = await readFile(new URL("../src/playback-observer.js", import.meta.url), "utf8");

test("MAIN world 脚本可在 document_start 且尚无 documentElement 时启动", () => {
  const { internals, observedTargets } = loadObserver({ documentElement: null });
  assert.ok(internals);
  assert.equal(observedTargets[0].target.nodeType, 9);
  assert.deepEqual(fromVm(internals.parseRangeHeader("bytes=12-99")), { start: 12, end: 99 });
  assert.deepEqual(fromVm(internals.parseContentRange("bytes 12-99/1000")), { start: 12, end: 99, total: 1000 });
});

test("同一路径切换 CDN host 时分别记录热区间", () => {
  const { internals } = loadObserver();
  const first = internals.trackFor("https://a.bilivideo.com/path/video.m4s?token=1");
  const renewed = internals.trackFor("https://a.bilivideo.com/path/video.m4s?token=2");
  const otherEdge = internals.trackFor("https://b.bilivideo.com/path/video.m4s?token=3");
  assert.equal(first, renewed);
  assert.notEqual(first, otherEdge);
  assert.equal(internals.tracks.size, 2);
  assert.equal(first.active, false);
  assert.equal(otherEdge.active, true);
});

test("只有音视频轨都预热的交集才映射为实心高亮", () => {
  const { internals, cacheTimes } = loadObserver();
  const video = internals.trackFor("https://a.bilivideo.com/path/video.m4s");
  video.size = 1000;
  cacheTimes.set(video.url, [[10, 30]]);
  const audio = internals.trackFor("https://a.bilivideo.com/path/audio.m4s");
  audio.size = 100;
  cacheTimes.set(audio.url, [[20, 40]]);

  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), [[0.2, 0.3]]);
});

test("只预热 DASH 单轨时不显示可能误导的实心高亮", () => {
  const { internals, cacheTimes } = loadObserver();
  const video = internals.trackFor("https://a.bilivideo.com/path/video.m4s");
  video.size = 1000;
  cacheTimes.set(video.url, [[10, 30]]);

  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), []);
});

test("未知索引的单文件 MP4 不再按字节比例伪造黄色", () => {
  const { internals } = loadObserver();
  const media = internals.trackFor("https://a.bilivideo.com/path/video.mp4");
  media.size = 1000;
  internals.recordMedia({ url: media.url, range: { start: 100 }, bytes: 200, status: 206, completed: true });

  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), []);
});


test("四种状态互斥且覆盖全时间轴，黄色保留插件来源，不被灰色覆盖", () => {
  const { internals } = loadObserver();
  assert.deepEqual(fromVm(internals.timelineStates(.25, [[0, .4], [.6, .7]], [[.2, .5], [.65, .8]])), [
    { start: 0, end: .25, state: "played" },
    { start: .25, end: .5, state: "plugin" },
    { start: .5, end: .6, state: "empty" },
    { start: .6, end: .65, state: "native" },
    { start: .65, end: .8, state: "plugin" },
    { start: .8, end: 1, state: "empty" }
  ]);
});

test("关闭区分后插件范围仍显示为缓冲，状态数据不丢失", () => {
  const { internals } = loadObserver();
  const states = internals.timelineStates(.1, [[.1, .2]], [[.2, .4]]);
  const before = JSON.stringify(states);
  assert.match(internals.timelineGradient(states), /#ff8a1f 20% 40%/);
  internals.cfg.showPreheatHighlight = false;
  assert.match(internals.timelineGradient(states), /#b8b8b8 20% 40%/);
  assert.equal(JSON.stringify(states), before);
  assert.match(internals.timelineGradient(states), /transparent 0% 10%/);
});

test("空缓冲、播放结束和异常范围仍产生完整状态", () => {
  const { internals } = loadObserver();
  assert.deepEqual(fromVm(internals.timelineStates(0, [], [])), [{ start: 0, end: 1, state: "empty" }]);
  assert.deepEqual(fromVm(internals.timelineStates(1, [[0, 1]], [[0, 1]])), [{ start: 0, end: 1, state: "played" }]);
  assert.deepEqual(fromVm(internals.timelineStates(0, [[NaN, 1], [.8, .2]], [[-1, 2]])), [{ start: 0, end: 1, state: "plugin" }]);
});

test("观察器只接受六位十六进制高亮颜色", () => {
  const { internals } = loadObserver();
  assert.equal(internals.normalizePreheatColor(" #AABBCC "), "#aabbcc");
  assert.equal(internals.normalizePreheatColor("rgba(0,0,0,0)"), "#ff8a1f");
});

test("追踪参数变化保留预热色段，切换分 P 才清空", () => {
  const { internals, location } = loadObserver();
  internals.trackFor("https://a.bilivideo.com/path/video.m4s");
  location.href = "https://www.bilibili.com/video/BV1test/?vd_source=changed";
  assert.equal(internals.resetTracksAfterNavigation(), false);
  assert.equal(internals.tracks.size, 1);

  location.href = "https://www.bilibili.com/video/BV1test/?p=2";
  assert.equal(internals.resetTracksAfterNavigation(), true);
  assert.equal(internals.tracks.size, 0);
});

test("播放器收到首个 Content-Range 响应头后即可规划预取", () => {
  const { internals } = loadObserver();
  const url = "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s";
  const track = internals.trackFor(url);
  internals.cfg.mode = "always";

  internals.recordMedia({
    url,
    range: { start: 0 },
    contentRange: "bytes 0-1048575/10485760",
    status: 206,
    completed: false
  });

  assert.equal(track.anchor, 1048576);
  assert.equal(track.size, 10485760);
  // 索引尚未解析：先取文件头 64 KiB 找 SIDX。
  assert.deepEqual(fromVm(internals.wantedRanges(track, 0)), [{ start: 0, end: 65536, order: 0 }]);
});

test("关闭时规划器不发任何请求；开启后即使标签页隐藏、播放余量为零也立即规划", async () => {
  const { internals, intervals, document, requests } = loadObserver({ hangFetch: true });
  document.hidden = true;
  const track = internals.trackFor("https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s");
  track.size = 16 * 1024 * 1024;
  internals.planPrefetch();
  assert.equal(internals.network.backgroundPending(), 0);

  internals.cfg.mode = "always";
  const scheduler = intervals.find((interval) => interval.milliseconds === 500);
  assert.ok(scheduler);
  scheduler.callback();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(internals.network.backgroundPending(), 1);
  assert.deepEqual(requests.map((request) => request.range), ["bytes=0-65535"]);
  stop(internals);
});

test("有索引时按 距播放点秒数 交错规划音视频分段，不超过排队深度", () => {
  const { internals, indexes, video } = loadObserver();
  internals.cfg.mode = "always";
  video.currentTime = 10;
  const MB = 1024 * 1024;
  // 视频每段 4 秒 2 MiB，音频每段 4 秒 128 KiB；初始化区都在 1000 字节之前。
  const segments = (size, count) => Array.from({ length: count }, (_, i) => ({ start: 1000 + i * size, end: 1000 + (i + 1) * size, timeStart: i * 4, timeEnd: i * 4 + 4 }));
  const videoTrack = internals.trackFor("https://a.bilivideo.com/v/video.m4s");
  const audioTrack = internals.trackFor("https://a.bilivideo.com/a/audio.m4s");
  indexes.set(videoTrack.url, { role: "video", segments: segments(2 * MB, 100) });
  indexes.set(audioTrack.url, { role: "audio", segments: segments(128 * 1024, 100) });

  const wanted = internals.wantedRanges(videoTrack, 10);
  assert.deepEqual(fromVm(wanted[0]), { start: 0, end: 1000, order: 0 });
  // 当前段 [8,12) 起算、前方 90 秒内（含 96 MiB 字节上限）。
  assert.deepEqual(fromVm(wanted[1]), { start: 1000 + 2 * 2 * MB, end: 1000 + 3 * 2 * MB, order: 0 });
  assert.equal(wanted.length, 1 + 23);
  assert(wanted.at(-1).order < 90);

  internals.planPrefetch();
  const pending = [videoTrack, audioTrack].flatMap((track) => internals.network.inflightRanges(track.url).map((range) => [track === videoTrack ? "v" : "a", ...range]));
  assert.equal(pending.length, 16, "排队深度封顶");
  assert(pending.some(([role]) => role === "a") && pending.some(([role]) => role === "v"), "音视频交错，不会只顾视频");
  stop(internals);
});

test("前方窗口按字节封顶：高码率视频不会把预热塞满整个页面缓存", () => {
  const { internals, indexes } = loadObserver();
  const MB = 1024 * 1024;
  const track = internals.trackFor("https://a.bilivideo.com/v/video.m4s");
  indexes.set(track.url, { role: "video", segments: Array.from({ length: 60 }, (_, i) => ({ start: 1000 + i * 10 * MB, end: 1000 + (i + 1) * 10 * MB, timeStart: i, timeEnd: i + 1 })) });
  const wanted = internals.wantedRanges(track, 0).slice(1);
  const bytes = wanted.reduce((sum, range) => sum + range.end - range.start, 0);
  assert(bytes >= 96 * MB && bytes < 106 * MB, `bytes=${bytes}`);
});

test("切换清晰度后只预热播放器最近使用的同类轨道", () => {
  const { internals, indexes } = loadObserver();
  internals.cfg.mode = "always";
  const segments = [{ start: 1000, end: 2000, timeStart: 0, timeEnd: 4 }];
  const old = internals.trackFor("https://a.bilivideo.com/old/video.m4s");
  const next = internals.trackFor("https://a.bilivideo.com/new/video.m4s");
  indexes.set(old.url, { role: "video", segments });
  indexes.set(next.url, { role: "video", segments });
  internals.planPrefetch();
  assert.deepEqual(fromVm(internals.network.inflightRanges(old.url)), []);
  assert.deepEqual(fromVm(internals.network.inflightRanges(next.url)), [[0, 1000], [1000, 2000]]);
  stop(internals);
});

test("拖动后旧窗口的后台分片被取消，新窗口立即补位", () => {
  const { internals, indexes, video } = loadObserver();
  internals.cfg.mode = "always";
  const KB = 1024;
  const track = internals.trackFor("https://a.bilivideo.com/v/video.m4s");
  indexes.set(track.url, { role: "video", segments: Array.from({ length: 200 }, (_, i) => ({ start: 1000 + i * 512 * KB, end: 1000 + (i + 1) * 512 * KB, timeStart: i, timeEnd: i + 1 })) });
  internals.planPrefetch();
  assert(internals.network.inflightRanges(track.url).every(([start]) => start < 1000 + 20 * 512 * KB));
  video.currentTime = 150;
  internals.planPrefetch();
  const ranges = internals.network.inflightRanges(track.url);
  assert(ranges.some(([start]) => start >= 1000 + 150 * 512 * KB), "新窗口已规划");
  assert(!ranges.some(([start]) => start > 1000 && start < 1000 + 149 * 512 * KB), "旧窗口分片已取消");
  stop(internals);
});

test("估计器护栏只在同 host 热样本充足且刚发生慢请求时清洗", async () => {
  const host = "upos-sz-mirrorcosov.bilivideo.com";
  const estimator = {
    entries: {
      [`XHR|${host}|4g|video`]: {
        samples: [320, 280, 20_000],
        p25Kbps: 280,
        p50Kbps: 320,
        ewmaKbps: 500,
        latencyMs: 4406
      },
      "XHR|unrelated.bilivideo.com|4g|video": {
        samples: [300],
        p25Kbps: 300,
        p50Kbps: 300,
        latencyMs: 4000
      }
    }
  };
  const { internals, localStorage } = loadObserver({
    storage: { bilibili_dash_throughput_lru_v1: JSON.stringify(estimator) }
  });
  internals.cfg.mode = "always";
  const url = `https://${host}/path/video.m4s`;
  for (let index = 0; index < 3; index += 1) {
    internals.recordMedia({
      url,
      range: { start: index * 1024 * 1024 },
      bytes: 1024 * 1024,
      ttfbMs: 20,
      totalMs: 100,
      status: 206,
      completed: true
    });
  }
  internals.recordMedia({
    url,
    range: { start: 4 * 1024 * 1024 },
    bytes: 1024,
    ttfbMs: 1200,
    totalMs: 1300,
    status: 206,
    completed: true
  });
  await Promise.resolve();

  const cleaned = JSON.parse(localStorage.getItem("bilibili_dash_throughput_lru_v1"));
  const entry = cleaned.entries[`XHR|${host}|4g|video`];
  assert.deepEqual(entry.samples, [20_000]);
  assert.equal(entry.p25Kbps, 20_000);
  assert.equal(entry.p50Kbps, 20_000);
  assert.equal(entry.ewmaKbps, 12_000);
  assert.equal(entry.latencyMs, 200);
  assert.deepEqual(cleaned.entries["XHR|unrelated.bilivideo.com|4g|video"], estimator.entries["XHR|unrelated.bilivideo.com|4g|video"]);
});

test('新清晰度未解析/未预热时不借旧轨道的黄色，旧请求晚完成不夺回当前轨', () => {
  const { internals, cacheTimes } = loadObserver();
  const old = internals.trackFor('https://a.bilivideo.com/old-video.m4s'); cacheTimes.set(old.url, [[0, 40]]);
  const audio = internals.trackFor('https://a.bilivideo.com/audio.m4s'); cacheTimes.set(audio.url, [[0, 40]]);
  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), [[0, .4]]);
  const next = internals.trackFor('https://a.bilivideo.com/new-video.m4s');
  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), []);
  cacheTimes.set(next.url, []);
  internals.recordMedia({ url: old.url, range: { start: 0 }, status: 206, completed: true, bytes: 100 });
  assert.equal(internals.chooseCurrentDashPair([...internals.tracks.values()]).video, next);
  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), []);
  cacheTimes.set(next.url, [[20, 30]]);
  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), [[.2, .3]]);
});
test('关闭后重新开启允许重新补齐已清理的初始化区，桥下发的旧策略字段被忽略', () => {
  const { internals, window, eventListeners } = loadObserver({ hangFetch: true });
  const track = internals.trackFor('https://a.bilivideo.com/video.m4s');
  track.size = 2 * 1024 * 1024; track.anchor = 1000; track.failures = 3; track.retryAt = Date.now() + 60000;
  const config = payload => eventListeners.get('message')({ source: window, data: { channel: 'bili-buffer-playback-assist-v1', dir: 'ext->page', type: 'config', payload } });
  config({ mode: 'off' }); config({ mode: 'always', leadSeconds: 5, maxConcurrency: 1 });
  assert.equal(internals.cfg.leadSeconds, 90);
  assert.equal(internals.cfg.maxConcurrency, undefined);
  internals.planPrefetch();
  assert.deepEqual(fromVm(internals.network.inflightRanges(track.url)), [[0, 65536]]);
  stop(internals);
});

function loadObserver({ documentElement = { dataset: {} }, storage = {}, hangFetch = false } = {}) {
  const cacheTimes = new Map(), indexes = new Map(), requests = [];
  const cache = {
    index: url => indexes.get(url) || (cacheTimes.has(url) ? { role: url.includes('audio') ? 'audio' : 'video' } : null),
    timeRanges: url => cacheTimes.get(url) || [],
    clear: () => cacheTimes.clear(), install() {}, ranges: () => [], stats: {}
  };
  const testVideo = { duration: 100, currentTime: 0, paused: true, buffered: { length: 0 }, addEventListener() {} };
  const eventListeners = new Map();
  const observedTargets = [];
  const intervals = [];
  class FakeStorage {
    constructor(initial) {
      this.values = new Map(Object.entries(initial));
    }
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
    setItem(key, value) { this.values.set(String(key), String(value)); }
    removeItem(key) { this.values.delete(String(key)); }
  }
  class FakeXhr {
    addEventListener() {}
    getResponseHeader() { return null; }
  }
  FakeXhr.prototype.open = function () {};
  FakeXhr.prototype.send = function () {};
  FakeXhr.prototype.setRequestHeader = function () {};

  const localStorage = new FakeStorage(storage);
  const document = {
    nodeType: 9,
    documentElement,
    hidden: false,
    addEventListener(type, listener) { eventListeners.set(`document:${type}`, listener); },
    querySelectorAll(selector) { return selector === "video" ? [testVideo] : []; }
  };
  const window = {
    __biliBufferCache: cache,
    Storage: FakeStorage,
    XMLHttpRequest: FakeXhr,
    // hangFetch：记录预热发出的真实 Range 请求并保持挂起，便于观察规划结果。
    fetch: hangFetch
      ? async (url, init) => { requests.push({ url, range: init.headers.Range }); return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })); }
      : async () => { throw new Error("测试不应发出真实请求"); },
    addEventListener(type, listener) { eventListeners.set(type, listener); },
    postMessage() {}
  };
  window.window = window;
  const location = { href: "https://www.bilibili.com/video/BV1test/" };
  const context = vm.createContext({
    window,
    document,
    localStorage,
    location,
    URL,
    Headers,
    AbortController,
    DOMException,
    Blob,
    performance,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval: (callback, milliseconds) => {
      intervals.push({ callback, milliseconds });
      return intervals.length;
    },
    clearInterval: () => {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target, options) { observedTargets.push({ target, options }); }
    }
  });
  vm.runInContext(networkSource, context);
  window.BiliPlaybackNetwork = context.BiliPlaybackNetwork;
  vm.runInContext(source, context, { filename: "playback-observer.js" });
  return {
    internals: window.__biliBufferPlaybackAssistInternals,
    window,
    cacheTimes,
    indexes,
    requests,
    video: testVideo,
    localStorage,
    location,
    observedTargets,
    eventListeners,
    intervals,
    document
  };
}

// 关闭辅助后再清空分片表：配置消息排下的规划会在测试结束后触发，开启状态下会继续发请求、拖住进程。
function stop(internals) {
  internals.cfg.mode = "off";
  internals.network.reset();
}

function fromVm(value) {
  return JSON.parse(JSON.stringify(value));
}
