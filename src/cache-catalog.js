import { listVideos, listVideosForBvid } from "./db.js";
import { getVideoPageId, hasCompleteByteCount, isAudioOnlyCache, parseBiliVideoUrl } from "./utils.js";
import { isExpiredCache } from "./temporary-cache.js";

function bestCache(videos) {
  return videos.sort((left, right) => (
    (Number(right.quality) || 0) - (Number(left.quality) || 0) ||
    (Number(right.completedAt) || 0) - (Number(left.completedAt) || 0)
  ))[0] || null;
}

function pageNumber(video) {
  const page = Number(video.page);
  if (Number.isSafeInteger(page) && page > 0) return page;
  if (Number(video.pageCount) === 1) return 1;
  return parseBiliVideoUrl(video.url).page;
}

/**
 * 直接使用下载时保存的 BV/av、分 P 与 CID。旧记录缺分 P，或同一页别名指到多个 CID 时，
 * 才请求网页元信息消歧。下载地址的签名和登录会话不参与片库查找。
 * @param {string} url 当前视频页地址
 * @param {(url: string) => Promise<object>} resolvePage 旧记录的远程消歧入口
 * @param {number} [quality] 完全缓冲按当前档位查找
 * @returns {Promise<{video: object|null}>}
 */
export async function lookupCachedPage(url, resolvePage, quality = 0) {
  const parsed = parseBiliVideoUrl(url);
  if (!parsed.supported) return { video: null };
  const rows = parsed.bvid ? await listVideosForBvid(parsed.bvid) : await listVideos();
  const playable = rows.filter(video => video.status === "complete" && !isExpiredCache(video) && hasCompleteByteCount(video) &&
    !isAudioOnlyCache(video) && (!quality || Number(video.quality) === quality));
  const candidates = parsed.aid ? playable.filter(video => Number(video.aid) === parsed.aid) : playable;
  const exact = candidates.filter(video => pageNumber(video) === parsed.page);
  const pageIds = new Set(exact.map(getVideoPageId));
  if (pageIds.size === 1) return { video: bestCache(exact) };

  const needsResolution = pageIds.size > 1 || candidates.some(video => !pageNumber(video)) ||
    (parsed.aid && playable.some(video => !Number(video.aid)));
  if (!needsResolution) return { video: null };
  const pageInfo = await resolvePage(url);
  return { video: bestCache(playable.filter(video => getVideoPageId(video) === pageInfo.id)) };
}
