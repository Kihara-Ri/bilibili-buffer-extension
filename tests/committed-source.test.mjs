import test from "node:test";
import assert from "node:assert/strict";
import { committedSources, sliceCommittedChunks, validCommittedRead } from "../src/committed-source.js";
import { parseBiliVideoUrl } from "../src/utils.js";

const MiB = 1024 * 1024;
const partition = "anonymous";
const page = parseBiliVideoUrl("https://www.bilibili.com/video/BVsource/?p=2");
const video = {
  id: "BVsource:22:q120", bvid: "BVsource", page: 2, createdAt: 3, runStartedAt: 5,
  status: "downloading", mediaKind: "dash", sourcePartition: partition,
  tracks: {
    video: { sourceUrls: ["https://one.bilivideo.com/v.m4s?deadline=1"], sourceChunkBytes: 2 * MiB,
      committedBytes: 4 * MiB, downloadedBytes: 6 * MiB, chunkCount: 2, totalBytes: 12 * MiB },
    audio: { sourceUrls: ["https://two.bilivideo.com/a.m4s"], sourceChunkBytes: 2 * MiB,
      committedBytes: MiB, downloadedBytes: MiB, chunkCount: 1, totalBytes: MiB }
  }
};

test("落盘水位按媒体轨道、分 P 与下载账户匹配，忽略在途字节", () => {
  const sources = committedSources(video, page, partition);
  assert.deepEqual(sources.map(({ role, paths, end }) => ({ role, paths, end })), [
    { role: "video", paths: ["/v.m4s"], end: 4 * MiB },
    { role: "audio", paths: ["/a.m4s"], end: MiB }
  ]);
  assert.deepEqual(committedSources(video, { ...page, page: 1 }, partition), []);
  assert.deepEqual(committedSources(video, page, "other"), []);
  assert.deepEqual(committedSources({ ...video, merged: { totalBytes: 1 } }, page, partition), []);
  assert.deepEqual(committedSources({ ...video, sourcePartition: "" }, page, partition), []);
  assert.equal(committedSources({ ...video, status: "paused" }, page, partition).length, 2);
});

test("只切片实际覆盖请求的分块，损坏或缺失的块不能返回部分响应", async () => {
  const track = { chunkBytes: 4, end: 10 };
  const chunks = [
    { index: 0, data: new Blob([Uint8Array.of(0, 1, 2, 3)]) },
    { index: 1, data: new Blob([Uint8Array.of(4, 5, 6, 7)]) },
    { index: 2, data: new Blob([Uint8Array.of(8, 9)]) }
  ];
  const body = sliceCommittedChunks(chunks.slice(1), track, 5, 10);
  assert.deepEqual([...new Uint8Array(await body.arrayBuffer())], [5, 6, 7, 8, 9]);
  assert.equal(sliceCommittedChunks(chunks.slice(1, 2), track, 5, 10), null);
  assert.equal(sliceCommittedChunks(chunks.slice(1), track, 5, 11), null);
  assert.equal(sliceCommittedChunks([chunks[1], { index: 2, data: new Blob(["x"]) }], track, 5, 10), null);
});

test("完整的 4K 大段可以一次从落盘区取出，单次读取仍受 24 MiB 上限约束", () => {
  const request = { id: video.id, createdAt: video.createdAt, runStartedAt: video.runStartedAt,
    role: "video", url: video.tracks.video.sourceUrls[0], total: 48 * MiB, start: 0 };
  assert.equal(validCommittedRead({ ...request, end: 24 * MiB }), true);
  assert.equal(validCommittedRead({ ...request, end: 24 * MiB + 1 }), false);
});
