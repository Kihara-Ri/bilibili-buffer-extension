import {
  chooseAudioRepresentation,
  chooseVideoRepresentation,
  getTrackUrls
} from "./media-selection.js";
import {
  Mp4MergeError,
  MP4_MERGE_PROBLEM,
  createAudioOnlyMp4,
  createMergedFragmentedMp4,
  verifyAudioOnlyMp4,
  verifyMergedHeader
} from "./mp4-merge.js";
import {
  clearChunks,
  deleteVideoData,
  getChunks,
  getVideo,
  listVideos,
  openCacheDb,
  putChunk,
  putChunksAndVideo,
  putVideo
} from "./db.js";
import {
  AUTO_QUALITY,
  CACHE_MODES,
  buildMediaQualityOptions,
  CODEC_LABELS,
  describeAudioTrack,
  getCodecFamily,
  getPersistedMediaSource,
  hasCompleteByteCount,
  isAudioOnlyCache,
  makeMimeCodec,
  normalizeCacheMode,
  normalizeCodecPreference,
  normalizeQualityId,
  parseContentRange,
  QUALITY_LABELS,
  toPublicError
} from "./utils.js";
import {
  DEFAULT_RANGE_CONCURRENCY,
  DEFAULT_RANGE_SIZE,
  downloadByteRanges,
  rankRangeCandidates
} from "./range-downloader.js";
import { isRecoverableDownloadError, makeDownloadRetryState } from "./download-retry.js";
import { startDevReloadPolling } from "./dev-reload.js";

const CHUNK_SIZE = 4 * 1024 * 1024;
// 合并后的单文件缓存使用独立的分块序列。
const MERGED_TRACK = "merged";
const PROGRESS_WRITE_INTERVAL = 450;
const META_WRITE_INTERVAL = 1500;
const activeDownloads = new Map();
const playbackUrls = new Map();

if (chrome.runtime.id) startDevReloadPolling();
void initialize();

async function initialize() {
  await openCacheDb();
  await navigator.storage?.persist?.().catch(() => false);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: toPublicError(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "START_DOWNLOAD":
      return startDownload(message.video);
    case "GET_ACTIVE_DOWNLOADS":
      return { videoIds: [...activeDownloads.keys()] };
    case "LIST_VIDEOS":
      return { videos: await listVideos() };
    case "GET_VIDEO":
      return { video: await getVideo(message.videoId) || null };
    case "GET_PLAYBACK_URL":
      return createPlaybackUrl(message.videoId);
    case "DELETE_VIDEO":
      return deleteVideo(message.videoId);
    default:
      throw new Error("未知的缓存指令");
  }
}

async function createPlaybackUrl(videoId) {
  let video = await getVideo(videoId);
  if (!video || video.status !== "complete" || !hasCompleteByteCount(video)) {
    throw new Error("本地缓存尚未完成");
  }

  const existingUrl = playbackUrls.get(videoId);
  if (existingUrl) {
    return video.mediaKind === "dash" && !isAudioOnlyCache(video)
      ? { playback: existingUrl, video }
      : { playbackUrl: existingUrl, video };
  }

  // 仅音频缓存只组装音频轨，不参与网页自动播放。
  if (isAudioOnlyCache(video)) {
    const track = video.tracks?.audio;
    if (!track) throw new Error("本地音频缓存缺少轨道信息");
    const playbackUrl = await createTrackBlobUrl(videoId, "audio", track);
    playbackUrls.set(videoId, playbackUrl);
    return { playbackUrl, video };
  }

  if (video.mediaKind === "dash") {
    // 双轨缓存优先合并成单个 MP4：播放与保存都只面对一个文件。
    if (video.tracks?.audio && !video.mergeError) {
      try {
        video = await ensureMergedTracks(video);
      } catch (error) {
        console.warn("[Bili 缓冲站] 合并本地双轨失败，回退到双轨播放：", error);
        // 记下失败原因，避免每次播放都重复尝试；双轨缓存始终原样保留。
        video = { ...video, mergeStage: "failed", mergeError: toPublicError(error), updatedAt: Date.now() };
        await putVideo(video).catch(() => {});
      }
    }
    if (isMergedComplete(video)) {
      const playbackUrl = await createTrackBlobUrl(videoId, MERGED_TRACK, {
        chunkCount: video.merged.chunkCount,
        totalBytes: video.merged.totalBytes,
        mimeType: video.merged.mimeType || "video/mp4"
      });
      playbackUrls.set(videoId, playbackUrl);
      return { playbackUrl, video };
    }

    const playbackTracks = [];
    for (const [trackName, track] of Object.entries(video.tracks || {})) {
      if (!hasCompleteByteCount(track)) throw new Error("本地 DASH 轨道尚未完成");
      playbackTracks.push({
        name: trackName,
        url: await createTrackBlobUrl(videoId, trackName, track),
        totalBytes: track.totalBytes,
        mimeType: track.mimeType,
        codecs: track.codecs,
        mimeCodec: track.mimeCodec || makeMimeCodec(track.mimeType, track.codecs)
      });
    }
    const playback = { kind: "dash", tracks: playbackTracks };
    playbackUrls.set(videoId, playback);
    return { playback, video };
  }

  const playbackUrl = await createTrackBlobUrl(videoId, "media", {
    chunkCount: video.chunkCount,
    totalBytes: video.totalBytes,
    mimeType: video.mimeType || "video/mp4"
  });
  playbackUrls.set(videoId, playbackUrl);
  return { playbackUrl, video };
}

/** 把一条轨道的本地分块组装成 Blob URL，并校验分块数与字节数。 */
async function createTrackBlobUrl(videoId, trackName, track) {
  const chunks = await getChunks(videoId, trackName);
  if (!chunks.length || (Number(track.chunkCount) > 0 && chunks.length !== Number(track.chunkCount))) {
    throw new Error(`本地${trackLabel(trackName)}缓存块不完整，请继续缓存或删除后重试`);
  }
  const blob = new Blob(chunks.map((chunk) => chunk.data), {
    type: track.mimeType || "application/octet-stream"
  });
  if (Number(track.totalBytes) > 0 && blob.size !== Number(track.totalBytes)) {
    throw new Error(`本地${trackLabel(trackName)}字节数校验失败`);
  }
  return URL.createObjectURL(blob);
}

function trackLabel(trackName) {
  if (trackName === "video") return "视频轨";
  if (trackName === "audio") return "音频轨";
  if (trackName === MERGED_TRACK) return "合并视频";
  return "缓存";
}

async function startDownload(video) {
  if (!video?.id || !video?.bvid || !video?.cid) {
    throw new Error("当前视频信息不完整");
  }

  const running = activeDownloads.get(video.id);
  if (running) return { started: false, video: await getVideo(video.id) };

  const existing = await getVideo(video.id);
  if (existing?.status === "complete") {
    return { started: false, alreadyComplete: true, video: existing };
  }

  const job = { controller: new AbortController(), deleted: false };
  activeDownloads.set(video.id, job);
  void downloadVideo(video, existing, job).finally(() => activeDownloads.delete(video.id));
  const { auth: _auth, playurlData: _playurlData, ...publicVideo } = video;
  return { started: true, video: existing || publicVideo };
}

function toDashTrack(name, representation) {
  const mimeType = representation.mimeType || representation.mime_type;
  return {
    name,
    urls: getTrackUrls(representation),
    expectedBytes: 0,
    mimeType,
    codecs: representation.codecs || "",
    mimeCodec: makeMimeCodec(mimeType, representation.codecs),
    bandwidth: Number(representation.bandwidth) || 0,
    representationId: Number(representation.id) || 0,
    representationKey: [
      representation.id,
      representation.codecid,
      representation.codecs
    ].join(":")
  };
}

async function resolveMediaSource(video) {
  const explicitlyRequested = Boolean(
    video.requestedQualityExplicit && normalizeQualityId(video.requestedQuality)
  );
  const requestedQuality = normalizeQualityId(
    video.requestedQuality ?? video.quality,
    AUTO_QUALITY
  );
  const data = video.playurlData;
  const auth = video.auth || { hasSessionCookie: false };
  const persistedSource = getPersistedMediaSource(video);
  const persistedCodec = getCodecFamily(persistedSource?.tracks?.video?.codecs);
  const requestedCodec = normalizeCodecPreference(
    video.requestedCodec,
    persistedCodec === "other" ? "auto" : persistedCodec
  );
  const cacheMode = normalizeCacheMode(
    video.cacheMode,
    video.mediaKind === "audio" ? CACHE_MODES.AUDIO : CACHE_MODES.VIDEO
  );
  if (!data) {
    if (persistedSource) return persistedSource;
    throw new Error("没有可恢复的播放地址，请重新打开原视频后继续缓存");
  }
  const actualQuality = normalizeQualityId(data.quality);
  const qualityOptions = buildMediaQualityOptions(data);
  const selectedQuality = explicitlyRequested
    ? requestedQuality
    : qualityOptions[0]?.quality || actualQuality;
  const actualOption = qualityOptions.find((option) => option.quality === selectedQuality);

  const dashVideo = chooseVideoRepresentation(data.dash?.video, selectedQuality, requestedCodec);
  const standardAudio = Array.isArray(data.dash?.audio) ? data.dash.audio : [];
  const dolbyAudio = Array.isArray(data.dash?.dolby?.audio) ? data.dash.dolby.audio : [];
  const flacAudio = data.dash?.flac?.audio ? [data.dash.flac.audio] : [];
  const audioCandidates = [...standardAudio, ...dolbyAudio, ...flacAudio];
  const progressiveSource = () => buildProgressiveSource({
    data,
    video,
    selectedQuality,
    actualQuality,
    requestedQuality,
    requestedCodec,
    actualOption
  });

  // 仅缓存音频：只下载音频轨，保留 B 站返回的原始容器与编码，Hi-Res 无损优先。
  if (cacheMode === CACHE_MODES.AUDIO) {
    const dashAudio = chooseAudioRepresentation(audioCandidates, { mode: "audio" });
    if (!dashAudio) {
      // 没有独立音频轨：退回单文件 MP4，整段下载后无损抽出音轨（yt-dlp -x 的做法）。
      const progressive = progressiveSource();
      if (progressive) {
        return { ...progressive, cacheMode: CACHE_MODES.AUDIO, audioOnly: true };
      }
      throw new Error("B 站没有返回可缓存的音频轨");
    }
    const audioTrack = toDashTrack("audio", dashAudio);
    const audioLabel = describeAudioTrack(audioTrack);
    return {
      mediaKind: "audio",
      cacheMode: CACHE_MODES.AUDIO,
      tracks: { audio: audioTrack },
      duration: Math.round(Number(data.dash?.duration) || video.duration || 0),
      quality: selectedQuality || requestedQuality,
      qualityLabel: audioLabel,
      audioLabel,
      audioId: Number(dashAudio.id) || 0,
      requestedQuality,
      codec: "",
      codecLabel: "",
      requestedCodec: "",
      format: "audio",
      mimeType: audioTrack.mimeType || "audio/mp4"
    };
  }

  const dashAudio = chooseAudioRepresentation(audioCandidates, { mode: "video" });

  if (dashVideo) {
    const selectedCodec = getCodecFamily(dashVideo.codecs);
    const tracks = { video: toDashTrack("video", dashVideo) };
    if (dashAudio) tracks.audio = toDashTrack("audio", dashAudio);
    return {
      mediaKind: "dash",
      cacheMode: CACHE_MODES.VIDEO,
      tracks,
      duration: Math.round(Number(data.dash?.duration) || video.duration || 0),
      quality: selectedQuality,
      qualityLabel: actualOption?.label || QUALITY_LABELS[selectedQuality] || `画质 ${selectedQuality}`,
      audioLabel: dashAudio ? describeAudioTrack(tracks.audio) : "",
      audioId: Number(dashAudio?.id) || 0,
      requestedQuality: selectedQuality,
      codec: selectedCodec,
      codecLabel: CODEC_LABELS[selectedCodec] || String(dashVideo.codecs || ""),
      requestedCodec,
      format: "dash"
    };
  }

  if (requestedCodec !== "auto" && requestedCodec !== "avc") {
    const requestedTrackExists = Array.isArray(data.dash?.video) && data.dash.video.some((track) => (
      normalizeQualityId(track?.id) === selectedQuality && getCodecFamily(track?.codecs) === requestedCodec
    ));
    if (requestedTrackExists) {
      throw new Error(`浏览器不支持当前 ${CODEC_LABELS[requestedCodec]} 轨道，请改用自动或 AVC`);
    }
    throw new Error(`B 站没有返回所选画质的 ${CODEC_LABELS[requestedCodec]} 轨道`);
  }

  if (explicitlyRequested && !actualOption) {
    if (persistedSource) return persistedSource;
    const authenticationHint = auth.hasSessionCookie
      ? "当前账号可能没有该画质权限，或登录状态已失效"
      : "该画质可能需要登录或大会员，请先在当前 Chrome 登录";
    throw new Error(`B 站没有返回所选的 ${QUALITY_LABELS[requestedQuality] || requestedQuality} 轨道；${authenticationHint}`);
  }

  const progressive = progressiveSource();
  if (progressive) return progressive;
  if (persistedSource) return persistedSource;
  throw new Error("B 站没有返回所选画质的可播放 MP4 或 DASH 轨道");
}

/** 单段 MP4 路线：同时用于视频缓存与“下载后提取音轨”的仅音频缓存。 */
function buildProgressiveSource({ data, video, selectedQuality, actualQuality, requestedQuality, requestedCodec, actualOption }) {
  const segments = Array.isArray(data.durl) ? data.durl : [];
  const isMp4 = String(data.format || "").includes("mp4");
  if (!isMp4 || segments.length !== 1 || !segments[0]?.url || actualQuality !== selectedQuality) return null;
  const segment = segments[0];
  return {
    mediaKind: "progressive",
    urls: [segment.url, ...(segment.backup_url || segment.backupUrl || [])].filter(Boolean),
    expectedBytes: Number(segment.size) || 0,
    duration: Math.round((Number(data.timelength) || video.duration * 1000) / 1000),
    quality: actualQuality,
    qualityLabel: actualOption?.label || QUALITY_LABELS[data.quality] || data.format || "MP4",
    requestedQuality: selectedQuality,
    codec: "avc",
    codecLabel: "AVC",
    requestedCodec,
    format: data.format || "mp4",
    mimeType: "video/mp4"
  };
}

async function downloadVideo(video, existing, job) {
  let currentVideo = video;
  let currentExisting = existing;
  let sourceRefreshes = 0;
  while (!job.deleted) {
    const { auth: _auth, playurlData: _playurlData, ...safeVideo } = currentVideo;
    try {
      const source = await resolveMediaSource(currentVideo);
      let meta = source.mediaKind === "progressive"
        ? await downloadProgressiveSource(safeVideo, currentExisting, source, job)
        : await downloadTrackSource(safeVideo, currentExisting, source, job);
      if (job.deleted) return;
      if (source.mediaKind === "progressive" && source.audioOnly) {
        meta = await extractAudioTrackChunks(meta, job);
      } else if (source.mediaKind === "dash" && source.tracks.audio) {
        meta = await mergeDownloadedTracks(meta, job);
      }
      if (job.deleted) return;
      // 合并失败时保留双轨记录，因此这里显式收尾为完成；只有 merged 完整才算合并成功。
      const completed = {
        ...meta,
        status: "complete",
        stage: "",
        progress: 1,
        speed: 0,
        autoRetryCount: 0,
        nextRetryAt: 0,
        retryDelayMs: 0
      };
      await putVideo(completed);
      broadcastProgress(completed, "CACHE_COMPLETE");
      return;
    } catch (caughtError) {
      if (job.deleted) return;
      let error = caughtError;
      const current = await getVideo(video.id).catch(() => null) || currentExisting || safeVideo;
      const { auth: _currentAuth, playurlData: _currentPlayurl, ...safeCurrent } = current;

      if (
        error?.name !== "AbortError" &&
        isRecoverableDownloadError(error) &&
        sourceRefreshes < 2
      ) {
        try {
          const refreshed = await refreshDownloadSource(safeCurrent);
          sourceRefreshes += 1;
          currentVideo = { ...safeCurrent, auth: refreshed.auth, playurlData: refreshed.playurlData };
          currentExisting = current;
          const refreshing = {
            ...safeCurrent,
            status: "downloading",
            speed: 0,
            error: "连接中断，正在刷新播放地址并续传",
            updatedAt: Date.now()
          };
          await putVideo(refreshing);
          broadcastProgress(refreshing);
          await abortableDelay(sourceRefreshes * 1000, job.controller.signal);
          continue;
        } catch (refreshError) {
          error = refreshError;
        }
      }

      const retry = error?.name === "AbortError" ? null : makeDownloadRetryState(safeCurrent, error);
      if (retry) {
        const waiting = {
          ...safeCurrent,
          ...retry,
          status: "downloading",
          speed: 0,
          updatedAt: Date.now()
        };
        await putVideo(waiting);
        broadcastProgress(waiting, "CACHE_RETRY");
        return;
      }

      const message = error?.name === "AbortError" ? "缓存已暂停，点击可继续" : toPublicError(error);
      const failed = {
        ...safeCurrent,
        status: "error",
        stage: "",
        speed: 0,
        error: message,
        updatedAt: Date.now()
      };
      await putVideo(failed);
      broadcastProgress(failed, "CACHE_ERROR");
      return;
    }
  }
}

async function refreshDownloadSource(video) {
  const response = await chrome.runtime.sendMessage({
    target: "background",
    type: "REFRESH_DOWNLOAD_SOURCE",
    video: {
      id: video.id,
      bvid: video.bvid,
      cid: video.cid,
      tabId: video.tabId,
      requestedQuality: video.requestedQuality ?? video.quality,
      requestedQualityExplicit: video.requestedQualityExplicit,
      requestedCodec: video.requestedCodec,
      mediaKind: video.mediaKind
    }
  });
  if (!response?.ok || !response.playurlData) {
    throw new Error(response?.error || "无法刷新播放地址");
  }
  return response;
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new DOMException("任务已取消", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("任务已取消", "AbortError"));
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function downloadProgressiveSource(video, existing, source, job) {
  const canResume = Boolean(
    existing &&
    existing.mediaKind !== "dash" &&
    (existing.resumeBytes ?? existing.downloadedBytes) > 0 &&
    existing.quality === source.quality &&
    (!existing.totalBytes || !source.expectedBytes || existing.totalBytes === source.expectedBytes)
  );
  if (!canResume) await clearChunks(video.id);

  const resumeBytes = canResume ? Number(existing.resumeBytes ?? existing.downloadedBytes) || 0 : 0;
  const resumeChunks = canResume ? Number(existing.chunkCount) || 0 : 0;
  let meta = {
    ...video,
    schemaVersion: 2,
    mediaKind: "progressive",
    merged: null,
    mergeStage: "",
    mergeError: "",
    status: "downloading",
    progress: source.expectedBytes ? resumeBytes / source.expectedBytes : 0,
    speed: 0,
    downloadedBytes: resumeBytes,
    resumeBytes,
    totalBytes: source.expectedBytes,
    chunkCount: resumeChunks,
    mimeType: source.mimeType,
    quality: source.quality,
    qualityLabel: source.qualityLabel,
    requestedQuality: source.requestedQuality,
    codec: source.codec,
    codecLabel: source.codecLabel,
    requestedCodec: source.requestedCodec,
    format: source.format,
    duration: source.duration || video.duration,
    tracks: null,
    sourceUrls: source.urls,
    error: "",
    updatedAt: Date.now()
  };
  await putVideo(meta);
  broadcastProgress(meta);

  let ranking;
  try {
    ranking = await rankRangeCandidates(source.urls, {
      start: resumeBytes,
      totalBytes: source.expectedBytes,
      signal: job.controller.signal
    });
  } catch (error) {
    if (!String(error?.message || "").includes("HTTP 206")) throw error;
    const result = await fetchAndStore(source.urls, meta, job);
    const expectedBytes = source.expectedBytes || result.totalBytes;
    if (!hasCompleteByteCount({ downloadedBytes: result.downloadedBytes, totalBytes: expectedBytes })) {
      throw new Error(`CDN 返回的数据不完整（${result.downloadedBytes} / ${expectedBytes || "未知"} 字节），已保留进度供续传`);
    }
    return {
      ...meta,
      status: "complete",
      progress: 1,
      speed: 0,
      downloadedBytes: result.downloadedBytes,
      resumeBytes: result.downloadedBytes,
      totalBytes: expectedBytes,
      chunkCount: result.chunkCount,
      downloadMetrics: { strategy: "sequential-fallback", concurrency: 1 },
      completedAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  const coordinator = createDownloadCoordinator({ ...meta, totalBytes: ranking.totalBytes }, {
    media: { resumeBytes, chunkCount: resumeChunks, totalBytes: ranking.totalBytes }
  });
  coordinator.setRanking("media", ranking);
  try {
    const result = await downloadByteRanges({
      urls: ranking.urls,
      start: resumeBytes,
      totalBytes: ranking.totalBytes,
      rangeSize: DEFAULT_RANGE_SIZE,
      concurrency: DEFAULT_RANGE_CONCURRENCY,
      signal: job.controller.signal,
      onReceive: (delta) => coordinator.receive("media", delta),
      onCommit: (batch) => coordinator.commit("media", batch)
    });
    coordinator.setTransferMetrics("media", result.metrics);
    await coordinator.stop();
  } catch (error) {
    await coordinator.persistSafeState();
    await coordinator.stop();
    throw error;
  }

  meta = coordinator.snapshot({ durableOnly: true, speed: 0 });
  if (!hasCompleteByteCount(meta)) {
    throw new Error(`CDN 返回的数据不完整（${meta.downloadedBytes} / ${meta.totalBytes || "未知"} 字节），已保留进度供续传`);
  }
  return {
    ...meta,
    status: "complete",
    progress: 1,
    speed: 0,
    completedAt: Date.now(),
    updatedAt: Date.now()
  };
}

function publicTrackMeta(sourceTrack, existingTrack = null) {
  const { urls, ...track } = sourceTrack;
  const canResume = Boolean(
    existingTrack &&
    existingTrack.representationKey === track.representationKey &&
    (existingTrack.resumeBytes ?? existingTrack.downloadedBytes) > 0
  );
  return {
    ...track,
    sourceUrls: urls.filter((url) => /^https?:\/\//i.test(String(url || ""))),
    downloadedBytes: canResume ? Number(existingTrack.downloadedBytes) || 0 : 0,
    resumeBytes: canResume ? Number(existingTrack.resumeBytes ?? existingTrack.downloadedBytes) || 0 : 0,
    totalBytes: canResume ? Number(existingTrack.totalBytes) || 0 : 0,
    chunkCount: canResume ? Number(existingTrack.chunkCount) || 0 : 0,
    estimatedBytes: Math.max(0, Math.round((Number(track.bandwidth) || 0) / 8))
  };
}

function aggregateDashMeta(meta, trackName, trackPatch, speed = 0) {
  const tracks = {
    ...meta.tracks,
    [trackName]: { ...meta.tracks[trackName], ...trackPatch }
  };
  const values = Object.values(tracks);
  const downloadedBytes = values.reduce((sum, track) => sum + (Number(track.downloadedBytes) || 0), 0);
  const resumeBytes = values.reduce((sum, track) => sum + (Number(track.resumeBytes) || 0), 0);
  const totalBytes = values.reduce((sum, track) => sum + (Number(track.totalBytes) || 0), 0);
  const chunkCount = values.reduce((sum, track) => sum + (Number(track.chunkCount) || 0), 0);
  const estimatedTotal = values.reduce((sum, track) => {
    const exact = Number(track.totalBytes) || 0;
    const estimate = (Number(track.estimatedBytes) || 0) * (Number(meta.duration) || 0);
    return sum + (exact || estimate);
  }, 0);
  return {
    ...meta,
    tracks,
    downloadedBytes,
    resumeBytes,
    totalBytes,
    chunkCount,
    progress: estimatedTotal ? Math.min(downloadedBytes / estimatedTotal, 0.999) : 0,
    speed,
    updatedAt: Date.now()
  };
}

function createDownloadCoordinator(baseMeta, initialStates) {
  const states = new Map(Object.entries(initialStates).map(([name, state]) => [name, {
    ...state,
    resumeBytes: Number(state.resumeBytes) || 0,
    chunkCount: Number(state.chunkCount) || 0,
    totalBytes: Number(state.totalBytes) || 0,
    volatileBytes: 0,
    metrics: {
      strategy: "parallel-range",
      concurrency: DEFAULT_RANGE_CONCURRENCY,
      rangeSize: DEFAULT_RANGE_SIZE,
      cdnHost: "",
      candidateCount: 0,
      probeBytes: 0,
      probeMs: 0,
      requestCount: 0,
      retryCount: 0,
      slowRequestCount: 0,
      cdnSwitchCount: 0,
      ttfbP50: null,
      ttfbP95: null,
      hosts: {},
      networkBytes: 0,
      committedBytes: Number(state.resumeBytes) || 0,
      dbWriteMs: 0,
      startedAt: Date.now()
    }
  }]));
  let currentSpeed = 0;
  let speedBytes = 0;
  let speedStartedAt = performance.now();
  let lastBroadcastAt = 0;
  let lastMetadataPersistAt = 0;
  let persistenceQueue = Promise.resolve();
  let stopped = false;

  const buildSnapshot = ({ durableOnly = false, speed = currentSpeed } = {}) => {
    if (baseMeta.mediaKind === "dash") {
      const tracks = {};
      for (const [name, state] of states) {
        tracks[name] = {
          ...baseMeta.tracks[name],
          downloadedBytes: state.resumeBytes + (durableOnly ? 0 : state.volatileBytes),
          resumeBytes: state.resumeBytes,
          totalBytes: state.totalBytes,
          chunkCount: state.chunkCount,
          metrics: publicDownloadMetrics(state.metrics)
        };
      }
      const values = Object.values(tracks);
      const downloadedBytes = values.reduce((sum, track) => sum + track.downloadedBytes, 0);
      const resumeBytes = values.reduce((sum, track) => sum + track.resumeBytes, 0);
      const totalBytes = values.reduce((sum, track) => sum + track.totalBytes, 0);
      const chunkCount = values.reduce((sum, track) => sum + track.chunkCount, 0);
      const estimatedTotal = values.reduce((sum, track) => {
        const exact = Number(track.totalBytes) || 0;
        const estimate = (Number(track.estimatedBytes) || 0) * (Number(baseMeta.duration) || 0);
        return sum + (exact || estimate);
      }, 0);
      return {
        ...baseMeta,
        tracks,
        downloadedBytes,
        resumeBytes,
        totalBytes,
        chunkCount,
        progress: estimatedTotal ? Math.min(downloadedBytes / estimatedTotal, 0.999) : 0,
        speed,
        downloadMetrics: aggregateDownloadMetrics(states),
        updatedAt: Date.now()
      };
    }

    // progressive 使用 media 键，仅音频缓存使用 audio 键，两者都是单轨记录。
    const stateName = states.has("media") ? "media" : [...states.keys()][0];
    const state = states.get(stateName);
    const downloadedBytes = state.resumeBytes + (durableOnly ? 0 : state.volatileBytes);
    const snapshot = {
      ...baseMeta,
      downloadedBytes,
      resumeBytes: state.resumeBytes,
      totalBytes: state.totalBytes,
      chunkCount: state.chunkCount,
      progress: state.totalBytes ? Math.min(downloadedBytes / state.totalBytes, 0.999) : 0,
      speed,
      downloadMetrics: publicDownloadMetrics(state.metrics),
      updatedAt: Date.now()
    };
    // 仅音频缓存仍带 tracks 元数据，续传水位必须同步写回该轨道。
    if (baseMeta.tracks) {
      snapshot.tracks = {
        ...baseMeta.tracks,
        [stateName]: {
          ...baseMeta.tracks[stateName],
          downloadedBytes,
          resumeBytes: state.resumeBytes,
          totalBytes: state.totalBytes,
          chunkCount: state.chunkCount,
          metrics: publicDownloadMetrics(state.metrics)
        }
      };
    }
    return snapshot;
  };

  const enqueue = (operation) => {
    const next = persistenceQueue.then(operation);
    persistenceQueue = next.catch(() => {});
    return next;
  };

  const persistMetadata = (force = false) => {
    const now = performance.now();
    if (!force && now - lastMetadataPersistAt < META_WRITE_INTERVAL) return;
    lastMetadataPersistAt = now;
    void enqueue(async () => {
      const startedAt = performance.now();
      await putVideo(buildSnapshot());
      addDbWriteTime(states, performance.now() - startedAt);
    });
  };

  const broadcast = (force = false) => {
    const now = performance.now();
    if (!force && now - lastBroadcastAt < PROGRESS_WRITE_INTERVAL) return;
    const elapsed = Math.max((now - speedStartedAt) / 1000, 0.001);
    currentSpeed = Math.max(0, speedBytes / elapsed);
    speedBytes = 0;
    speedStartedAt = now;
    lastBroadcastAt = now;
    broadcastProgress(buildSnapshot());
    persistMetadata();
  };

  return {
    getState(name) {
      return states.get(name);
    },
    setRanking(name, ranking) {
      const state = states.get(name);
      state.totalBytes = ranking.totalBytes;
      state.metrics.cdnHost = ranking.probes[0]?.host || "";
      state.metrics.candidateCount = ranking.urls.length;
      state.metrics.probeBytes = ranking.probes.reduce((sum, probe) => sum + probe.bytes, 0);
      state.metrics.probeMs = Math.max(0, ...ranking.probes.map((probe) => probe.elapsedMs));
      broadcast(true);
    },
    receive(name, delta) {
      const state = states.get(name);
      state.volatileBytes = Math.max(0, state.volatileBytes + delta);
      if (delta > 0) {
        speedBytes += delta;
        state.metrics.networkBytes += delta;
      }
      broadcast();
    },
    async commit(name, batch) {
      return enqueue(async () => {
        const state = states.get(name);
        let nextResume = state.resumeBytes;
        let nextIndex = state.chunkCount;
        let committedBytes = 0;
        const chunks = [];
        for (const entry of batch) {
          if (entry.range.start !== nextResume) {
            throw new Error("并发分块无法推进连续续传位置");
          }
          chunks.push({
            videoId: baseMeta.id,
            track: name,
            index: nextIndex,
            data: entry.data
          });
          committedBytes += entry.data.size;
          nextResume = entry.range.end + 1;
          nextIndex += 1;
        }

        const previousResume = state.resumeBytes;
        const previousIndex = state.chunkCount;
        state.resumeBytes = nextResume;
        state.chunkCount = nextIndex;
        state.volatileBytes = Math.max(0, state.volatileBytes - committedBytes);
        state.metrics.committedBytes = nextResume;
        baseMeta.autoRetryCount = 0;
        baseMeta.nextRetryAt = 0;
        baseMeta.retryDelayMs = 0;
        const snapshot = buildSnapshot();
        const startedAt = performance.now();
        try {
          await putChunksAndVideo(snapshot, chunks);
          addDbWriteTime(states, performance.now() - startedAt);
        } catch (error) {
          state.resumeBytes = previousResume;
          state.chunkCount = previousIndex;
          state.volatileBytes += committedBytes;
          throw error;
        }
        broadcastProgress(buildSnapshot());
      });
    },
    setTransferMetrics(name, metrics) {
      const state = states.get(name);
      Object.assign(state.metrics, {
        concurrency: metrics.concurrency,
        rangeSize: metrics.rangeSize,
        cdnHost: metrics.cdnHost || state.metrics.cdnHost,
        requestCount: metrics.requestCount,
        retryCount: metrics.retryCount,
        slowRequestCount: metrics.slowRequestCount,
        cdnSwitchCount: metrics.cdnSwitchCount,
        ttfbP50: metrics.ttfbP50,
        ttfbP95: metrics.ttfbP95,
        hosts: metrics.hosts || {},
        rangeCount: metrics.rangeCount,
        networkBytes: metrics.networkBytes,
        completedAt: metrics.completedAt
      });
    },
    async stop() {
      stopped = true;
      await persistenceQueue;
      currentSpeed = 0;
    },
    snapshot(options = {}) {
      return buildSnapshot(options);
    },
    async persistSafeState() {
      if (stopped) return;
      await enqueue(async () => putVideo(buildSnapshot({ durableOnly: true, speed: 0 })));
    }
  };
}

function publicDownloadMetrics(metrics) {
  return {
    strategy: metrics.strategy,
    concurrency: metrics.concurrency,
    rangeSize: metrics.rangeSize,
    cdnHost: metrics.cdnHost,
    candidateCount: metrics.candidateCount,
    probeBytes: metrics.probeBytes,
    probeMs: Math.round(metrics.probeMs || 0),
    requestCount: metrics.requestCount,
    retryCount: metrics.retryCount,
    slowRequestCount: metrics.slowRequestCount || 0,
    cdnSwitchCount: metrics.cdnSwitchCount || 0,
    ttfbP50: Number.isFinite(metrics.ttfbP50) ? Math.round(metrics.ttfbP50) : null,
    ttfbP95: Number.isFinite(metrics.ttfbP95) ? Math.round(metrics.ttfbP95) : null,
    hosts: metrics.hosts || {},
    networkBytes: metrics.networkBytes,
    committedBytes: metrics.committedBytes,
    dbWriteMs: Math.round(metrics.dbWriteMs || 0),
    startedAt: metrics.startedAt,
    completedAt: metrics.completedAt || 0
  };
}

function aggregateDownloadMetrics(states) {
  const metrics = [...states.values()].map((state) => state.metrics);
  return {
    strategy: "parallel-range",
    concurrency: metrics.reduce((sum, value) => sum + (Number(value.concurrency) || 0), 0),
    requestCount: metrics.reduce((sum, value) => sum + (Number(value.requestCount) || 0), 0),
    retryCount: metrics.reduce((sum, value) => sum + (Number(value.retryCount) || 0), 0),
    slowRequestCount: metrics.reduce((sum, value) => sum + (Number(value.slowRequestCount) || 0), 0),
    cdnSwitchCount: metrics.reduce((sum, value) => sum + (Number(value.cdnSwitchCount) || 0), 0),
    networkBytes: metrics.reduce((sum, value) => sum + (Number(value.networkBytes) || 0), 0),
    committedBytes: metrics.reduce((sum, value) => sum + (Number(value.committedBytes) || 0), 0),
    dbWriteMs: Math.round(metrics.reduce((sum, value) => sum + (Number(value.dbWriteMs) || 0), 0)),
    cdnHosts: [...new Set(metrics.map((value) => value.cdnHost).filter(Boolean))]
  };
}

function addDbWriteTime(states, duration) {
  const share = duration / Math.max(states.size, 1);
  for (const state of states.values()) state.metrics.dbWriteMs += share;
}

async function downloadTrackSource(video, existing, source, job) {
  const sourceEntries = Object.entries(source.tracks);
  const canResume = Boolean(
    existing?.mediaKind === source.mediaKind &&
    (source.mediaKind === "audio" || existing.quality === source.quality) &&
    sourceEntries.every(([name, track]) => (
      existing.tracks?.[name]?.representationKey === track.representationKey
    ))
  );
  if (!canResume) await clearChunks(video.id);

  const tracks = Object.fromEntries(sourceEntries.map(([name, track]) => [
    name,
    publicTrackMeta(track, canResume ? existing.tracks?.[name] : null)
  ]));
  let meta = {
    ...video,
    schemaVersion: 3,
    mediaKind: source.mediaKind,
    cacheMode: source.mediaKind === "audio" ? CACHE_MODES.AUDIO : CACHE_MODES.VIDEO,
    // 重新下载轨道时旧的合并结果已经失效，避免完成判定继续读取陈旧的 merged 字段。
    merged: null,
    mergeStage: "",
    mergeError: "",
    status: "downloading",
    progress: 0,
    speed: 0,
    downloadedBytes: 0,
    resumeBytes: 0,
    totalBytes: 0,
    chunkCount: 0,
    mimeType: source.mimeType || (source.mediaKind === "audio" ? "audio/mp4" : "video/mp4"),
    quality: source.quality,
    audioLabel: source.audioLabel || "",
    audioId: Number(source.audioId) || 0,
    qualityLabel: source.qualityLabel,
    requestedQuality: source.requestedQuality,
    codec: source.codec,
    codecLabel: source.codecLabel,
    requestedCodec: source.requestedCodec,
    format: source.format,
    duration: source.duration || video.duration,
    tracks,
    error: "",
    updatedAt: Date.now()
  };
  for (const [name, track] of Object.entries(tracks)) {
    meta = aggregateDashMeta(meta, name, track, 0);
  }
  await putVideo(meta);
  broadcastProgress(meta);

  // 源分块已经完整（例如上次中断在合并阶段）：跳过网络阶段直接返回。
  if (Object.values(tracks).every((track) => hasCompleteByteCount(track))) {
    const values = Object.values(meta.tracks);
    const totalBytes = values.reduce((sum, track) => sum + (Number(track.totalBytes) || 0), 0);
    return {
      ...meta,
      status: "complete",
      progress: 1,
      speed: 0,
      downloadedBytes: totalBytes,
      resumeBytes: totalBytes,
      totalBytes,
      chunkCount: values.reduce((sum, track) => sum + (Number(track.chunkCount) || 0), 0),
      completedAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  const coordinator = createDownloadCoordinator(meta, Object.fromEntries(
    Object.entries(tracks).map(([name, track]) => [name, {
      resumeBytes: Number(track.resumeBytes) || 0,
      chunkCount: Number(track.chunkCount) || 0,
      totalBytes: Number(track.totalBytes) || 0
    }])
  ));
  const localController = new AbortController();
  const abortFromJob = () => localController.abort(job.controller.signal.reason);
  if (job.controller.signal.aborted) abortFromJob();
  else job.controller.signal.addEventListener("abort", abortFromJob, { once: true });
  let primaryError = null;

  const tasks = sourceEntries.map(async ([trackName, sourceTrack]) => {
    try {
      const state = coordinator.getState(trackName);
      const ranking = await rankRangeCandidates(sourceTrack.urls, {
        start: state.resumeBytes,
        totalBytes: state.totalBytes,
        signal: localController.signal
      });
      coordinator.setRanking(trackName, ranking);
      const trackConcurrency = sourceEntries.length > 1
        ? trackName === "video" ? DEFAULT_RANGE_CONCURRENCY : 1
        : DEFAULT_RANGE_CONCURRENCY;
      const result = await downloadByteRanges({
        urls: ranking.urls,
        start: state.resumeBytes,
        totalBytes: ranking.totalBytes,
        rangeSize: DEFAULT_RANGE_SIZE,
        concurrency: trackConcurrency,
        signal: localController.signal,
        onReceive: (delta) => coordinator.receive(trackName, delta),
        onCommit: (batch) => coordinator.commit(trackName, batch)
      });
      coordinator.setTransferMetrics(trackName, result.metrics);
    } catch (error) {
      if (error?.name !== "AbortError" && !primaryError) primaryError = error;
      if (!localController.signal.aborted) localController.abort(error);
      throw error;
    }
  });

  const results = await Promise.allSettled(tasks);
  job.controller.signal.removeEventListener("abort", abortFromJob);
  const failure = primaryError || results.find((result) => result.status === "rejected")?.reason;
  if (failure) await coordinator.persistSafeState();
  await coordinator.stop();
  if (failure) throw failure;

  meta = coordinator.snapshot({ durableOnly: true, speed: 0 });
  for (const [trackName, track] of Object.entries(meta.tracks)) {
    if (!hasCompleteByteCount(track)) {
      throw new Error(`${trackName === "video" ? "视频" : "音频"}轨数据不完整，已保留进度供续传`);
    }
  }
  const values = Object.values(meta.tracks);
  const totalBytes = values.reduce((sum, track) => sum + track.totalBytes, 0);
  const chunkCount = values.reduce((sum, track) => sum + track.chunkCount, 0);
  return {
    ...meta,
    status: "complete",
    progress: 1,
    speed: 0,
    downloadedBytes: totalBytes,
    resumeBytes: totalBytes,
    totalBytes,
    chunkCount,
    completedAt: Date.now(),
    updatedAt: Date.now()
  };
}

async function fetchDashTrackAndStore(urls, meta, job, trackName) {
  let lastError;
  for (const url of urls) {
    try {
      return await fetchDashTrackCandidate(url, meta, job, trackName);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      lastError = error;
      meta = await getVideo(meta.id) || meta;
    }
  }
  throw lastError || new Error(`${trackName === "video" ? "视频" : "音频"}轨的所有 CDN 地址均无法连接`);
}

async function fetchDashTrackCandidate(url, meta, job, trackName) {
  let track = { ...meta.tracks[trackName] };
  let storedBytes = Number(track.resumeBytes ?? track.downloadedBytes) || 0;
  let downloadedBytes = storedBytes;
  let chunkIndex = Number(track.chunkCount) || 0;
  let totalBytes = Number(track.totalBytes) || 0;
  let pending = [];
  let pendingBytes = 0;
  let measuredBytes = downloadedBytes;
  let measureStartedAt = performance.now();
  let lastPersistAt = 0;

  const persistProgress = async (force = false) => {
    const now = performance.now();
    if (!force && now - lastPersistAt < PROGRESS_WRITE_INTERVAL) return;
    const elapsed = Math.max((now - measureStartedAt) / 1000, 0.001);
    const speed = Math.max(0, (downloadedBytes - measuredBytes) / elapsed);
    track = { ...track, downloadedBytes, resumeBytes: storedBytes, totalBytes, chunkCount: chunkIndex };
    meta = aggregateDashMeta(meta, trackName, track, speed);
    await putVideo(meta);
    broadcastProgress(meta);
    measuredBytes = downloadedBytes;
    measureStartedAt = now;
    lastPersistAt = now;
  };

  const flush = async () => {
    if (!pendingBytes) return;
    const blob = new Blob(pending, { type: "application/octet-stream" });
    await putChunk(meta.id, trackName, chunkIndex, blob);
    storedBytes += blob.size;
    chunkIndex += 1;
    pending = [];
    pendingBytes = 0;
  };

  try {
    do {
      const requestedOffset = downloadedBytes;
      const response = await fetch(url, {
        credentials: "omit",
        headers: { Range: `bytes=${requestedOffset}-` },
        signal: job.controller.signal
      });
      if (!response.ok) {
        if (response.status === 403) {
          throw new Error(`CDN ${trackName === "video" ? "视频" : "音频"}轨拒绝下载（HTTP 403），播放地址可能已过期；请重新打开原视频后继续`);
        }
        throw new Error(`CDN ${trackName === "video" ? "视频" : "音频"}轨下载失败（HTTP ${response.status}）`);
      }
      if (!response.body) throw new Error("浏览器没有提供可读取的下载流");

      if (requestedOffset > 0 && response.status !== 206) {
        await clearChunks(meta.id, trackName);
        storedBytes = 0;
        downloadedBytes = 0;
        chunkIndex = 0;
        pending = [];
        pendingBytes = 0;
        measuredBytes = 0;
        track = { ...track, downloadedBytes: 0, resumeBytes: 0, totalBytes: 0, chunkCount: 0 };
        meta = aggregateDashMeta(meta, trackName, track, 0);
        await putVideo(meta);
      }

      const contentRange = parseContentRange(response.headers.get("content-range"));
      const responseStart = downloadedBytes;
      if (response.status === 206) {
        if (!contentRange || contentRange.start !== responseStart) {
          throw new Error("CDN 返回了无法安全续传的数据范围");
        }
        if (contentRange.total > 0) {
          if (totalBytes > 0 && totalBytes !== contentRange.total) {
            throw new Error("CDN 返回的轨道大小与元数据不一致");
          }
          totalBytes = contentRange.total;
        }
      }

      const contentLength = Number(response.headers.get("content-length")) || 0;
      if (response.status === 200 && contentLength > 0) totalBytes = contentLength;
      const reader = response.body.getReader();
      let responseBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (job.deleted) throw new DOMException("已删除", "AbortError");
        pending.push(value);
        pendingBytes += value.byteLength;
        downloadedBytes += value.byteLength;
        responseBytes += value.byteLength;
        if (pendingBytes >= CHUNK_SIZE) await flush();
        await persistProgress();
      }
      if (contentLength > 0 && responseBytes !== contentLength) {
        throw new Error("CDN 连接提前结束，已保留进度供续传");
      }
      if (contentRange && downloadedBytes !== contentRange.end + 1) {
        throw new Error("CDN 返回的数据范围不完整，已保留进度供续传");
      }
      if (responseBytes === 0 && (!totalBytes || downloadedBytes < totalBytes)) {
        throw new Error("CDN 未返回后续数据，已保留进度供续传");
      }
    } while (totalBytes > 0 && downloadedBytes < totalBytes);
    if (totalBytes <= 0 || downloadedBytes !== totalBytes) {
      throw new Error("CDN 返回的轨道数据不完整，已保留进度供续传");
    }
  } catch (error) {
    if (!job.deleted) {
      track = { ...track, downloadedBytes: storedBytes, resumeBytes: storedBytes, totalBytes, chunkCount: chunkIndex };
      meta = aggregateDashMeta(meta, trackName, track, 0);
      await putVideo(meta);
    }
    throw error;
  }

  await flush();
  await persistProgress(true);
  return { meta, track: meta.tracks[trackName] };
}

async function fetchAndStore(urls, meta, job) {
  let lastError;
  for (const url of urls) {
    try {
      return await fetchCandidate(url, meta, job);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      lastError = error;
      meta = await getVideo(meta.id) || meta;
    }
  }
  throw lastError || new Error("所有 CDN 地址均无法连接");
}

async function fetchCandidate(url, meta, job) {
  let storedBytes = Number(meta.resumeBytes ?? meta.downloadedBytes) || 0;
  let downloadedBytes = storedBytes;
  let chunkIndex = Number(meta.chunkCount) || 0;
  let totalBytes = Number(meta.totalBytes) || 0;
  let pending = [];
  let pendingBytes = 0;
  let measuredBytes = downloadedBytes;
  let measureStartedAt = performance.now();
  let lastPersistAt = 0;

  const persistProgress = async (force = false) => {
    const now = performance.now();
    if (!force && now - lastPersistAt < PROGRESS_WRITE_INTERVAL) return;
    const elapsed = Math.max((now - measureStartedAt) / 1000, 0.001);
    const speed = Math.max(0, (downloadedBytes - measuredBytes) / elapsed);
    meta = {
      ...meta,
      downloadedBytes,
      resumeBytes: storedBytes,
      totalBytes,
      chunkCount: chunkIndex,
      progress: totalBytes ? Math.min(downloadedBytes / totalBytes, 0.999) : 0,
      speed,
      updatedAt: Date.now()
    };
    await putVideo(meta);
    broadcastProgress(meta);
    measuredBytes = downloadedBytes;
    measureStartedAt = now;
    lastPersistAt = now;
  };

  const flush = async () => {
    if (!pendingBytes) return;
    const blob = new Blob(pending, { type: "application/octet-stream" });
    await putChunk(meta.id, "media", chunkIndex, blob);
    storedBytes += blob.size;
    chunkIndex += 1;
    pending = [];
    pendingBytes = 0;
  };

  try {
    do {
      const requestedOffset = downloadedBytes;
      const headers = requestedOffset > 0 ? { Range: `bytes=${requestedOffset}-` } : undefined;
      const response = await fetch(url, {
        credentials: "omit",
        headers,
        signal: job.controller.signal
      });

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error("CDN 拒绝了下载来源（HTTP 403），请确认扩展已重载到最新版本");
        }
        throw new Error(`CDN 下载失败（HTTP ${response.status}）`);
      }
      if (!response.body) throw new Error("浏览器没有提供可读取的下载流");

      if (requestedOffset > 0 && response.status !== 206) {
        await clearChunks(meta.id);
        storedBytes = 0;
        downloadedBytes = 0;
        chunkIndex = 0;
        pending = [];
        pendingBytes = 0;
        measuredBytes = 0;
        meta = {
          ...meta,
          downloadedBytes: 0,
          resumeBytes: 0,
          chunkCount: 0,
          progress: 0,
          updatedAt: Date.now()
        };
        await putVideo(meta);
      }

      const contentRange = parseContentRange(response.headers.get("content-range"));
      const responseStart = downloadedBytes;
      if (response.status === 206) {
        if (!contentRange || contentRange.start !== responseStart) {
          throw new Error("CDN 返回了无法安全续传的数据范围");
        }
        if (contentRange.total > 0) {
          if (totalBytes > 0 && totalBytes !== contentRange.total) {
            throw new Error("CDN 返回的视频大小与元数据不一致");
          }
          totalBytes = contentRange.total;
        }
      }

      const contentLength = Number(response.headers.get("content-length")) || 0;
      if (response.status === 200 && contentLength > 0) {
        if (totalBytes > 0 && totalBytes !== contentLength) {
          throw new Error("CDN 返回的视频大小与元数据不一致");
        }
        totalBytes = contentLength;
      }

      const reader = response.body.getReader();
      let responseBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (job.deleted) throw new DOMException("已删除", "AbortError");
        pending.push(value);
        pendingBytes += value.byteLength;
        downloadedBytes += value.byteLength;
        responseBytes += value.byteLength;
        if (pendingBytes >= CHUNK_SIZE) await flush();
        await persistProgress();
      }

      if (contentLength > 0 && responseBytes !== contentLength) {
        throw new Error("CDN 连接提前结束，已保留进度供续传");
      }
      if (contentRange && downloadedBytes !== contentRange.end + 1) {
        throw new Error("CDN 返回的数据范围不完整，已保留进度供续传");
      }
      if (responseBytes === 0 && (!totalBytes || downloadedBytes < totalBytes)) {
        throw new Error("CDN 未返回后续数据，已保留进度供续传");
      }
    } while (totalBytes > 0 && downloadedBytes < totalBytes);

    if (totalBytes > 0 && downloadedBytes !== totalBytes) {
      throw new Error("CDN 返回的数据不完整，已保留进度供续传");
    }
  } catch (error) {
    if (!job.deleted) {
      meta = {
        ...meta,
        downloadedBytes: storedBytes,
        resumeBytes: storedBytes,
        chunkCount: chunkIndex,
        progress: totalBytes ? Math.min(storedBytes / totalBytes, 0.999) : 0,
        speed: 0,
        updatedAt: Date.now()
      };
      await putVideo(meta);
    }
    throw error;
  }

  await flush();
  await persistProgress(true);
  return { downloadedBytes, totalBytes, chunkCount: chunkIndex };
}

const mergeTasks = new Map();

function isMergedComplete(video) {
  return Number(video?.merged?.totalBytes) > 0 && hasCompleteByteCount(video);
}

/** 同一记录的合并任务只跑一次：播放与保存可能同时请求。 */
function ensureMergedTracks(video) {
  if (isMergedComplete(video)) return Promise.resolve(video);
  const running = mergeTasks.get(video.id);
  if (running) return running;
  const task = mergeTrackChunks(video, null, video.status === "complete" ? "complete" : "downloading")
    .finally(() => mergeTasks.delete(video.id));
  mergeTasks.set(video.id, task);
  return task;
}

/** 下载完成后的合并步骤；失败不丢数据，保留两条独立轨道供分别保存。 */
async function mergeDownloadedTracks(meta, job) {
  try {
    return await mergeTrackChunks(meta, job);
  } catch (error) {
    if (job?.deleted) return meta;
    const message = toPublicError(error);
    console.warn("[Bili 缓冲站] 双轨合并失败，保留独立轨道：", error);
    const failed = {
      ...meta,
      status: "downloading",
      stage: "",
      mergeStage: "failed",
      mergeError: message,
      updatedAt: Date.now()
    };
    await putVideo(failed);
    broadcastProgress(failed);
    return failed;
  }
}

function assertCompleteTrackChunks(label, track, chunks) {
  const storedBytes = chunks.reduce((sum, chunk) => sum + (Number(chunk.data?.size) || 0), 0);
  const totalBytes = Number(track.totalBytes) || 0;
  if (
    !chunks.length ||
    chunks.length !== Number(track.chunkCount) ||
    storedBytes !== totalBytes ||
    !hasCompleteByteCount(track)
  ) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.TRUNCATED, `${label}轨本地分块不完整，无法合并`);
  }
}

function createChunkWriter(videoId, track) {
  const buffer = new Uint8Array(CHUNK_SIZE);
  let used = 0;
  let index = 0;
  let total = 0;
  const flush = async () => {
    if (!used) return;
    await putChunk(videoId, track, index, new Blob([buffer.slice(0, used)], { type: "application/octet-stream" }));
    index += 1;
    used = 0;
  };
  return {
    async write(bytes) {
      total += bytes.length;
      let offset = 0;
      while (offset < bytes.length) {
        const size = Math.min(CHUNK_SIZE - used, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + size), used);
        used += size;
        offset += size;
        if (used === CHUNK_SIZE) await flush();
      }
    },
    async close() {
      await flush();
      return { totalBytes: total, chunkCount: index };
    }
  };
}

/**
 * 单文件 MP4 的仅音频路线：整段下载完成后无损抽出音轨，只保留音频分块。
 * 抽取失败会向上抛出，由 downloadVideo 写成错误状态，已下载的分块保留供重试。
 */
async function extractAudioTrackChunks(meta, job) {
  const mediaChunks = await getChunks(meta.id, "media");
  const storedBytes = mediaChunks.reduce((sum, chunk) => sum + (Number(chunk.data?.size) || 0), 0);
  if (
    !mediaChunks.length ||
    mediaChunks.length !== Number(meta.chunkCount) ||
    storedBytes !== Number(meta.totalBytes) ||
    !hasCompleteByteCount(meta)
  ) {
    throw new Error("单文件 MP4 的本地分块不完整，无法提取音轨");
  }

  const extraction = await createAudioOnlyMp4({ chunks: mediaChunks });
  await clearChunks(meta.id, "audio");
  const extracting = { ...meta, status: "downloading", stage: "extracting", merged: null, mergeError: "", speed: 0 };
  const writer = createChunkWriter(meta.id, "audio");
  const expectedBytes = Number(extraction.sourceBytes) || Number(meta.totalBytes) || 0;
  let written = 0;
  let lastBroadcastAt = 0;
  const report = async (force) => {
    const now = performance.now();
    if (!force && now - lastBroadcastAt < PROGRESS_WRITE_INTERVAL) return;
    lastBroadcastAt = now;
    const snapshot = {
      ...extracting,
      progress: expectedBytes > 0 ? Math.min(written / expectedBytes, 0.99) : 0,
      updatedAt: Date.now()
    };
    await putVideo(snapshot);
    broadcastProgress(snapshot);
  };
  await report(true);

  await writer.write(extraction.header);
  written += extraction.header.length;
  for await (const piece of extraction.stream()) {
    if (job?.deleted) throw new DOMException("已删除", "AbortError");
    await writer.write(piece);
    written += piece.length;
    await report(false);
  }
  const stats = await writer.close();

  // 自检：写回的字节数、块数与开头结构都必须与提取结果一致。
  const storedChunks = await getChunks(meta.id, "audio");
  const audioBytes = storedChunks.reduce((sum, chunk) => sum + (Number(chunk.data?.size) || 0), 0);
  if (audioBytes !== stats.totalBytes || storedChunks.length !== stats.chunkCount || stats.totalBytes !== written) {
    throw new Error("音轨写入本地缓存时字节数不一致");
  }
  const headBytes = new Uint8Array(await storedChunks[0].data.slice(0, extraction.header.length).arrayBuffer());
  if (headBytes.length !== extraction.header.length) {
    throw new Error("音轨初始化段写入不完整");
  }
  // 只校验写回的开头（ftyp + 单轨 moov）；完整字节数已在上面的分块统计里核对。
  verifyAudioOnlyMp4(headBytes, { requireMdat: false });

  const duration = Number(extraction.audioTrack.duration) || Number(meta.duration) || 0;
  const bandwidth = Number(extraction.audioTrack.bandwidth)
    || (duration > 0 ? Math.round(stats.totalBytes * 8 / duration) : 0);
  const audioLabel = describeAudioTrack({ ...extraction.audioTrack, bandwidth });
  const record = {
    ...meta,
    schemaVersion: 3,
    mediaKind: "audio",
    cacheMode: CACHE_MODES.AUDIO,
    stage: "",
    mergeStage: "",
    mergeError: "",
    extractedFrom: {
      mediaBytes: Number(meta.totalBytes) || 0,
      mimeType: meta.mimeType || "video/mp4"
    },
    tracks: {
      audio: {
        name: "audio",
        representationKey: `progressive:${extraction.audioTrack.trackId}:${extraction.audioTrack.codecs || extraction.audioTrack.sampleEntryType}`,
        representationId: 0,
        codecs: extraction.audioTrack.codecs || "",
        mimeType: extraction.audioTrack.mimeType || "audio/mp4",
        bandwidth,
        sourceUrls: Array.isArray(meta.sourceUrls) ? meta.sourceUrls : [],
        downloadedBytes: stats.totalBytes,
        resumeBytes: stats.totalBytes,
        totalBytes: stats.totalBytes,
        chunkCount: stats.chunkCount
      }
    },
    mimeType: extraction.audioTrack.mimeType || "audio/mp4",
    codec: "",
    codecLabel: "",
    qualityLabel: audioLabel,
    audioLabel,
    audioId: 0,
    downloadedBytes: stats.totalBytes,
    resumeBytes: stats.totalBytes,
    totalBytes: stats.totalBytes,
    chunkCount: stats.chunkCount,
    progress: 1,
    updatedAt: Date.now()
  };
  // 先落记录再释放整段 MP4，避免崩溃窗口里出现“记录已完成但分块已删除”。
  await putVideo(record);
  await clearChunks(meta.id, "media");
  broadcastProgress(record);
  return record;
}

/**
 * 把视频轨与音频轨重封装成单个双轨 MP4，写回本地缓存并释放两条源轨道。
 * 只有全部校验通过才会删除源分块，合并失败时原轨道原样保留。
 */
async function mergeTrackChunks(meta, job, mergingStatus = "downloading") {
  if (isMergedComplete(meta)) return meta;
  const videoTrack = meta.tracks?.video;
  const audioTrack = meta.tracks?.audio;
  if (!videoTrack || !audioTrack) {
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, "缺少音频伴音轨，无法合并为单个 MP4");
  }

  const videoChunks = await getChunks(meta.id, "video");
  const audioChunks = await getChunks(meta.id, "audio");
  assertCompleteTrackChunks("视频", videoTrack, videoChunks);
  assertCompleteTrackChunks("音频", audioTrack, audioChunks);

  await clearChunks(meta.id, MERGED_TRACK);
  const merged = await createMergedFragmentedMp4({
    video: { chunks: videoChunks },
    audio: { chunks: audioChunks }
  });
  const expectedBytes = Number(videoTrack.totalBytes) + Number(audioTrack.totalBytes);
  const merging = { ...meta, status: mergingStatus, stage: "merging", mergeStage: "merging", mergeError: "", speed: 0 };
  const writer = createChunkWriter(meta.id, MERGED_TRACK);
  let written = 0;
  let lastBroadcastAt = 0;
  const report = async (force) => {
    const now = performance.now();
    if (!force && now - lastBroadcastAt < PROGRESS_WRITE_INTERVAL) return;
    lastBroadcastAt = now;
    const snapshot = {
      ...merging,
      progress: expectedBytes > 0 ? Math.min(written / expectedBytes, 0.99) : 0,
      downloadedBytes: Math.min(written, expectedBytes),
      totalBytes: expectedBytes,
      updatedAt: Date.now()
    };
    await putVideo(snapshot);
    broadcastProgress(snapshot);
  };
  await report(true);

  await writer.write(merged.header);
  written += merged.header.length;
  for await (const fragment of merged.stream()) {
    if (job?.deleted) throw new DOMException("已删除", "AbortError");
    await writer.write(fragment);
    written += fragment.length;
    await report(false);
  }
  const stats = await writer.close();

  // 自检：写回的字节数、块数与开头结构都必须与合并结果一致。
  const storedChunks = await getChunks(meta.id, MERGED_TRACK);
  const storedBytes = storedChunks.reduce((sum, chunk) => sum + (Number(chunk.data?.size) || 0), 0);
  if (storedBytes !== stats.totalBytes || storedChunks.length !== stats.chunkCount || stats.totalBytes !== written) {
    throw new Error("合并结果写入本地缓存时字节数不一致");
  }
  const headBytes = new Uint8Array(await storedChunks[0].data.slice(0, merged.header.length).arrayBuffer());
  if (headBytes.length !== merged.header.length) {
    throw new Error("合并结果初始化段写入不完整");
  }
  verifyMergedHeader(headBytes, {
    videoTrackId: merged.videoTrackId,
    audioTrackId: merged.audioTrackId
  });

  const audioLabel = describeAudioTrack(audioTrack);
  const completed = {
    ...meta,
    schemaVersion: 3,
    status: "downloading",
    stage: "",
    mergeStage: "done",
    mergeError: "",
    speed: 0,
    merged: {
      track: MERGED_TRACK,
      mimeType: "video/mp4",
      totalBytes: stats.totalBytes,
      downloadedBytes: stats.totalBytes,
      chunkCount: stats.chunkCount,
      videoCodecs: String(videoTrack.codecs || ""),
      audioCodecs: String(audioTrack.codecs || ""),
      audioLabel,
      mergedAt: Date.now()
    },
    status: mergingStatus,
    tracks: {
      video: releasedTrack(videoTrack),
      audio: releasedTrack(audioTrack)
    },
    audioLabel,
    downloadedBytes: stats.totalBytes,
    resumeBytes: stats.totalBytes,
    totalBytes: stats.totalBytes,
    chunkCount: stats.chunkCount,
    progress: 1,
    updatedAt: Date.now()
  };
  // 先把合并结果写成唯一事实，再释放源分块：中途崩溃最多多占一份空间，
  // 不会出现"记录已完成但分块已被删掉"的死局。
  await putVideo(completed);
  await clearChunks(meta.id, "video");
  await clearChunks(meta.id, "audio");
  broadcastProgress(completed);
  return completed;
}

/** 源轨道分块已并入单文件，只保留展示与诊断所需的元数据。 */
function releasedTrack(track) {
  return {
    ...track,
    downloadedBytes: 0,
    resumeBytes: 0,
    totalBytes: 0,
    chunkCount: 0,
    releasedIntoMerged: true
  };
}

async function deleteVideo(videoId) {
  const playback = playbackUrls.get(videoId);
  if (playback) {
    if (typeof playback === "string") {
      URL.revokeObjectURL(playback);
    } else {
      for (const track of playback.tracks || []) URL.revokeObjectURL(track.url);
    }
    playbackUrls.delete(videoId);
  }
  const job = activeDownloads.get(videoId);
  if (job) {
    job.deleted = true;
    job.controller.abort();
  }
  await deleteVideoData(videoId);
  chrome.runtime.sendMessage({ target: "background", type: "CACHE_DELETED", videoId }).catch(() => {});
  return { deleted: true };
}

function broadcastProgress(video, type = "CACHE_PROGRESS") {
  chrome.runtime.sendMessage({ target: "background", type, video }).catch(() => {});
}
