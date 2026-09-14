import {
  getAudioFamily,
  getCodecFamily,
  makeMimeCodec,
  normalizeCodecPreference,
  normalizeQualityId
} from "./utils.js";

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

// 音频轨优先级：缓存视频时优先兼容性最好的 AAC，仅缓存音频时优先无损/杜比原轨。
const AUDIO_FAMILY_PRIORITY = Object.freeze({
  video: Object.freeze({ aac: 5, flac: 4, dolby: 3, other: 2 }),
  audio: Object.freeze({ flac: 5, dolby: 4, aac: 3, other: 2 })
});

/**
 * 选择音频表示。mode 为 "audio" 时优先 Hi-Res 无损（B 站 30251 fLaC），其次杜比全景声，最后按码率；
 * mode 为 "video" 时默认取兼容性最好的 AAC，保证合并后的文件到处能播。
 */
export function chooseAudioRepresentation(tracks, { mode = "video" } = {}) {
  const priority = AUDIO_FAMILY_PRIORITY[mode === "audio" ? "audio" : "video"];
  return (Array.isArray(tracks) ? tracks : [])
    .filter((track) => isSupportedTrack(track))
    .map((track) => ({ track, weight: priority[getAudioFamily(track)] ?? 0 }))
    .sort((left, right) => (
      right.weight - left.weight ||
      (Number(right.track.bandwidth) || 0) - (Number(left.track.bandwidth) || 0)
    ))[0]?.track || null;
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

