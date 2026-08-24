import { normalizeQualityId, parseBiliVideoUrl } from "./utils.js";

export const POPUP_SNAPSHOT_TTL = 30 * 60 * 1000;
export const POPUP_SNAPSHOT_MAX_AGE = 24 * 60 * 60 * 1000;

export function makePopupPageKey(inputUrl) {
  const parsed = parseBiliVideoUrl(inputUrl);
  if (parsed.supported) {
    const video = parsed.bvid
      ? `bv:${String(parsed.bvid).toUpperCase()}`
      : `av:${Number(parsed.aid) || 0}`;
    return `video:${video}:p${parsed.page}`;
  }
  try {
    const url = new URL(inputUrl);
    return `page:${url.hostname.toLowerCase()}${url.pathname}`;
  } catch {
    return "page:invalid";
  }
}

export function isPopupSnapshotMatch(snapshot, tabId, inputUrl) {
  return Boolean(
    snapshot &&
    Number.isInteger(tabId) &&
    snapshot.tabId === tabId &&
    snapshot.pageKey === makePopupPageKey(inputUrl) &&
    snapshot.pageInfo
  );
}

export function isPopupSnapshotFresh(snapshot, now = Date.now()) {
  const savedAt = Number(snapshot?.savedAt) || 0;
  return savedAt > 0 && now - savedAt >= 0 && now - savedAt < POPUP_SNAPSHOT_TTL;
}

export function choosePopupQuality(qualities, ...preferences) {
  const options = Array.isArray(qualities) ? qualities : [];
  const available = new Set(options.map((option) => normalizeQualityId(option?.quality)).filter(Boolean));
  for (const preference of preferences) {
    const quality = normalizeQualityId(preference);
    if (quality && available.has(quality)) return quality;
  }
  return normalizeQualityId(options[0]?.quality);
}
