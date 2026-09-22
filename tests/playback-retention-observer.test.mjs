import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const routesSource = await readFile(new URL('../src/playback-routes.js', import.meta.url), 'utf8');
const networkSource = await readFile(new URL('../src/playback-network.js', import.meta.url), 'utf8');
const cacheSource = await readFile(new URL('../src/playback-cache.js', import.meta.url), 'utf8');
const observerSource = await readFile(new URL('../src/playback-observer.js', import.meta.url), 'utf8');

/**
 * 验证观察器把真实播放位置交给缓存，而不只是在缓存内部单测回收算法。
 * 默认用记录调用的假缓存；realCache 时装载真实缓存做端到端回收验收。
 */
function loadObserver({ realCache = false, currentTime = 0, duration = 100 } = {}) {
  const calls = { retained: new Map(), released: [], cleared: 0 };
  const video = { duration, currentTime, paused: false, buffered: { length: 0 }, addEventListener() {} };
  const eventListeners = new Map();
  const intervals = [];
  const observedTargets = [];
  class FakeStorage {
    getItem() { return null; }
    setItem() {}
    removeItem() {}
  }
  class FakeXhr {
    addEventListener() {}
    getResponseHeader() { return null; }
  }
  FakeXhr.prototype.open = function () {};
  FakeXhr.prototype.send = function () {};
  FakeXhr.prototype.setRequestHeader = function () {};

  const fakeCache = {
    index: () => null,
    timeRanges: () => [],
    ranges: () => [],
    stats: {},
    install() {},
    clear() { calls.cleared += 1; calls.retained.clear(); },
    clearRetention() { calls.retained.clear(); },
    retain(url, hint) { calls.retained.set(url, { ...hint }); },
    release(url) { calls.released.push(url); calls.retained.delete(url); }
  };
  const document = {
    nodeType: 9,
    documentElement: { dataset: {} },
    hidden: false,
    addEventListener(type, listener) { eventListeners.set(`document:${type}`, listener); },
    querySelectorAll(selector) { return selector === 'video' ? [video] : []; }
  };
  const window = {
    __biliBufferCache: realCache ? undefined : fakeCache,
    Storage: FakeStorage,
    XMLHttpRequest: FakeXhr,
    fetch: async () => { throw new Error('测试不应发出真实请求'); },
    addEventListener(type, listener) { eventListeners.set(type, listener); },
    postMessage() {}
  };
  window.window = window;
  const location = { href: 'https://www.bilibili.com/video/BV1test/' };
  const context = vm.createContext({
    window,
    document,
    localStorage: new FakeStorage(),
    location,
    URL,
    Headers,
    Response,
    Request,
    ReadableStream,
    Uint8Array,
    DataView,
    ArrayBuffer,
    Blob,
    DOMException,
    AbortController,
    performance,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval: (callback, milliseconds) => { intervals.push({ callback, milliseconds }); return intervals.length; },
    clearInterval: () => {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target, options) { observedTargets.push({ target, options }); }
    }
  });
  vm.runInContext(routesSource, context);
  vm.runInContext(networkSource, context);
  window.BiliPlaybackNetwork = context.BiliPlaybackNetwork;
  if (realCache) vm.runInContext(cacheSource, context);
  vm.runInContext(observerSource, context, { filename: 'playback-observer.js' });
  return {
    internals: window.__biliBufferPlaybackAssistInternals,
    cache: window.__biliBufferCache,
    window,
    video,
    calls,
    intervals,
    location,
    observedTargets
  };
}

function segmentIndex({ sizes, durations, earliest = 0, firstOffset = 0, timescale = 1000 } = {}) {
  const bytes = new Uint8Array(32 + sizes.length * 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes.set([115, 105, 100, 120], 4);
  bytes[8] = 0;
  view.setUint32(12, 1);
  view.setUint32(16, timescale);
  view.setUint32(20, earliest);
  view.setUint32(24, firstOffset);
  view.setUint16(30, sizes.length);
  let p = 32;
  sizes.forEach((size, i) => {
    view.setUint32(p, size);
    view.setUint32(p + 4, durations[i]);
    view.setUint32(p + 8, 0x90000000);
    p += 12;
  });
  return bytes;
}

const fromVm = (value) => JSON.parse(JSON.stringify(value));
test('关闭辅助后的反复渲染不会重建旧轨道保护',()=>{
 const {internals,calls}=loadObserver();internals.cfg.mode='always';
 internals.trackFor('https://a.bilivideo.com/video.m4s');internals.renderPreheatProgress();assert.equal(calls.retained.size,1);
 internals.cfg.mode='original';for(let i=0;i<10;i++)internals.renderPreheatProgress();assert.equal(calls.retained.size,0);
});

test('观察器按当前播放位置刷新保留提示，并释放失活轨道', () => {
  const { internals, calls } = loadObserver({ currentTime: 12, duration: 100 });
  internals.cfg.mode = 'always';
  const old = internals.trackFor('https://a.bilivideo.com/video.m4s?token=old');
  const active = internals.trackFor('https://b.bilivideo.com/video.m4s?token=new');
  const audio = internals.trackFor('https://a.bilivideo.com/audio.m4s');

  internals.renderPreheatProgress();

  const expected = { active: true, position: 12, ahead: 45, rewind: 5, duration: 100, protectInit: true };
  assert.deepEqual(calls.retained.get(active.url), expected);
  assert.deepEqual(calls.retained.get(audio.url), expected);
  assert.equal(calls.retained.has(old.url), false);
  assert.ok(calls.released.includes(old.url));
});

test('拖动后保留提示跟随新的播放位置', () => {
  const { internals, video, calls } = loadObserver({ currentTime: 5, duration: 200 });
  internals.cfg.mode = 'always';
  const track = internals.trackFor('https://a.bilivideo.com/video.m4s');

  internals.renderPreheatProgress();
  assert.equal(calls.retained.get(track.url).position, 5);

  video.currentTime = 150;
  internals.renderPreheatProgress();
  assert.equal(calls.retained.get(track.url).position, 150);
});

test('切换清晰度后旧轨道的保留提示被释放', () => {
  const { internals, calls } = loadObserver();
  internals.cfg.mode = 'always';
  const first = internals.trackFor('https://a.bilivideo.com/video.m4s?token=1');
  internals.renderPreheatProgress();
  assert.ok(calls.retained.has(first.url));

  // 同一 path 但不同 CDN host 会创建新轨道并把旧轨道标记为失活。
  const second = internals.trackFor('https://b.bilivideo.com/video.m4s?token=2');
  internals.renderPreheatProgress();
  assert.equal(calls.retained.has(first.url), false);
  assert.ok(calls.retained.has(second.url));
});

test('切换分 P 时清空保留状态', () => {
  const { internals, calls, location } = loadObserver();
  internals.cfg.mode = 'always';
  internals.trackFor('https://a.bilivideo.com/video.m4s');
  internals.renderPreheatProgress();
  assert.equal(calls.retained.size, 1);

  location.href = 'https://www.bilibili.com/video/BV1test/?p=2';
  assert.equal(internals.resetTracksAfterNavigation(), true);
  assert.equal(calls.retained.size, 0);
  assert.ok(calls.cleared >= 1);
});

test('400ms 调度独立刷新保留提示', () => {
  const { internals, calls, intervals, video } = loadObserver({ currentTime: 30, duration: 100 });
  internals.cfg.mode = 'always';
  const track = internals.trackFor('https://a.bilivideo.com/video.m4s');
  video.currentTime = 33;

  const scheduler = intervals.find(item => item.milliseconds === 400);
  assert.ok(scheduler);
  scheduler.callback();
  assert.equal(calls.retained.get(track.url)?.position, 33);
});

test('真实缓存按观察器提示回收，保留初始化与当前窗口', () => {
  const { internals, cache, video } = loadObserver({ realCache: true, currentTime: 25, duration: 40 });
  internals.cfg.mode = 'always';
  internals.cfg.leadSeconds = 6;
  video.currentTime = 25;

  const url = 'https://a.bilivideo.com/video.m4s';
  const index = segmentIndex({ sizes: [100, 100, 100, 100], durations: [10000, 10000, 10000, 10000] });
  const first = index.length;
  const total = first + 400;
  cache.setLimit(1024 * 1024);
  cache.put(url, 0, index, total);
  for (let i = 0; i < 4; i += 1) cache.put(url, first + i * 100, new Uint8Array(100), total);
  assert.equal(cache.stats.bytes, total);

  internals.trackFor(url);
  internals.renderPreheatProgress();

  // 提示 position=25 / ahead=6 / rewind=5 已进入真实缓存；收紧后只保留初始化与 [20,40)s 窗口。
  cache.setLimit(300);
  assert.ok(cache.stats.bytes <= 300, `bytes=${cache.stats.bytes}`);
  assert.deepEqual(fromVm(cache.ranges(url)), [[0, first], [first + 200, total]]);
});
