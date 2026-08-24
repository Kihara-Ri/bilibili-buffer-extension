export const QUALITY_LABELS = Object.freeze({
  127: "8K",
  126: "杜比视界",
  125: "HDR",
  120: "4K",
  116: "1080P60",
  112: "1080P+",
  80: "1080P",
  74: "720P60",
  64: "720P",
  32: "480P",
  16: "360P"
});

export const AUTO_QUALITY = 127;

export const CODEC_LABELS = Object.freeze({
  auto: "自动（省流）",
  av1: "AV1",
  hevc: "HEVC",
  avc: "AVC"
});

export function normalizeCodecPreference(value, fallback = "auto") {
  const codec = String(value || "").trim().toLowerCase();
  return Object.hasOwn(CODEC_LABELS, codec) ? codec : fallback;
}

export function getCodecFamily(value) {
  const codec = String(value || "").trim().toLowerCase();
  if (codec.startsWith("av01")) return "av1";
  if (codec.startsWith("hvc1") || codec.startsWith("hev1")) return "hevc";
  if (codec.startsWith("avc1")) return "avc";
  return "other";
}

export function isVideoCodecSelectionMatch(video, requestedCodec) {
  const selected = normalizeCodecPreference(requestedCodec);
  if (selected === "auto") return true;
  const actual = getCodecFamily(video?.tracks?.video?.codecs);
  if (actual === selected || video?.codec === selected) return true;
  return normalizeCodecPreference(video?.requestedCodec, "") === selected;
}

export function normalizeQualityId(value, fallback = 0) {
  const quality = Number(value);
  return Number.isSafeInteger(quality) && quality > 0 && quality <= 127
    ? quality
    : fallback;
}

export function buildQualityOptions(playurlData) {
  const data = playurlData && typeof playurlData === "object" ? playurlData : {};
  const accepted = Array.isArray(data.accept_quality) ? data.accept_quality : [];
  const descriptions = Array.isArray(data.accept_description) ? data.accept_description : [];
  const formats = Array.isArray(data.support_formats) ? data.support_formats : [];
  const formatByQuality = new Map(
    formats
      .map((format) => [normalizeQualityId(format?.quality), format])
      .filter(([quality]) => quality > 0)
  );
  const descriptionByQuality = new Map();
  accepted.forEach((quality, index) => {
    const normalized = normalizeQualityId(quality);
    if (normalized) descriptionByQuality.set(normalized, String(descriptions[index] || "").trim());
  });

  const qualities = new Set(accepted.map((quality) => normalizeQualityId(quality)).filter(Boolean));
  const actualQuality = normalizeQualityId(data.quality);
  if (actualQuality) qualities.add(actualQuality);

  return [...qualities]
    .sort((left, right) => right - left)
    .map((quality) => {
      const format = formatByQuality.get(quality) || {};
      const description = descriptionByQuality.get(quality) || "";
      const label = String(
        format.new_description ||
        format.display_desc ||
        description ||
        QUALITY_LABELS[quality] ||
        `画质 ${quality}`
      ).trim();
      const accessText = [
        format.superscript,
        format.description,
        format.new_description,
        description
      ].filter(Boolean).join(" ");

      return {
        quality,
        label,
        requiresVip: Boolean(format.need_vip) || /大会员|会员专享/.test(accessText),
        requiresLogin: Boolean(format.need_login) || /登录/.test(accessText)
      };
    });
}

export function buildMediaQualityOptions(playurlData) {
  const data = playurlData && typeof playurlData === "object" ? playurlData : {};
  const available = new Set();
  const dashVideos = Array.isArray(data.dash?.video) ? data.dash.video : [];
  for (const track of dashVideos) {
    const quality = normalizeQualityId(track?.id);
    const mimeType = String(track?.mimeType || track?.mime_type || "");
    const codecs = String(track?.codecs || "");
    if (quality && mimeType === "video/mp4" && codecs) available.add(quality);
  }

  const progressiveSegments = Array.isArray(data.durl) ? data.durl : [];
  const actualQuality = normalizeQualityId(data.quality);
  if (actualQuality && String(data.format || "").includes("mp4") && progressiveSegments.length === 1) {
    available.add(actualQuality);
  }

  const described = new Map(buildQualityOptions(data).map((option) => [option.quality, option]));
  return [...available]
    .sort((left, right) => right - left)
    .map((quality) => described.get(quality) || {
      quality,
      label: QUALITY_LABELS[quality] || `画质 ${quality}`,
      requiresVip: false,
      requiresLogin: false
    });
}

export function buildMediaCodecOptions(playurlData, requestedQuality) {
  const data = playurlData && typeof playurlData === "object" ? playurlData : {};
  const quality = normalizeQualityId(requestedQuality);
  const tracks = (Array.isArray(data.dash?.video) ? data.dash.video : [])
    .filter((track) => normalizeQualityId(track?.id) === quality)
    .map((track) => ({
      codec: getCodecFamily(track?.codecs),
      codecs: String(track?.codecs || ""),
      bandwidth: Math.max(0, Number(track?.bandwidth) || 0)
    }))
    .filter((track) => track.codec !== "other" && track.codecs);
  const byCodec = new Map();
  for (const track of tracks) {
    const current = byCodec.get(track.codec);
    if (!current) {
      byCodec.set(track.codec, {
        codec: track.codec,
        label: CODEC_LABELS[track.codec],
        minBandwidth: track.bandwidth,
        maxBandwidth: track.bandwidth,
        codecs: [track.codecs]
      });
      continue;
    }
    current.minBandwidth = Math.min(current.minBandwidth || track.bandwidth, track.bandwidth);
    current.maxBandwidth = Math.max(current.maxBandwidth, track.bandwidth);
    if (!current.codecs.includes(track.codecs)) current.codecs.push(track.codecs);
  }
  const preferenceOrder = { av1: 0, hevc: 1, avc: 2 };
  const concrete = [...byCodec.values()].sort((left, right) => (
    (left.minBandwidth || Number.MAX_SAFE_INTEGER) - (right.minBandwidth || Number.MAX_SAFE_INTEGER) ||
    preferenceOrder[left.codec] - preferenceOrder[right.codec]
  ));
  if (!concrete.length) return [];
  const knownBandwidths = concrete
    .map((option) => Number(option.minBandwidth) || 0)
    .filter((bandwidth) => bandwidth > 0);
  return [
    {
      codec: "auto",
      label: CODEC_LABELS.auto,
      minBandwidth: knownBandwidths.length ? Math.min(...knownBandwidths) : 0
    },
    ...concrete
  ];
}

export function makeMimeCodec(mimeType, codecs) {
  const mime = String(mimeType || "").trim();
  const codec = String(codecs || "").trim();
  return mime && codec ? `${mime}; codecs="${codec}"` : mime;
}

function getPersistedSourceUrls(value) {
  return (Array.isArray(value) ? value : []).filter((url) => /^https?:\/\//i.test(String(url || "")));
}

export function getPersistedMediaSource(video) {
  if (video?.mediaKind === "dash") {
    const entries = Object.entries(video.tracks || {})
      .map(([name, track]) => [name, {
        ...track,
        name,
        urls: getPersistedSourceUrls(track.sourceUrls)
      }])
      .filter(([, track]) => track.urls.length > 0);
    if (!entries.some(([name]) => name === "video")) return null;
    return {
      mediaKind: "dash",
      tracks: Object.fromEntries(entries),
      duration: Number(video.duration) || 0,
      quality: normalizeQualityId(video.quality || video.requestedQuality),
      qualityLabel: video.qualityLabel || QUALITY_LABELS[video.quality] || "DASH",
      requestedQuality: normalizeQualityId(video.requestedQuality || video.quality),
      codec: video.codec || getCodecFamily(video.tracks?.video?.codecs),
      codecLabel: video.codecLabel || CODEC_LABELS[video.codec] || "",
      requestedCodec: normalizeCodecPreference(
        video.requestedCodec,
        getCodecFamily(video.tracks?.video?.codecs) === "other"
          ? "auto"
          : getCodecFamily(video.tracks?.video?.codecs)
      ),
      format: video.format || "dash"
    };
  }

  const urls = getPersistedSourceUrls(video?.sourceUrls);
  if (!urls.length) return null;
  return {
    mediaKind: "progressive",
    urls,
    expectedBytes: Number(video.totalBytes) || 0,
    duration: Number(video.duration) || 0,
    quality: normalizeQualityId(video.quality || video.requestedQuality),
    qualityLabel: video.qualityLabel || QUALITY_LABELS[video.quality] || "MP4",
    requestedQuality: normalizeQualityId(video.requestedQuality || video.quality),
    codec: video.codec || "avc",
    codecLabel: video.codecLabel || "AVC",
    requestedCodec: normalizeCodecPreference(video.requestedCodec),
    format: video.format || "mp4",
    mimeType: video.mimeType || "video/mp4"
  };
}

export function parseBiliVideoUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return { supported: false, reason: "invalidUrl" };
  }

  const isBilibili = url.hostname === "bilibili.com" || url.hostname.endsWith(".bilibili.com");
  if (!isBilibili) {
    return { supported: false, reason: "notBilibili" };
  }

  const bvidMatch = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
  const aidMatch = url.pathname.match(/\/video\/av(\d+)/i);
  const listBvid = url.pathname.startsWith("/list/")
    ? url.searchParams.get("bvid")?.match(/^BV[0-9A-Za-z]+$/i)?.[0] || null
    : null;
  if (!bvidMatch && !aidMatch && !listBvid) {
    return { supported: false, reason: "notVideo" };
  }

  const requestedPage = Number.parseInt(url.searchParams.get("p") || "1", 10);
  return {
    supported: true,
    bvid: bvidMatch?.[1] || listBvid,
    aid: aidMatch ? Number.parseInt(aidMatch[1], 10) : null,
    page: Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1
  };
}

export function makeVideoId(bvid, cid) {
  return `${bvid}:${cid}`;
}

export function makeQualityVideoId(pageId, quality, codecPreference = "") {
  const normalized = normalizeQualityId(quality);
  if (!normalized) return pageId;
  const base = `${pageId}:q${normalized}`;
  const codec = normalizeCodecPreference(codecPreference, "");
  return codec ? `${base}:c${codec}` : base;
}

export function getVideoPageId(video) {
  if (video?.pageId) return video.pageId;
  if (video?.bvid && video?.cid) return makeVideoId(video.bvid, video.cid);
  return String(video?.id || "").replace(/:q\d+(?::c(?:auto|av1|hevc|avc))?$/, "");
}

export function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(digits)} ${units[index]}`;
}

export function formatSpeed(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

export function normalizeHttpUrl(input) {
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.protocol === "http:") url.protocol = "https:";
    return url.href;
  } catch {
    return "";
  }
}

export function makeBiliSpaceUrl(value) {
  const mid = Number(value);
  return Number.isSafeInteger(mid) && mid > 0
    ? `https://space.bilibili.com/${mid}`
    : "";
}

export function sanitizeDownloadFilename(input, fallback = "Bili 视频") {
  const sanitized = String(input || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  return (sanitized || fallback).slice(0, 160).replace(/[. ]+$/g, "") || fallback;
}

export function buildCachedDownloadPlan(cached) {
  const video = cached?.video || {};
  const title = video.partTitle
    ? `${video.title} - ${video.partTitle}`
    : video.title || video.bvid || "Bili 视频";
  const quality = video.qualityLabel ? ` [${video.qualityLabel}]` : "";
  const baseName = sanitizeDownloadFilename(`${title}${quality}`);

  if (cached?.playbackUrl) {
    return {
      splitTracks: false,
      items: [{ url: cached.playbackUrl, filename: `${baseName}.mp4` }]
    };
  }

  const tracks = Array.isArray(cached?.playback?.tracks) ? cached.playback.tracks : [];
  if (!tracks.length) throw new Error("本地视频没有可保存的媒体轨道");
  return {
    splitTracks: tracks.length > 1,
    items: tracks.map((track) => {
      const isAudio = track.name === "audio";
      const filename = tracks.length > 1
        ? `${baseName}.${isAudio ? "音频轨.m4a" : "视频轨.mp4"}`
        : `${baseName}.${isAudio ? "m4a" : "mp4"}`;
      return { url: track.url, filename };
    })
  };
}

export function shouldShowInLibrary(video) {
  if (video?.status !== "error") return true;
  return Number(video.resumeBytes ?? video.downloadedBytes) > 0;
}

export function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  if (!match) return null;

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? 0 : Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start) return null;
  if (total > 0 && end >= total) return null;
  return { start, end, total };
}

export function hasCompleteByteCount(video) {
  const downloadedBytes = Number(video?.downloadedBytes) || 0;
  const totalBytes = Number(video?.totalBytes) || 0;
  return totalBytes > 0 && downloadedBytes === totalBytes;
}

export function toPublicError(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "发生未知错误");
}
