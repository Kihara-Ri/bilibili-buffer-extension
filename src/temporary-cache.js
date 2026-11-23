export const TEMPORARY_CACHE_ALARM = "bili-buffer-temporary-cache-expiry-v1";
export const TEMPORARY_CACHE_TTL = 30 * 60_000;

/** @param {object} video @returns {boolean} 只有明确来自进页全速缓冲的记录才允许自动删除。 */
export function isTemporaryCache(video) {
  return video?.automatic === true && video.cacheOrigin === "full-speed";
}

/** @param {object} video @param {number} now @returns {boolean} */
export function isExpiredCache(video, now = Date.now()) {
  return isTemporaryCache(video) && video.cacheExpiresAt > 0 && video.cacheExpiresAt <= now;
}

/** @param {object} video 片库记录 @param {object} page 浏览器当前标签的投稿与分 P @returns {boolean} */
export function isCachePageOpen(video, page) {
  return page.supported && Math.min(page.page, Number(video.pageCount) || Infinity) === Number(video.page) &&
    (page.bvid ? video.bvid === page.bvid : Number(video.aid) === page.aid);
}
