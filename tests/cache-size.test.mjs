import test from "node:test";
import assert from "node:assert/strict";
import { buildCacheSizeInfo, getCacheSize } from "../src/cache-size.js";

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
