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

test("只有音视频轨都预热的交集才标为提前加载", () => {
  const { internals, cacheTimes } = loadObserver();
  const video = internals.trackFor("https://a.bilivideo.com/path/video.m4s");
  video.size = 1000;
  cacheTimes.set(video.url, [[10, 30]]);
  const audio = internals.trackFor("https://a.bilivideo.com/path/audio.m4s");
  audio.size = 100;
  cacheTimes.set(audio.url, [[20, 40]]);

  assert.deepEqual(fromVm(internals.normalizedPrefetchedRanges()), [[0.2, 0.3]]);
});

test("只预热 DASH 单轨时不标为提前加载", () => {
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


test("按真实时间区间绘制实色缓冲并保留缺口", () => {
  const { internals } = loadObserver();
  assert.equal(internals.timelineGradient([[0, .25], [.5, .75]], "gray"),
    "linear-gradient(to right, gray 0%, gray 25%, transparent 25%, transparent 50%, gray 50%, gray 75%, transparent 75%, transparent 100%)");
});

test("空缓冲和全程缓冲都生成有效的 CSS 渐变", () => {
  const { internals } = loadObserver();
  assert.equal(internals.timelineGradient([], "gray"), "linear-gradient(to right, transparent 0%, transparent 100%)");
  assert.equal(internals.timelineGradient([[0, 1]], "gray"), "linear-gradient(to right, gray 0%, gray 100%)");
});

test("当前位置离下一段再近，统计也不跨过播放器缓冲和预取缓冲的缺口", () => {
  const { internals, cacheTimes, video } = loadObserver();
  const image = internals.trackFor("https://a.bilivideo.com/path/video.m4s");
  const audio = internals.trackFor("https://a.bilivideo.com/path/audio.m4s");
  cacheTimes.set(image.url, [[10.05, 30]]);
  cacheTimes.set(audio.url, [[10.05, 30]]);
  video.buffered = { length: 2, start: index => [0, 10.06][index], end: index => [10, 20][index] };
  video.currentTime = 10.02;
  assert.equal(internals.publicStats().bufferAheadSec, 0);
  assert.equal(internals.publicStats().prefetchAheadSec, 0);
  video.currentTime = 11;
  assert.equal(internals.publicStats().bufferAheadSec, 9);
  assert.equal(internals.publicStats().prefetchAheadSec, 19);
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

test("关闭或隐藏且暂停时不抢带宽，隐藏标签仍在播放时补上启动余量", async () => {
  const { internals, intervals, document, requests, video } = loadObserver({ hangFetch: true });
  document.hidden = true;
  const track = internals.trackFor("https://upos-sz-mirrorcosov.bilivideo.com/path/video.m4s");
  track.size = 16 * 1024 * 1024;
  internals.planPrefetch();
  assert.equal(internals.network.backgroundPending(), 0);

  internals.cfg.mode = "always";
  const scheduler = intervals.find((interval) => interval.milliseconds === 500);
  assert.ok(scheduler);
  scheduler.callback();
  assert.equal(internals.network.backgroundPending(), 0);
  video.paused = false;
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
  video.paused = false;
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
  assert(pending.length <= 16, "排队深度封顶");
  assert(pending.some(([role]) => role === "a") && pending.some(([role]) => role === "v"), "音视频交错，不会只顾视频");
  stop(internals);
});

test("播放器额外目标按音视频共同的连续覆盖和完整分片字节限制", () => {
  const { internals } = loadObserver();
  const MB = 1024 * 1024;
  const segments = bytes => Array.from({ length: 10 }, (_, i) =>
    ({ start: i * bytes, end: (i + 1) * bytes, timeStart: i * 5, timeEnd: (i + 1) * 5 }));
  const video = { ranges: [[28, 50]], segments: segments(MB) };
  const audio = { ranges: [[29, 44]], segments: segments(64 * 1024) };
  assert.equal(internals.residentPlayerBufferEnd(30, 32, [video, audio]), 42);
  assert.equal(internals.residentPlayerBufferEnd(30, 32, [video, { ...audio, ranges: [[29, 35], [36, 44]] }]), 35);
  assert.equal(internals.residentPlayerBufferEnd(30, 32, [video, { ...audio, ranges: [[32, 44]] }]), 30);
  assert.equal(internals.residentPlayerBufferEnd(30, 30, [{ ...video, segments: segments(12 * MB) }, audio]), 35);
  // 站点原先的目标到 28 秒，正常就需要追加 [25,30)。只消耗 [30,35) 的额外预算。
  assert.equal(internals.residentPlayerBufferEnd(30, 28, [{ ...video, segments: segments(12 * MB) }, audio]), 35);
});

test("只提高当前播放器的同一组音视频目标，回退时尊重站点改过的设置", () => {
  const { internals, indexes, cacheTimes, video, window } = loadObserver();
  internals.cfg.mode = "always";
  video.paused = false;
  video.readyState = 4;
  video.currentTime = 10;
  video.buffered = { length: 1, start: () => 0, end: () => 30 };
  const keys = ["StableBufferTime", "BufferTimeAtTopQuality", "BufferTimeAtTopQualityLongForm"];
  const original = Object.fromEntries(keys.map(key => [key, 20]));
  const settings = { ...original };
  const adapter = {};
  for (const key of keys) {
    adapter[`get${key}`] = () => settings[key];
    adapter[`set${key}`] = value => { settings[key] = value; };
  }
  const urls = {};
  for (const role of ["video", "audio"]) {
    const url = urls[role] = `https://a.bilivideo.com/path/${role}.m4s`;
    internals.trackFor(url);
    indexes.set(url, { role, segments: Array.from({ length: 9 }, (_, i) =>
      ({ start: i * 1000, end: (i + 1) * 1000, timeStart: i * 5, timeEnd: (i + 1) * 5 })) });
    cacheTimes.set(url, [[0, 36]]);
  }
  const dash = { video, getCorePlayer: () => adapter, getCurrentPlayURLFor: role => urls[role] };
  window.player = { __core: () => dash };

  internals.updatePlayerBufferTarget();
  assert.deepEqual(Object.values(settings), [25, 25, 25]);
  settings.StableBufferTime = 23;
  internals.updatePlayerBufferTarget();
  assert.deepEqual(Object.values(settings), [23, 20, 20]);
  internals.updatePlayerBufferTarget();
  assert.deepEqual(Object.values(settings), [25, 25, 25]);
  const newVideo = internals.trackFor("https://a.bilivideo.com/path/new-video.m4s");
  indexes.set(newVideo.url, { ...indexes.get(urls.video) });
  internals.updatePlayerBufferTarget();
  assert.deepEqual(Object.values(settings), [23, 20, 20]);
  internals.updatePlayerBufferTarget();
  assert.deepEqual(Object.values(settings), [23, 20, 20]);
  urls.video = newVideo.url;
  cacheTimes.set(urls.video, [[0, 36]]);
  internals.updatePlayerBufferTarget();
  assert.deepEqual(Object.values(settings), [25, 25, 25]);
  video.seeking = true;
  internals.updatePlayerBufferTarget();
  assert.deepEqual(Object.values(settings), [23, 20, 20]);
});

test("自适应预热跳过播放器已有的 20 秒，余量用完后再补近端", () => {
  const { internals, indexes, video } = loadObserver({ hangFetch: true });
  const url = "https://a.bilivideo.com/path/video.m4s";
  const track = internals.trackFor(url);
  const size = 1024;
  indexes.set(url, { role: "video", segments: Array.from({ length: 25 }, (_, index) => ({
    start: 1024 + index * size, end: 1024 + (index + 1) * size, timeStart: index * 4, timeEnd: index * 4 + 4
  })) });
  internals.cfg.mode = "always";
  video.paused = false;
  video.readyState = 4;
  video.buffered = { length: 1, start: () => 0, end: () => 20 };
  try {
    internals.planPrefetch();
    assert(internals.network.inflightRanges(track.url).every(([start, end]) => start >= 6 * size || end <= 1024),
      "规划重复下载已经能播放的正文");
    video.currentTime = 17;
    internals.planPrefetch();
    assert(internals.network.inflightRanges(track.url).some(([start]) => start === 6 * size), "余量下降后应补 20 秒处的第一个缺口");
  } finally { stop(internals); }
});

test("大视频段用满一批分片前，给同一时刻的音频留名额", () => {
  const { internals, indexes, video } = loadObserver({ hangFetch: true });
  internals.cfg.mode = "always";
  video.paused = false;
  const tracks = ["video", "audio"].map(role => {
    const url = "https://a.bilivideo.com/path/" + role + ".m4s";
    const bytes = role === "video" ? 10 * 1024 ** 2 : 1024;
    indexes.set(url, { role, segments: [{ start: 1024, end: 1024 + bytes, timeStart: 0, timeEnd: 4 }] });
    return internals.trackFor(url);
  });
  try {
    internals.planPrefetch();
    assert(internals.network.inflightRanges(tracks[1].url).some(([, end]) => end > 1024),
      "视频的首段不能吃完队列，导致没有音频正文");
  } finally { stop(internals); }
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
  video.duration = 200;
  const KB = 1024;
  const track = internals.trackFor("https://a.bilivideo.com/v/video.m4s");
  indexes.set(track.url, { role: "video", segments: Array.from({ length: 200 }, (_, i) => ({ start: 1000 + i * 512 * KB, end: 1000 + (i + 1) * 512 * KB, timeStart: i, timeEnd: i + 1 })) });
  internals.planPrefetch();
  assert(internals.network.inflightRanges(track.url).every(([start]) => start < 1000 + 20 * 512 * KB));
  video.currentTime = 150;
  video.seeking = true;
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

function loadObserver({ documentElement = { dataset: {} }, storage = {}, hangFetch = false, committed } = {}) {
  const cacheTimes = new Map(), indexes = new Map(), requests = [];
  const cache = {
    index: url => indexes.get(url) || (cacheTimes.has(url) ? { role: url.includes('audio') ? 'audio' : 'video' } : null),
    timeRanges: url => cacheTimes.get(url) || [],
    clear: () => cacheTimes.clear(), install() {}, ranges: () => [], stats: {}
  };
  const eventListeners = new Map();
  const testVideo = {
    duration: 100, currentTime: 0, paused: true, buffered: { length: 0 },
    addEventListener(type, listener) { eventListeners.set(`video:${type}`, listener); }
  };
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
    AbortSignal,
    DOMException,
    Blob,
    performance,
    BiliPlaybackReuse: committed && { createCommittedClient: () => committed },
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

test("橙点区跳转只为已接到同一跳转且空闲的原生音轨准备正文", async () => {
  const committed = { hasSources: () => true, find: () => ({ end: 1000, total: 1000 }), revision: () => 0 };
  const { internals, indexes, video, window } = loadObserver({ committed });
  internals.cfg.mode = "always";
  video.currentTime = 16;
  video.seeking = true;
  const urls = {};
  for (const role of ["video", "audio"]) {
    const url = urls[role] = `https://cdn.bilivideo.com/${role}.m4s`;
    internals.trackFor(url);
    indexes.set(url, { role, segments: [{ start: 5, end: 1000, timeStart: 10, timeEnd: 20 }] });
  }
  let reads = 0, submitted = 0, pruning = true, seekingTo = 16, cursor = 2;
  committed.read = async () => { reads++; return { body: new Uint8Array(995), total: 1000 }; };
  window.__biliBufferCache.put = () => true;
  const representation = {};
  const stream = { getProcessors: () => [processor] };
  const processor = {
    getType: () => "audio",
    getBufferController: () => ({
      getBuffer: () => ({ getBuffer: () => ({ buffered: { length: 0 } }) }),
      getIsPruningInProgress: () => pruning
    }),
    getFragmentModel: () => ({ getLoadingRequests: () => [], isFragmentLoadedOrPending: () => false,
      executeRequest: () => { assert.equal(cursor, 2); submitted++; } }),
    getScheduleController: () => ({ getSeekTarget: () => seekingTo, isStarted: () => true }),
    getRepresentationController: () => ({ getCurrentRepresentation: () => representation }),
    getIndexHandler: () => ({
      getIndex: () => cursor,
      setIndex: index => { cursor = index; },
      getSegmentRequestForTime: () => { cursor = 8; return { action: "download", mediaType: "audio", range: "5-999", url: urls.audio }; }
    })
  };
  const core = {
    video, getCurrentPlayURLFor: role => urls[role],
    getCorePlayer: () => ({ getActiveStream: () => stream })
  };
  window.player = { __core: () => core };
  const signal = new AbortController().signal;
  await internals.prepareSeekTrack({ video, target: 16, signal }, "audio");
  assert.equal(reads, 0, "等原播放器完成清理再准备缺段");
  pruning = false;
  seekingTo = 18;
  await internals.prepareSeekTrack({ video, target: 16, signal }, "audio");
  assert.equal(reads, 0, "不能重启站点正在处理的新跳转");
  seekingTo = 16;
  await internals.prepareSeekTrack({ video, target: 16, signal }, "audio");
  assert.deepEqual([reads, submitted], [1, 1], "只把已备好的音段交给原播放器");
  video.currentTime = 21;
  seekingTo = 21;
  await internals.prepareSeekTrack({ video, target: 21, signal }, "audio");
  assert.deepEqual([reads, submitted], [1, 1], "没有落盘的区间保留站点调度");
  const canceled = new AbortController();
  video.currentTime = seekingTo = 16;
  committed.read = async () => { canceled.abort(); return { body: new Uint8Array(995), total: 1000 }; };
  await internals.prepareSeekTrack({ video, target: 16, signal: canceled.signal }, "audio");
  assert.equal(submitted, 1, "旧跳转取消后迟到的分块不能再提交");
});

test("橙点区跳转时只提前交付正文完整驻留的原生画段", { timeout: 1000 }, async () => {
  let reads = 0, submitted = 0, residentEnd = 499;
  const committed = {
    hasSources: () => true, find: () => ({ end: 1000, total: 1000 }), revision: () => 0,
    async read() { reads++; return null; }
  };
  const { internals, indexes, video, window, eventListeners } = loadObserver({ committed });
  internals.cfg.mode = "always";
  video.currentTime = 16;
  video.seeking = true;
  const urlFor = role => `https://cdn.bilivideo.com/${role}.m4s`;
  for (const role of ["video", "audio"]) {
    internals.trackFor(urlFor(role));
    indexes.set(urlFor(role), { role, segments: [{ start: 5, end: 1000, timeStart: 10, timeEnd: 20 }] });
  }
  window.__biliBufferCache.ranges = url => url === urlFor("video") ? [[5, residentEnd]] : [];
  const buffer = { buffered: { length: 0 } };
  const representation = {};
  const request = { action: "download", mediaType: "video", range: "5-999", url: urlFor("video") };
  const processor = {
    getType: () => "video",
    getBufferController: () => ({ getBuffer: () => ({ getBuffer: () => buffer }), getIsPruningInProgress: () => false }),
    getFragmentModel: () => ({ getLoadingRequests: () => [], isFragmentLoadedOrPending: () => false,
      executeRequest: value => { assert.equal(value, request); submitted++; } }),
    getScheduleController: () => ({ getSeekTarget: () => 16, isStarted: () => true }),
    getRepresentationController: () => ({ getCurrentRepresentation: () => representation }),
    getIndexHandler: () => ({ getIndex: () => 0, getSegmentRequestForTime: () => request })
  };
  const stream = { getProcessors: () => [processor] };
  const core = { video, getCurrentPlayURLFor: urlFor, getCorePlayer: () => ({ getActiveStream: () => stream }) };
  window.player = { __core: () => core };

  const seek = async () => {
    eventListeners.get("video:seeking")();
    await new Promise(resolve => setTimeout(resolve, 90));
  };
  await seek();
  assert.deepEqual([reads, submitted], [0, 0], "点选时缺视频正文交给原播放器调度");
  residentEnd = 1000;
  await seek();
  assert.deepEqual([reads, submitted], [0, 1], "有完整正文时跳过画轨轮询且不增加读盘");
  eventListeners.get("video:seeked")();
});

test("悬停橙点时依次准备音轨和画轨，预读逐片让行并使用空闲缓存空间", { timeout: 1800 }, async () => {
  const MiB = 1024 * 1024, options = [], reads = [];
  const descriptor = role => ({ id: "test", createdAt: 1, runStartedAt: 1,
    end: role === "audio" ? 1000 : 5 * MiB, total: 6 * MiB });
  const committed = {
    hasSources: () => true,
    revision: () => 0,
    find: (url, _total, role) => descriptor(role),
    async read(source, url, start, end, _signal, speculative) {
      reads.push([url.split("/").at(-1), start, end, speculative]);
      return { body: new Uint8Array(end - start), total: source.total };
    }
  };
  const { internals, indexes, video, window, eventListeners } = loadObserver({ committed });
  internals.cfg.mode = "always";
  video.paused = false;
  video.readyState = 4;
  video.currentTime = 30;
  video.buffered = { length: 1, start: () => 28, end: () => 45 };
  const urls = {};
  for (const role of ["video", "audio"]) {
    const url = urls[role] = `https://cdn.bilivideo.com/${role}.m4s`;
    internals.trackFor(url);
    indexes.set(url, { role, segments: [{ start: 0, end: descriptor(role).end, timeStart: 10, timeEnd: 20 }] });
  }
  const core = { video, getCurrentPlayURLFor: role => urls[role] };
  window.player = { __core: () => core };
  const root = { closest: () => null, querySelectorAll: () => [schedule] };
  const schedule = { isConnected: true, closest: () => root, getBoundingClientRect: () => ({ left: 0, right: 100, width: 100 }) };
  window.__biliBufferCache.freeBytes = () => 8 * MiB;
  const finished = new Promise(resolve => {
    window.__biliBufferCache.put = (_url, _start, _body, _total, opts) => {
      options.push(opts.allowEviction);
      if (options.length === 3) resolve();
      return true;
    };
  });
  eventListeners.get("document:pointermove")({
    target: { closest: () => schedule }, buttons: 0, pointerType: "mouse", clientX: 16
  });
  await finished;
  assert.deepEqual(reads, [
    ["audio.m4s", 0, 1000, true],
    ["video.m4s", 0, 4 * MiB, true],
    ["video.m4s", 4 * MiB, 5 * MiB, true]
  ]);
  assert.deepEqual(options, [false, false, false]);
});

// 关闭辅助后再清空分片表：配置消息排下的规划会在测试结束后触发，开启状态下会继续发请求、拖住进程。
function stop(internals) {
  internals.cfg.mode = "off";
  internals.network.reset();
}

function fromVm(value) {
  return JSON.parse(JSON.stringify(value));
}

test('无 SIDX 且时长为小数时，码率估算仍只发整数 Range', async () => {
  const {internals,window,video,requests}=loadObserver({hangFetch:true});
  const MiB=1024*1024,url='https://a.bilivideo.com/progressive.mp4';
  window.__biliBufferCache.ranges=()=>[[0,MiB]];
  video.duration=431.7;
  const track=internals.trackFor(url);track.size=10*MiB;track.anchor=MiB;
  internals.cfg.mode='always';
  try{
    internals.planPrefetch();await new Promise(r=>setTimeout(r,5));
    assert(requests.length>0);
    assert(requests.every(r=>/^bytes=\d+-\d+$/.test(r.range)),JSON.stringify(requests));
  }finally{stop(internals);}
});
