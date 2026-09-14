import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MP4_MERGE_PROBLEM,
  Mp4MergeError,
  createAudioOnlyMp4,
  listBoxes,
  readBoxHeader,
  verifyAudioOnlyMp4
} from "../src/mp4-merge.js";

const PROGRESSIVE = new Uint8Array(readFileSync(new URL("./fixtures/progressive-avc-aac.mp4", import.meta.url)));

function chunksOf(bytes, size = bytes.length) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push({ data: bytes.subarray(offset, Math.min(offset + size, bytes.length)) });
  }
  return chunks;
}

async function extractAll(bytes, size) {
  const extraction = await createAudioOnlyMp4({ chunks: chunksOf(bytes, size) });
  const parts = [extraction.header];
  const pieceLengths = [];
  for await (const piece of extraction.stream()) {
    parts.push(piece);
    pieceLengths.push(piece.length);
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return { output, extraction, pieceLengths };
}

function handlerOf(bytes, trak) {
  const mdia = listBoxes(bytes, trak.offset + trak.headerSize, trak.end).find((box) => box.type === "mdia");
  const hdlr = listBoxes(bytes, mdia.offset + mdia.headerSize, mdia.end).find((box) => box.type === "hdlr");
  return String.fromCharCode(...bytes.subarray(hdlr.offset + hdlr.headerSize + 8, hdlr.offset + hdlr.headerSize + 12));
}

function tracksOf(bytes) {
  const moov = listBoxes(bytes).find((box) => box.type === "moov");
  return listBoxes(bytes, moov.offset + moov.headerSize, moov.end)
    .filter((box) => box.type === "trak")
    .map((trak) => ({ trak, handler: handlerOf(bytes, trak) }));
}

function chunkOffsetsOf(bytes, handler) {
  const entry = tracksOf(bytes).find((item) => item.handler === handler);
  assert(entry, "找不到 " + handler + " 轨");
  const mdia = listBoxes(bytes, entry.trak.offset + entry.trak.headerSize, entry.trak.end).find((box) => box.type === "mdia");
  const minf = listBoxes(bytes, mdia.offset + mdia.headerSize, mdia.end).find((box) => box.type === "minf");
  const stbl = listBoxes(bytes, minf.offset + minf.headerSize, minf.end).find((box) => box.type === "stbl");
  const stco = listBoxes(bytes, stbl.offset + stbl.headerSize, stbl.end).find((box) => box.type === "stco" || box.type === "co64");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(stco.offset + stco.headerSize + 4);
  const width = stco.type === "co64" ? 8 : 4;
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    offsets.push(width === 8
      ? Number(view.getBigUint64(stco.offset + stco.headerSize + 8 + index * 8))
      : view.getUint32(stco.offset + stco.headerSize + 8 + index * 4));
  }
  return { type: stco.type, offsets };
}

function concatRanges(bytes, ranges) {
  const total = ranges.reduce((sum, range) => sum + range.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const range of ranges) {
    output.set(bytes.subarray(range.offset, range.offset + range.length), offset);
    offset += range.length;
  }
  return output;
}

function mdatPayload(bytes) {
  const mdat = listBoxes(bytes).find((box) => box.type === "mdat");
  return bytes.subarray(mdat.offset + mdat.headerSize, mdat.end);
}

test("从真实单文件 MP4 无损提取音轨", async () => {
  const { output, extraction } = await extractAll(PROGRESSIVE, 64 * 1024);
  assert.equal(extraction.fragmented, false);
  assert.deepEqual(listBoxes(output).map((box) => box.type), ["ftyp", "moov", "mdat"]);
  assert(output.length < PROGRESSIVE.length, "只保留音轨后应当更小");
  assert.deepEqual(verifyAudioOnlyMp4(output, { totalBytes: output.length }).trackId, 1);

  assert.equal(extraction.audioTrack.codecs, "mp4a.40.2");
  assert.equal(extraction.audioTrack.mimeType, "audio/mp4");
  assert.equal(extraction.audioTrack.family, "aac");
  assert.equal(extraction.audioTrack.sampleCount, 814);
  assert(Math.abs(extraction.audioTrack.duration - 18.9) < 0.1, "音频时长应与视频一致");
  assert(extraction.audioTrack.bandwidth > 60000 && extraction.audioTrack.bandwidth < 70000, "平均码率应由样本表算出");

  // 只保留音频样本：mdat 紧凑存放音频分块，stco 指向新位置，视频样本被丢弃。
  const ranges = extraction.audioTrack.chunkRanges;
  const outputMdat = listBoxes(output).find((box) => box.type === "mdat");
  assert.deepEqual(mdatPayload(output), concatRanges(PROGRESSIVE, ranges));
  assert.equal(output.length, extraction.header.length + extraction.audioTrack.sampleBytes, "输出只应包含头部与音频样本");
  assert.equal(outputMdat.size, 8 + extraction.audioTrack.sampleBytes);
  assert(output.length < PROGRESSIVE.length / 2, "只保留音轨后体量应明显变小");
  assert.equal(chunkOffsetsOf(PROGRESSIVE, "soun").offsets.length, ranges.length);
  const expectedOffsets = [];
  let cursor = outputMdat.offset + outputMdat.headerSize;
  for (const range of ranges) {
    expectedOffsets.push(cursor);
    cursor += range.length;
  }
  assert.deepEqual(chunkOffsetsOf(output, "soun").offsets, expectedOffsets);
  assert.equal(tracksOf(output).filter((item) => item.handler === "vide").length, 0, "视频轨必须被移除");
});

test("分块边界不改变提取结果", async () => {
  const single = await extractAll(PROGRESSIVE);
  const split = await extractAll(PROGRESSIVE, 4096);
  const awkward = await extractAll(PROGRESSIVE, 997);
  assert.deepEqual(split.output, single.output);
  assert.deepEqual(awkward.output, single.output);
});

test("没有音频轨的单文件 MP4 明确报错", async () => {
  const bytes = buildProgressiveMp4({ audio: null, videoOffsets: [120] });
  await assert.rejects(
    () => extractAll(bytes),
    (error) => error instanceof Mp4MergeError && error.problem === MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT
  );
});

test("样本偏移不在媒体数据段内时拒绝写出坏文件", async () => {
  const bytes = buildProgressiveMp4({ audioOffsets: [900000], videoOffsets: [100] });
  await assert.rejects(
    () => extractAll(bytes),
    (error) => error instanceof Mp4MergeError && error.problem === MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT
  );
});

test("支持多个 mdat 与 co64 偏移表", async () => {
  const mdatA = box("mdat", new Uint8Array(64).fill(7));
  const mdatB = box("mdat", new Uint8Array(48).fill(9));
  // 先构造骨架以确定 moov 长度，再回填真实偏移
  const skeleton = buildProgressiveMp4({
    audio: { audioOffsets: [0, 0] },
    videoOffsets: [0],
    mdats: [mdatA, mdatB],
    co64: true
  });
  const moovSize = listBoxes(skeleton).find((box) => box.type === "moov").size;
  const ftypSize = listBoxes(skeleton).find((box) => box.type === "ftyp").size;
  const firstData = ftypSize + moovSize + 8;
  const secondData = firstData + mdatA.length;
  const bytes = buildProgressiveMp4({
    audio: { audioOffsets: [secondData + 4, firstData] },
    videoOffsets: [firstData + 16],
    mdats: [mdatA, mdatB],
    co64: true
  });
  const { output, extraction } = await extractAll(bytes);
  assert.equal(extraction.audioTrack.codecs, "mp4a.40.2");
  const outputMdat = listBoxes(output).find((box) => box.type === "mdat");
  assert.equal(outputMdat.size, 8 + extraction.audioTrack.sampleBytes, "两个 mdat 里的音频分块应被紧凑拼接");
  assert.deepEqual(mdatPayload(output), concatRanges(bytes, extraction.audioTrack.chunkRanges));
  const shifted = chunkOffsetsOf(output, "soun");
  assert.equal(shifted.type, "co64", "保留源文件的偏移表宽度");
  assert.deepEqual(shifted.offsets, [outputMdat.offset + outputMdat.headerSize, outputMdat.offset + outputMdat.headerSize + 8]);
});

test("fragmented 单文件 MP4 只保留音频片段", async () => {
  const bytes = buildFragmentedMp4();
  const { output, extraction } = await extractAll(bytes);
  assert.equal(extraction.fragmented, true);
  const types = listBoxes(output).map((box) => box.type);
  assert.deepEqual(types, ["ftyp", "moov", "moof", "mdat", "moof", "mdat"]);
  const trackIds = listBoxes(output)
    .filter((box) => box.type === "moof")
    .map((box) => {
      const traf = listBoxes(output, box.offset + box.headerSize, box.end).find((item) => item.type === "traf");
      const tfhd = listBoxes(output, traf.offset + traf.headerSize, traf.end).find((item) => item.type === "tfhd");
      return new DataView(output.buffer, output.byteOffset, output.byteLength).getUint32(tfhd.offset + tfhd.headerSize + 4);
    });
  assert.deepEqual(trackIds, [1, 1], "音频片段的 track_ID 必须改写为 1");
  assert.equal(tracksOf(output).length, 1);
  assert.equal(tracksOf(output)[0].handler, "soun");
});

function buildProgressiveMp4({ audio = {}, videoOffsets = [100], mdats = null, co64 = false }) {
  const ftyp = box("ftyp", concat([ascii("isom"), uint32(0x200), ascii("isom"), ascii("iso2"), ascii("mp41")]));
  const mediaBoxes = mdats || [box("mdat", new Uint8Array(256).fill(5))];
  const videoTrak = buildTrak({ trackId: 1, handler: "vide", timescale: 30000, entryType: "avc1", chunkOffsets: videoOffsets, sampleSizes: [16], co64 });
  const build = (audioChunkOffsets) => {
    const traks = [videoTrak];
    if (audio) {
      traks.push(buildTrak({
        trackId: 2,
        handler: "soun",
        timescale: 44100,
        entryType: "mp4a",
        chunkOffsets: audioChunkOffsets || [120],
        sampleSizes: [8, 8],
        co64,
        withEsds: true,
        audioObjectType: 2
      }));
    }
    return box("moov", concat([
      box("mvhd", concat([uint32(0), uint32(0), uint32(0), uint32(1000), uint32(2000), new Uint8Array(80), uint32(3)])),
      ...traks
    ]));
  };
  return concat([ftyp, build(audio?.audioOffsets), ...mediaBoxes]);
}

function buildTrak({ trackId, handler, timescale, entryType, chunkOffsets, sampleSizes, co64 = false, withEsds = false, audioObjectType = 2 }) {
  const entryPayload = withEsds && entryType === "mp4a"
    ? concat([
      new Uint8Array(6), uint16(1), uint16(0), uint16(0), new Uint8Array(4),
      uint16(2), uint16(16), uint16(0), uint16(0), uint32(44100 * 65536),
      box("esds", concat([uint32(0), descriptor(3, concat([
        uint16(2), new Uint8Array([0]),
        descriptor(4, concat([
          new Uint8Array([0x40, 0x15]), new Uint8Array([0, 0, 0]), uint32(0), uint32(64000),
          descriptor(5, new Uint8Array([audioObjectType << 3, 0x10, 0x56, 0xe5, 0x00]))
        ]))
      ]))]))
    ])
    : concat([new Uint8Array(6), uint16(1), new Uint8Array(70)]);
  const stsd = box("stsd", concat([uint32(0), uint32(1), box(entryType, entryPayload)]));
  const sizes = concat([uint32(sampleSizes.length), ...sampleSizes.map((size) => uint32(size))]);
  const stsz = box("stsz", concat([uint32(0), uint32(0), sizes]));
  const stts = box("stts", concat([uint32(0), uint32(1), uint32(1), uint32(1024)]));
  const stsc = box("stsc", concat([uint32(0), uint32(1), uint32(1), uint32(1), uint32(1)]));
  const offsetBox = box(co64 ? "co64" : "stco", concat([uint32(0), uint32(chunkOffsets.length), ...chunkOffsets.map((value) => (co64 ? uint64(value) : uint32(value)))]));
  const maxOffset = Math.max(...chunkOffsets);
  const stbl = box("stbl", concat([stsd, stts, stsc, stsz, offsetBox]));
  const minf = box("minf", stbl);
  const mdhd = box("mdhd", concat([uint32(0), uint32(0), uint32(0), uint32(timescale), uint32(timescale), uint16(0x55c4), uint16(0)]));
  const hdlr = box("hdlr", concat([uint32(0), uint32(0), ascii(handler), new Uint8Array(12)]));
  const tkhd = box("tkhd", concat([uint32(0x00000003), uint32(0), uint32(0), uint32(trackId), new Uint8Array(60)]));
  void maxOffset;
  return box("trak", concat([tkhd, box("mdia", concat([mdhd, hdlr, minf]))]));
}

function buildFragmentedMp4() {
  const ftyp = box("ftyp", concat([ascii("iso5"), uint32(1), ascii("iso5"), ascii("dash")]));
  const trak = (trackId, handler) => box("trak", concat([
    box("tkhd", concat([uint32(3), uint32(0), uint32(0), uint32(trackId), new Uint8Array(60)])),
    box("mdia", concat([
      box("mdhd", concat([uint32(0), uint32(0), uint32(0), uint32(48000), uint32(48000), uint16(0x55c4), uint16(0)])),
      box("hdlr", concat([uint32(0), uint32(0), ascii(handler), new Uint8Array(12)]))
    ]))
  ]));
  const mvex = box("mvex", concat([
    box("trex", concat([uint32(0), uint32(1), uint32(1), uint32(1024), uint32(0), uint32(0)])),
    box("trex", concat([uint32(0), uint32(2), uint32(1), uint32(1024), uint32(0), uint32(0)]))
  ]));
  const moov = box("moov", concat([
    box("mvhd", concat([uint32(0), uint32(0), uint32(0), uint32(1000), uint32(4000), new Uint8Array(80), uint32(3)])),
    mvex,
    trak(1, "vide"),
    trak(2, "soun")
  ]));
  const fragment = (trackId, decodeTime, sequenceNumber) => concat([
    box("moof", concat([
      box("mfhd", concat([uint32(0), uint32(sequenceNumber)])),
      box("traf", concat([
        box("tfhd", concat([uint32(0x020000), uint32(trackId)])),
        box("tfdt", concat([uint32(0), uint32(decodeTime)])),
        box("trun", concat([uint32(0), uint32(1), uint32(0x000001), uint32(0)]))
      ]))
    ])),
    box("mdat", new Uint8Array(32).fill(trackId))
  ]);
  return concat([ftyp, moov, fragment(1, 0, 1), fragment(2, 0, 1), fragment(1, 48000, 2), fragment(2, 48000, 2)]);
}

function descriptor(tag, payload) {
  const header = [tag];
  let size = payload.length;
  const bytes = [size & 0x7f];
  size >>= 7;
  while (size > 0) {
    bytes.unshift((size & 0x7f) | 0x80);
    size >>= 7;
  }
  return new Uint8Array([...header, ...bytes, ...payload]);
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
function uint16(value) {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}
function uint64(value) {
  return concat([uint32(Math.floor(value / 0x100000000)), uint32(value % 0x100000000)]);
}
function ascii(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}
