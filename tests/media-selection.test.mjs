import test from "node:test";
import assert from "node:assert/strict";
import { chooseAudioRepresentation, chooseVideoRepresentation } from "../src/media-selection.js";

const track = (id, codecs, bandwidth) => ({
  id,
  codecs,
  mimeType: "audio/mp4",
  bandwidth,
  baseUrl: "https://cdn.example/audio-" + id + ".m4s"
});

const AAC = track(30280, "mp4a.40.2", 192_000);
const FLAC = track(30251, "fLaC", 1_411_000);
const DOLBY = track(30250, "ec-3", 448_000);
const AAC_LOW = track(30232, "mp4a.40.2", 132_000);

test("缓存视频时优先兼容性最好的 AAC 音频轨", () => {
  const previous = globalThis.MediaSource;
  globalThis.MediaSource = { isTypeSupported: () => true };
  try {
    assert.equal(chooseAudioRepresentation([FLAC, DOLBY, AAC, AAC_LOW], { mode: "video" }), AAC);
    assert.equal(chooseAudioRepresentation([FLAC, DOLBY], { mode: "video" }), FLAC);
  } finally {
    globalThis.MediaSource = previous;
  }
});

test("仅缓存音频时优先 Hi-Res 无损，其次杜比，最后 AAC", () => {
  const previous = globalThis.MediaSource;
  globalThis.MediaSource = { isTypeSupported: () => true };
  try {
    assert.equal(chooseAudioRepresentation([AAC, DOLBY, FLAC], { mode: "audio" }), FLAC);
    assert.equal(chooseAudioRepresentation([AAC_LOW, DOLBY, AAC], { mode: "audio" }), DOLBY);
    assert.equal(chooseAudioRepresentation([AAC_LOW, AAC], { mode: "audio" }), AAC);
  } finally {
    globalThis.MediaSource = previous;
  }
});

test("浏览器不支持的音频编码不会进入缓存计划", () => {
  const previous = globalThis.MediaSource;
  globalThis.MediaSource = { isTypeSupported: (type) => !type.includes("ec-3") };
  try {
    assert.equal(chooseAudioRepresentation([FLAC, DOLBY], { mode: "audio" }), FLAC);
    assert.equal(chooseAudioRepresentation([DOLBY], { mode: "audio" }), null);
  } finally {
    globalThis.MediaSource = previous;
  }
});

test("没有可用地址或没有返回音频轨时返回空", () => {
  assert.equal(chooseAudioRepresentation([], { mode: "audio" }), null);
  assert.equal(chooseAudioRepresentation([{ ...AAC, baseUrl: "", backupUrl: [] }], { mode: "audio" }), null);
  assert.equal(chooseVideoRepresentation([], 80, "auto"), null);
});
