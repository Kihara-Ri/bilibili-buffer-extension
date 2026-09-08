import { getCodecFamily, makeMimeCodec, normalizeCodecPreference, normalizeQualityId } from "./utils.js";

export function getTrackUrls(track) {
  const primary = track?.baseUrl || track?.base_url;
  const backups = track?.backupUrl || track?.backup_url || [];
  return [primary, ...backups].filter(Boolean);
}

function isSupportedTrack(track) {
  const mimeType = track?.mimeType || track?.mime_type;
  const type = makeMimeCodec(mimeType, track?.codecs);
  if (!type || !(track?.hasSource || getTrackUrls(track).length)) return false;
  return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function"
    ? MediaSource.isTypeSupported(type)
    : /^(video|audio)\/mp4/i.test(type);
}

function codecPriority(codecs) {
  const value = String(codecs || "").toLowerCase();
  if (value.startsWith("avc1")) return 4;
  if (value.startsWith("av01")) return 3;
  if (value.startsWith("hvc1") || value.startsWith("hev1")) return 2;
  if (value.startsWith("mp4a")) return 4;
  return 1;
}

export function chooseRepresentation(tracks, predicate = () => true) {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((track) => predicate(track) && isSupportedTrack(track))
    .sort((left, right) => {
      const codecDifference = codecPriority(right.codecs) - codecPriority(left.codecs);
      return codecDifference || (Number(right.bandwidth) || 0) - (Number(left.bandwidth) || 0);
    })[0] || null;
}

export function chooseVideoRepresentation(tracks, quality, codecPreference) {
  const preference = normalizeCodecPreference(codecPreference);
  let candidates = (Array.isArray(tracks) ? tracks : [])
    .filter((track) => normalizeQualityId(track?.id) === quality && isSupportedTrack(track));
  if (preference !== "auto") {
    candidates = candidates.filter((track) => getCodecFamily(track?.codecs) === preference);
  }
  const efficientOrder = { av1: 0, hevc: 1, avc: 2, other: 3 };
  return candidates.sort((left, right) => (
    (Number(left.bandwidth) || Number.MAX_SAFE_INTEGER) -
      (Number(right.bandwidth) || Number.MAX_SAFE_INTEGER) ||
    efficientOrder[getCodecFamily(left.codecs)] - efficientOrder[getCodecFamily(right.codecs)]
  ))[0] || null;
}

