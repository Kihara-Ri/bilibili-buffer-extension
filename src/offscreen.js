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
  buildMediaQualityOptions,
  CODEC_LABELS,
  getCodecFamily,
  getPersistedMediaSource,
  hasCompleteByteCount,
  makeMimeCodec,
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
import { startDevReloadPolling } from "./dev-reload.js";

const CHUNK_SIZE = 4 * 1024 * 1024;
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
  const video = await getVideo(videoId);
  if (!video || video.status !== "complete" || !hasCompleteByteCount(video)) {
    throw new Error("本地缓存尚未完成");
  }

  const existingUrl = playbackUrls.get(videoId);
  if (existingUrl) {
    return video.mediaKind === "dash"
      ? { playback: existingUrl, video }
      : { playbackUrl: existingUrl, video };
  }

  if (video.mediaKind === "dash") {
    const playbackTracks = [];
    for (const [trackName, track] of Object.entries(video.tracks || {})) {
      if (!hasCompleteByteCount(track)) throw new Error("本地 DASH 轨道尚未完成");
      const chunks = await getChunks(videoId, trackName);
      if (!chunks.length || chunks.length !== track.chunkCount) {
        throw new Error(`本地${trackName === "video" ? "视频" : "音频"}轨缓存块不完整`);
      }
      const blob = new Blob(chunks.map((chunk) => chunk.data), {
        type: track.mimeType || "application/octet-stream"
      });
      if (blob.size !== track.totalBytes) throw new Error("本地 DASH 轨道字节数校验失败");
      playbackTracks.push({
        name: trackName,
        url: URL.createObjectURL(blob),
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

  const chunks = await getChunks(videoId, "media");
  if (!chunks.length || chunks.length !== video.chunkCount) {
    throw new Error("本地缓存块不完整，请继续缓存或删除后重试");
  }
  const blob = new Blob(chunks.map((chunk) => chunk.data), {
    type: video.mimeType || "video/mp4"
  });
  if (blob.size !== video.totalBytes) {
    throw new Error("本地缓存字节数不完整，请继续缓存或删除后重试");
  }

  const playbackUrl = URL.createObjectURL(blob);
  playbackUrls.set(videoId, playbackUrl);
  return { playbackUrl, video };
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

function getTrackUrls(track) {
  const primary = track?.baseUrl || track?.base_url;
  const backups = track?.backupUrl || track?.backup_url || [];
  return [primary, ...backups].filter(Boolean);
}

function isSupportedTrack(track) {
  const mimeType = track?.mimeType || track?.mime_type;
  const type = makeMimeCodec(mimeType, track?.codecs);
  if (!type || !getTrackUrls(track).length) return false;
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

function chooseRepresentation(tracks, predicate = () => true) {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((track) => predicate(track) && isSupportedTrack(track))
    .sort((left, right) => {
      const codecDifference = codecPriority(right.codecs) - codecPriority(left.codecs);
      return codecDifference || (Number(right.bandwidth) || 0) - (Number(left.bandwidth) || 0);
    })[0] || null;
}

function chooseVideoRepresentation(tracks, quality, codecPreference) {
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
  const dashAudio = chooseRepresentation([...standardAudio, ...dolbyAudio, ...flacAudio]);

  if (dashVideo) {
    const selectedCodec = getCodecFamily(dashVideo.codecs);
    const tracks = { video: toDashTrack("video", dashVideo) };
    if (dashAudio) tracks.audio = toDashTrack("audio", dashAudio);
    return {
      mediaKind: "dash",
      tracks,
      duration: Math.round(Number(data.dash?.duration) || video.duration || 0),
      quality: selectedQuality,
      qualityLabel: actualOption?.label || QUALITY_LABELS[selectedQuality] || `画质 ${selectedQuality}`,
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

  const segments = Array.isArray(data.durl) ? data.durl : [];
  const isMp4 = String(data.format || "").includes("mp4");
  if (!isMp4 || segments.length !== 1 || !segments[0]?.url || actualQuality !== selectedQuality) {
    if (persistedSource) return persistedSource;
    throw new Error("B 站没有返回所选画质的可播放 MP4 或 DASH 轨道");
  }

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
  const { auth: _auth, playurlData: _playurlData, ...safeVideo } = video;
  try {
    const source = await resolveMediaSource(video);
    const meta = source.mediaKind === "dash"
      ? await downloadDashSource(safeVideo, existing, source, job)
      : await downloadProgressiveSource(safeVideo, existing, source, job);
    if (job.deleted) return;
    await putVideo(meta);
    broadcastProgress(meta, "CACHE_COMPLETE");
  } catch (error) {
    if (job.deleted) return;
    const current = await getVideo(video.id).catch(() => null) || existing || safeVideo;
    const { auth: _currentAuth, playurlData: _currentPlayurl, ...safeCurrent } = current;
    const message = error?.name === "AbortError" ? "缓存已暂停，点击可继续" : toPublicError(error);
    const failed = {
      ...safeCurrent,
      status: "error",
      speed: 0,
      error: message,
      updatedAt: Date.now()
    };
    await putVideo(failed);
    broadcastProgress(failed, "CACHE_ERROR");
  }
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

    const state = states.get("media");
    const downloadedBytes = state.resumeBytes + (durableOnly ? 0 : state.volatileBytes);
    return {
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

async function downloadDashSource(video, existing, source, job) {
  const sourceEntries = Object.entries(source.tracks);
  const canResume = Boolean(
    existing?.mediaKind === "dash" &&
    existing.quality === source.quality &&
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
    schemaVersion: 2,
    mediaKind: "dash",
    status: "downloading",
    progress: 0,
    speed: 0,
    downloadedBytes: 0,
    resumeBytes: 0,
    totalBytes: 0,
    chunkCount: 0,
    mimeType: "video/mp4",
    quality: source.quality,
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
        ? trackName === "video" ? 2 : 1
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
