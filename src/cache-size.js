import { chooseAudioRepresentation, chooseVideoRepresentation, getTrackUrls } from "./media-selection.js";
import { buildQualityOptions, describeAudioTrack, isAudioOnlyCache } from "./utils.js";

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
    // B 站声明的档位（含只对大会员开放的），用于在界面上区分“声明可用”和“当前账号实际返回”。
    declared: buildQualityOptions(data),
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
  const audio = chooseAudioRepresentation(info.audio, { mode: "video" });
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


/**
 * 仅缓存音频时的体积估算：
 * 已有记录优先显示实际落盘大小；有独立音频轨时按“仅音频模式”选中的轨道码率乘时长估算；
 * 只有单文件 MP4 时显示整段下载体积，并标明需要下载后提取音轨。
 */
export function getAudioCacheSize(info, cached) {
  if (isAudioOnlyCache(cached)) {
    const track = cached.tracks?.audio || {};
    const bytes = Number(track.totalBytes) || Number(cached.totalBytes) || 0;
    if (bytes > 0) {
      return { bytes, estimated: false, label: describeAudioTrack(track), mode: "track" };
    }
  }
  if (!info) return null;
  if (info.audio?.length && info.duration > 0) {
    const audio = chooseAudioRepresentation(info.audio, { mode: "audio" });
    if (audio?.bandwidth) {
      return {
        bytes: Math.ceil(Number(audio.bandwidth) * info.duration / 8),
        estimated: true,
        label: describeAudioTrack(audio),
        mode: "track"
      };
    }
  }
  if (Number(info.progressiveBytes) > 0) {
    return {
      bytes: Number(info.progressiveBytes),
      estimated: false,
      label: "单文件 MP4 · 整段下载后提取音轨",
      mode: "extract"
    };
  }
  return null;
}
