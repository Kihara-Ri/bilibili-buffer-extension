import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

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
  const { internals } = loadObserver();
  const video = internals.trackFor("https://a.bilivideo.com/path/video.m4s");
  video.size = 1000;
  internals.addRange(video.prefetchedRanges, 100, 300);
  const audio = internals.trackFor("https://a.bilivideo.com/path/audio.m4s");
  audio.size = 100;
  internals.addRange(audio.prefetchedRanges, 20, 40);

  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), [[0.2, 0.3]]);
});

test("只预热 DASH 单轨时不显示可能误导的实心高亮", () => {
  const { internals } = loadObserver();
  const video = internals.trackFor("https://a.bilivideo.com/path/video.m4s");
  video.size = 1000;
  internals.addRange(video.prefetchedRanges, 100, 300);

  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), []);
});

test("单文件 MP4 预热仍可直接映射进度条", () => {
  const { internals } = loadObserver();
  const media = internals.trackFor("https://a.bilivideo.com/path/video.mp4");
  media.size = 1000;
  internals.addRange(media.prefetchedRanges, 100, 300);

  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), [[0.1, 0.3]]);
});

test("播放边缘只有接入预热片段时才显示白色分界", () => {
  const { internals } = loadObserver();
  const ranges = [[0.2, 0.3], [0.5, 0.7]];

  assert.equal(internals.isPlaybackBoundaryConnected(ranges, 0.25), true);
  assert.equal(internals.isPlaybackBoundaryConnected(ranges, 0.1985), true);
  assert.equal(internals.isPlaybackBoundaryConnected(ranges, 0.4), false);
  assert.equal(internals.isPlaybackBoundaryConnected(ranges, null), false);
});

test("多分段进度条按各段宽度建立唯一的全片时间区间", () => {
  const { internals } = loadObserver();
  const segments = fromVm(internals.buildTimelineSegments([30, 40, 30]));

  assert.deepEqual(segments, [
    { start: 0, end: 0.3, index: 0, count: 3 },
    { start: 0.3, end: 0.7, index: 1, count: 3 },
    { start: 0.7, end: 1, index: 2, count: 3 }
  ]);
});

test("全片预热范围只投影到实际相交的子进度段", () => {
  const { internals } = loadObserver();
  const ranges = [[0.2, 0.3], [0.5, 0.7]];
  const first = fromVm(internals.projectRangesToTimelineSegment(ranges, 0, 0.3));
  const second = fromVm(internals.projectRangesToTimelineSegment(ranges, 0.3, 0.7));

  assert.equal(first.length, 1);
  assert.ok(Math.abs(first[0][0] - 2 / 3) < 1e-12);
  assert.equal(first[0][1], 1);
  assert.equal(second.length, 1);
  assert.ok(Math.abs(second[0][0] - 0.5) < 1e-12);
  assert.equal(second[0][1], 1);
  assert.deepEqual(fromVm(internals.projectRangesToTimelineSegment(ranges, 0.7, 1)), []);
});

test("播放标记只换算到当前播放位置所属的子进度段", () => {
  const { internals } = loadObserver();

  assert.equal(internals.projectPlaybackRatioToTimelineSegment(0.25, 0, 0.3), 5 / 6);
  assert.equal(internals.projectPlaybackRatioToTimelineSegment(0.25, 0.3, 0.7), null);
  assert.equal(internals.projectPlaybackRatioToTimelineSegment(0.3, 0, 0.3), null);
  assert.equal(internals.projectPlaybackRatioToTimelineSegment(0.3, 0.3, 0.7), 0);
  assert.equal(internals.projectPlaybackRatioToTimelineSegment(1, 0.7, 1, true), 1);
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

test("配置确认开启后不等待播放时长或慢请求，关闭仍立即阻止预取", () => {
  const { internals } = loadObserver();
  const url = "https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s";
  const track = internals.trackFor(url);
  track.anchor = 1024;
  assert.equal(internals.shouldPrefetch(track), false);
  internals.cfg.mode = "always";
  assert.equal(internals.shouldPrefetch(track), true);
  assert.equal(track.cold, false);
  assert.equal(internals.stats.playedSec, 0);
  internals.cfg.mode = "off";
  assert.equal(internals.shouldPrefetch(track), false);
  internals.cfg.mode = "always";
  track.cooldownUntil = Date.now() + 1000;
  assert.equal(internals.shouldPrefetch(track), false);
  track.cooldownUntil = 0;
  track.prefetchDisabled = true;
  assert.equal(internals.shouldPrefetch(track), false);
});

test("播放器收到首个 Content-Range 响应头后即可预取下一段", () => {
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
  assert.equal(internals.shouldPrefetch(track), true);
});

test("开启调度不再因标签页隐藏或初始播放余量为零而暂停", async () => {
  const { internals, intervals, document } = loadObserver();
  document.hidden = true;
  internals.cfg.mode = "always";
  const track = internals.trackFor("https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s");
  track.anchor = 1024;
  track.size = 16 * 1024 * 1024;

  const scheduler = intervals.find((interval) => interval.milliseconds === 400);
  assert.ok(scheduler);
  scheduler.callback();
  assert.equal(internals.stats.prefetching, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(internals.stats.prefetching, 0);
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

function loadObserver({ documentElement = { dataset: {} }, storage = {} } = {}) {
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
    querySelectorAll() { return []; }
  };
  const window = {
    Storage: FakeStorage,
    XMLHttpRequest: FakeXhr,
    fetch: async () => { throw new Error("测试不应发出真实请求"); },
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
  vm.runInContext(source, context, { filename: "playback-observer.js" });
  return {
    internals: window.__biliBufferPlaybackAssistInternals,
    localStorage,
    location,
    observedTargets,
    eventListeners,
    intervals,
    document
  };
}

function fromVm(value) {
  return JSON.parse(JSON.stringify(value));
}
