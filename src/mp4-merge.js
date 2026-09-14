/**
 * 把 B 站 DASH 的独立视频轨与音频轨（fragmented MP4 / fMP4）合并为一个双轨 MP4。
 *
 * 背景：B 站高画质只返回两条互相独立的 fMP4 轨道（ftyp + moov(mvex) + moof/mdat...）。
 * 这里不做任何转码，只把两条轨道重封装进同一个 moov，并按解码时间交错 moof/mdat，
 * 于是 Chrome、VLC、mpv、ffmpeg 都能像播放普通 MP4 一样播放合并结果。
 *
 * 设计要点：
 * - 轨道数据以 IndexedDB 分块保存，读取走随机访问 + 顺序复制，任意时刻只在内存里保留一个片段。
 * - 只支持 fragmented MP4（moov 内有 mvex）。progressive MP4 本来就只有一条轨道，不需要合并。
 * - 不做样本级重排：moof 内的 trun 数据偏移以 moof 起点计算，整段复制后依然有效。
 */

export const MP4_MERGE_PROBLEM = Object.freeze({
  NOT_FRAGMENTED: "notFragmented",
  UNSUPPORTED_LAYOUT: "unsupportedLayout",
  TRUNCATED: "truncated"
});

export class Mp4MergeError extends Error {
  constructor(problem, message) {
    super(message);
    this.name = "Mp4MergeError";
    this.problem = problem;
  }
}

const MAX_UINT32 = 0xffffffff;
// 初始化段（moov 之前）与片段之间的非媒体盒子：跳过它们不影响 moof 内部偏移。
const SKIP_BOX_TYPES = new Set(["free", "wide", "skip", "styp", "sidx", "emsg", "prft", "mfra", "mfro", "ssix"]);

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readUint64(bytes, offset) {
  return readUint32(bytes, offset) * 0x100000000 + readUint32(bytes, offset + 4);
}

function writeUint32(bytes, offset, value) {
  const next = value >>> 0;
  bytes[offset] = (next >>> 24) & 0xff;
  bytes[offset + 1] = (next >>> 16) & 0xff;
  bytes[offset + 2] = (next >>> 8) & 0xff;
  bytes[offset + 3] = next & 0xff;
}

function latin1(bytes, start, end) {
  let text = "";
  for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index]);
  return text;
}

function ascii(text) {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
}

function concatBytes(parts) {
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

/** 读取一个 MP4 盒子头；offset 处字节不足时返回 null。 */
export function readBoxHeader(bytes, offset = 0) {
  if (!bytes || offset < 0 || offset + 8 > bytes.length) return null;
  let size = readUint32(bytes, offset);
  const type = latin1(bytes, offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > bytes.length) return null;
    size = readUint64(bytes, offset + 8);
    headerSize = 16;
  } else if (size === 0) {
    return { type, size: bytes.length - offset, headerSize: 8, toEnd: true };
  }
  if (size < headerSize) return null;
  return { type, size, headerSize, toEnd: false };
}

/** 列出一段字节里的连续顶层盒子；遇到损坏的盒子就停下来。 */
export function listBoxes(bytes, start = 0, end = bytes.length) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const header = readBoxHeader(bytes, offset);
    if (!header) break;
    const boxEnd = header.toEnd ? end : offset + header.size;
    if (boxEnd > end || boxEnd <= offset) break;
    boxes.push({ ...header, offset, end: boxEnd });
    offset = boxEnd;
  }
  return boxes;
}

function makeBox(type, payload) {
  const header = new Uint8Array(8);
  writeUint32(header, 0, payload.length + 8);
  header.set(ascii(type), 4);
  return concatBytes([header, payload]);
}

function findChild(bytes, parent, types) {
  return listBoxes(bytes, parent.offset + parent.headerSize, parent.end)
    .find((box) => types.includes(box.type)) || null;
}

/** 取出 trak 的 track_ID（tkhd）与媒体时间刻度（mdhd）、处理器类型（hdlr）。 */
function describeTrak(moovBytes, trak) {
  const tkhd = findChild(moovBytes, trak, ["tkhd"]);
  if (!tkhd) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存轨道缺少 tkhd 盒子");
  const tkhdVersion = moovBytes[tkhd.offset + tkhd.headerSize];
  const trackIdOffset = tkhd.offset + tkhd.headerSize + 4 + (tkhdVersion === 1 ? 16 : 8);
  if (trackIdOffset + 4 > tkhd.end) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存轨道的 tkhd 盒子无法解析");
  }
  const trackId = readUint32(moovBytes, trackIdOffset);

  const mdia = findChild(moovBytes, trak, ["mdia"]);
  if (!mdia) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存轨道缺少 mdia 盒子");
  const mdhd = findChild(moovBytes, mdia, ["mdhd"]);
  if (!mdhd) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存轨道缺少 mdhd 盒子");
  const mdhdVersion = moovBytes[mdhd.offset + mdhd.headerSize];
  const timescale = readUint32(moovBytes, mdhd.offset + mdhd.headerSize + (mdhdVersion === 1 ? 20 : 12));

  const hdlr = findChild(moovBytes, mdia, ["hdlr"]);
  const handlerType = hdlr ? latin1(moovBytes, hdlr.offset + hdlr.headerSize + 8, hdlr.offset + hdlr.headerSize + 12) : "";

  return { trackId, timescale, handlerType };
}

/**
 * 解析一条轨道的初始化段（ftyp / free / moov）。非 fragmented MP4 会抛出 Mp4MergeError。
 */
export function parseInitSegment(bytes) {
  const boxes = listBoxes(bytes);
  const ftypBox = boxes.find((box) => box.type === "ftyp") || null;
  const moovBox = boxes.find((box) => box.type === "moov") || null;
  if (!moovBox) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.NOT_FRAGMENTED, "缓存轨道缺少 moov 初始化段");
  }
  const children = listBoxes(bytes, moovBox.offset + moovBox.headerSize, moovBox.end);
  const mvex = children.find((box) => box.type === "mvex") || null;
  if (!mvex) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.NOT_FRAGMENTED, "缓存轨道不是 fragmented MP4，无法自动合并");
  }
  const traks = children.filter((box) => box.type === "trak");
  if (traks.length !== 1) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存轨道必须只包含一条媒体轨");
  }
  const mvhd = children.find((box) => box.type === "mvhd");
  if (!mvhd) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存轨道缺少 mvhd 盒子");

  const trak = traks[0];
  const trakBytes = bytes.slice(trak.offset, trak.end);
  const mvhdBytes = bytes.slice(mvhd.offset, mvhd.end);
  const mvexBytes = bytes.slice(mvex.offset, mvex.end);
  const described = describeTrak(bytes, trak);
  const mvhdVersion = bytes[mvhd.offset + mvhd.headerSize];
  const durationOffset = mvhd.headerSize + (mvhdVersion === 1 ? 24 : 16);
  const duration = mvhdVersion === 1
    ? readUint64(mvhdBytes, durationOffset)
    : readUint32(mvhdBytes, durationOffset);

  return {
    ftypBytes: ftypBox ? bytes.slice(ftypBox.offset, ftypBox.end) : null,
    moovBytes: bytes.slice(moovBox.offset, moovBox.end),
    mvhdBytes,
    mvexBytes,
    trakBytes,
    duration,
    ...described
  };
}

/** 读取片段（moof）里的 track_ID、解码时间与片段序号。 */
export function parseFragment(moofBytes) {
  const moof = readBoxHeader(moofBytes, 0);
  if (!moof || moof.type !== "moof") {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存片段缺少 moof 盒子");
  }
  const moofChildren = listBoxes(moofBytes, moof.headerSize, moof.size);
  const trafs = moofChildren.filter((box) => box.type === "traf");
  if (trafs.length !== 1) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存片段必须只包含一条 traf");
  }
  const traf = trafs[0];
  const trafChildren = listBoxes(moofBytes, traf.offset + traf.headerSize, traf.end);
  const tfhd = trafChildren.find((box) => box.type === "tfhd");
  const tfdt = trafChildren.find((box) => box.type === "tfdt");
  const mfhd = moofChildren.find((box) => box.type === "mfhd");
  if (!tfhd || !mfhd) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存片段缺少 tfhd 或 mfhd 盒子");
  }

  let decodeTime = null;
  if (tfdt) {
    const version = moofBytes[tfdt.offset + tfdt.headerSize];
    const valueOffset = tfdt.offset + tfdt.headerSize + 4;
    decodeTime = version === 1 ? readUint64(moofBytes, valueOffset) : readUint32(moofBytes, valueOffset);
  }

  return {
    trackId: readUint32(moofBytes, tfhd.offset + tfhd.headerSize + 4),
    sequenceNumber: readUint32(moofBytes, mfhd.offset + mfhd.headerSize + 4),
    decodeTime
  };
}

function patchMvhd(bytes, { duration, nextTrackId }) {
  const copy = bytes.slice();
  const header = readBoxHeader(copy, 0);
  const version = copy[header.headerSize];
  if (duration !== null && duration !== undefined) {
    if (version === 1) {
      const high = Math.floor(duration / 0x100000000);
      writeUint32(copy, header.headerSize + 24, high);
      writeUint32(copy, header.headerSize + 28, duration % 0x100000000);
    } else {
      writeUint32(copy, header.headerSize + 16, Math.min(duration, MAX_UINT32));
    }
  }
  if (nextTrackId) writeUint32(copy, header.size - 4, nextTrackId);
  return copy;
}

/** 改写 trak / trex / trep 里的 track_ID（盒子长度不变）。 */
export function patchTrackId(bytes, trackId) {
  const copy = bytes.slice();
  const head = readBoxHeader(copy, 0);
  if (!head) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "无法解析需要改写 track_ID 的盒子");
  if (head.type === "trak") {
    const tkhd = listBoxes(copy, head.headerSize, copy.length).find((box) => box.type === "tkhd");
    if (!tkhd) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存轨道缺少 tkhd 盒子");
    const version = copy[tkhd.offset + tkhd.headerSize];
    writeUint32(copy, tkhd.offset + tkhd.headerSize + 4 + (version === 1 ? 16 : 8), trackId);
    return copy;
  }
  if (head.type === "trex" || head.type === "trep") {
    writeUint32(copy, head.headerSize + 4, trackId);
    return copy;
  }
  throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "无法改写缓存轨道的 track_ID");
}

/**
 * 改写 moof：把 tfhd 的 track_ID 换成合并后的编号，并把 mfhd 的片段序号改成全局递增。
 * moof 内的 trun 数据偏移以 moof 起点计算，长度不变所以偏移依然有效。
 */
export function patchFragmentBytes(bytes, { trackId, sequenceNumber } = {}) {
  const moof = readBoxHeader(bytes, 0);
  if (!moof || moof.type !== "moof") {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "只能改写 moof 片段");
  }
  if (trackId !== undefined && trackId !== null) {
    const traf = listBoxes(bytes, moof.headerSize, moof.size).find((box) => box.type === "traf");
    if (!traf) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存片段缺少 traf");
    const tfhd = listBoxes(bytes, traf.offset + traf.headerSize, traf.end).find((box) => box.type === "tfhd");
    if (!tfhd) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存片段缺少 tfhd");
    writeUint32(bytes, tfhd.offset + tfhd.headerSize + 4, trackId);
  }
  if (sequenceNumber !== undefined && sequenceNumber !== null) {
    const mfhd = listBoxes(bytes, moof.headerSize, moof.size).find((box) => box.type === "mfhd");
    if (!mfhd) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存片段缺少 mfhd");
    writeUint32(bytes, mfhd.offset + mfhd.headerSize + 4, sequenceNumber);
  }
  return bytes;
}

function parseFtyp(bytes) {
  if (!bytes) return null;
  const header = readBoxHeader(bytes, 0);
  if (!header || header.type !== "ftyp") return null;
  const payload = bytes.subarray(header.headerSize, header.size);
  const brands = [];
  for (let offset = 8; offset + 4 <= payload.length; offset += 4) brands.push(latin1(payload, offset, offset + 4));
  return { major: latin1(payload, 0, 4), minor: payload.slice(4, 8), brands };
}

/** 合并两条轨道的 ftyp：保留主品牌并去重兼容品牌，让播放器知道可用编码。 */
function mergeFtyp(videoFtyp, audioFtyp) {
  const primary = parseFtyp(videoFtyp) || parseFtyp(audioFtyp);
  if (!primary) {
    return makeBox("ftyp", concatBytes([ascii("isom"), new Uint8Array([0, 0, 2, 0]), ascii("isom"), ascii("iso2"), ascii("mp41")]));
  }
  const seen = new Set();
  const brands = [];
  for (const brand of [primary.major, ...primary.brands, ...(parseFtyp(audioFtyp)?.brands || [])]) {
    if (!brand || seen.has(brand)) continue;
    seen.add(brand);
    brands.push(brand);
  }
  const payload = new Uint8Array(8 + brands.length * 4);
  payload.set(ascii(primary.major), 0);
  payload.set(primary.minor, 4);
  brands.forEach((brand, index) => payload.set(ascii(brand), 8 + index * 4));
  return makeBox("ftyp", payload);
}

/**
 * 用两条轨道各自的 moov 生成合并后的 ftyp + moov。
 * 视频轨固定为 track_ID 1，音频轨固定为 track_ID 2，并同步改写 mvex/trex/trep。
 */
export function buildMergedInit(video, audio) {
  const videoTrackId = 1;
  const audioTrackId = 2;
  const videoMvexChildren = listBoxes(video.mvexBytes, 8, video.mvexBytes.length);
  const audioMvexChildren = listBoxes(audio.mvexBytes, 8, audio.mvexBytes.length);
  const takeBoxes = (children, types) => children.filter((box) => types.includes(box.type));

  const mehd = takeBoxes(videoMvexChildren, ["mehd"])[0] || takeBoxes(audioMvexChildren, ["mehd"])[0] || null;
  const mvexParts = [];
  if (mehd) mvexParts.push(video.mvexBytes.slice(mehd.offset, mehd.end));
  for (const [children, bytes, trackId] of [
    [videoMvexChildren, video.mvexBytes, videoTrackId],
    [audioMvexChildren, audio.mvexBytes, audioTrackId]
  ]) {
    for (const box of takeBoxes(children, ["trex", "trep"])) {
      mvexParts.push(patchTrackId(bytes.slice(box.offset, box.end), trackId));
    }
  }
  // mvhd 的 next_track_ID 必须大于最大轨道号；时长取两条轨道中较长的一条。
  const mvhd = patchMvhd(video.mvhdBytes, {
    duration: Math.max(Number(video.duration) || 0, Number(audio.duration) || 0) || null,
    nextTrackId: audioTrackId + 1
  });
  const moov = makeBox("moov", concatBytes([
    mvhd,
    patchTrackId(video.trakBytes, videoTrackId),
    patchTrackId(audio.trakBytes, audioTrackId),
    makeBox("mvex", concatBytes(mvexParts))
  ]));
  const ftypBytes = mergeFtyp(video.ftypBytes, audio.ftypBytes);
  return {
    bytes: concatBytes([ftypBytes, moov]),
    ftypBytes,
    moovBytes: moov,
    videoTrackId,
    audioTrackId
  };
}

function dataSize(data) {
  if (data instanceof Blob) return data.size;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  throw new Mp4MergeError(MP4_MERGE_PROBLEM.TRUNCATED, "缓存分块格式无法识别");
}

async function readChunkRange(data, start, end) {
  if (data instanceof Blob) return new Uint8Array(await data.slice(start, end).arrayBuffer());
  const view = data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return view.slice(start, end);
}

/** 把分块数组包装成可按绝对偏移随机读取的访问器。 */
function createChunkAccess(chunks) {
  const entries = [];
  let total = 0;
  for (const chunk of chunks) {
    const data = chunk?.data ?? chunk;
    const size = dataSize(data);
    entries.push({ data, size, start: total });
    total += size;
  }
  return {
    totalBytes: total,
    async readRange(start, length) {
      if (length <= 0) return new Uint8Array(0);
      if (start < 0 || start + length > total) {
        throw new Mp4MergeError(MP4_MERGE_PROBLEM.TRUNCATED, "缓存轨道分块不完整，无法合并");
      }
      const result = new Uint8Array(length);
      let offset = start;
      let remaining = length;
      let written = 0;
      while (remaining > 0) {
        let low = 0;
        let high = entries.length - 1;
        while (low < high) {
          const middle = (low + high + 1) >> 1;
          if (entries[middle].start <= offset) low = middle;
          else high = middle - 1;
        }
        const entry = entries[low];
        const within = offset - entry.start;
        const take = Math.min(remaining, entry.size - within);
        const view = await readChunkRange(entry.data, within, within + take);
        result.set(view.subarray(0, take), written);
        offset += take;
        remaining -= take;
        written += take;
      }
      return result;
    }
  };
}

function isSkippable(type) {
  return SKIP_BOX_TYPES.has(type);
}

/**
 * 顺序扫描一条轨道的分块：先读出初始化段，再按顺序产出片段。
 * 片段读取使用随机访问，因此内存占用只与单个片段大小相关。
 */
export async function readHeaderAt(access, offset, scratch = new Uint8Array(16)) {
  if (offset + 8 > access.totalBytes) return null;
  const available = Math.min(16, access.totalBytes - offset);
  const bytes = await access.readRange(offset, available);
  if (available === 16) scratch.set(bytes);
  return readBoxHeader(available === 16 ? scratch : bytes, 0);
}

/** 顺序列出顶层盒子；只读取盒子头，不会把 mdat 正文读进内存。 */
export async function scanTopLevelBoxes(access) {
  const boxes = [];
  const scratch = new Uint8Array(16);
  let position = 0;
  while (position + 8 <= access.totalBytes) {
    const header = await readHeaderAt(access, position, scratch);
    if (!header) break;
    const size = header.toEnd ? access.totalBytes - position : header.size;
    if (size < header.headerSize || position + size > access.totalBytes) {
      throw new Mp4MergeError(MP4_MERGE_PROBLEM.TRUNCATED, `缓存文件的 ${header.type} 盒子在中间被截断`);
    }
    boxes.push({ type: header.type, size, headerSize: header.headerSize, offset: position, end: position + size });
    position += size;
  }
  return boxes;
}

export function createFragmentReader(chunks) {
  const access = createChunkAccess(chunks);
  let position = 0;
  const headerBuffer = new Uint8Array(16);

  const headerAt = (offset) => readHeaderAt(access, offset, headerBuffer);

  /** 跳过 ftyp / moov 等初始化盒子，直接定位到第一个 moof（只提取单条轨道时使用）。 */
  async function skipToFragments() {
    while (position < access.totalBytes) {
      const header = await headerAt(position);
      if (!header) return;
      if (header.type === "moof") return;
      if (header.type !== "ftyp" && header.type !== "moov" && !isSkippable(header.type)) {
        throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, `缓存文件出现无法识别的顶层盒子：${header.type}`);
      }
      position += header.toEnd ? access.totalBytes - position : header.size;
    }
  }

  async function readInit() {
    let ftypBytes = null;
    while (position < access.totalBytes) {
      const header = await headerAt(position);
      if (!header) break;
      if (header.type === "ftyp") {
        ftypBytes = await access.readRange(position, header.size);
        position += header.size;
        continue;
      }
      if (header.type === "moov") {
        const moovBytes = await access.readRange(position, header.size);
        position += header.size;
        return { ...parseInitSegment(moovBytes), ftypBytes };
      }
      if (header.type === "mdat") {
        throw new Mp4MergeError(MP4_MERGE_PROBLEM.NOT_FRAGMENTED, "缓存轨道不是 fragmented MP4（先出现 mdat）");
      }
      if (!isSkippable(header.type)) {
        throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存轨道出现无法识别的顶层盒子：" + header.type);
      }
      position += header.size;
    }
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.NOT_FRAGMENTED, "缓存轨道缺少 moov 初始化段");
  }

  async function nextFragment() {
    while (position < access.totalBytes) {
      const header = await headerAt(position);
      if (!header) break;
      if (header.type !== "moof") {
        if (!isSkippable(header.type)) {
          throw new Mp4MergeError(
            MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT,
            header.type === "mdat"
              ? "缓存轨道不是 fragmented MP4（片段之间出现裸 mdat）"
              : "缓存轨道出现无法识别的顶层盒子：" + header.type
          );
        }
        position += header.size;
        continue;
      }
      const moofBytes = await access.readRange(position, header.size);
      const parsed = parseFragment(moofBytes);
      let end = position + header.size;
      let mediaEnd = 0;
      // 片段 = moof 以及它之后直到下一个 moof 的内容。moof 与最后一个 mdat 之间的字节必须
      // 逐字节保留（trun 的 data_offset 以 moof 起点计算）；最后一个 mdat 之后的 sidx /
      // mfra / free 等尾部盒子引用的是原始文件偏移，交错后不再成立，直接丢弃。
      while (end < access.totalBytes) {
        const next = await headerAt(end);
        if (!next || next.type === "moof") break;
        if (next.size < next.headerSize || next.toEnd || end + next.size > access.totalBytes) {
          throw new Mp4MergeError(MP4_MERGE_PROBLEM.TRUNCATED, "缓存片段在盒子中间被截断");
        }
        end += next.size;
        if (next.type === "mdat") mediaEnd = end;
      }
      const fragmentEnd = mediaEnd || end;
      const bytes = await access.readRange(position, fragmentEnd - position);
      position = end;
      return { ...parsed, moofBytes, bytes, byteLength: bytes.length };
    }
    return null;
  }

  return { totalBytes: access.totalBytes, readInit, skipToFragments, nextFragment };
}

/**
 * 合并两条 fragmented MP4 轨道。
 * 返回 { header, stream() }：先写 header（ftyp + moov），再按解码时间交错写入片段。
 */
export async function createMergedFragmentedMp4({ video, audio }) {
  const videoReader = createFragmentReader(video.chunks);
  const audioReader = createFragmentReader(audio.chunks);
  const videoInit = await videoReader.readInit();
  const audioInit = await audioReader.readInit();
  if (Math.max(videoInit.timescale, audioInit.timescale) <= 0) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存轨道缺少媒体时间刻度");
  }
  const init = buildMergedInit(videoInit, audioInit);

  const seconds = (fragment, trackInit) => (
    fragment.decodeTime === null || fragment.decodeTime === undefined || !trackInit.timescale
      ? null
      : fragment.decodeTime / trackInit.timescale
  );

  async function* stream() {
    let sequenceNumber = 1;
    let videoFragment = await videoReader.nextFragment();
    let audioFragment = await audioReader.nextFragment();
    while (videoFragment || audioFragment) {
      const videoTime = videoFragment ? seconds(videoFragment, videoInit) : null;
      const audioTime = audioFragment ? seconds(audioFragment, audioInit) : null;
      // 按解码时间交错；时间信息缺失时视频轨优先，保证输出确定。
      const pickVideo = Boolean(videoFragment) && (
        !audioFragment || videoTime === null || audioTime === null || videoTime <= audioTime
      );
      const fragment = pickVideo ? videoFragment : audioFragment;
      const targetTrackId = pickVideo ? init.videoTrackId : init.audioTrackId;
      if (fragment.trackId !== targetTrackId || fragment.sequenceNumber !== sequenceNumber) {
        patchFragmentBytes(fragment.bytes, { trackId: targetTrackId, sequenceNumber });
      }
      yield fragment.bytes;
      sequenceNumber += 1;
      if (pickVideo) videoFragment = await videoReader.nextFragment();
      else audioFragment = await audioReader.nextFragment();
    }
  }

  return {
    header: init.bytes,
    videoTrackId: init.videoTrackId,
    audioTrackId: init.audioTrackId,
    sourceBytes: videoReader.totalBytes + audioReader.totalBytes,
    stream
  };
}

/** 合并结果自检：读回开头字节确认 ftyp + 双轨 moov，并核对轨道编号。 */
export function verifyMergedHeader(bytes, { videoTrackId = 1, audioTrackId = 2 } = {}) {
  const boxes = listBoxes(bytes);
  const ftyp = boxes.find((box) => box.type === "ftyp");
  const moov = boxes.find((box) => box.type === "moov");
  if (!ftyp || !moov) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "合并结果缺少 ftyp 或 moov");
  }
  const children = listBoxes(bytes, moov.offset + moov.headerSize, moov.end);
  const traks = children.filter((box) => box.type === "trak");
  const mvex = children.find((box) => box.type === "mvex");
  if (traks.length !== 2 || !mvex) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "合并结果必须包含两条媒体轨与 mvex");
  }
  const trackIds = traks.map((trak) => {
    const tkhd = listBoxes(bytes, trak.offset + trak.headerSize, trak.end).find((box) => box.type === "tkhd");
    const version = bytes[tkhd.offset + tkhd.headerSize];
    return readUint32(bytes, tkhd.offset + tkhd.headerSize + 4 + (version === 1 ? 16 : 8));
  });
  if (trackIds[0] !== videoTrackId || trackIds[1] !== audioTrackId) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "合并结果的轨道编号不正确");
  }
  return { trackIds };
}

const AUDIO_SAMPLE_ENTRY_TYPES = Object.freeze({
  mp4a: { mimeType: "audio/mp4", family: "aac" },
  fLaC: { mimeType: "audio/mp4", family: "flac" },
  "ec-3": { mimeType: "audio/mp4", family: "dolby" },
  "ac-3": { mimeType: "audio/mp4", family: "dolby" },
  "ec-4": { mimeType: "audio/mp4", family: "dolby" },
  Opus: { mimeType: "audio/mp4", family: "other" },
  opus: { mimeType: "audio/mp4", family: "other" },
  alac: { mimeType: "audio/mp4", family: "other" },
  "mp3 ": { mimeType: "audio/mpeg", family: "mp3" },
  ".mp3": { mimeType: "audio/mpeg", family: "mp3" }
});

function makeDefaultFtyp() {
  return makeBox("ftyp", concatBytes([
    ascii("isom"),
    new Uint8Array([0, 0, 2, 0]),
    ascii("isom"),
    ascii("iso2"),
    ascii("mp41")
  ]));
}

function readDescriptor(bytes, start, end) {
  if (start + 2 > end) return null;
  const tag = bytes[start];
  let size = 0;
  let offset = start + 1;
  for (let index = 0; index < 4 && offset < end; index += 1) {
    size = (size << 7) | (bytes[offset] & 0x7f);
    const more = (bytes[offset] & 0x80) !== 0;
    offset += 1;
    if (!more) break;
  }
  return { tag, dataStart: offset, end: Math.min(end, offset + size) };
}

/** 从 mp4a 采样描述里的 esds 还原 AAC 的 AudioObjectType，用于写出真实 codec 字符串。 */
function readAudioObjectType(sampleEntryBytes) {
  const header = readBoxHeader(sampleEntryBytes, 0);
  if (!header) return null;
  const esds = listBoxes(sampleEntryBytes, header.headerSize + 28, header.size)
    .find((box) => box.type === "esds");
  if (!esds) return null;
  const end = sampleEntryBytes.length;
  const base = esds.offset + esds.headerSize + 4;
  const esDescriptor = readDescriptor(sampleEntryBytes, base, end);
  if (!esDescriptor || esDescriptor.tag !== 0x03) return null;
  const configDescriptor = readDescriptor(sampleEntryBytes, esDescriptor.dataStart + 3, end);
  if (!configDescriptor || configDescriptor.tag !== 0x04) return null;
  const specificDescriptor = readDescriptor(sampleEntryBytes, configDescriptor.dataStart + 13, end);
  if (!specificDescriptor || specificDescriptor.tag !== 0x05) return null;
  const audioObjectType = sampleEntryBytes[specificDescriptor.dataStart] >> 3;
  return audioObjectType > 0 ? audioObjectType : null;
}

/** 读取音频采样描述（stsd 的第一个条目），得到容器与真实 codec 字符串。 */
function describeAudioSampleEntry(moovBytes, trak, { lenient = false } = {}) {
  const mdia = findChild(moovBytes, trak, ["mdia"]);
  const minf = mdia ? findChild(moovBytes, mdia, ["minf"]) : null;
  const stbl = minf ? findChild(moovBytes, minf, ["stbl"]) : null;
  const stsd = stbl ? listBoxes(moovBytes, stbl.offset + stbl.headerSize, stbl.end).find((box) => box.type === "stsd") : null;
  if (!stsd) {
    // fragmented 描述可以省掉 stsd；此时只能给出容器信息，具体编码由调用方兜底。
    if (lenient) return { sampleEntryType: "", mimeType: "audio/mp4", family: "other", codecs: "" };
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存视频缺少样本描述（stsd）");
  }
  const entryOffset = stsd.offset + stsd.headerSize + 8;
  const entry = readBoxHeader(moovBytes, entryOffset);
  const entryType = entry?.type || "";
  const typeInfo = AUDIO_SAMPLE_ENTRY_TYPES[entryType] || { mimeType: "audio/mp4", family: "other" };
  let codecs = entryType === "mp4a" ? "mp4a" : entryType.trim();
  if (entryType === "mp4a" && entry) {
    const audioObjectType = readAudioObjectType(moovBytes.slice(entryOffset, entryOffset + entry.size));
    codecs = audioObjectType ? `mp4a.40.${audioObjectType}` : "mp4a.40.2";
  }
  return { sampleEntryType: entryType, mimeType: typeInfo.mimeType, family: typeInfo.family, codecs };
}

/** 读取一条 stbl 的音频样本表，得到时长、样本数量与平均码率等元数据。 */
function describeAudioSampleTable(moovBytes, trak) {
  const described = describeTrak(moovBytes, trak);
  const entry = describeAudioSampleEntry(moovBytes, trak);
  const mdia = findChild(moovBytes, trak, ["mdia"]);
  const minf = mdia ? findChild(moovBytes, mdia, ["minf"]) : null;
  const stbl = minf ? findChild(moovBytes, minf, ["stbl"]) : null;
  const children = stbl ? listBoxes(moovBytes, stbl.offset + stbl.headerSize, stbl.end) : [];
  const stsz = children.find((box) => box.type === "stsz") || null;
  if (!stsz) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存视频缺少样本大小表，无法安全提取音轨");
  }

  const uniformSize = readUint32(moovBytes, stsz.offset + stsz.headerSize + 4);
  const sampleCount = readUint32(moovBytes, stsz.offset + stsz.headerSize + 8);
  let sampleBytes = 0;
  if (uniformSize) {
    sampleBytes = uniformSize * sampleCount;
  } else {
    for (let index = 0; index < sampleCount; index += 1) {
      sampleBytes += readUint32(moovBytes, stsz.offset + stsz.headerSize + 12 + index * 4);
    }
  }

  const mdhd = findChild(moovBytes, mdia, ["mdhd"]);
  const mdhdVersion = moovBytes[mdhd.offset + mdhd.headerSize];
  const duration = mdhdVersion === 1
    ? readUint64(moovBytes, mdhd.offset + mdhd.headerSize + 24)
    : readUint32(moovBytes, mdhd.offset + mdhd.headerSize + 16);
  const durationSeconds = described.timescale > 0 ? duration / described.timescale : 0;

  const stco = children.find((box) => box.type === "stco" || box.type === "co64");
  if (!stco) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存视频缺少分块偏移表，无法安全提取音轨");
  }

  return {
    ...described,
    ...entry,
    sampleCount,
    sampleBytes,
    chunkRanges: expandChunkRanges(moovBytes, children, stco, stsz),
    duration: durationSeconds,
    bandwidth: durationSeconds > 0 ? Math.round(sampleBytes * 8 / durationSeconds) : 0
  };
}

/** 按 stsc / stsz / stco 展开每个分块在源文件中的字节区间。 */
function expandChunkRanges(moovBytes, stblChildren, stco, stsz) {
  const stsc = stblChildren.find((box) => box.type === "stsc");
  if (!stsc) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存视频缺少 stsc 分块映射表");
  const uniformSize = readUint32(moovBytes, stsz.offset + stsz.headerSize + 4);
  const sampleCount = readUint32(moovBytes, stsz.offset + stsz.headerSize + 8);
  const sampleSizeAt = (index) => (uniformSize
    ? uniformSize
    : readUint32(moovBytes, stsz.offset + stsz.headerSize + 12 + index * 4));
  const entryCount = readUint32(moovBytes, stsc.offset + stsc.headerSize + 4);
  const entries = [];
  for (let index = 0; index < entryCount; index += 1) {
    const at = stsc.offset + stsc.headerSize + 8 + index * 12;
    entries.push({ firstChunk: readUint32(moovBytes, at), samplesPerChunk: readUint32(moovBytes, at + 4) });
  }
  const chunkCount = readUint32(moovBytes, stco.offset + stco.headerSize + 4);
  const width = stco.type === "co64" ? 8 : 4;
  const ranges = [];
  let sampleIndex = 0;
  for (let chunkIndex = 1; chunkIndex <= chunkCount; chunkIndex += 1) {
    let samplesPerChunk = 0;
    for (const entry of entries) {
      if (entry.firstChunk > chunkIndex) break;
      samplesPerChunk = entry.samplesPerChunk;
    }
    let length = 0;
    for (let index = 0; index < samplesPerChunk && sampleIndex + index < sampleCount; index += 1) {
      length += sampleSizeAt(sampleIndex + index);
    }
    const at = stco.offset + stco.headerSize + 8 + (chunkIndex - 1) * width;
    ranges.push({
      offset: width === 8 ? readUint64(moovBytes, at) : readUint32(moovBytes, at),
      length
    });
    sampleIndex += samplesPerChunk;
  }
  return ranges;
}

/** 只有尺寸已知、正文稍后流式写入的盒子头。 */
function makeStreamingHeader(type, payloadSize) {
  const header = new Uint8Array(8);
  writeUint32(header, 0, payloadSize + 8);
  header.set(ascii(type), 4);
  return header;
}

/** 把 stco / co64 里的样本偏移改写成新文件里的对应位置；mapper 接收 (原偏移, 序号)。 */
function shiftChunkOffsets(trakBytes, mapOffset) {
  const copy = trakBytes.slice();
  const trak = listBoxes(copy)[0];
  const mdia = findChild(copy, trak, ["mdia"]);
  const minf = mdia ? findChild(copy, mdia, ["minf"]) : null;
  const stbl = minf ? findChild(copy, minf, ["stbl"]) : null;
  const box = stbl
    ? listBoxes(copy, stbl.offset + stbl.headerSize, stbl.end)
      .find((item) => item.type === "stco" || item.type === "co64")
    : null;
  if (!box) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存视频缺少分块偏移表，无法安全提取音轨");
  }
  const width = box.type === "co64" ? 8 : 4;
  const count = readUint32(copy, box.offset + box.headerSize + 4);
  for (let index = 0; index < count; index += 1) {
    const at = box.offset + box.headerSize + 8 + index * width;
    const previous = width === 8 ? readUint64(copy, at) : readUint32(copy, at);
    const next = mapOffset(previous, index);
    if (width === 8) {
      writeUint32(copy, at, Math.floor(next / 0x100000000));
      writeUint32(copy, at + 4, next % 0x100000000);
    } else {
      writeUint32(copy, at, next);
    }
  }
  return copy;
}

function readBoxTrackId(bytes) {
  const header = readBoxHeader(bytes, 0);
  return header ? readUint32(bytes, header.headerSize + 4) : 0;
}

/**
 * 从一个 MP4 里只取出音频轨，等价于 `ffmpeg -i in.mp4 -vn -c:a copy out.m4a`：
 * 不重新编码任何音频样本，只重建 moov、把音轨的样本偏移平移到新文件并复制媒体数据段。
 *
 * - 非 fragmented MP4：输出 ftyp + 单轨 moov + 原样复制的 mdat，样本偏移按常量平移；
 * - fragmented MP4：只保留音频轨的 moof/mdat，track_ID 改写为 1；
 * - 轨道里没有音频轨、样本偏移不在 mdat 内或文件被截断时抛出 Mp4MergeError。
 */
export async function createAudioOnlyMp4({ chunks }) {
  const access = createChunkAccess(chunks);
  const boxes = await scanTopLevelBoxes(access);
  const ftypBox = boxes.find((box) => box.type === "ftyp") || null;
  const moovBox = boxes.find((box) => box.type === "moov") || null;
  if (!moovBox) throw new Mp4MergeError(MP4_MERGE_PROBLEM.NOT_FRAGMENTED, "缓存视频缺少 moov 初始化段");

  const ftypBytes = ftypBox ? await access.readRange(ftypBox.offset, ftypBox.size) : null;
  const moovBytes = await access.readRange(moovBox.offset, moovBox.size);
  const moovHeader = readBoxHeader(moovBytes, 0);
  const moovChildren = listBoxes(moovBytes, moovHeader.headerSize, moovBytes.length);
  const mvhdBox = moovChildren.find((box) => box.type === "mvhd");
  const mvexBox = moovChildren.find((box) => box.type === "mvex") || null;
  if (!mvhdBox) throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存视频缺少 mvhd 盒子");

  const audioTrakBox = moovChildren
    .filter((box) => box.type === "trak")
    .find((trak) => describeTrak(moovBytes, trak).handlerType === "soun");
  if (!audioTrakBox) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "这个 MP4 里没有音频轨，无法仅缓存音频");
  }
  // fragmented 轨道的 stbl 里通常只有 stsd（没有样本表），因此只解析采样描述。
  const audioTable = mvexBox
    ? { ...describeTrak(moovBytes, audioTrakBox), ...describeAudioSampleEntry(moovBytes, audioTrakBox, { lenient: true }) }
    : describeAudioSampleTable(moovBytes, audioTrakBox);
  const audioTrakBytes = moovBytes.slice(audioTrakBox.offset, audioTrakBox.end);
  const mvhdBytes = patchMvhd(moovBytes.slice(mvhdBox.offset, mvhdBox.end), { nextTrackId: 2 });

  if (mvexBox) {
    const mvexBytes = moovBytes.slice(mvexBox.offset, mvexBox.end);
    const mvexChildren = listBoxes(mvexBytes, 8, mvexBytes.length);
    const parts = [];
    const mehd = mvexChildren.find((box) => box.type === "mehd");
    if (mehd) parts.push(mvexBytes.slice(mehd.offset, mehd.end));
    for (const box of mvexChildren.filter((item) => item.type === "trex" || item.type === "trep")) {
      const boxBytes = mvexBytes.slice(box.offset, box.end);
      if (readBoxTrackId(boxBytes) === audioTable.trackId) parts.push(patchTrackId(boxBytes, 1));
    }
    const header = concatBytes([
      ftypBytes || makeDefaultFtyp(),
      makeBox("moov", concatBytes([
        mvhdBytes,
        patchTrackId(audioTrakBytes, 1),
        makeBox("mvex", concatBytes(parts))
      ]))
    ]);
    const reader = createFragmentReader(chunks);
    await reader.skipToFragments();
    async function* streamFragments() {
      let sequenceNumber = 1;
      let fragment = await reader.nextFragment();
      while (fragment) {
        if (fragment.trackId === audioTable.trackId) {
          patchFragmentBytes(fragment.bytes, { trackId: 1, sequenceNumber });
          sequenceNumber += 1;
          yield fragment.bytes;
        }
        fragment = await reader.nextFragment();
      }
    }
    return {
      header,
      audioTrack: { ...audioTable, trackId: 1 },
      sourceBytes: access.totalBytes,
      fragmented: true,
      stream: streamFragments
    };
  }

  const mdatBoxes = boxes.filter((box) => box.type === "mdat");
  if (!mdatBoxes.length) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.NOT_FRAGMENTED, "缓存视频缺少媒体数据段（mdat）");
  }
  const sizedTrak = patchTrackId(audioTrakBytes, 1);

  // 只保留音频分块：把它们依次紧凑写进新的 mdat，并同步改写 stco / co64。
  const ranges = audioTable.chunkRanges || [];
  const audioBytes = ranges.reduce((sum, range) => sum + range.length, 0);
  if (!ranges.length || audioBytes !== audioTable.sampleBytes) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "音频样本表与分块长度不一致，无法安全提取音轨");
  }
  if (audioBytes + 8 > MAX_UINT32) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "音频数据超过单文件 MP4 的 32 位长度上限");
  }
  for (const range of ranges) {
    const inside = mdatBoxes.some((box) => {
      const start = box.offset + box.headerSize;
      const end = box.offset + box.size;
      return range.offset >= start && range.offset + range.length <= end;
    });
    if (!inside) {
      throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缓存视频的音频样本不在媒体数据段内，无法安全提取音轨");
    }
  }

  const dataStart = (ftypBytes || makeDefaultFtyp()).length + 8 + mvhdBytes.length + sizedTrak.length + 8;
  const newOffsets = [];
  let cursor = dataStart;
  for (const range of ranges) {
    newOffsets.push(cursor);
    cursor += range.length;
  }
  const moov = makeBox("moov", concatBytes([
    mvhdBytes,
    shiftChunkOffsets(sizedTrak, (_offset, index) => newOffsets[index])
  ]));
  const header = concatBytes([ftypBytes || makeDefaultFtyp(), moov, makeStreamingHeader("mdat", audioBytes)]);
  if (header.length !== dataStart) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "提取音轨时头部长度计算不一致");
  }

  // 源文件里音视频分块交错，逐块小读会退化；这里用 4 MiB 预读窗口按顺序取音频字节。
  async function* streamSamples() {
    const windowSize = 4 * 1024 * 1024;
    let windowStart = -1;
    let windowBytes = null;
    for (const range of ranges) {
      if (range.length <= 0) continue;
      if (
        windowBytes === null ||
        range.offset < windowStart ||
        range.offset + range.length > windowStart + windowBytes.length
      ) {
        windowStart = range.offset;
        windowBytes = await access.readRange(
          range.offset,
          Math.min(Math.max(windowSize, range.length), access.totalBytes - range.offset)
        );
      }
      yield windowBytes.subarray(range.offset - windowStart, range.offset - windowStart + range.length);
    }
  }
  return {
    header,
    audioTrack: { ...audioTable, trackId: 1 },
    sourceBytes: access.totalBytes,
    fragmented: false,
    stream: streamSamples
  };
}

/** 仅音频文件自检：必须只有一条音频轨、track_ID 为 1，且样本偏移都落在 mdat 之内。 */
export function verifyAudioOnlyMp4(bytes, { totalBytes, requireMdat = true } = {}) {
  const boxes = listBoxes(bytes);
  const ftyp = boxes.find((box) => box.type === "ftyp");
  const moov = boxes.find((box) => box.type === "moov");
  const mdat = boxes.find((box) => box.type === "mdat");
  if (!ftyp || !moov || (requireMdat && !mdat)) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "仅音频文件缺少 ftyp、moov 或 mdat");
  }
  const children = listBoxes(bytes, moov.offset + moov.headerSize, moov.end);
  const traks = children.filter((box) => box.type === "trak");
  if (traks.length !== 1) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "仅音频文件必须只包含一条媒体轨");
  }
  const described = describeTrak(bytes, traks[0]);
  if (described.handlerType !== "soun" || described.trackId !== 1) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "仅音频文件保留的不是 track_ID 1 的音频轨");
  }
  if (Number(totalBytes) > 0 && bytes.length !== Number(totalBytes)) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.TRUNCATED, "仅音频文件字节数与元数据不一致");
  }
  return {
    trackId: described.trackId,
    timescale: described.timescale,
    mdatDataStart: mdat ? mdat.offset + mdat.headerSize : 0
  };
}
