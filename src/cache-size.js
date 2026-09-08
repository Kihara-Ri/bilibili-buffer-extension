import { chooseRepresentation, chooseVideoRepresentation, getTrackUrls } from "./media-selection.js";

// Keep only sizing metadata in popup snapshots, without signed CDN addresses.
export function buildCacheSizeInfo(data, duration = 0) {
  const summarize = (track) => ({
    id: track.id, mimeType: track.mimeType || track.mime_type,
    codecs: track.codecs, bandwidth: track.bandwidth,
    hasSource: getTrackUrls(track).length > 0
  });
  const audio = [
    ...(data.dash?.audio || []), ...(data.dash?.dolby?.audio || []),
    ...(data.dash?.flac?.audio ? [data.dash.flac.audio] : [])
  ];
  return {
    duration: Number(data.dash?.duration) || Number(data.timelength) / 1000 || Number(duration) || 0,
    video: (data.dash?.video || []).map(summarize), audio: audio.map(summarize),
    progressiveQuality: Number(data.quality) || 0,
    progressiveBytes: String(data.format || "").includes("mp4") && data.durl?.length === 1
      ? Number(data.durl[0].size) || 0 : 0
  };
}

export function getCacheSize(info, quality, cached) {
  const tracks = Object.values(cached?.tracks || {});
  const exactBytes = cached?.status === "complete"
    ? Number(cached.totalBytes || cached.downloadedBytes)
    : cached?.mediaKind === "dash"
      ? tracks.length > 0 && tracks.every((track) => Number(track.totalBytes) > 0)
        ? tracks.reduce((sum, track) => sum + Number(track.totalBytes), 0) : 0
      : Number(cached?.totalBytes);
  if (Number.isFinite(exactBytes) && exactBytes > 0) return { bytes: exactBytes, estimated: false };
  if (!info || !quality) return null;
  const video = chooseVideoRepresentation(info.video, Number(quality), "auto");
  const audio = chooseRepresentation(info.audio);
  if (video && audio) {
    if (!(video.bandwidth > 0 && audio.bandwidth > 0 && info.duration > 0)) return null;
    const bytes = Math.ceil((Number(video.bandwidth) + Number(audio.bandwidth)) * info.duration / 8);
    return Number.isFinite(bytes) ? { bytes, estimated: true } : null;
  }
  if (info.progressiveQuality === Number(quality) && info.progressiveBytes > 0) {
    return { bytes: info.progressiveBytes, estimated: false };
  }
  return null;
}
