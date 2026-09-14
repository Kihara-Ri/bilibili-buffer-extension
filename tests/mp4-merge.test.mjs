import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MP4_MERGE_PROBLEM,
  Mp4MergeError,
  listBoxes,
  parseFragment,
  readBoxHeader,
  verifyMergedHeader,
  createMergedFragmentedMp4
} from "../src/mp4-merge.js";

const fixtureBytes = (name) => new Uint8Array(readFileSync(new URL("./fixtures/" + name, import.meta.url)));
const VIDEO = fixtureBytes("dash-video-2frag.mp4");
const AUDIO = fixtureBytes("dash-audio-2frag.mp4");

function chunksOf(bytes, sizes) {
  const chunks = [];
  const pattern = sizes || [bytes.length];
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const size = pattern[index % pattern.length];
    chunks.push({ data: bytes.subarray(offset, Math.min(offset + size, bytes.length)) });
    offset += size;
    index += 1;
  }
  return chunks;
}

async function mergeAll(videoChunks, audioChunks) {
  const merged = await createMergedFragmentedMp4({
    video: { chunks: videoChunks },
    audio: { chunks: audioChunks }
  });
  const parts = [merged.header];
  const fragments = [];
  for await (const fragment of merged.stream()) {
    const moof = readBoxHeader(fragment, 0);
    const parsed = parseFragment(fragment.subarray(0, moof.size));
    fragments.push({ ...parsed, byteLength: fragment.length });
    parts.push(fragment);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, header: merged.header, fragments, sourceBytes: merged.sourceBytes };
}

test("把真实 B 站 DASH 双轨合并为按解码时间交错的 fMP4", async () => {
  const merged = await mergeAll(chunksOf(VIDEO), chunksOf(AUDIO));
  assert.deepEqual(
    merged.fragments.map((fragment) => [fragment.trackId, fragment.sequenceNumber, fragment.decodeTime]),
    [[1, 1, 0], [2, 2, 0], [2, 3, 239616], [1, 4, 80000]]
  );
  assert.deepEqual(verifyMergedHeader(merged.bytes), { trackIds: [1, 2] });
  const topLevel = listBoxes(merged.bytes).map((box) => box.type);
  assert.deepEqual(topLevel, ["ftyp", "moov", "moof", "mdat", "moof", "mdat", "moof", "mdat", "moof", "mdat"]);
  assert.equal(merged.sourceBytes, VIDEO.length + AUDIO.length);
  // 只丢掉各自独立的 free / sidx 与另一份 ftyp+moov，媒体载荷逐字节保留。
  const payloadBytes = merged.fragments.reduce((sum, fragment) => sum + fragment.byteLength, 0);
  assert.equal(payloadBytes, VIDEO.length + AUDIO.length - (8 + 74) * 2 - 860 - 872 - 36 - 882 - 36 - 816);
  assert.equal(merged.bytes.length, payloadBytes + merged.header.length);
});

test("分块边界不改变合并结果", async () => {
  const single = await mergeAll(chunksOf(VIDEO), chunksOf(AUDIO));
  const split = await mergeAll(chunksOf(VIDEO, [100000]), chunksOf(AUDIO, [32768]));
  const awkward = await mergeAll(chunksOf(VIDEO, [16]), chunksOf(AUDIO, [7]));
  assert.deepEqual(split.bytes, single.bytes);
  assert.deepEqual(awkward.bytes, single.bytes);
});

test("两条轨道使用相同 track_ID 时改写为 1 与 2", async () => {
  const video = buildTrack({ trackId: 1, timescale: 90000, handlerType: "vide", fragments: [0, 90000] });
  const audio = buildTrack({ trackId: 1, timescale: 48000, handlerType: "soun", fragments: [0, 24000] });
  const merged = await mergeAll(chunksOf(video), chunksOf(audio));
  assert.deepEqual(merged.fragments.map((fragment) => fragment.trackId), [1, 2, 2, 1]);
  assert.deepEqual(verifyMergedHeader(merged.bytes), { trackIds: [1, 2] });
  const moov = listBoxes(merged.bytes).find((box) => box.type === "moov");
  const mvex = listBoxes(merged.bytes, moov.offset + moov.headerSize, moov.end).find((box) => box.type === "mvex");
  const trexIds = listBoxes(merged.bytes, mvex.offset + mvex.headerSize, mvex.end)
    .filter((box) => box.type === "trex")
    .map((box) => readUint32(merged.bytes, box.offset + box.headerSize + 4));
  assert.deepEqual(trexIds, [1, 2]);
  const mvhd = listBoxes(merged.bytes, moov.offset + moov.headerSize, moov.end).find((box) => box.type === "mvhd");
  assert.equal(readUint32(merged.bytes, mvhd.offset + mvhd.size - 4), 3);
});

test("缺少 mvex 的轨道报告为不可合并而不是写出坏文件", async () => {
  const progressive = buildTrack({ trackId: 1, timescale: 1000, handlerType: "vide", fragments: [0], mvex: false });
  await assert.rejects(
    () => mergeAll(chunksOf(progressive), chunksOf(AUDIO)),
    (error) => error instanceof Mp4MergeError && error.problem === MP4_MERGE_PROBLEM.NOT_FRAGMENTED
  );
});

test("分块不完整时中止合并", async () => {
  const truncated = { data: VIDEO.subarray(0, 40000) };
  await assert.rejects(
    () => mergeAll([truncated], chunksOf(AUDIO)),
    (error) => error instanceof Mp4MergeError && error.problem === MP4_MERGE_PROBLEM.TRUNCATED
  );
});

test("读取 64 位长度与延伸到文件末尾的盒子头", () => {
  const large = new Uint8Array(24);
  writeUint32(large, 0, 1);
  large.set(ascii("mdat"), 4);
  writeUint64(large, 8, 0x1_0000_0000 + 8);
  assert.deepEqual(readBoxHeader(large, 0), { type: "mdat", size: 0x1_0000_0008, headerSize: 16, toEnd: false });
  const toEnd = new Uint8Array(8);
  toEnd.set(ascii("mdat"), 4);
  assert.equal(readBoxHeader(toEnd, 0).toEnd, true);
});

function buildInit({ trackId, timescale, handlerType, mvex = true }) {
  const trak = box("trak", concat([
    box("tkhd", concat([new Uint8Array(4), uint32(0), uint32(0), uint32(trackId), new Uint8Array(60)])),
    box("mdia", concat([
      box("mdhd", concat([new Uint8Array(4), uint32(0), uint32(0), uint32(timescale), uint32(0), new Uint8Array(4)])),
      box("hdlr", concat([new Uint8Array(8), ascii(handlerType), new Uint8Array(12)]))
    ]))
  ]));
  const parts = [box("mvhd", concat([new Uint8Array(4), uint32(0), uint32(0), uint32(1000), uint32(120000), new Uint8Array(80), uint32(trackId + 1)]))];
  parts.push(trak);
  if (mvex) {
    parts.push(box("mvex", concat([
      box("mehd", concat([new Uint8Array(4), uint32(120000)])),
      box("trex", concat([new Uint8Array(4), uint32(trackId), uint32(1), uint32(timescale / 30), uint32(0), uint32(0)]))
    ])));
  }
  return concat([box("ftyp", concat([ascii("iso5"), uint32(1), ascii("iso5"), ascii("dash")])), box("moov", concat(parts))]);
}

function buildFragment(trackId, decodeTime, sampleByte = 1, sequenceNumber = 1) {
  return concat([
    box("moof", concat([
      box("mfhd", concat([new Uint8Array(4), uint32(sequenceNumber)])),
      box("traf", concat([
        box("tfhd", concat([new Uint8Array(4), uint32(trackId), uint32(0x020000)])),
        box("tfdt", concat([new Uint8Array(4), uint32(decodeTime)])),
        box("trun", concat([new Uint8Array(4), uint32(1), uint32(0x000001), uint32(0)]))
      ]))
    ])),
    box("mdat", new Uint8Array(64).fill(sampleByte))
  ]);
}

function buildTrack({ trackId, timescale, handlerType, fragments, mvex = true }) {
  return concat([
    buildInit({ trackId, timescale, handlerType, mvex }),
    ...fragments.map((decodeTime, index) => buildFragment(trackId, decodeTime, index + 1, index + 1))
  ]);
}

function box(type, payload) {
  return concat([uint32(payload.length + 8), ascii(type), payload]);
}
function concat(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function uint32(value) {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}
function writeUint32(bytes, offset, value) {
  bytes.set(uint32(value), offset);
}
function writeUint64(bytes, offset, value) {
  writeUint32(bytes, offset, Math.floor(value / 0x100000000));
  writeUint32(bytes, offset + 4, value % 0x100000000);
}
function ascii(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}
test("丢弃片段尾部与片段之间引用旧偏移的索引盒子", async () => {
  const video = concat([
    buildInit({ trackId: 1, timescale: 90000, handlerType: "vide" }),
    buildFragment(1, 0, 1, 1),
    box("sidx", new Uint8Array(20)),
    buildFragment(1, 90000, 2, 2),
    box("sidx", new Uint8Array(20))
  ]);
  const audio = concat([
    buildInit({ trackId: 2, timescale: 48000, handlerType: "soun" }),
    buildFragment(2, 0, 3, 1)
  ]);
  const merged = await mergeAll(chunksOf(video), chunksOf(audio));
  const types = listBoxes(merged.bytes).map((item) => item.type);
  assert.equal(types.includes("sidx"), false, "sidx 引用的原文件偏移在交错后不再成立，必须丢弃");
  assert.deepEqual(types, ["ftyp", "moov", "moof", "mdat", "moof", "mdat", "moof", "mdat"]);
  assert.deepEqual(merged.fragments.map((fragment) => fragment.trackId), [1, 2, 1]);
  assert.deepEqual(merged.fragments.map((fragment) => fragment.sequenceNumber), [1, 2, 3]);
});

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
