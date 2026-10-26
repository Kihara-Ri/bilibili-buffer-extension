import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { t } from "../src/i18n.js";
import { buildCachedDownloadPlan, hasCompleteByteCount, isAudioOnlyCache, makeMimeCodec } from "../src/utils.js";

const source = await readFile(new URL("../src/offscreen.js", import.meta.url), "utf8");
const playbackSource = source.slice(source.indexOf("async function createPlaybackUrl("), source.indexOf("\n/** 把一条轨道的本地分块"));
const track = { totalBytes: 4, downloadedBytes: 4, chunkCount: 1, mimeType: "video/mp4" };

function loadPlayback(video) {
  const createdTracks = [];
  // 运行生产函数，只替换数据库、合并与 Blob I/O；返回字段和保存计划都使用真实逻辑。
  const createPlaybackUrl = vm.runInNewContext(`(${playbackSource})`, {
    getVideo: async () => video,
    playbackUrls: new Map(),
    hasCompleteByteCount, isAudioOnlyCache, makeMimeCodec, t,
    MERGED_TRACK: "merged",
    ensureMergedTracks: async value => value,
    isMergedComplete: value => Number(value.merged?.totalBytes) > 0 && hasCompleteByteCount(value),
    createTrackBlobUrl: async (_id, name) => {
      createdTracks.push(name);
      return `blob:${name}`;
    }
  });
  return { createPlaybackUrl, createdTracks };
}

test("合并 DASH 先播放再重复保存时始终返回同一单文件地址", async () => {
  const video = {
    id: "merged", title: "测试", status: "complete", mediaKind: "dash",
    totalBytes: 4, downloadedBytes: 4, merged: { ...track },
    tracks: { video: { releasedIntoMerged: true }, audio: { releasedIntoMerged: true } }
  };
  const { createPlaybackUrl, createdTracks } = loadPlayback(video);
  const playback = await createPlaybackUrl(video.id);
  assert.equal(playback.playbackUrl, "blob:merged");
  for (let attempt = 0; attempt < 2; attempt++) {
    const cached = await createPlaybackUrl(video.id);
    // Issue #2：页面自动播放先请求一次，保存时命中内存缓存也必须能生成下载计划。
    assert.deepEqual(buildCachedDownloadPlan(cached), {
      splitTracks: false,
      items: [{ url: playback.playbackUrl, filename: "测试.mp4" }]
    });
    assert.equal(cached.playbackUrl, playback.playbackUrl);
    assert.equal(cached.playback, undefined);
  }
  assert.deepEqual(createdTracks, ["merged"], "重复请求应复用 Blob，不重新读取媒体");
});

for (const fixture of [
  { name: "未合并 DASH", mediaKind: "dash", totalBytes: 8, downloadedBytes: 8, mergeError: "保留双轨", tracks: { video: { ...track }, audio: { ...track, mimeType: "audio/mp4" } }, expectedTracks: ["video", "audio"], expectedPlan: { splitTracks: true, items: [{ url: "blob:video", filename: "测试.视频轨.mp4" }, { url: "blob:audio", filename: "测试.音频轨.m4a" }] } },
  { name: "单文件 MP4", mediaKind: "progressive", ...track, expectedTracks: ["media"], expectedPlan: { splitTracks: false, items: [{ url: "blob:media", filename: "测试.mp4" }] } },
  { name: "仅音频 DASH", mediaKind: "dash", cacheMode: "audio", ...track, tracks: { audio: { ...track, mimeType: "audio/mp4" } }, expectedTracks: ["audio"], expectedPlan: { splitTracks: false, items: [{ url: "blob:audio", filename: "测试.m4a" }] } }
]) {
  test(`${fixture.name} 重复请求保持可保存的返回格式`, async () => {
    const video = { ...fixture, id: fixture.name, title: "测试", status: "complete" };
    const { createPlaybackUrl, createdTracks } = loadPlayback(video);
    const first = await createPlaybackUrl(video.id);
    const second = await createPlaybackUrl(video.id);
    // VM 的双轨数组来自另一个 realm；消息传输会结构化克隆，这里也按相同边界比较值。
    assert.deepEqual(structuredClone(buildCachedDownloadPlan(first)), fixture.expectedPlan);
    assert.deepEqual(structuredClone(buildCachedDownloadPlan(second)), fixture.expectedPlan);
    assert.equal(second.playbackUrl, first.playbackUrl);
    assert.equal(second.playback, first.playback);
    assert.deepEqual(createdTracks, fixture.expectedTracks);
  });
}
