import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCache } from './playback-cache-helpers.mjs';
export function sidx({ version = 0, firstOffset = 8, earliest = 2000, sizes = [10, 20], durations = [1000, 3000] } = {}) {
  const bytes = new Uint8Array(32 + (version === 1 ? 8 : 0) + sizes.length * 12);
  const v = new DataView(bytes.buffer); v.setUint32(0, bytes.length);
  bytes.set([115, 105, 100, 120], 4); bytes[8] = version;
  v.setUint32(12, 1); v.setUint32(16, 1000);
  let p = 20;
  if (version === 1) { v.setUint32(p + 4, earliest); v.setUint32(p + 12, firstOffset); p += 16; }
  else { v.setUint32(p, earliest); v.setUint32(p + 4, firstOffset); p += 8; }
  v.setUint16(p + 2, sizes.length); p += 4;
  sizes.forEach((size, i) => { v.setUint32(p, size); v.setUint32(p + 4, durations[i]); v.setUint32(p + 8, 0x90000000); p += 12; });
  return bytes;
}
const url = 'https://a.bilivideo.com/video.m4s?token=one';
test('分段拼接/子范围/开放结尾；任何缺口均不命中', () => {
  const cache = loadCache();
  cache.put(url, 2, new Uint8Array([2, 3]), 6);
  cache.put(url, 4, new Uint8Array([4, 5]), 6);
  assert.deepEqual([...cache.match(url, 'bytes=3-5').body], [3, 4, 5]);
  assert.deepEqual([...cache.match(url, 'bytes=2-').body], [2, 3, 4, 5]);
  for (const range of ['bytes=0-5', 'bytes=2-3,4-5', 'bytes=-3', 'bytes=2-6', 'bytes=5-4']) assert.equal(cache.match(url, range), null);
  assert.equal(cache.match(url + 'x', 'bytes=2-5'), null);
});
test('容量回收、资源长度变化与导航清理都不能返回陈旧数据', () => {
  const cache = loadCache(); cache.setLimit(4);
  cache.put(url, 0, new Uint8Array([0, 1, 2]), 6);
  cache.put(url, 3, new Uint8Array([3, 4, 5]), 6);
  assert.equal(cache.match(url, 'bytes=0-2'), null);
  assert.equal(cache.stats.bytes, 3);
  cache.put(url, 0, new Uint8Array([7, 8]), 2);
  assert.equal(cache.match(url, 'bytes=3-5'), null);
  cache.clear(); assert.equal(cache.stats.bytes, 0);
  assert.equal(cache.match(url, 'bytes=0-1'), null);
});
test('SIDX v0/v1 精确映射非等码率段，只标记完整且初始化就绪的区间', () => {
  for (const version of [0, 1]) {
    const cache = loadCache(); const index = sidx({ version });
    const start = index.length + 8, total = start + 30;
    cache.put(url, 0, index, total);
    assert.equal(cache.index(url).segments[0].start, start);
    assert.equal(cache.index(url).segments[1].timeEnd, 6);
    cache.put(url, start, new Uint8Array(30), total);
    assert.deepEqual(JSON.parse(JSON.stringify(cache.timeRanges(url))), []);
    cache.put(url, index.length, new Uint8Array(8), total);
    assert.deepEqual(JSON.parse(JSON.stringify(cache.timeRanges(url))), [[2, 6]]);
    cache.setLimit(10);
    assert.deepEqual(JSON.parse(JSON.stringify(cache.timeRanges(url))), []);
  }
});
test('损坏/截断/层级 SIDX 不产生错误黄色', () => {
  const cache = loadCache();
  const bad = sidx(); new DataView(bad.buffer).setUint32(32, 0x80000001);
  cache.put(url, 0, bad, 1000); assert.equal(cache.index(url), null);
  cache.clear(); cache.put(url, 0, sidx().slice(0, 35), 1000); assert.equal(cache.index(url), null);
});
