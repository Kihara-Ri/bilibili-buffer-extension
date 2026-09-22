import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCache } from './playback-cache-helpers.mjs';

/**
 * 播放位置感知回收的纯逻辑验收：只依赖缓存模块，不启动浏览器。
 * SIDX 构造器与 playback-cache.test.mjs 保持一致，但单独保留一份，
 * 避免测试文件互相 import 时把对方的用例重复注册进当前进程。
 */
const MEDIA = 'https://a.bilivideo.com/video.m4s';
const STALE = 'https://a.bilivideo.com/stale.m4s';
// vm 上下文里的数组与宿主的 Array 原型不同，深比较前统一转成宿主值。
const fromVm = (value) => JSON.parse(JSON.stringify(value));

function segmentIndex({ sizes, durations, earliest = 0, firstOffset = 0, timescale = 1000 } = {}) {
  const bytes = new Uint8Array(32 + sizes.length * 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes.set([115, 105, 100, 120], 4); // "sidx"
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

/** 写入一个「初始化 + N 个等长分段」的完整轨道，返回各段字节起点。 */
function seedTrack(cache, url, { count = 4, size = 100, seconds = 10 } = {}) {
  const index = segmentIndex({ sizes: Array(count).fill(size), durations: Array(count).fill(seconds * 1000) });
  const first = index.length; // firstOffset = 0 时首段紧随索引盒尾。
  const total = first + count * size;
  cache.put(url, 0, index, total);
  const starts = [];
  for (let i = 0; i < count; i += 1) {
    const start = first + i * size;
    starts.push(start);
    cache.put(url, start, new Uint8Array(size).fill(i + 1), total);
  }
  return { index, first, total, starts };
}

test('活动轨道保留初始化与临近播放窗口，非活动资源先回收', () => {
  const cache = loadCache();
  cache.setLimit(1024 * 1024);
  const active = seedTrack(cache, MEDIA);
  const stale = seedTrack(cache, STALE);
  assert.equal(cache.stats.bytes, active.total + stale.total);

  // 播放位置 25s，前方 6s、回看 5s → 只保护初始化区与第 3/4 段。
  cache.retain(MEDIA, { active: true, position: 25, ahead: 6, rewind: 5, duration: 40 });
  cache.setLimit(active.total); // 恰好只放得下活动轨道

  assert.equal(cache.stats.bytes, active.total);
  assert.deepEqual(fromVm(cache.ranges(STALE)), []);
  assert.deepEqual(fromVm(cache.ranges(MEDIA)), [[0, active.total]]);
});

test('远离窗口的活动数据先于窗口数据被回收', () => {
  const cache = loadCache();
  cache.setLimit(1024 * 1024);
  const active = seedTrack(cache, MEDIA);
  cache.retain(MEDIA, { active: true, position: 25, ahead: 6, rewind: 5, duration: 40 });

  cache.setLimit(300); // 需要腾出 180 字节
  assert.ok(cache.stats.bytes <= 300);
  // 初始化区与窗口内的后两段仍在；窗口外的前两段被回收。
  assert.deepEqual(fromVm(cache.ranges(MEDIA)), [[0, active.first], [active.first + 200, active.total]]);
});

test('整池都处于保护区时仍满足硬上限', () => {
  const cache = loadCache();
  cache.setLimit(1024 * 1024);
  const active = seedTrack(cache, MEDIA);
  // 窗口覆盖整条轨道，所有块都被保护。
  cache.retain(MEDIA, { active: true, position: 5, ahead: 60, rewind: 60, duration: 40 });
  const before = cache.stats.evictions;

  cache.setLimit(150);
  assert.ok(cache.stats.bytes <= 150, `bytes=${cache.stats.bytes}`);
  assert.ok(cache.stats.evictions > before);
  assert.ok(cache.ranges(MEDIA).length > 0, '保护只影响顺序，不应把缓存整体清空到违反下限');
});

test('无 SIDX 时按总大小/时长比例回退保护当前窗口', () => {
  const cache = loadCache();
  const total = 4 * 1024 * 1024;
  const block = 256 * 1024;
  cache.setLimit(total);
  // 全零数据无法解析为 SIDX，index 必须保持为空，从而走字节比例回退。
  for (let offset = 0; offset < total; offset += block) cache.put(MEDIA, offset, new Uint8Array(block), total);
  assert.equal(cache.index(MEDIA), null);
  assert.equal(cache.stats.bytes, total);

  cache.retain(MEDIA, { active: true, position: 50, ahead: 10, rewind: 5, duration: 100 });
  cache.setLimit(total - 1); // 只需要回收一个块，验证选择顺序
  assert.ok(cache.stats.bytes <= total - 1);

  const resident = cache.ranges(MEDIA);
  assert.ok(resident.some(([start]) => start === 0), '初始化区仍应在驻留集合中');
  assert.ok(resident.some(([start, end]) => start <= 2 * 1024 * 1024 && end >= 2.25 * 1024 * 1024), '当前窗口内的块仍应驻留');
  assert.equal(resident.some(([start]) => start === total - block), false, '最远的尾部块应先被回收');
});

test('同级候选按插入顺序回收，结果确定可复现', () => {
  const run = () => {
    const cache = loadCache();
    cache.setLimit(20);
    cache.put(MEDIA, 0, new Uint8Array(10), 30);
    cache.put(MEDIA, 10, new Uint8Array(10), 30);
    cache.put(MEDIA, 20, new Uint8Array(10), 30);
    return fromVm(cache.ranges(MEDIA));
  };
  assert.deepEqual(run(), [[10, 30]]);
  assert.deepEqual(run(), [[10, 30]]);
});

test('release 取消单个资源的保留提示', () => {
  const cache = loadCache();
  cache.setLimit(1024 * 1024);
  const active = seedTrack(cache, MEDIA);
  cache.retain(MEDIA, { active: true, position: 25, ahead: 6, rewind: 5, duration: 40 });
  cache.release(MEDIA);

  cache.setLimit(300);
  // 没有保留提示时按插入顺序回收：先初始化区，再首段。
  assert.deepEqual(fromVm(cache.ranges(MEDIA)), [[active.first + 100, active.total]]);
});

test('导航清理会同时清空保留状态，重载后不残留旧窗口', () => {
  const cache = loadCache();
  cache.setLimit(1024 * 1024);
  seedTrack(cache, MEDIA);
  cache.retain(MEDIA, { active: true, position: 25, ahead: 6, rewind: 5, duration: 40 });
  cache.clear();
  assert.equal(cache.stats.bytes, 0);

  const reloaded = seedTrack(cache, MEDIA);
  cache.setLimit(300);
  // 若旧提示残留，初始化区会被保护；现在应按最老的块先回收。
  assert.deepEqual(fromVm(cache.ranges(MEDIA)), [[reloaded.first + 100, reloaded.total]]);
});
