import test from "node:test";
import assert from "node:assert/strict";
import { buildCacheSizeInfo, getAudioCacheSize, getCacheSize } from "../src/cache-size.js";

const track = (id, bandwidth, codecs = "avc1.640032", mimeType = "video/mp4") => ({
  id, bandwidth, codecs, mimeType, baseUrl: "https://cdn.example/video?token=private"
});
const data = {
  dash: { duration: 100, video: [track(80, 1600000), track(80, 800000, "av01.0.08M.08"), track(64, 400000)],
    audio: [track(30280, 128000, "mp4a.40.2", "audio/mp4")] }
};
test("画质切换估算包含音频，且不保存 CDN 签名地址", () => {
  const info = buildCacheSizeInfo(data);
  assert.deepEqual(getCacheSize(info, 80), { bytes: 11600000, estimated: true });
  assert.deepEqual(getCacheSize(info, 64), { bytes: 6600000, estimated: true });
  assert.equal(JSON.stringify(info).includes("private"), false);
  // 快照里带上 B 站声明的档位（含大会员档），供界面区分“声明可用”与“实际返回”。
  assert.deepEqual(info.declared, []);
  assert.equal(getCacheSize(info, 120), null);
});
test("估算排除浏览器不支持的编码", () => {
  const previous = globalThis.MediaSource;
  globalThis.MediaSource = { isTypeSupported: (type) => !type.includes("av01") };
  try {
    assert.deepEqual(getCacheSize(buildCacheSizeInfo(data), 80), { bytes: 21600000, estimated: true });
  } finally { globalThis.MediaSource = previous; }
});
test("实际大小只在所有 DASH 轨道总量已知时替代估算", () => {
  const info = buildCacheSizeInfo(data);
  const cached = { mediaKind: "dash", totalBytes: 100, tracks: { video: { totalBytes: 100 }, audio: { totalBytes: 0 } } };
  assert.equal(getCacheSize(info, 80, cached).estimated, true);
  cached.tracks.audio.totalBytes = 20;
  assert.deepEqual(getCacheSize(info, 80, cached), { bytes: 120, estimated: false });
});
test("单段 MP4 使用清单大小，缺失码率不会显示为零", () => {
  const info = buildCacheSizeInfo({ quality: 80, format: "mp4", durl: [{ size: 1234 }] });
  assert.deepEqual(getCacheSize(info, 80), { bytes: 1234, estimated: false });
  assert.equal(getCacheSize(buildCacheSizeInfo({ dash: { ...data.dash, duration: 0 } }), 80), null);
});

test("仅缓存音频的体积按 Hi-Res 无损优先估算", () => {
  const lossless = track(30251, 1_411_000, "fLaC", "audio/mp4");
  const aac = track(30280, 128_000, "mp4a.40.2", "audio/mp4");
  const withLossless = buildCacheSizeInfo({ dash: { duration: 100, audio: [aac, lossless] } });
  assert.deepEqual(getAudioCacheSize(withLossless), {
    bytes: Math.ceil(1_411_000 * 100 / 8),
    estimated: true,
    label: "Hi-Res 无损",
    mode: "track"
  });
  const withoutLossless = buildCacheSizeInfo({ dash: { duration: 100, audio: [aac] } });
  assert.deepEqual(getAudioCacheSize(withoutLossless), {
    bytes: Math.ceil(128_000 * 100 / 8),
    estimated: true,
    label: "AAC 192K",
    mode: "track"
  });
  assert.equal(getAudioCacheSize(buildCacheSizeInfo({ dash: { duration: 0, audio: [aac] } })), null);
  assert.equal(getAudioCacheSize(buildCacheSizeInfo({ dash: { duration: 0, audio: [aac] } })), null);
});

test("仅音频缓存已完成时显示实际大小", () => {
  const cached = {
    mediaKind: "audio",
    cacheMode: "audio",
    tracks: { audio: { id: 30280, codecs: "mp4a.40.2", totalBytes: 4321 } }
  };
  assert.deepEqual(getAudioCacheSize(buildCacheSizeInfo({}), cached), {
    bytes: 4321,
    estimated: false,
    label: "AAC 192K",
    mode: "track"
  });
});

test("只有单文件 MP4 时按整段下载体积提示提取音轨", () => {
  const info = buildCacheSizeInfo({ quality: 32, format: "mp4", durl: [{ size: 402602 }] });
  assert.deepEqual(getAudioCacheSize(info), {
    bytes: 402602,
    estimated: false,
    label: "单文件 MP4 · 整段下载后提取音轨",
    mode: "extract"
  });
  assert.equal(getAudioCacheSize(null), null);
  assert.equal(getAudioCacheSize(buildCacheSizeInfo({})), null);
});
