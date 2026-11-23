import { BUILD_VERSION } from "./distribution.js";
import { createDownloadBudget } from "./download-budget.js";
import { committedMediaPath, createCommittedSourceReader } from "./committed-source.js";
import { createWorkGate } from "./update-work-gate.js";
import { t } from "./i18n.js";
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
  publishVideoAsset,
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
  getPublishedCacheAsset,
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
import { createSourceMirror } from "./source-mirror.js";
import { createSourceRepository, createSourceWriter, sourceRangeScope } from "./source-range-store.js";
import { isCachePageOpen, isExpiredCache, isTemporaryCache, TEMPORARY_CACHE_TTL } from "./temporary-cache.js";

// 镜像直写共享的 IndexedDB（原因见 createSourceWriter）；账户分区仍由后台用 cookies API 计算。
const sourceRepository = typeof indexedDB === "undefined" ? null : createSourceRepository();
const requestSourcePartition = async (type = "SOURCE_RANGE") => {
  let timer;
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage({ target: "background", type, request: { op: "partition" } }),
      new Promise(resolve => { timer = setTimeout(resolve, 1_500); })
    ]);
    return response?.partition;
  } finally {
    clearTimeout(timer);
  }
};
/** 每个下载任务一个写入器：账户分区按任务取一次。 */

import { isDownloadRetryDue, isRecoverableDownloadError, makeDownloadRetryState, needsDownloadRecovery } from "./download-retry.js";
import { startDevReloadPolling } from "./dev-reload.js";

// 原生 fetch 必须以 window 为 this 调用；作为 options.fetchImpl 传下去再以方法形式调用会抛
// 「Illegal invocation」（2.8.13 的回归：离线缓存每次都在第一个请求就失败）。
const networkFetch = (input, init) => fetch(input, init);
// 任务内连续多少次「没有任何新落盘字节」的失败后才交给看门狗，以及每次的等待秒数。
// 只要还在推进就一直在本进程内续传，不再动辄等一分钟。
const IN_PROCESS_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000, 15_000, 30_000, 60_000]);
const CHUNK_SIZE = 4 * 1024 * 1024;
// 合并后的单文件缓存使用独立的分块序列。
const MERGED_TRACK = "merged";
const PROGRESS_WRITE_INTERVAL = 450;
const META_WRITE_INTERVAL = 1500;
const AUTOMATIC_CACHE_BYTES = 8 * 1024 ** 3;
const activeDownloads = new Map();
const taskCommands = new Map();
const playbackUrls = new Map();
const playbackUses = new Map();
const PLAYBACK_OPEN_TIMEOUT = 5 * 60_000;
const automaticReservations = new Map();
let automaticAdmission = Promise.resolve();
const downloadBudget = createDownloadBudget();
const createDownloadMirror = video => createSourceMirror({
  send: createSourceWriter({ repository: sourceRepository, partition: requestSourcePartition,
    videoId: isTemporaryCache(video) ? video.id : undefined }),
  reserve: downloadBudget.tryReserveBytes
});
const committedSourceReader = createCommittedSourceReader();
let latestTaskStamp = 0;

async function committedPartition(urls, prior) {
  if (prior) return prior;
  if (!urls.some(committedMediaPath)) return "";
  // 使用账户摘要绑定源分块。继续下载不能把已有归属的字节改记到另一个账户。
  try {
    return await requestSourcePartition("GET_COMMITTED_PARTITION") || "";
  } catch { return ""; }
}

if (chrome.runtime.id) startDevReloadPolling();
void initialize();

async function initialize() {
  await openCacheDb();
  await navigator.storage?.persist?.().catch(() => false);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: toPublicError(error) }));
  return true;
});

const updateGate = createWorkGate();
async function handleMessage(message, sender) {
  if (message.type === "UPDATE_CACHE_PLAYBACK_USE" && !sender?.tab) {
    updatePlaybackUse(message);
    return {};
  }
  if (message.type === "READ_COMMITTED_SOURCE") {
    if (!sender?.tab && sender?.id === chrome.runtime.id) return committedSourceReader.read(message);
    return {};
  }
  if (message.type === "RELEASE_COMMITTED_SOURCE") {
    if (sender?.id === chrome.runtime.id) committedSourceReader.release(message.url);
    return {};
  }
  if (message.type === "PLAYBACK_PRESSURE") {
    const tabId = sender?.tab?.id;
    const scope = sourceRangeScope({ id: sender?.id, url: sender?.url }, { runtimeId: chrome.runtime.id });
    if (scope === "reader" && sender.frameId === 0 && Number.isInteger(tabId)) {
      downloadBudget.updatePlayback(`${tabId}:${sender.documentId || ""}`, message.level, message.sampledAt, message.fullSpeed === true);
    }
    return {};
  }
  if (message.type === 'GET_UPDATE_HEALTH') return {version:BUILD_VERSION};
  if (message.type === 'UNLOCK_FOR_UPDATE') { updateGate.open(); return {}; }
  if (message.type === 'LOCK_FOR_UPDATE') {
    await updateGate.close();
    const ids = [...new Set([...activeDownloads.keys(), ...(await listVideos()).filter(video=>video.status==='downloading').map(video=>video.id)])];
    const paused = await Promise.all(ids.map(id => runTaskCommand(id, () => pauseDownload(id, { forUpdate: true }))));
    return { pausedIds: paused.filter(result => result.paused).map(result => result.video.id) };
  }
  if (["START_DOWNLOAD", "RESUME_DOWNLOAD", "RECOVER_DOWNLOADS", "GET_PLAYBACK_URL", "DELETE_VIDEO", "PAUSE_DOWNLOAD", "SYNC_TEMPORARY_CACHES"].includes(message.type)) {
    return updateGate.run(() => handleCacheCommand(message));
  }
  return handleCacheCommand(message);
}
async function handleCacheCommand(message) {
  const { videoId } = message;
  switch (message.type) {
    case "START_DOWNLOAD":
      return runTaskCommand(message.video?.id, () => startDownload(message.video.id, { request: message.video }));
    case "RESUME_DOWNLOAD":
      return runTaskCommand(videoId, () => startDownload(videoId, {
        createdAt: message.createdAt, tabId: message.tabId, afterUpdate: message.afterUpdate
      }));
    case "RECOVER_DOWNLOADS":
      return recoverDownloads();
    case "SYNC_TEMPORARY_CACHES":
      return syncTemporaryCaches(message.pages);
    case "GET_ACTIVE_DOWNLOADS":
      return { videoIds: [...activeDownloads.keys()] };
    case "LIST_VIDEOS":
      return { videos: await listVideos() };
    case "GET_VIDEO":
      return { video: await getVideo(message.videoId) || null };
    case "GET_PLAYBACK_URL":
      // 旧双轨读取可能触发合并并写库，要与同任务的删除互斥。
      return runTaskCommand(videoId, async () => {
        const result = await createPlaybackUrl(videoId);
        const temporary = isTemporaryCache(result.video);
        if (message.leaseId) {
          beginPlaybackUse(message.leaseId, videoId, message.tabId, temporary);
        } else {
          // 旧的直接 URL 调用没有关闭事件，用有限租约维持同一地址供近期复用。
          beginPlaybackUse(`raw:${videoId}`, videoId, undefined, temporary);
        }
        if (temporary && result.video.cacheExpiresAt) {
          result.video = await putVideo({ ...result.video, cacheExpiresAt: null });
        }
        return result;
      });
    case "DELETE_VIDEO":
      return runTaskCommand(videoId, () => deleteVideo(videoId, message.createdAt));
    case "PAUSE_DOWNLOAD":
      return runTaskCommand(videoId, () => pauseDownload(videoId, { createdAt: message.createdAt }));
    default:
      throw new Error(t("err.unknownCacheCommand"));
  }
}

function beginPlaybackUse(leaseId, videoId, tabId, temporary) {
  const previous = playbackUses.get(leaseId);
  clearTimeout(previous?.timer);
  const use = { videoId, tabId, temporary, downloads: new Set(), opening: !Number.isInteger(tabId) };
  if (use.opening) use.timer = setTimeout(() => finishOpening(leaseId, use), PLAYBACK_OPEN_TIMEOUT);
  playbackUses.set(leaseId, use);
}

function hasPlaybackUse(videoId) {
  for (const use of playbackUses.values()) if (use.videoId === videoId) return true;
  return false;
}

function releasePlaybackUse(leaseId, use) {
  clearTimeout(use.timer);
  playbackUses.delete(leaseId);
  if (!hasPlaybackUse(use.videoId)) {
    revokePlayback(use.videoId);
    if (use.temporary) chrome.runtime.sendMessage({ target: "background", type: "TEMPORARY_CACHE_USE_ENDED" }).catch(() => {});
  }
}

function finishOpening(leaseId, use) {
  clearTimeout(use.timer);
  use.opening = false;
  if (!Number.isInteger(use.tabId) && !use.downloads.size) releasePlaybackUse(leaseId, use);
}

/** 使用者由 SW 转交；Offscreen 持有租约，SW 休眠后收到关闭事件仍可释放。 */
function updatePlaybackUse({ action, leaseId, tabId, downloadId }) {
  if (action === "closeTab" || action === "endDownload") {
    for (const [id, use] of playbackUses) {
      if (action === "closeTab" && use.tabId === tabId) releasePlaybackUse(id, use);
      if (action === "endDownload" && use.downloads.delete(downloadId) && !use.opening && !use.downloads.size) {
        releasePlaybackUse(id, use);
      }
    }
    return;
  }
  const use = playbackUses.get(leaseId);
  if (!use) return;
  if (action === "release" && (tabId === undefined || use.tabId === tabId)) releasePlaybackUse(leaseId, use);
  if (action === "bindTab") {
    use.tabId = tabId;
    finishOpening(leaseId, use);
  }
  if (action === "addDownload") use.downloads.add(downloadId);
  if (action === "finish") finishOpening(leaseId, use);
}

async function createPlaybackUrl(videoId) {
  let video = await getVideo(videoId);
  if (!video || (isExpiredCache(video) && !hasPlaybackUse(videoId)) ||
      video.status !== "complete" || !hasCompleteByteCount(video)) {
    throw new Error(t("err.notComplete"));
  }

  const existingUrl = playbackUrls.get(videoId);
  if (existingUrl) {
    // DASH 合并后仍保留 mediaKind，但缓存值已是单文件 URL；重复请求必须与首次返回同一契约。
    return typeof existingUrl === "string"
      ? { playbackUrl: existingUrl, video }
      : { playback: existingUrl, video };
  }

  // 仅音频缓存只组装音频轨，不参与网页自动播放。
  if (isAudioOnlyCache(video)) {
    const track = video.tracks?.audio;
    if (!track) throw new Error(t("err.audioNoTrack"));
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
        console.warn("[海内存知] 合并本地双轨失败，回退到双轨播放：", error);
        // 记下失败原因，避免每次播放都重复尝试；双轨缓存始终原样保留。
        video = { ...(await getVideo(videoId) || video), stage: "", mergeStage: "failed", mergeError: toPublicError(error), updatedAt: Date.now() };
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
      if (!hasCompleteByteCount(track)) throw new Error(t("err.dashIncomplete"));
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
    throw new Error(t("err.chunksIncomplete", { track: trackLabel(trackName) }));
  }
  const blob = new Blob(chunks.map((chunk) => chunk.data), {
    type: track.mimeType || "application/octet-stream"
  });
  if (Number(track.totalBytes) > 0 && blob.size !== Number(track.totalBytes)) {
    throw new Error(t("err.bytesMismatch", { track: trackLabel(trackName) }));
  }
  return URL.createObjectURL(blob);
}

function trackLabel(trackName) {
  if (trackName === "video") return t("track.videoTrack");
  if (trackName === "audio") return t("track.audioTrack");
  if (trackName === MERGED_TRACK) return t("track.merged");
  return t("track.cache");
}

/** 同一 ID 的控制命令按入队顺序执行。网络取源和下载在队列外运行，便于暂停或删除。 */
function runTaskCommand(videoId, operation) {
  if (!videoId || typeof videoId !== "string") throw new Error(t("err.videoInfoIncomplete"));
  const command = (taskCommands.get(videoId) || Promise.resolve()).then(operation);
  const tail = command.catch(() => {});
  taskCommands.set(videoId, tail);
  return command.finally(() => {
    if (taskCommands.get(videoId) === tail) taskCommands.delete(videoId);
  });
}

function nextTaskStamp(video) {
  latestTaskStamp = Math.max(Date.now(), latestTaskStamp + 1, (Number(video?.runStartedAt) || 0) + 1, (Number(video?.updatedAt) || 0) + 1);
  return latestTaskStamp;
}

/** 旧记录没有创建时间时按 0 匹配。世代校验必须在中止或启动下载之前执行。 */
function matchesTaskCreation(video, createdAt) {
  return !Number.isFinite(createdAt) || Boolean(video && (Number(video.createdAt) || 0) === createdAt);
}

async function startDownload(videoId, { request, recovery, createdAt, tabId, afterUpdate } = {}) {
  let existing = await getVideo(videoId);
  // 看门狗扫描可能落后于暂停、删除与重新缓存，入队后必须用最新的状态、世代和退避时间复核。
  if (recovery && (!needsDownloadRecovery(existing) || !isDownloadRetryDue(existing) ||
    existing.runStartedAt !== recovery.runStartedAt || existing.createdAt !== recovery.createdAt)) return { started: false };
  if (afterUpdate && !(existing?.status === "downloading" || (existing?.status === "paused" && existing.pausedByUpdate !== false))) {
    return { started: false, video: existing || null };
  }
  if ((!existing && !request) || !matchesTaskCreation(existing, createdAt)) throw new Error(t("err.taskGone"));
  const keepManually = request && request.automatic !== true;
  if (isExpiredCache(existing) && !keepManually && !hasPlaybackUse(videoId)) {
    if (!request) return { started: false, video: existing };
    await deleteVideo(videoId, Number(existing.createdAt) || 0);
    existing = null;
  }
  if (keepManually && existing?.automatic) {
    // 下载快照会覆盖旧元数据。先结束该世代再转手动，从同一确认水位继续，完成的文件直接保留。
    await stopDownload(videoId);
    existing = await putVideo({ ...await getVideo(videoId), automatic: false, cacheOrigin: "manual",
      cacheExpiresAt: null, pausedByDeparture: false });
  }
  if (isTemporaryCache(existing) && existing.cacheExpiresAt > 0 && !request) {
    return { started: false, video: existing };
  }
  if (activeDownloads.has(videoId)) return { started: false, video: existing };
  if (request?.automatic && existing &&
      ((existing.status === "paused" && !existing.pausedByDeparture) || existing.status === "error" ||
      !isDownloadRetryDue(existing))) return { started: false, video: existing };
  if (existing?.status === "complete" && hasCompleteByteCount(existing)) {
    return { started: false, alreadyComplete: true, video: existing };
  }
  const input = request?.automatic && existing
    ? { ...existing, tabId: request.tabId, requestedQuality: request.requestedQuality, requestedQualityExplicit: true,
        sourcePaths: request.sourcePaths || existing.sourcePaths }
    : { ...existing, ...request };
  if (!input.bvid || !input.cid) throw new Error(t("err.videoInfoIncomplete"));

  const asset = getPublishedCacheAsset(existing);
  const published = asset ? await recoverPublishedAsset(existing, asset) : null;
  if (published) {
    broadcastProgress(published, "CACHE_COMPLETE");
    return { started: false, alreadyComplete: true, video: published };
  }
  if (existing?.remux) existing = await discardRemux(existing);
  const { auth, playurlData, ...safe } = input;
  const stamp = nextTaskStamp(existing);
  const resumeBytes = asset ? 0 : Math.max(0, committedBytesOf(existing));
  const totalBytes = asset ? 0 : Number(existing?.totalBytes) || 0;
  const record = {
    ...safe,
    remux: existing?.remux || null,
    automatic: existing ? existing.automatic === true && (!request || request.automatic === true) : request?.automatic === true,
    // 旧条目的 automatic 也可能由手动快捷键产生。复用旧条目时不得补记为进页自动。
    cacheOrigin: existing ? existing.cacheOrigin : request?.cacheOrigin,
    cacheExpiresAt: null,
    pausedByDeparture: false,
    // 从当前视频页继续时，用该页的会话取源，并在完成后通知该页接管播放。
    tabId: Number.isInteger(tabId) ? tabId : safe.tabId,
    // 旧合并记录已核实缺块。保留视频身份，断点和旧轨道地址按无可续数据处理。
    ...(asset ? { merged: null, extractedFrom: null, tracks: null, sourceUrls: [], etag: "", chunkCount: 0 } : {}),
    downloadedBytes: resumeBytes, committedBytes: resumeBytes, resumeBytes, totalBytes,
    progress: totalBytes ? Math.min(resumeBytes / totalBytes, 0.999) : 0,
    status: "downloading", stage: "", mergeStage: "", pausedByUpdate: false,
    createdAt: existing ? Number(existing.createdAt) || 0 : stamp,
    runStartedAt: stamp, updatedAt: stamp, completedAt: null,
    error: "", speed: 0, nextRetryAt: 0, retryDelayMs: 0,
    autoRetryCount: recovery ? Number(existing.autoRetryCount) || 0 : 0
  };
  // 每次取源前先登记可恢复的记录。重启只能从这条记录决定是否自动继续。
  await putVideo(record);
  if (existing?.status === "complete") revokePlayback(videoId);
  const job = { controller: new AbortController(), deleted: false };
  activeDownloads.set(videoId, job);
  job.done = downloadVideo({ ...record, auth, playurlData }, asset ? null : existing, job)
    .catch(error => console.warn("[海内存知] 下载任务收尾失败", toPublicError(error)))
    .finally(() => activeDownloads.delete(videoId));
  broadcastProgress(record);
  return { started: true, video: record };
}

async function recoverDownloads() {
  const candidates = (await listVideos()).filter(needsDownloadRecovery);
  const results = await Promise.allSettled(candidates.map(video =>
    runTaskCommand(video.id, () => startDownload(video.id, { recovery: video }))
  ));
  for (const result of results) {
    if (result.status === "rejected") console.warn("[海内存知] 无法恢复上次的缓存任务", toPublicError(result.reason));
  }
  return {};
}

/** 浏览器标签快照由 SW 提供；Offscreen 按任务 ID 串行变更保留期限、停下载与删除。 */
async function syncTemporaryCaches(pages) {
  if (!Array.isArray(pages)) return {};
  const observedAt = Date.now();
  const rows = (await listVideos()).filter(isTemporaryCache);
  const deadlines = await Promise.all(rows.map(({ id }) => runTaskCommand(id, async () => {
    let video = await getVideo(id);
    if (!isTemporaryCache(video)) return 0;
    const held = hasPlaybackUse(id);
    if (!held && isExpiredCache(video, observedAt)) {
      await deleteVideo(id, Number(video.createdAt) || 0);
      return 0;
    }
    if (held || pages.some(page => isCachePageOpen(video, page))) {
      if (video.cacheExpiresAt) await putVideo({ ...video, cacheExpiresAt: null });
      return 0;
    }
    if (video.cacheExpiresAt > 0) return video.cacheExpiresAt;
    await stopDownload(id);
    video = await getVideo(id);
    const cacheExpiresAt = observedAt + TEMPORARY_CACHE_TTL;
    const departed = video.status === "downloading";
    const next = await putVideo({
      ...(departed ? pausedRecord(video, false) : video), cacheExpiresAt,
      pausedByDeparture: departed || video.pausedByDeparture === true
    });
    if (departed) broadcastProgress(next, "CACHE_PAUSED");
    return cacheExpiresAt;
  })));
  const nextExpiry = deadlines.reduce((earliest, deadline) => deadline > 0 ? Math.min(earliest, deadline) : earliest, Infinity);
  return { nextExpiry: Number.isFinite(nextExpiry) ? nextExpiry : null };
}

async function stopDownload(videoId, deleted = false) {
  const job = activeDownloads.get(videoId);
  if (!job) return;
  job.deleted = deleted;
  job.controller.abort();
  // 已经开出的分块事务仍需收尾。等它结束后再改变状态或清库。
  await job.done;
}

async function pauseDownload(videoId, { createdAt, forUpdate = false } = {}) {
  if (Number.isFinite(createdAt) && !matchesTaskCreation(await getVideo(videoId), createdAt)) return { paused: false };
  await stopDownload(videoId);
  const video = await getVideo(videoId);
  if (!video || video.status === "complete") return { paused: false, video: video || null };
  if (forUpdate && video.status !== "downloading") return { paused: false, video };
  if (video.status === "paused" && !video.pausedByUpdate && !video.pausedByDeparture) return { paused: true, video };
  const paused = pausedRecord({ ...video, pausedByDeparture: false }, forUpdate);
  await putVideo(paused);
  broadcastProgress(paused, "CACHE_PAUSED");
  return { paused: true, video: paused };
}

function pausedRecord(video, forUpdate) {
  const stamp = nextTaskStamp(video);
  return {
    ...video, status: "paused", pausedByUpdate: forUpdate, stage: "", speed: 0, error: "",
    nextRetryAt: 0, retryDelayMs: 0, runStartedAt: stamp, updatedAt: stamp
  };
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
    throw new Error(t("err.noResumeUrl"));
  }
  const actualQuality = normalizeQualityId(data.quality);
  const qualityOptions = buildMediaQualityOptions(data);
  const selectedQuality = explicitlyRequested
    ? requestedQuality
    : qualityOptions[0]?.quality || actualQuality;
  const actualOption = qualityOptions.find((option) => option.quality === selectedQuality);

  // 站点可能选用了音质不同的 AAC 或同一画质的另一编码。自动任务优先取播放器实际正在用的那条。
  const sameSource = (tracks, role) => (Array.isArray(tracks) ? tracks : []).filter(track =>
    video.sourcePaths?.[role] && getTrackUrls(track).some(url => committedMediaPath(url) === video.sourcePaths[role]));
  const dashVideo = chooseVideoRepresentation(sameSource(data.dash?.video, "video"), selectedQuality, requestedCodec) ||
    chooseVideoRepresentation(data.dash?.video, selectedQuality, requestedCodec);
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
      throw new Error(t("err.noAudioTrack"));
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

  const dashAudio = chooseAudioRepresentation(sameSource(audioCandidates, "audio"), { mode: "video" }) ||
    chooseAudioRepresentation(audioCandidates, { mode: "video" });

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
      qualityLabel: actualOption?.label || QUALITY_LABELS[selectedQuality] || t("quality.fallback", { quality: selectedQuality }),
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
      throw new Error(t("err.codecUnsupported", { codec: CODEC_LABELS[requestedCodec] }));
    }
    throw new Error(t("err.codecMissing", { codec: CODEC_LABELS[requestedCodec] }));
  }

  if (explicitlyRequested && !actualOption) {
    if (persistedSource) return persistedSource;
    const authenticationHint = auth.hasSessionCookie
      ? t("err.qualityHintSession")
      : t("err.qualityHintNoSession");
    throw new Error(t("err.qualityMissing", { quality: QUALITY_LABELS[requestedQuality] || requestedQuality, hint: authenticationHint }));
  }

  const progressive = progressiveSource();
  if (progressive) return progressive;
  if (persistedSource) return persistedSource;
  throw new Error(t("err.noPlayableTrack"));
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

/** 已确认落盘的字节数：判断一次失败前任务有没有推进。 */
const committedBytesOf = (video) => Number(video?.resumeBytes ?? video?.downloadedBytes) || 0;

class AutomaticCacheError extends Error {}

/** 只为已知真实大小的自动任务预留。与其他任务共用 Offscreen，但手动片库有独立的空间策略。 */
function reserveAutomaticBytes(video, bytes, signal) {
  if (!isTemporaryCache(video)) return;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new AutomaticCacheError(t("err.autoCacheUnknownSize"));
  if (bytes > AUTOMATIC_CACHE_BYTES) throw new AutomaticCacheError(t("err.autoCacheSpace"));
  const evictable = row => isTemporaryCache(row) && row.cacheExpiresAt > 0 &&
    (["complete", "error"].includes(row.status) || row.pausedByDeparture === true);
  const canEvict = row => evictable(row) &&
    !activeDownloads.has(row.id) && !taskCommands.has(row.id) && !hasPlaybackUse(row.id);
  const sizeOf = row => Math.max(
    Math.max(committedBytesOf(row), row.merged?.totalBytes || 0, row.remux?.sourceBytes || 0) + (row.remux?.bytes || 0),
    automaticReservations.get(row.id) || 0
  );
  const admission = automaticAdmission.then(async () => {
    signal?.throwIfAborted();
    const rows = (await listVideos()).filter(row => isTemporaryCache(row) && row.id !== video.id);
    let excess = bytes + rows.reduce((sum, row) => sum + sizeOf(row), 0) - AUTOMATIC_CACHE_BYTES;
    if (excess > 0) {
      const candidates = rows.filter(row => canEvict(row) && sizeOf(row) > 0)
        .sort((left, right) => left.cacheExpiresAt - right.cacheExpiresAt);
      if (candidates.reduce((sum, row) => sum + sizeOf(row), 0) < excess) throw new AutomaticCacheError(t("err.autoCacheSpace"));
      for (const row of candidates) {
        signal?.throwIfAborted();
        // 已排队的控制命令优先。运行中的任务可能在等本次准入，这里不能等待它们退出。
        if (!canEvict(row)) continue;
        excess -= await runTaskCommand(row.id, async () => {
          const current = await getVideo(row.id);
          if (!matchesTaskCreation(current, Number(row.createdAt) || 0) || !evictable(current) || hasPlaybackUse(row.id)) return 0;
          signal?.throwIfAborted();
          return (await deleteVideo(row.id, Number(row.createdAt) || 0)).deleted ? sizeOf(current) : 0;
        });
        if (excess <= 0) break;
      }
      if (excess > 0) throw new AutomaticCacheError(t("err.autoCacheSpace"));
    }
    signal?.throwIfAborted();
    automaticReservations.set(video.id, bytes);
  });
  automaticAdmission = admission.catch(() => {});
  return admission;
}

async function downloadVideo(video, existing, job) {
  let currentVideo = video;
  let currentExisting = existing;
  const { signal } = job.controller;
  let refreshBeforeAttempt = !video.playurlData;
  // 连续「零推进」失败次数：有新字节落盘就清零。只要还在推进，就在本进程内刷新地址后续传，
  // 播放页关着也不影响（播放地址由后台直接向 B 站接口获取）；真正长时间断网才交给看门狗。
  let stalledFailures = 0;
  let lastCommitted = committedBytesOf(existing);
  while (!signal.aborted) {
    const { auth: _auth, playurlData: _playurlData, ...safeVideo } = currentVideo;
    try {
      const releaseTask = await downloadBudget.acquireTask(signal);
      try {
        await downloadBudget.waitForPlayback(signal);
        if (refreshBeforeAttempt) {
          try {
            const { auth, playurlData } = await refreshDownloadSource(safeVideo, signal);
            currentVideo = { ...safeVideo, auth, playurlData };
          } catch (error) {
            signal.throwIfAborted();
            // 取清单失败时仍可试用保存的旧地址；新任务交给同一套退避流程。
            if (!currentVideo.playurlData && !getPersistedMediaSource(safeVideo)) throw error;
          }
        }
        signal.throwIfAborted();
        const source = await resolveMediaSource(currentVideo);
        signal.throwIfAborted();
        const meta = source.mediaKind === "progressive"
          ? await downloadProgressiveSource(safeVideo, currentExisting, source, job)
          : await downloadTrackSource(safeVideo, currentExisting, source, job);
        if (job.deleted) return;
        let completed;
        if (source.mediaKind === "progressive" && source.audioOnly) completed = await extractAudioTrackChunks(meta, job);
        else if (source.mediaKind === "dash" && source.tracks.audio) completed = await mergeDownloadedTracks(meta, job);
        else completed = await putVideo(completeDownload(meta));
        if (!job.deleted) broadcastProgress(completed, "CACHE_COMPLETE");
        return;
      } finally {
        // 退避和再次入队都在归还任务名额之后，避免断网任务占着槽位。
        automaticReservations.delete(video.id);
        releaseTask();
      }
    } catch (caughtError) {
      if (signal.aborted) return;
      const error = caughtError;
      const current = await getVideo(video.id).catch(() => null) || currentExisting || safeVideo;
      if (signal.aborted) return;
      const { auth: _currentAuth, playurlData: _currentPlayurl, ...safeCurrent } = current;
      const committed = committedBytesOf(current);
      if (committed > lastCommitted) { lastCommitted = committed; stalledFailures = 0; }

      if (error?.name !== "AbortError" && isRecoverableDownloadError(error) && stalledFailures < IN_PROCESS_RETRY_DELAYS_MS.length) {
        const delayMs = IN_PROCESS_RETRY_DELAYS_MS[stalledFailures];
        stalledFailures += 1;
        const waiting = {
          ...safeCurrent,
          status: "downloading",
          speed: 0,
          error: t("err.retrying", { seconds: Math.round(delayMs / 1000) }),
          updatedAt: Date.now()
        };
        await putVideo(waiting);
        if (signal.aborted) return;
        broadcastProgress(waiting);
        await abortableDelay(delayMs, signal).catch(() => {});
        currentVideo = { ...safeCurrent, auth: currentVideo.auth, playurlData: currentVideo.playurlData };
        currentExisting = current;
        refreshBeforeAttempt = true;
        continue;
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
        if (!signal.aborted) broadcastProgress(waiting, "CACHE_RETRY");
        return;
      }

      const message = error?.name === "AbortError" ? t("err.pausedResume") : toPublicError(error);
      const failed = {
        ...safeCurrent,
        status: "error",
        stage: "",
        speed: 0,
        error: message,
        updatedAt: Date.now()
      };
      await putVideo(failed);
      if (!signal.aborted) broadcastProgress(failed, "CACHE_ERROR");
      return;
    }
  }
}

async function refreshDownloadSource(video, jobSignal) {
  const signal = AbortSignal.any([jobSignal, AbortSignal.timeout(25_000)]);
  signal.throwIfAborted();
  const message = {
    target: "background",
    type: "REFRESH_DOWNLOAD_SOURCE",
    video: {
      id: video.id,
      bvid: video.bvid,
      cid: video.cid,
      tabId: video.tabId,
      requestedQuality: video.requestedQuality ?? video.quality,
      mediaKind: video.mediaKind
    }
  };
  // Chrome 的消息请求无法随任务撤回。停止本地等待，迟到响应不能进入下载器。
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  const request = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return chrome.runtime.sendMessage(message);
  }).catch(() => { throw new Error(t("err.refreshFailed")); });
  let response;
  try {
    response = await Promise.race([request, cancelled]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (!response?.ok || !response.playurlData) {
    throw new Error(response?.error || t("err.refreshFailed"));
  }
  return response;
}

function abortableDelay(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason || new DOMException(t("err.cancelled"), "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException(t("err.cancelled"), "AbortError"));
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
  const expectedBytes = source.expectedBytes || (canResume ? Number(existing.totalBytes) || 0 : 0);
  const etag = canResume ? existing.etag || "" : "";
  let meta = {
    ...video,
    schemaVersion: 2,
    mediaKind: "progressive",
    merged: null,
    mergeStage: "",
    mergeError: "",
    status: "downloading",
    progress: expectedBytes ? resumeBytes / expectedBytes : 0,
    speed: 0,
    downloadedBytes: resumeBytes,
    committedBytes: resumeBytes,
    resumeBytes,
    totalBytes: expectedBytes,
    etag,
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
    sourcePartition: source.audioOnly ? "" : await committedPartition(source.urls, canResume && existing.sourcePartition),
    sourceChunkBytes: canResume ? existing.sourceChunkBytes || 0 : DEFAULT_RANGE_SIZE,
    error: "",
    updatedAt: Date.now()
  };
  await putVideo(meta);
  broadcastProgress(meta);

  let ranking;
  try {
    ranking = await rankRangeCandidates(source.urls, {
      fetchImpl: networkFetch,
      budget: downloadBudget,
      start: resumeBytes,
      totalBytes: expectedBytes,
      etag,
      signal: job.controller.signal
    });
  } catch (error) {
    if (!String(error?.message || "").includes("HTTP 206")) throw error;
    // 顺序回退使用另外的分块大小。后续落盘的该路线不再按固定 Range 主键读取。
    meta = { ...meta, sourceChunkBytes: 0 };
    const result = await fetchAndStore(source.urls, meta, job);
    const expectedBytes = source.expectedBytes || result.totalBytes;
    if (!hasCompleteByteCount({ downloadedBytes: result.downloadedBytes, totalBytes: expectedBytes })) {
      throw new Error(t("err.cdnIncompleteBytes", { received: result.downloadedBytes, total: expectedBytes || t("unknown") }));
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

  await reserveAutomaticBytes(meta, ranking.totalBytes, job.controller.signal);
  const mirror = createDownloadMirror(meta);
  const coordinator = createDownloadCoordinator({ ...meta, totalBytes: ranking.totalBytes }, {
    media: { resumeBytes, chunkCount: resumeChunks, totalBytes: ranking.totalBytes, etag }
  });
  coordinator.setRanking("media", ranking);
  try {
    const result = await downloadByteRanges({
      fetchImpl: networkFetch,
      budget: downloadBudget,
      urls: ranking.urls,
      start: resumeBytes,
      totalBytes: ranking.totalBytes,
      etag,
      rangeSize: DEFAULT_RANGE_SIZE,
      concurrency: DEFAULT_RANGE_CONCURRENCY,
      signal: job.controller.signal,
      onReceive: (delta) => coordinator.receive("media", delta),
      onCommit: (batch) => coordinator.commit("media", batch),
      onVerifiedRange: meta.sourcePartition && meta.sourceChunkBytes ? undefined : mirror.onVerifiedRange
    });
    coordinator.setTransferMetrics("media", result.metrics);
    await coordinator.stop();
  } catch (error) {
    await coordinator.persistSafeState();
    await coordinator.stop();
    throw error;
  } finally {
    if (isTemporaryCache(meta)) await mirror.drain();
  }

  meta = coordinator.snapshot({ durableOnly: true, speed: 0 });
  if (!hasCompleteByteCount(meta)) {
    throw new Error(t("err.cdnIncompleteBytes", { received: meta.downloadedBytes, total: meta.totalBytes || t("unknown") }));
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
    // DASH 按固定 Range 块提交。旧轨的断点也必须落在同样的块边界。
    sourceChunkBytes: !canResume || existingTrack.sourceChunkBytes === DEFAULT_RANGE_SIZE ||
      (!existingTrack.sourceChunkBytes && existingTrack.resumeBytes === (Number(existingTrack.chunkCount) || 0) * DEFAULT_RANGE_SIZE)
      ? DEFAULT_RANGE_SIZE : 0,
    downloadedBytes: canResume ? Number(existingTrack.downloadedBytes) || 0 : 0,
    resumeBytes: canResume ? Number(existingTrack.resumeBytes ?? existingTrack.downloadedBytes) || 0 : 0,
    etag: canResume ? existingTrack.etag || "" : "",
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
    committedBytes: resumeBytes,
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
    confirmedResume: Number(state.resumeBytes) || 0,
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
      hedgeCount: 0,
      hedgeWins: 0,
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

  const buildSnapshot = ({ durableOnly = false, speed = currentSpeed, committing = null } = {}) => {
    if (baseMeta.mediaKind === "dash") {
      const tracks = {};
      for (const [name, state] of states) {
        tracks[name] = {
          ...baseMeta.tracks[name],
          downloadedBytes: state.resumeBytes + (durableOnly ? 0 : state.volatileBytes),
          resumeBytes: state.resumeBytes,
          committedBytes: committing === name ? state.resumeBytes : state.confirmedResume,
          totalBytes: state.totalBytes,
          chunkCount: state.chunkCount,
          etag: state.etag || "",
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
        committedBytes: values.reduce((sum, track) => sum + track.committedBytes, 0),
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
      committedBytes: committing === stateName ? state.resumeBytes : state.confirmedResume,
      resumeBytes: state.resumeBytes,
      totalBytes: state.totalBytes,
      chunkCount: state.chunkCount,
      ...(baseMeta.tracks ? {} : { etag: state.etag || "" }),
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
          etag: state.etag || "",
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
            throw new Error(t("err.cannotAdvance"));
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
        const previousEtag = state.etag;
        state.resumeBytes = nextResume;
        state.chunkCount = nextIndex;
        // 校验器与这批字节使用同一个事务，崩溃后只会看到同一版本的安全断点。
        state.etag ||= batch.find(entry => entry.etag)?.etag;
        state.volatileBytes = Math.max(0, state.volatileBytes - committedBytes);
        state.metrics.committedBytes = nextResume;
        baseMeta.autoRetryCount = 0;
        baseMeta.nextRetryAt = 0;
        baseMeta.retryDelayMs = 0;
        // 提交中的水位只写进同一原子事务；完成前 UI 广播仍读 confirmedResume。
        const snapshot = buildSnapshot({ committing: name });
        const startedAt = performance.now();
        try {
          await putChunksAndVideo(snapshot, chunks);
          state.confirmedResume = nextResume;
          addDbWriteTime(states, performance.now() - startedAt);
        } catch (error) {
          state.resumeBytes = previousResume;
          state.chunkCount = previousIndex;
          state.etag = previousEtag;
          state.metrics.committedBytes = previousResume;
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
        hedgeCount: metrics.hedgeCount || 0,
        hedgeWins: metrics.hedgeWins || 0,
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
    hedgeCount: metrics.hedgeCount || 0,
    hedgeWins: metrics.hedgeWins || 0,
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
    hedgeCount: metrics.reduce((sum, value) => sum + (Number(value.hedgeCount) || 0), 0),
    hedgeWins: metrics.reduce((sum, value) => sum + (Number(value.hedgeWins) || 0), 0),
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
    sourcePartition: source.mediaKind === "dash"
      ? await committedPartition(sourceEntries.flatMap(([, track]) => track.urls), canResume && existing.sourcePartition) : "",
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
      totalBytes: Number(track.totalBytes) || 0,
      etag: track.etag
    }])
  ));
  const localController = new AbortController();
  const abortFromJob = () => localController.abort(job.controller.signal.reason);
  if (job.controller.signal.aborted) abortFromJob();
  else job.controller.signal.addEventListener("abort", abortFromJob, { once: true });
  let primaryError = null;
  // 每个下载任务共享一份镜像配额与熔断状态；轨道各自的回调都指向同一个 mirror。
  const mirror = createDownloadMirror(meta);

  const rankings = sourceEntries.map(([trackName, sourceTrack]) => {
    const state = coordinator.getState(trackName);
    return rankRangeCandidates(sourceTrack.urls, {
      fetchImpl: networkFetch,
      budget: downloadBudget,
      start: state.resumeBytes,
      totalBytes: state.totalBytes,
      etag: state.etag,
      signal: localController.signal
    });
  });
  // 两条轨道合起来有足够空间才开始正文，避免先挤出旧片又因另一轨超额而中止。
  const admission = isTemporaryCache(video) ? Promise.all(rankings).then(results =>
    reserveAutomaticBytes(meta, results.reduce((sum, rank) => sum + rank.totalBytes, 0), localController.signal)
  ) : null;
  const tasks = sourceEntries.map(async ([trackName], index) => {
    try {
      const [ranking] = await Promise.all([rankings[index], admission]);
      const state = coordinator.getState(trackName);
      coordinator.setRanking(trackName, ranking);
      const trackConcurrency = sourceEntries.length > 1
        ? trackName === "video" ? DEFAULT_RANGE_CONCURRENCY : 2
        : DEFAULT_RANGE_CONCURRENCY;
      const result = await downloadByteRanges({
      fetchImpl: networkFetch,
        budget: downloadBudget,
        urls: ranking.urls,
        start: state.resumeBytes,
        totalBytes: ranking.totalBytes,
        etag: state.etag,
        rangeSize: DEFAULT_RANGE_SIZE,
        concurrency: trackConcurrency,
        signal: localController.signal,
        onReceive: (delta) => coordinator.receive(trackName, delta),
        onCommit: (batch) => coordinator.commit(trackName, batch),
        onVerifiedRange: meta.sourcePartition && meta.tracks[trackName].sourceChunkBytes ? undefined : mirror.onVerifiedRange
      });
      coordinator.setTransferMetrics(trackName, result.metrics);
    } catch (error) {
      if (error?.name !== "AbortError" && !primaryError) primaryError = error;
      if (!localController.signal.aborted) localController.abort(error);
      throw error;
    }
  });

  const results = await Promise.allSettled(tasks);
  await Promise.allSettled(rankings);
  if (isTemporaryCache(meta)) await mirror.drain();
  job.controller.signal.removeEventListener("abort", abortFromJob);
  const failure = primaryError || results.find((result) => result.status === "rejected")?.reason;
  if (failure) await coordinator.persistSafeState();
  await coordinator.stop();
  if (failure) throw failure;

  meta = coordinator.snapshot({ durableOnly: true, speed: 0 });
  for (const [trackName, track] of Object.entries(meta.tracks)) {
    if (!hasCompleteByteCount(track)) {
      throw new Error(t("err.trackIncomplete", { track: t(trackName === "video" ? "track.video" : "track.audio") }));
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

async function fetchAndStore(urls, meta, job) {
  let lastError;
  const { signal } = job.controller;
  for (const url of urls) {
    try {
      const release = await downloadBudget.reserveBytes(CHUNK_SIZE, signal);
      try {
        // 不支持 Range 的节点只能续读同一响应。保留一个连接名额，播放告急时停止拉取。
        return await downloadBudget.runRequest(() => fetchCandidate(url, meta, job), signal, { preemptible: false });
      } finally {
        release();
      }
    } catch (error) {
      if (error?.name === "AbortError" || error instanceof AutomaticCacheError) throw error;
      lastError = error;
      meta = await getVideo(meta.id) || meta;
    }
  }
  throw lastError || new Error(t("err.allCdnFailed"));
}

async function fetchCandidate(url, meta, job) {
  const { signal } = job.controller;
  let storedBytes = Number(meta.resumeBytes ?? meta.downloadedBytes) || 0;
  let downloadedBytes = storedBytes;
  let chunkIndex = Number(meta.chunkCount) || 0;
  let totalBytes = Number(meta.totalBytes) || 0;
  const buffer = new Uint8Array(CHUNK_SIZE);
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
      committedBytes: storedBytes,
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
    const blob = new Blob([buffer.subarray(0, pendingBytes)], { type: "application/octet-stream" });
    await putChunk(meta.id, "media", chunkIndex, blob);
    storedBytes += blob.size;
    chunkIndex += 1;
    pendingBytes = 0;
  };

  let response;
  try {
    do {
      await downloadBudget.waitForPlayback(signal);
      const requestedOffset = downloadedBytes;
      const headers = requestedOffset > 0 ? { Range: `bytes=${requestedOffset}-` } : undefined;
      response = await networkFetch(url, {
        credentials: "omit",
        headers,
        priority: "low",
        signal
      });

      if (!response.ok) {
        if (response.status === 403) {
          throw new Error(t("err.referer403"));
        }
        throw new Error(t("err.cdnHttp", { status: response.status }));
      }
      if (!response.body) throw new Error(t("err.noStream"));

      if (requestedOffset > 0 && response.status !== 206) {
        await clearChunks(meta.id);
        storedBytes = 0;
        downloadedBytes = 0;
        chunkIndex = 0;
        pendingBytes = 0;
        measuredBytes = 0;
        meta = {
          ...meta,
          downloadedBytes: 0,
          committedBytes: 0,
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
          throw new Error(t("err.unsafeRange"));
        }
        if (contentRange.total > 0) {
          if (totalBytes > 0 && totalBytes !== contentRange.total) {
            throw new Error(t("err.videoSizeMismatch"));
          }
          totalBytes = contentRange.total;
        }
      }

      const contentLength = Number(response.headers.get("content-length")) || 0;
      if (response.status === 200 && contentLength > 0) {
        if (totalBytes > 0 && totalBytes !== contentLength) {
          throw new Error(t("err.videoSizeMismatch"));
        }
        totalBytes = contentLength;
      }
      if (isTemporaryCache(meta) && automaticReservations.get(meta.id) !== totalBytes) {
        await reserveAutomaticBytes(meta, totalBytes, signal);
      }

      const reader = response.body.getReader();
      const cancelRead = () => reader.cancel().catch(() => {});
      signal.addEventListener("abort", cancelRead, { once: true });
      try {
        while (true) {
          await downloadBudget.waitForPlayback(signal);
          const { done, value } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          if (isTemporaryCache(meta) && downloadedBytes + value.byteLength > totalBytes) throw new Error(t("err.videoSizeMismatch"));
          // Chrome 返回的读取片段大小不固定。复制进已预约的固定窗口后再开始下一次读取。
          for (let offset = 0; offset < value.byteLength;) {
            const count = Math.min(CHUNK_SIZE - pendingBytes, value.byteLength - offset);
            buffer.set(value.subarray(offset, offset + count), pendingBytes);
            offset += count;
            pendingBytes += count;
            downloadedBytes += count;
            if (pendingBytes === CHUNK_SIZE) await flush();
          }
          await persistProgress();
        }
      } finally {
        signal.removeEventListener("abort", cancelRead);
        reader.releaseLock();
      }

      const responseBytes = downloadedBytes - responseStart;
      if (contentLength > 0 && responseBytes !== contentLength) {
        throw new Error(t("err.connectionEnded"));
      }
      if (contentRange && downloadedBytes !== contentRange.end + 1) {
        throw new Error(t("err.rangeIncomplete"));
      }
      if (responseBytes === 0 && (!totalBytes || downloadedBytes < totalBytes)) {
        throw new Error(t("err.noMoreData"));
      }
    } while (totalBytes > 0 && downloadedBytes < totalBytes);

    if (totalBytes > 0 && downloadedBytes !== totalBytes) {
      throw new Error(t("err.dataIncomplete"));
    }
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    if (!job.deleted) {
      meta = {
        ...meta,
        downloadedBytes: storedBytes,
        committedBytes: storedBytes,
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

function completeDownload(meta) {
  const now = Date.now();
  return {
    ...meta,
    status: "complete",
    stage: "",
    progress: 1,
    speed: 0,
    committedBytes: meta.totalBytes,
    error: "",
    autoRetryCount: 0,
    nextRetryAt: 0,
    retryDelayMs: 0,
    completedAt: meta.completedAt || now,
    updatedAt: now
  };
}

async function recoverPublishedAsset(video, asset) {
  const chunks = await getChunks(video.id, asset.name);
  try {
    assertCompleteTrackChunks(trackLabel(asset.name), {
      downloadedBytes: asset.track.totalBytes,
      ...asset.track
    }, chunks);
  } catch {
    // 旧版只有元数据而没有完整产物时，仍可由正常下载路径恢复。
    return null;
  }
  return publishVideoAsset(completeDownload(video), asset.sourceTracks);
}

function isMergedComplete(video) {
  return Number(video?.merged?.totalBytes) > 0 && hasCompleteByteCount(video);
}

/** 播放与保存已按 ID 排队。旧双轨只需在首次请求时合并。 */
function ensureMergedTracks(video) {
  if (isMergedComplete(video)) return Promise.resolve(video);
  return mergeTrackChunks(video, null, "complete");
}

/** 下载完成后的合并步骤；失败不丢数据，保留两条独立轨道供分别保存。 */
async function mergeDownloadedTracks(meta, job) {
  try {
    return await mergeTrackChunks(meta, job);
  } catch (error) {
    job?.controller.signal.throwIfAborted();
    const message = toPublicError(error);
    console.warn("[海内存知] 双轨合并失败，保留独立轨道：", error);
    const fallback = completeDownload({
      ...meta,
      remux: (await getVideo(meta.id))?.remux || null,
      stage: "",
      mergeStage: "failed",
      mergeError: message
    });
    return putVideo(fallback);
  }
}

function discardRemux(video) {
  // 分块与占用记录同事务删除；失败时保留占用记录，以便下次仍按实际可能占用的上界计费。
  return publishVideoAsset({ ...video, remux: null }, [video.remux.track]);
}

/** 在输出的第一块落盘前预留源与成品共存的峰值，持有到发布或清理完成。 */
async function withRemuxSpace(meta, track, { sourceBytes, outputBytes }, job, write) {
  const signal = job?.controller.signal;
  const previous = automaticReservations.get(meta.id);
  const current = await getVideo(meta.id);
  if (current?.remux) await discardRemux(current);
  else await clearChunks(meta.id, track);
  try {
    await reserveAutomaticBytes(meta, sourceBytes + outputBytes, signal);
    signal?.throwIfAborted();
    return await write({ ...meta, remux: { track, sourceBytes, bytes: outputBytes } });
  } catch (error) {
    const partial = await getVideo(meta.id);
    if (partial?.remux) await discardRemux(partial);
    throw error;
  } finally {
    if (previous) automaticReservations.set(meta.id, previous);
    else automaticReservations.delete(meta.id);
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
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.TRUNCATED, t("err.mergeChunksIncomplete", { track: label }));
  }
}

function createChunkWriter(videoId, track, limit) {
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
      if (bytes.length > limit - total) throw new Error(t("err.mergeWriteMismatch"));
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
    throw new Error(t("err.mp4ChunksIncomplete"));
  }

  const extraction = await createAudioOnlyMp4({ chunks: mediaChunks });
  return withRemuxSpace(meta, "audio", extraction, job, prepared => writeExtractedAudio(prepared, extraction, job));
}

async function writeExtractedAudio(meta, extraction, job) {
  const signal = job?.controller.signal;
  const extracting = { ...meta, status: "downloading", stage: "extracting", merged: null, mergeError: "", speed: 0 };
  const writer = createChunkWriter(meta.id, "audio", extraction.outputBytes);
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

  signal?.throwIfAborted();
  await writer.write(extraction.header);
  written += extraction.header.length;
  for await (const piece of extraction.stream()) {
    signal?.throwIfAborted();
    await writer.write(piece);
    written += piece.length;
    await report(false);
  }
  const stats = await writer.close();

  // 自检：写回的字节数、块数与开头结构都必须与提取结果一致。
  const storedChunks = await getChunks(meta.id, "audio");
  const audioBytes = storedChunks.reduce((sum, chunk) => sum + (Number(chunk.data?.size) || 0), 0);
  if (audioBytes !== stats.totalBytes || storedChunks.length !== stats.chunkCount || stats.totalBytes !== written) {
    throw new Error(t("err.audioWriteMismatch"));
  }
  const headBytes = new Uint8Array(await storedChunks[0].data.slice(0, extraction.header.length).arrayBuffer());
  if (headBytes.length !== extraction.header.length) {
    throw new Error(t("err.audioInitIncomplete"));
  }
  // 只校验写回的开头（ftyp + 单轨 moov）；完整字节数已在上面的分块统计里核对。
  verifyAudioOnlyMp4(headBytes, { requireMdat: false });

  const duration = Number(extraction.audioTrack.duration) || Number(meta.duration) || 0;
  const bandwidth = Number(extraction.audioTrack.bandwidth)
    || (duration > 0 ? Math.round(stats.totalBytes * 8 / duration) : 0);
  const audioLabel = describeAudioTrack({ ...extraction.audioTrack, bandwidth });
  const record = completeDownload({
    ...meta,
    schemaVersion: 3,
    remux: null,
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
    chunkCount: stats.chunkCount
  });
  signal?.throwIfAborted();
  return publishVideoAsset(record, ["media"]);
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
    throw new Mp4MergeError(MP4_MERGE_PROBLEM.UNSUPPORTED_LAYOUT, t("err.mergeNoAudio"));
  }

  const videoChunks = await getChunks(meta.id, "video");
  const audioChunks = await getChunks(meta.id, "audio");
  assertCompleteTrackChunks(t("track.video"), videoTrack, videoChunks);
  assertCompleteTrackChunks(t("track.audio"), audioTrack, audioChunks);

  const merged = await createMergedFragmentedMp4({
    video: { chunks: videoChunks },
    audio: { chunks: audioChunks }
  });
  const expectedBytes = Number(videoTrack.totalBytes) + Number(audioTrack.totalBytes);
  return withRemuxSpace(meta, MERGED_TRACK, merged, job, prepared =>
    writeMergedTracks(prepared, merged, expectedBytes, job, mergingStatus));
}

async function writeMergedTracks(meta, merged, expectedBytes, job, mergingStatus) {
  const signal = job?.controller.signal;
  const { video: videoTrack, audio: audioTrack } = meta.tracks;
  const merging = { ...meta, status: mergingStatus, stage: "merging", mergeStage: "merging", mergeError: "", speed: 0 };
  const writer = createChunkWriter(meta.id, MERGED_TRACK, merged.outputBytes);
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

  signal?.throwIfAborted();
  await writer.write(merged.header);
  written += merged.header.length;
  for await (const fragment of merged.stream()) {
    signal?.throwIfAborted();
    await writer.write(fragment);
    written += fragment.length;
    await report(false);
  }
  const stats = await writer.close();

  // 自检：写回的字节数、块数与开头结构都必须与合并结果一致。
  const storedChunks = await getChunks(meta.id, MERGED_TRACK);
  const storedBytes = storedChunks.reduce((sum, chunk) => sum + (Number(chunk.data?.size) || 0), 0);
  if (storedBytes !== stats.totalBytes || storedChunks.length !== stats.chunkCount || stats.totalBytes !== written) {
    throw new Error(t("err.mergeWriteMismatch"));
  }
  const headBytes = new Uint8Array(await storedChunks[0].data.slice(0, merged.header.length).arrayBuffer());
  if (headBytes.length !== merged.header.length) {
    throw new Error(t("err.mergeInitIncomplete"));
  }
  verifyMergedHeader(headBytes, {
    videoTrackId: merged.videoTrackId,
    audioTrackId: merged.audioTrackId
  });

  const audioLabel = describeAudioTrack(audioTrack);
  const completed = completeDownload({
    ...meta,
    schemaVersion: 3,
    remux: null,
    mergeStage: "done",
    mergeError: "",
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
    tracks: {
      video: releasedTrack(videoTrack),
      audio: releasedTrack(audioTrack)
    },
    audioLabel,
    downloadedBytes: stats.totalBytes,
    resumeBytes: stats.totalBytes,
    totalBytes: stats.totalBytes,
    chunkCount: stats.chunkCount
  });
  signal?.throwIfAborted();
  return publishVideoAsset(completed, ["video", "audio"]);
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

function revokePlayback(videoId) {
  for (const [id, use] of playbackUses) {
    if (use.videoId !== videoId) continue;
    clearTimeout(use.timer);
    playbackUses.delete(id);
  }
  const playback = playbackUrls.get(videoId);
  if (!playback) return;
  if (typeof playback === "string") URL.revokeObjectURL(playback);
  else for (const track of playback.tracks || []) URL.revokeObjectURL(track.url);
  playbackUrls.delete(videoId);
}

async function deleteVideo(videoId, createdAt) {
  if (Number.isFinite(createdAt) && !matchesTaskCreation(await getVideo(videoId), createdAt)) return { deleted: false };
  await stopDownload(videoId, true);
  const deletedVideo = await getVideo(videoId);
  if (isTemporaryCache(deletedVideo)) await sourceRepository?.deleteForVideo(videoId);
  await deleteVideoData(videoId);
  revokePlayback(videoId);
  // 删除通知晚于重新缓存抵达时，弹窗仍可按控制端的世代判断这次删除的范围。
  const deletedAt = nextTaskStamp(deletedVideo);
  chrome.runtime.sendMessage({ target: "background", type: "CACHE_DELETED", videoId, deletedAt, tabId: deletedVideo?.tabId }).catch(() => {});
  return { deleted: true, deletedAt };
}

function broadcastProgress(video, type = "CACHE_PROGRESS") {
  chrome.runtime.sendMessage({ target: "background", type, video }).catch(() => {});
}
