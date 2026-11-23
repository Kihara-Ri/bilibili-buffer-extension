import { isAudioOnlyCache, parseBiliVideoUrl } from "./utils.js";
import { readCommittedChunks } from "./db.js";

// 有些 4K 的单个 SIDX 分段超过 16 MiB。单次读保持低于全局 32 MiB，
// 大画轨在途时给同一次跳转的音轨留出额度。
export const COMMITTED_READ_LIMIT = 24 * 1024 * 1024;
const COMMITTED_IN_FLIGHT_LIMIT = 32 * 1024 * 1024;
const SPECULATIVE_SLICE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_CHUNK_BYTES = 16 * 1024 * 1024;
const MEDIA_HOST = /(^|\.)(bilivideo\.com|bilivideo\.cn|hdslb\.com|akamaized\.net)$/;
const SOURCE_ROLES = ["video", "audio", "media"];
const positive = value => Number.isSafeInteger(value) && value > 0;

/** @param {string} value 原始媒体 URL @returns {string} 不含签名的媒体路径 */
export function committedMediaPath(value) {
  if (typeof value !== "string" || value.length > 4096) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && MEDIA_HOST.test(url.hostname) &&
        !url.username && !url.password && !url.hash && url.pathname.length <= 512) return url.pathname;
  } catch { /* 来自页面的地址只能作为候选，不参与授权。 */ }
  return "";
}

function matchesPage(video, page) {
  if (!page?.supported || (page.bvid ? video.bvid !== page.bvid : Number(video.aid) !== page.aid)) return false;
  const part = Number(video.page) || (Number(video.pageCount) === 1 ? 1 : parseBiliVideoUrl(video.url).page);
  return part === page.page;
}

/** 只公布能按分块主键定位的源轨道。重封装发布后，同事务释放的原始轨道立即退场。
 * @param {object} video @param {object} page @param {string} partition @returns {object[]}
 */
export function committedSources(video, page, partition) {
  if (!video || !partition || video.sourcePartition !== partition || video.merged || video.extractedFrom ||
      isAudioOnlyCache(video) || !matchesPage(video, page) ||
      !positive(video.createdAt) || !positive(video.runStartedAt)) return [];
  const descriptors = [];
  for (const role of SOURCE_ROLES) {
    const track = role === "media" && video.mediaKind === "progressive" ? video : video.tracks?.[role];
    if (!track || track.releasedIntoMerged) continue;
    const { sourceChunkBytes: chunkBytes, totalBytes: total, chunkCount } = track;
    const end = track.committedBytes ?? track.resumeBytes;
    if (![chunkBytes, total, end].every(positive) || end > total ||
        chunkBytes < 64 * 1024 || chunkBytes > MAX_SOURCE_CHUNK_BYTES || chunkCount !== Math.ceil(end / chunkBytes) ||
        (end !== total && end % chunkBytes !== 0)) continue;
    const paths = [...new Set((track.sourceUrls || []).map(committedMediaPath).filter(Boolean))].slice(0, 8);
    if (paths.length) descriptors.push({
      id: video.id, createdAt: video.createdAt, runStartedAt: video.runStartedAt,
      role, paths, total, end, chunkBytes, contentType: track.mimeType || "application/octet-stream"
    });
  }
  return descriptors;
}

/** @param {object} request @returns {boolean} */
export function validCommittedRead(request) {
  return typeof request?.id === "string" && request.id.length <= 256 &&
    positive(request.createdAt) && positive(request.runStartedAt) && SOURCE_ROLES.includes(request.role) &&
    positive(request.total) && Number.isSafeInteger(request.start) && request.start >= 0 &&
    positive(request.end) && request.end > request.start && request.end <= request.total &&
    request.end - request.start <= COMMITTED_READ_LIMIT && Boolean(committedMediaPath(request.url));
}

/** 按需以 Blob 切片拼出正文。缺块、错位或残缺分块均视为未命中，读取方可回原线路。
 * @param {object[]} rows @param {object} track @param {number} start @param {number} end @returns {Blob|null}
 */
export function sliceCommittedChunks(rows, track, start, end) {
  if (end > track.end || end <= start) return null;
  const parts = [];
  let cursor = start;
  for (const row of rows) {
    const offset = Math.floor(cursor / track.chunkBytes) * track.chunkBytes;
    const size = Math.min(track.chunkBytes, track.end - offset);
    if (!row || row.index * track.chunkBytes !== offset || row.data?.size !== size) return null;
    const stop = Math.min(end, offset + size);
    parts.push(row.data.slice(cursor - offset, stop - offset));
    cursor = stop;
  }
  return cursor === end ? new Blob(parts, { type: track.contentType }) : null;
}

/** Offscreen 以短期 Blob URL 交付，Service Worker 消息只承载元数据。 */
export function createCommittedSourceReader() {
  const leases = new Map();
  let outstanding = 0;
  let outstandingBytes = 0;
  let speculativeRead = false;

  function release(url) {
    const lease = leases.get(url);
    if (!lease) return;
    leases.delete(url);
    clearTimeout(lease.timer);
    outstanding--;
    outstandingBytes -= lease.size;
    if (lease.speculative) speculativeRead = false;
    URL.revokeObjectURL(url);
  }

  return {
    release,
    /** @param {{request:object, page:object, partition:string}} input @returns {Promise<object>} */
    async read({ request, page, partition }) {
      if (!validCommittedRead(request) || !partition) return {};
      const size = request.end - request.start;
      const speculative = request.speculative === true;
      if (outstanding >= 8 || outstandingBytes + size > COMMITTED_IN_FLIGHT_LIMIT) return {};
      // 全站同时只允许一小片悬停读取。保留一整条前台 4K Range 的额度，
      // 正在播放或跳转的页面无需等鼠标预读释放。
      if (speculative && (speculativeRead || size > SPECULATIVE_SLICE_BYTES ||
          outstandingBytes + size > COMMITTED_IN_FLIGHT_LIMIT - COMMITTED_READ_LIMIT)) return {};
      if (speculative) speculativeRead = true;
      outstanding++;
      outstandingBytes += size;
      let url;
      try {
        const path = committedMediaPath(request.url);
        const found = await readCommittedChunks(request.id, request.role, request.start, request.end, row =>
          committedSources(row, page, partition).find(track =>
            track.createdAt === request.createdAt && track.runStartedAt === request.runStartedAt &&
            track.role === request.role && track.total === request.total && track.paths.includes(path)));
        if (!found) return {};
        const { track, chunks } = found;
        const blob = sliceCommittedChunks(chunks, track, request.start, request.end);
        if (!blob || blob.size !== size) return {};
        url = URL.createObjectURL(blob);
        leases.set(url, { size, speculative, timer: setTimeout(() => release(url), 3_000) });
        return { url, total: track.total, contentType: track.contentType };
      } finally {
        // 未消费的 URL 有短 TTL，页面消失、响应逾期也能自己回收额度。
        if (!url) {
          outstanding--;
          outstandingBytes -= size;
          if (speculative) speculativeRead = false;
        }
      }
    }
  };
}
