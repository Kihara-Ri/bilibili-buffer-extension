import { createRuntimeUpdater } from "./update-runtime.js";
import { newerTask, taskBadge } from "./task-presentation.js";
import { t } from "./i18n.js";
import { buildCacheSizeInfo } from "./cache-size.js";
import { lookupCachedPage } from "./cache-catalog.js";
import {
  AUTO_QUALITY,
  CACHE_MODES,
  buildCachedDownloadPlan,
  buildMediaCodecOptions,
  buildMediaQualityOptions,
  getCacheMode,
  getVideoPageId,
  isVideoCodecSelectionMatch,
  makeAudioCacheVideoId,
  makeBiliSpaceUrl,
  makeVideoId,
  makeQualityVideoId,
  normalizeCacheMode,
  normalizeCodecPreference,
  normalizeQualityId,
  parseBiliVideoUrl,
  toPublicError
} from "./utils.js";
import { listVideos, listVideosForBvid } from "./db.js";
import { committedSources, validCommittedRead } from "./committed-source.js";
import { createPendingDeleteRegistry } from "./pending-deletes.js";
import { startDevReloadBackground } from "./dev-reload.js";
import {
  choosePopupCodec,
  choosePopupQuality,
  isPopupSnapshotFresh,
  isPopupSnapshotMatch,
  makePopupPageKey,
  POPUP_SNAPSHOT_MAX_AGE
} from "./popup-snapshot.js";
import {
  DOWNLOAD_WATCHDOG_ALARM,
  DOWNLOAD_WATCHDOG_MINUTES,
  makeDownloadWatchdogSchedule,
  needsDownloadRecovery
} from "./download-retry.js";
import { ASSIST_DEFAULTS, sanitizeAssistConfig } from "./assist-config.js";
import { createSourceRepository, createSourceService, sourceRangeScope } from "./source-range-store.js";
import { collectHealthChecks } from "./health-check.js";
import { createMcpNativeBridge } from "./mcp-native-bridge.js";
import { isTemporaryCache, TEMPORARY_CACHE_ALARM } from "./temporary-cache.js";

// 离线已下载的源范围镜像：只接收逐字节校验过的 CDN 范围，供播放侧按「路径 + 总长」复用。
const sourceRanges = createSourceService({
  repository: typeof indexedDB === "undefined" ? null : createSourceRepository(),
  account: biliAccountFingerprint
});

/** 用 SESSDATA 的不可逆摘要做账户分区；原始 cookie 值不落盘、不进消息、不进日志。
 * @param {boolean} [verified] 部分缓存要求明确的账户归属
 * @returns {Promise<string>}
 */
async function biliAccountFingerprint(verified = false) {
  try {
    const cookie = await chrome.cookies.get({ url: "https://www.bilibili.com/", name: "SESSDATA" });
    if (!cookie?.value) return "anonymous";
    if (!globalThis.crypto?.subtle) return verified ? "" : "anonymous";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookie.value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  } catch { return verified ? "" : "anonymous"; }
}
const OFFSCREEN_PATH = "offscreen.html";
const BILI_PLAYBACK_TABS = [
  "https://www.bilibili.com/video/*", "https://www.bilibili.com/list/*",
  "https://www.bilibili.com/*/video/*", "https://www.bilibili.com/*/list/*"
];
const POPUP_SNAPSHOTS_KEY = "popupPageSnapshotsV1";
const ASSIST_CONFIG_KEY = "playbackAssistConfigV1";
const CACHE_MODE_KEY = "cacheModeV1";
const HEALTH_REPORT_KEY = "browserHealthV1";
const HEALTH_MAX_AGE_MS = 6 * 60 * 60 * 1000;
let creatingOffscreen;
let restoringDownloads;
let watchdogQueue = Promise.resolve();
let temporaryCacheQueue = Promise.resolve();
let temporaryPageTabs = new Set();
let popupSnapshotQueue = Promise.resolve();
let badgeQueue = Promise.resolve();
const popupSnapshotMemory = new Map();
let healthReportQueue = null;

// 文件替换期间锁住新缓存、合并及保存；暂停清单先落盘，SW 休眠也不会丢失恢复意图。
const updater = createRuntimeUpdater({
  runtime: chrome.runtime, storage: chrome.storage.local, session: chrome.storage.session,
  async freeze(persist) {
    const ids = (await listVideos()).filter(video => video.status === 'downloading').map(video => video.id);
    await persist(ids);
    const result = unwrap(await sendToOffscreen({type:'LOCK_FOR_UPDATE'}));
    return [...new Set([...ids, ...(result.pausedIds || [])])];
  },
  async thaw(ids) {
    await sendToOffscreen({type:'UNLOCK_FOR_UPDATE'});
    return Promise.all(ids.map(async id => {
      try { await resumeCache(id, { afterUpdate: true }); return {id,resumed:true}; }
      catch (error) { return {id,resumed:false,error:toPublicError(error)}; }
    }));
  },
  ping: async () => unwrap(await sendToOffscreen({type:'GET_UPDATE_HEALTH'})),
  async refresh() {
    const tabs = await chrome.tabs.query({ url: BILI_PLAYBACK_TABS });
    await Promise.allSettled(tabs.map(tab=>chrome.tabs.reload(tab.id)));
  },
  ownerAlive: async id => { try { await chrome.tabs.get(id); return true; } catch { return false; } },
  openPage: () => chrome.tabs.create({url:chrome.runtime.getURL('update.html#resume')}),
  hasSaving: async () => (await chrome.downloads.search({state:'in_progress',urlRegex:`^blob:chrome-extension://${chrome.runtime.id}/`})).length > 0
});

/**
 * 浏览器侧能力自检结论。Chrome 更新（onInstalled 的 chrome_update）会强制刷新，
 * 其余情况 6 小时内复用，避免每次打开弹窗都重跑一遍探测。
 * @param {{refresh?:boolean}} [options] @returns {Promise<object>}
 */
function readHealthReport({ refresh = false } = {}) {
  const load = async () => {
    const saved = await chrome.storage.local.get(HEALTH_REPORT_KEY).then((values) => values?.[HEALTH_REPORT_KEY]).catch(() => null);
    const fresh = saved && Date.now() - Number(saved.checkedAt || 0) < HEALTH_MAX_AGE_MS;
    if (!refresh && fresh) return saved;
    const report = await collectHealthChecks();
    await chrome.storage.local.set({ [HEALTH_REPORT_KEY]: report }).catch(() => {});
    return report;
  };
  // 并发合并：弹窗轮询与 onInstalled 可能同时触发，只跑一次探测。
  healthReportQueue = healthReportQueue ? healthReportQueue.then(load, load) : load();
  const pending = healthReportQueue;
  healthReportQueue = pending.catch(() => {});
  return pending;
}

if (chrome.runtime.id) startDevReloadBackground(ensureOffscreenDocument);
void updater.startup().catch(() => {});
void restoreActiveDownloads();
void restoreTaskBadges();
chrome.runtime.onInstalled.addListener((details) => {
  // Chrome 自更新（chrome_update）与扩展更新是浏览器侧能力最容易变的时刻，
  // 立刻记一份结论，用户下次打开弹窗就能看到哪里失效，而不是只看到「没反应」。
  void readHealthReport({ refresh: true }).catch(() => {});
  if (details?.reason === "update" || details?.reason === "chrome_update") void invalidatePopupSnapshots();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === DOWNLOAD_WATCHDOG_ALARM) void restoreActiveDownloads();
  if (alarm?.name === TEMPORARY_CACHE_ALARM) void syncTemporaryCaches();
});
chrome.runtime.onStartup?.addListener(() => { void restoreActiveDownloads(); });
chrome.cookies.onChanged.addListener((changeInfo) => {
  const cookie = changeInfo?.cookie;
  if (cookie?.name === "SESSDATA" && String(cookie.domain || "").endsWith("bilibili.com")) {
    void invalidatePopupSnapshots();
  }
});
// 监听器在 SW 启动时同步注册。Offscreen 保存使用者，唤醒后的首个关闭或下载事件即可释放。
function onCacheTabRemoved(tabId) {
  void updateCachePlaybackUse("closeTab", { tabId }).then(syncTemporaryCaches);
}
chrome.tabs?.onRemoved?.addListener(onCacheTabRemoved);
chrome.tabs?.onReplaced?.addListener((_, removedTabId) => onCacheTabRemoved(removedTabId));
chrome.tabs?.onUpdated?.addListener((tabId, change, tab) => {
  // 同文档切分 P 一般只更新 URL。导航到无权限的站点可能读不到新 URL，由 complete 补一次。
  if ((change.url || change.status === "complete") &&
      (temporaryPageTabs.has(tabId) || parseBiliVideoUrl(change.url || tab.url).supported)) void syncTemporaryCaches();
});
chrome.downloads?.onChanged?.addListener(({ id, state }) => {
  if (["complete", "interrupted"].includes(state?.current)) void updateCachePlaybackUse("endDownload", { downloadId: id });
});

// 弹窗关闭时提交它撤销期内的删除。监听必须在 SW 顶层同步注册，休眠唤醒后的首个 connect 才不会漏掉。
const pendingDeletes = createPendingDeleteRegistry({
  commit: (videoId, createdAt) => deleteCachedVideo(videoId, createdAt),
  onError: (error, videoId) => console.warn("[海内存知] 弹窗关闭后提交删除失败：", videoId, toPublicError(error))
});
chrome.runtime.onConnect.addListener((port) => { pendingDeletes.attach(port); });

const mcpBridge = createMcpNativeBridge(chrome, handleMessage, (id, operation) => updater.withSave(() => withCacheExport(id, operation)));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target && message.target !== "background") return false;

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: toPublicError(error) }));
  return true;
});

async function handleMessage(message, sender) {
  if (String(message?.type || "").startsWith("UPDATER_")) return updater.handle(message,sender);
  if (["START_CACHE","RESUME_CACHE","DELETE_VIDEO","PAUSE_CACHE","GET_PLAYBACK_URL"].includes(message?.type)) await updater.assertUnlocked();
  switch (message?.type) {
    case "MCP_BRIDGE_STATUS":
    case "MCP_BRIDGE_SET": {
      if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("mcp.html")) throw new Error("MCP setup requires the extension page");
      const bridge = message.type === "MCP_BRIDGE_SET" ? await mcpBridge.set(message.enabled) : mcpBridge.status();
      return { bridge };
    }
    case "SOURCE_RANGE": {
      const request = message.request;
      if (!request || typeof request !== "object") return {};
      // 写入与取分区只允许扩展自己的下载文档，读取只允许 B 站视频页；其余来源直接拒绝。
      const scope = sourceRangeScope(sender, {
        runtimeId: chrome.runtime.id,
        offscreenUrl: chrome.runtime.getURL(OFFSCREEN_PATH)
      });
      if (!scope || (request.op === "write" || request.op === "partition") !== (scope === "writer")) return {};
      return sourceRanges.handle(request, scope);
    }
    case "GET_COMMITTED_PARTITION":
      return sourceRangeScope(sender, { runtimeId: chrome.runtime.id, offscreenUrl: chrome.runtime.getURL(OFFSCREEN_PATH) }) === "writer"
        ? { partition: await biliAccountFingerprint(true) } : {};
    case "GET_COMMITTED_SOURCES":
      return getCommittedSources(message, sender);
    case "READ_COMMITTED_SOURCE":
      return readCommittedSource(message, sender);
    case "GET_POPUP_SNAPSHOT": {
      const snapshot = await readPopupSnapshot(message.tabId, message.url);
      return { snapshot, stale: snapshot ? !isPopupSnapshotFresh(snapshot) : true };
    }
    case "REFRESH_POPUP_DATA":
      return { snapshot: await refreshPopupSnapshot(message.url, message.tabId) };
    case "SET_POPUP_SELECTION":
      return { saved: await savePopupSelection(message.tabId, message.url, message.quality, message.codec) };
    case "GET_ASSIST_STATE":
      return getAssistState(message.tabId);
    case "GET_HEALTH":
      return { report: await readHealthReport({ refresh: message.refresh === true }) };
    case "GET_CACHE_MODE":
      return { mode: await getCacheModePreference() };
    case "SET_CACHE_MODE":
      return { mode: await setCacheModePreference(message.mode) };
    case "SET_ASSIST_CONFIG":
      return { config: await setAssistConfig(message.patch) };
    case "GET_PAGE_INFO":
      return { pageInfo: await getPageInfo(message.url, { includeParts: message.includeParts === true }) };
    case "GET_QUALITY_OPTIONS": {
      const pageInfo = await getPageInfo(message.url);
      if (!pageInfo.supported) throw new Error(pageInfo.message);
      const auth = await getBiliSessionState();
      const playurl = await requestPlayurl(pageInfo, AUTO_QUALITY, message.tabId, auth);
      const qualities = buildMediaQualityOptions(playurl.data);
      if (!qualities.length) throw new Error(t("err.noQualities"));
      const codecOptionsByQuality = buildCodecOptionsByQuality(playurl.data, qualities);
      return {
        pageInfo,
        qualities,
        codecOptionsByQuality,
        defaultQuality: qualities[0].quality,
        defaultCodec: choosePopupCodec(codecOptionsByQuality[String(qualities[0].quality)], "auto"),
        auth: playurl.auth
      };
    }
    case "START_CACHE": {
      const pageInfo = await getPageInfo(message.url);
      // MCP 清单可能在排队时发生重排。对照规划时的 CID，避免下载错 P。
      if (message.expectedPageId && pageInfo.id !== message.expectedPageId) return { pageChanged: true };
      return startCacheForPage(pageInfo, message);
    }
    case "START_AUTO_CACHE":
      return startAutomaticCache(message, sender);
    case "LIST_VIDEOS":
      return { videos: await listVideos() };
    case "GET_VIDEO":
      return unwrap(await sendToOffscreen({ type: "GET_VIDEO", videoId: message.videoId }));
    case "GET_PLAYBACK_URL":
      return getCachedPlaybackForPage(message.videoId,
        sourceRangeScope(sender, { runtimeId: chrome.runtime.id }) === "reader" ? sender.tab?.id : undefined);
    case "RELEASE_CACHE_PLAYBACK":
      if (Number.isInteger(sender.tab?.id)) await updateCachePlaybackUse("release", { leaseId: message.leaseId, tabId: sender.tab.id });
      return {};
    case "TEMPORARY_CACHE_USE_ENDED":
      if (!sender.tab && sender.url === chrome.runtime.getURL(OFFSCREEN_PATH)) void syncTemporaryCaches();
      return {};
    case "OPEN_CACHED_VIDEO":
      return openCachedVideo(message.videoId);
    case "SAVE_VIDEO":
      return updater.withSave(() => saveCachedVideo(message.videoId,
        message.saveAs !== false || sender.url !== chrome.runtime.getURL("privacy.html")));
    case "GET_CACHED_FOR_URL":
      return lookupCachedPage(message.url, getPageInfo, normalizeQualityId(message.quality));
    case "DELETE_VIDEO":
      return deleteCachedVideo(message.videoId, message.createdAt);
    case "PAUSE_CACHE": {
      const result = unwrap(await sendToOffscreen({ type: "PAUSE_DOWNLOAD", videoId: message.videoId, createdAt: message.createdAt }));
      void syncDownloadWatchdog();
      return result;
    }
    case "RESUME_CACHE":
      return resumeCache(message.videoId, { createdAt: message.createdAt, tabId: message.tabId });
    case "CACHE_PROGRESS":
      await handleCacheEvent(message);
      return { received: true };
    case "CACHE_RETRY":
    case "CACHE_COMPLETE":
    case "CACHE_ERROR":
    case "CACHE_PAUSED":
    case "CACHE_DELETED":
      await handleCacheEvent(message);
      void syncDownloadWatchdog();
      return { received: true };
    case "REFRESH_DOWNLOAD_SOURCE":
      return refreshDownloadSource(message.video);
    case "PLAYBACK_ACTIVE":
      if (sender.tab?.id) {
        const active = (await listVideos()).some(video => video.tabId === sender.tab.id && video.status === "downloading");
        if (active) { await updateTaskBadge(sender.tab.id); return { received: true }; }
        await chrome.action.setBadgeBackgroundColor({ color: "#1682a7", tabId: sender.tab.id });
        await chrome.action.setBadgeText({ text: t("badge.local"), tabId: sender.tab.id });
      }
      return { received: true };
    default:
      throw new Error(t("err.unknownCommand"));
  }
}

async function refreshPopupSnapshot(inputUrl, tabId) {
  if (!Number.isInteger(tabId)) throw new Error(t("err.noTab"));
  const previous = await readPopupSnapshot(tabId, inputUrl);
  const pageInfo = await getPageInfo(inputUrl);
  const savedAt = Date.now();
  if (!pageInfo.supported) {
    const snapshot = {
      schemaVersion: 2,
      tabId,
      pageKey: makePopupPageKey(inputUrl),
      pageInfo,
      qualities: [],
      codecOptionsByQuality: {},
      defaultQuality: 0,
      selectedQuality: 0,
      defaultCodec: "",
      selectedCodec: "",
      auth: null,
      savedAt,
      selectionUpdatedAt: savedAt
    };
    await storePopupSnapshot(snapshot);
    return snapshot;
  }

  const auth = await getBiliSessionState();
  const playurl = await requestPlayurl(pageInfo, AUTO_QUALITY, tabId, auth);
  const qualities = buildMediaQualityOptions(playurl.data);
  if (!qualities.length) throw new Error(t("err.noQualities"));
  const codecOptionsByQuality = buildCodecOptionsByQuality(playurl.data, qualities);
  const latest = await readPopupSnapshot(tabId, inputUrl);
  const selectionSnapshot = (Number(latest?.selectionUpdatedAt) || 0) >= (Number(previous?.selectionUpdatedAt) || 0)
    ? latest
    : previous;
  const defaultQuality = qualities[0].quality;
  const selectedQuality = choosePopupQuality(
    qualities,
    selectionSnapshot?.selectedQuality,
    defaultQuality
  );
  const codecOptions = codecOptionsByQuality[String(selectedQuality)] || [];
  const selectedCodec = choosePopupCodec(
    codecOptions,
    selectionSnapshot?.selectedQuality === selectedQuality ? selectionSnapshot?.selectedCodec : "",
    "auto"
  );
  const snapshot = {
    schemaVersion: 2,
    tabId,
    pageKey: makePopupPageKey(inputUrl),
    pageInfo,
    qualities,
    cacheSizeInfo: buildCacheSizeInfo(playurl.data, pageInfo.duration),
    codecOptionsByQuality,
    defaultQuality,
    selectedQuality,
    defaultCodec: choosePopupCodec(codecOptionsByQuality[String(defaultQuality)] || [], "auto"),
    selectedCodec,
    auth: playurl.auth,
    savedAt,
    selectionUpdatedAt: Number(selectionSnapshot?.selectionUpdatedAt) || savedAt
  };
  await storePopupSnapshot(snapshot);
  return snapshot;
}

async function savePopupSelection(tabId, inputUrl, requestedQuality, requestedCodec) {
  const snapshot = await readPopupSnapshot(tabId, inputUrl);
  if (!snapshot) return false;
  const selectedQuality = choosePopupQuality(snapshot.qualities, requestedQuality);
  if (!selectedQuality || selectedQuality !== normalizeQualityId(requestedQuality)) return false;
  const codecOptions = snapshot.codecOptionsByQuality?.[String(selectedQuality)] || [];
  const selectedCodec = choosePopupCodec(codecOptions, requestedCodec, "auto");
  await storePopupSnapshot({
    ...snapshot,
    selectedQuality,
    selectedCodec,
    selectionUpdatedAt: Date.now()
  });
  return true;
}

function buildCodecOptionsByQuality(playurlData, qualities) {
  return Object.fromEntries((Array.isArray(qualities) ? qualities : []).map((option) => [
    String(option.quality),
    buildMediaCodecOptions(playurlData, option.quality)
  ]));
}

async function getCacheModePreference() {
  try {
    const stored = await chrome.storage.local.get(CACHE_MODE_KEY);
    return normalizeCacheMode(stored?.[CACHE_MODE_KEY]);
  } catch {
    return CACHE_MODES.VIDEO;
  }
}

async function setCacheModePreference(value) {
  const mode = normalizeCacheMode(value);
  await chrome.storage.local.set({ [CACHE_MODE_KEY]: mode });
  return mode;
}

async function getAssistConfig() {
  try {
    const stored = await chrome.storage.local.get(ASSIST_CONFIG_KEY);
    return sanitizeAssistConfig(stored?.[ASSIST_CONFIG_KEY], ASSIST_DEFAULTS);
  } catch {
    return { ...ASSIST_DEFAULTS };
  }
}

function sameVideoPage(leftUrl, rightUrl) {
  const left = parseBiliVideoUrl(leftUrl), right = parseBiliVideoUrl(rightUrl);
  return left.supported && right.supported && left.bvid === right.bvid && left.aid === right.aid && left.page === right.page;
}

function committedPage(sender, url) {
  if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !sameVideoPage(sender.url, url) ||
      sourceRangeScope(sender, { runtimeId: chrome.runtime.id }) !== "reader") return null;
  return parseBiliVideoUrl(sender.url);
}

async function getCommittedSources(message, sender) {
  const page = committedPage(sender, message.pageUrl);
  if (!page) return { sources: [] };
  const [partition, rows] = await Promise.all([
    biliAccountFingerprint(true), page.bvid ? listVideosForBvid(page.bvid) : listVideos()
  ]);
  return { sources: rows.flatMap(row => committedSources(row, page, partition)).slice(0, 80) };
}

async function readCommittedSource(message, sender) {
  const page = committedPage(sender, message.pageUrl);
  if (!page || !validCommittedRead(message.request)) return {};
  const partition = await biliAccountFingerprint(true);
  if (!partition) return {};
  const reply = await sendToOffscreen({ type: "READ_COMMITTED_SOURCE", request: message.request, page, partition });
  if (reply?.url && partition !== await biliAccountFingerprint(true)) {
    void chrome.runtime.sendMessage({ target: "offscreen", type: "RELEASE_COMMITTED_SOURCE", url: reply.url }).catch(() => {});
    return {};
  }
  return { range: reply?.url ? { url: reply.url, total: reply.total, contentType: reply.contentType } : null };
}

async function startAutomaticCache(message, sender) {
  const tabId = sender.tab?.id;
  const quality = normalizeQualityId(message.quality);
  const onDemand = message.onDemand === true;
  // 自动任务只接收播放器确认的档位。缺少画质时不沿用手动缓存的最高档默认值。
  if (!quality || sender.frameId !== 0 || !Number.isInteger(tabId) ||
      sourceRangeScope({ id: sender.id, url: sender.url }, { runtimeId: chrome.runtime.id }) !== "reader" ||
      !sameVideoPage(message.url, sender.url)) return { skipped: true };
  const enabled = config => config.mode === "always" && config.bufferMode === (onDemand ? "adaptive" : "full-speed");
  if (!enabled(await getAssistConfig())) return { skipped: true };
  await updater.assertUnlocked();
  const pageInfo = await getPageInfo(sender.url);
  const result = await startCacheForPage(pageInfo, {
    tabId, quality, automatic: true, cacheOrigin: onDemand ? "manual" : "full-speed",
    // 取 CID 和查库期间可能切分 P、换画质或关闭自动缓冲。交给 Offscreen 前复核发起文档。
    canStart: async () => {
      const [tab, config, player] = await Promise.all([
        chrome.tabs.get(tabId).catch(() => null),
        getAssistConfig(),
        chrome.tabs.sendMessage(tabId, { type: "BILI_BUFFER_CONFIRM_CACHE_QUALITY", url: message.url, quality, onDemand },
          sender.documentId ? { documentId: sender.documentId } : { frameId: 0 }).catch(() => null)
      ]);
      return tab?.active && sameVideoPage(tab.url, sender.url) && enabled(config) && player?.confirmed === true ? player : null;
    }
  });
  if (!onDemand && !result.skipped) void syncTemporaryCaches();
  return result;
}

async function startCacheForPage(pageInfo, { tabId, quality, codec, mode, automatic = false, cacheOrigin = "manual", canStart }) {
  if (!pageInfo.supported) throw new Error(pageInfo.message);
  const selectedQuality = normalizeQualityId(quality);
  const requestedQuality = selectedQuality || AUTO_QUALITY;
  const requestedCodec = normalizeCodecPreference(codec);
  const cacheMode = normalizeCacheMode(mode);
  const pageId = pageInfo.id;
  const matchingCache = (await listVideos()).find(video => {
    if (getVideoPageId(video) !== pageId || getCacheMode(video) !== cacheMode) return false;
    const matchQuality = automatic ? (video.quality || video.requestedQuality) : (video.requestedQuality || video.quality);
    return cacheMode === CACHE_MODES.AUDIO ||
      (Number(matchQuality) === requestedQuality && isVideoCodecSelectionMatch(video, requestedCodec));
  });
  const id = matchingCache?.id || (cacheMode === CACHE_MODES.AUDIO
    ? makeAudioCacheVideoId(pageId)
    : makeQualityVideoId(pageId, requestedQuality, requestedCodec));
  const video = {
    ...pageInfo, id, pageId, tabId, requestedQuality, requestedCodec, cacheMode, automatic, cacheOrigin,
    requestedQualityExplicit: selectedQuality > 0
  };
  if (canStart) {
    const confirmation = await canStart();
    if (!confirmation) return { skipped: true };
    // 路径只作为合法播放清单内的选轨提示，包含签名的 CDN URL 不从页面透传给下载任务。
    const sourcePaths = {};
    for (const role of ["video", "audio"]) {
      const path = confirmation.sourcePaths?.[role];
      if (typeof path === "string" && path.startsWith("/") && path.length <= 512) sourcePaths[role] = path;
    }
    if (Object.keys(sourcePaths).length) video.sourcePaths = sourcePaths;
  }
  const result = unwrap(await sendToOffscreen({ type: "START_DOWNLOAD", video }));
  void syncDownloadWatchdog();
  return { pageInfo: video, ...result };
}

async function getAssistState(tabId) {
  const config = await getAssistConfig();
  if (!Number.isInteger(tabId)) return { config, stats: null };
  try {
    const state = await chrome.tabs.sendMessage(tabId, { type: "BILI_BUFFER_GET_ASSIST_STATE" });
    return { config, stats: state?.stats || null, fullPhase: state?.fullPhase || "" };
  } catch {
    return { config, stats: null };
  }
}

async function setAssistConfig(patch) {
  const current = await getAssistConfig();
  const config = sanitizeAssistConfig(patch, current);
  await chrome.storage.local.set({ [ASSIST_CONFIG_KEY]: config });
  return config;
}

async function readPopupSnapshot(tabId, inputUrl) {
  if (!Number.isInteger(tabId)) return null;
  await popupSnapshotQueue;
  const memory = popupSnapshotMemory.get(tabId);
  if (isPopupSnapshotMatch(memory, tabId, inputUrl)) return memory;
  try {
    const stored = await chrome.storage.session.get(POPUP_SNAPSHOTS_KEY);
    const snapshot = stored?.[POPUP_SNAPSHOTS_KEY]?.[String(tabId)] || null;
    if (!isPopupSnapshotMatch(snapshot, tabId, inputUrl)) return null;
    popupSnapshotMemory.set(tabId, snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

async function storePopupSnapshot(snapshot) {
  popupSnapshotMemory.set(snapshot.tabId, snapshot);
  return enqueuePopupSnapshotUpdate(async () => {
    try {
      const stored = await chrome.storage.session.get(POPUP_SNAPSHOTS_KEY);
      const snapshots = { ...(stored?.[POPUP_SNAPSHOTS_KEY] || {}) };
      const cutoff = Date.now() - POPUP_SNAPSHOT_MAX_AGE;
      for (const [key, value] of Object.entries(snapshots)) {
        const lastUsedAt = Math.max(Number(value?.savedAt) || 0, Number(value?.selectionUpdatedAt) || 0);
        if (lastUsedAt < cutoff) delete snapshots[key];
      }
      snapshots[String(snapshot.tabId)] = snapshot;
      await chrome.storage.session.set({ [POPUP_SNAPSHOTS_KEY]: snapshots });
    } catch {
      // 内存快照仍可供当前 Service Worker 生命周期内使用。
    }
  });
}

async function invalidatePopupSnapshots() {
  for (const [tabId, snapshot] of popupSnapshotMemory) {
    popupSnapshotMemory.set(tabId, { ...snapshot, savedAt: 0 });
  }
  await enqueuePopupSnapshotUpdate(async () => {
    try {
      const stored = await chrome.storage.session.get(POPUP_SNAPSHOTS_KEY);
      const snapshots = Object.fromEntries(Object.entries(stored?.[POPUP_SNAPSHOTS_KEY] || {})
        .map(([key, snapshot]) => [key, { ...snapshot, savedAt: 0 }]));
      await chrome.storage.session.set({ [POPUP_SNAPSHOTS_KEY]: snapshots });
    } catch {
      // Cookie 变更后至少内存快照已经失效。
    }
  });
}

function enqueuePopupSnapshotUpdate(operation) {
  const next = popupSnapshotQueue.then(operation);
  popupSnapshotQueue = next.catch(() => {});
  return next;
}

async function ensureOffscreenDocument() {
  if (creatingOffscreen) return creatingOffscreen;
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (creatingOffscreen) return creatingOffscreen;
  if (contexts.length > 0) return;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS"],
    justification: t("err.offscreenReason")
  }).then(syncPlaybackPressure).finally(() => {
    creatingOffscreen = null;
  });
  return creatingOffscreen;
}

async function syncPlaybackPressure() {
  // 新 Offscreen 启动时让已播放的标签页立即直接上报，无需等到下次心跳才让行。
  const query = (async () => {
    const tabs = await chrome.tabs.query({ url: BILI_PLAYBACK_TABS });
    await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, { type: "BILI_BUFFER_SYNC_PLAYBACK_PRESSURE" }, { frameId: 0 })));
  })();
  let timer;
  try {
    await Promise.race([query.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 400); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  if (["START_DOWNLOAD", "RESUME_DOWNLOAD", "RECOVER_DOWNLOADS", "GET_PLAYBACK_URL", "DELETE_VIDEO", "PAUSE_DOWNLOAD", "SYNC_TEMPORARY_CACHES"].includes(message.type)) {
    await updater.assertUnlocked();
  }
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function refreshDownloadSource(video) {
  if (!video?.bvid || !video?.cid) throw new Error(t("err.taskNoIdentity"));
  const auth = await getBiliSessionState();
  const requestedQuality = normalizeQualityId(video.requestedQuality ?? video.quality, AUTO_QUALITY);
  const fnval = video.mediaKind === "progressive" ? "1" : "4048";
  const playurl = await requestPlayurl(video, requestedQuality, video.tabId, auth, fnval);
  return { auth: playurl.auth, playurlData: playurl.data };
}

/** 继续由 Offscreen 核对目标记录、登记运行世代并取源。 */
async function resumeCache(videoId, { createdAt, tabId, afterUpdate = false } = {}) {
  const result = unwrap(await sendToOffscreen({ type: "RESUME_DOWNLOAD", videoId, createdAt, tabId, afterUpdate }));
  void syncDownloadWatchdog();
  return result;
}

/** 弹窗的 DELETE_VIDEO 与弹窗关闭后的补提交共用；更新锁期间同样拒绝，避免改动正在被替换的数据。 */
async function deleteCachedVideo(videoId, createdAt) {
  await updater.assertUnlocked();
  return unwrap(await sendToOffscreen({ type: "DELETE_VIDEO", videoId, createdAt }));
}

function syncDownloadWatchdog() {
  // 多条任务事件并发到达时，以串行的只读快照调整闹钟，后到的退避不能推迟较早的唤醒。
  watchdogQueue = watchdogQueue.then(async () => {
    const pending = (await listVideos()).filter(needsDownloadRecovery);
    if (!pending.length) {
      await chrome.alarms.clear(DOWNLOAD_WATCHDOG_ALARM);
      return;
    }
    const now = Date.now();
    const interval = DOWNLOAD_WATCHDOG_MINUTES * 60_000;
    const when = pending.reduce((earliest, video) => {
      const retryAt = Number(video.nextRetryAt) || 0;
      return Math.min(earliest, retryAt > now ? retryAt : now + interval);
    }, Infinity);
    const current = await chrome.alarms.get(DOWNLOAD_WATCHDOG_ALARM);
    if (!current || current.scheduledTime > when) {
      await chrome.alarms.create(DOWNLOAD_WATCHDOG_ALARM, makeDownloadWatchdogSchedule(when, now));
    }
  }).catch(error => console.warn("[海内存知] 无法同步下载看门狗", toPublicError(error)));
  return watchdogQueue;
}

function syncTemporaryCaches() {
  if (!chrome.tabs?.query) return;
  temporaryCacheQueue = temporaryCacheQueue.then(async () => {
    let nextExpiry;
    const videoTabs = new Set();
    if ((await listVideos()).some(isTemporaryCache)) {
      // 直接从浏览器读全部标签；SW 休眠期间无需保活或保存标签计数。
      const tabs = await chrome.tabs.query({ url: BILI_PLAYBACK_TABS });
      const pages = [];
      for (const tab of tabs) {
        const page = parseBiliVideoUrl(tab.pendingUrl || tab.url);
        if (!page.supported) continue;
        videoTabs.add(tab.id);
        pages.push(page);
      }
      ({ nextExpiry } = unwrap(await sendToOffscreen({ type: "SYNC_TEMPORARY_CACHES", pages })));
    }
    // 仅用于减少无关页面的 IndexedDB 查询。下一轮保留判定仍以浏览器快照为准。
    temporaryPageTabs = videoTabs;
    if (!Number.isFinite(nextExpiry)) await chrome.alarms.clear(TEMPORARY_CACHE_ALARM);
    else if ((await chrome.alarms.get(TEMPORARY_CACHE_ALARM))?.scheduledTime !== nextExpiry) {
      await chrome.alarms.create(TEMPORARY_CACHE_ALARM, { when: nextExpiry });
    }
  }).catch(async () => {
    // 更新锁或浏览器暂时不可查询时保留原记录。重试用持久闹钟，避免开着 SW 等待。
    await chrome.alarms.create(TEMPORARY_CACHE_ALARM, { delayInMinutes: 1 }).catch(() => {});
  });
  return temporaryCacheQueue;
}

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || t("err.offscreenNoResponse"));
  return result;
}

async function getBiliSessionState() {
  try {
    const sessionCookie = await chrome.cookies.get({
      url: "https://www.bilibili.com/",
      name: "SESSDATA"
    });
    return { cookieAccess: true, hasSessionCookie: Boolean(sessionCookie) };
  } catch {
    return { cookieAccess: false, hasSessionCookie: false };
  }
}

function makePlayurlEndpoint(video, requestedQuality, fnval) {
  const endpoint = new URL("https://api.bilibili.com/x/player/playurl");
  endpoint.search = new URLSearchParams({
    bvid: video.bvid,
    cid: String(video.cid),
    qn: String(requestedQuality),
    fnver: "0",
    fnval,
    fourk: "1"
  });
  return endpoint;
}

async function requestPlayurl(video, requestedQuality, tabId, session, fnval = "4048") {
  let payload;
  let viaPageSession = false;
  if (Number.isInteger(tabId)) {
    try {
      const pageResult = await chrome.tabs.sendMessage(tabId, {
        type: "BILI_BUFFER_FETCH_PLAYURL",
        request: {
          bvid: video.bvid,
          cid: video.cid,
          quality: requestedQuality,
          fnval
        }
      });
      if (pageResult?.ok && pageResult.payload) {
        payload = pageResult.payload;
        viaPageSession = true;
      }
    } catch {
      // 页面可能已关闭或内容脚本尚未注入；下面回退到扩展源请求。
    }
  }

  if (!payload) {
    const response = await fetch(makePlayurlEndpoint(video, requestedQuality, fnval), {
      cache: "no-store",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(t("err.playurlHttp", { status: response.status }));
    payload = await response.json();
  }

  if (payload.code !== 0 || !payload.data) {
    const authenticationHint = session.hasSessionCookie
      ? t("err.authHintSession")
      : t("err.authHintNoCookie");
    throw new Error(t("err.withHint", { message: payload.message || t("err.apiCode", { code: payload.code }), hint: authenticationHint }));
  }

  return {
    data: payload.data,
    auth: {
      ...session,
      // 只记录播放清单来自哪条取源路径。两条路径都使用 credentials: include。
      viaPageSession,
      vipActive: Number(payload.data.vip_status) === 1 || Number(payload.data.vip_type) > 0
    }
  };
}

/**
 * 取视频元信息（标题 / UP 主 / 分 P / cid）。
 *
 * 为什么有两个端点：B 站网页端已迁到 `/x/web-interface/wbi/view`（无需签名即可用），
 * 而老的 `/x/web-interface/view` 对不带网页端指纹的请求（包括扩展后台与自动化浏览器）
 * 会稳定回 HTTP 412 风控页。老端点只保留作回退，新端点失败（被风控、字段改版）时才用。
 * @param {{bvid?: string, aid?: number}} parsed 已解析的视频标识。
 * @returns {Promise<{code: number, data: object}>}
 */
async function requestVideoView(parsed) {
  const endpoints = [
    "https://api.bilibili.com/x/web-interface/wbi/view",
    "https://api.bilibili.com/x/web-interface/view"
  ];
  let lastError = new Error(t("err.unrecognized"));
  for (const base of endpoints) {
    const endpoint = new URL(base);
    if (parsed.bvid) endpoint.searchParams.set("bvid", parsed.bvid);
    if (parsed.aid) endpoint.searchParams.set("aid", String(parsed.aid));
    try {
      const response = await fetch(endpoint, {
        cache: "no-store",
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) throw new Error(t("err.viewHttp", { status: response.status }));
      const payload = await response.json();
      if (payload.code !== 0 || !payload.data) {
        throw new Error(payload.message || t("err.unrecognizedCode", { code: payload.code }));
      }
      return payload;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function getPageInfo(inputUrl, { includeParts = false } = {}) {
  const parsed = parseBiliVideoUrl(inputUrl);
  if (!parsed.supported) {
    const messages = {
      notBilibili: t("err.notBilibili"),
      notVideo: t("err.notVideo"),
      invalidUrl: t("err.invalidUrl")
    };
    return { supported: false, reason: parsed.reason, message: messages[parsed.reason] };
  }

  const payload = await requestVideoView(parsed);

  const data = payload.data;
  const pages = Array.isArray(data.pages) && data.pages.length
    ? data.pages
    : [{ cid: data.cid, page: 1, part: data.title, duration: data.duration }];
  const pageNumber = Math.min(Math.max(parsed.page, 1), pages.length);
  const page = pages[pageNumber - 1];
  const bvid = data.bvid || parsed.bvid;
  const ownerId = Number(data.owner?.mid) || 0;
  const pageUrl = number => `https://www.bilibili.com/video/${bvid}/${pages.length > 1 ? `?p=${number}` : ""}`;
  return {
    supported: true,
    id: makeVideoId(bvid, page.cid),
    bvid,
    aid: data.aid,
    cid: page.cid,
    page: pageNumber,
    pageCount: pages.length,
    title: data.title || page.part || bvid,
    partTitle: pages.length > 1 ? page.part : "",
    owner: data.owner?.name || "",
    ownerId,
    ownerUrl: makeBiliSpaceUrl(ownerId),
    cover: data.pic || "",
    duration: page.duration || data.duration || 0,
    url: pageUrl(pageNumber),
    // MCP 按清单选集。弹窗默认只取当前 P，避免把完整清单写入快照。
    ...(includeParts ? { parts: pages.map((item, index) => ({
      page: index + 1, cid: item.cid, title: item.part || "", durationSeconds: item.duration || 0, url: pageUrl(index + 1)
    })) } : {}),
    updatedAt: Date.now()
  };
}

/** @param {number} tabId @param {object|null} incoming @returns {Promise<void>} */
function updateTaskBadge(tabId, incoming = null) {
  // 队列仅防止异步 API 乱序，不保存任务真相；SW 重启后从 IndexedDB 重建。
  const next = badgeQueue.then(async () => {
    const videos = await listVideos();
    const index = incoming ? videos.findIndex(video => video.id === incoming.id) : -1;
    if (index >= 0) videos[index] = newerTask(videos[index], incoming);
    const badge = taskBadge(videos, tabId);
    await chrome.action.setBadgeBackgroundColor({ color: badge.color, tabId });
    await chrome.action.setBadgeText({ text: badge.text, tabId });
    await chrome.action.setTitle?.({ title: badge.title, tabId });
  });
  badgeQueue = next.catch(() => {});
  return next;
}

async function restoreTaskBadges() {
  try {
    const ids = new Set((await listVideos()).map(video => video.tabId).filter(Number.isInteger));
    for (const id of ids) await updateTaskBadge(id).catch(() => {});
  } catch { /* 数据库或旧标签页暂不可用；下一条任务事件会重新派生徽标。 */ }
}

async function handleCacheEvent(message) {
  const video = message.video;
  const tabId = video?.tabId ?? message.tabId;
  try {
    if (Number.isInteger(tabId)) {
      chrome.tabs.sendMessage(tabId, { type: "BILI_BUFFER_COMMITTED_CHANGED" }).catch(() => {});
      await updateTaskBadge(tabId, video);
      if (message.type === 'CACHE_COMPLETE') chrome.tabs.sendMessage(tabId, { type: 'CACHE_READY', videoId: video.id }).catch(() => {});
    }
  } catch {
    // 原标签页关闭不能中断下载或 Popup 推送。
  } finally { broadcastToPopup(message); }
}

function updateCachePlaybackUse(action, fields) {
  // 浏览器的关闭/下载事件也会在 Offscreen 已销毁时抵达，无需因此新建文档。
  return chrome.runtime.sendMessage({ target: "offscreen", type: "UPDATE_CACHE_PLAYBACK_USE", action, ...fields }).catch(() => {});
}

async function getCachedPlaybackForPage(videoId, tabId) {
  if (!Number.isInteger(tabId)) return unwrap(await sendToOffscreen({ type: "GET_PLAYBACK_URL", videoId }));
  const leaseId = crypto.randomUUID();
  try {
    const cached = unwrap(await sendToOffscreen({ type: "GET_PLAYBACK_URL", videoId, leaseId, tabId }));
    await chrome.tabs.get(tabId);
    return { ...cached, leaseId };
  } catch (error) {
    await updateCachePlaybackUse("release", { leaseId });
    throw error;
  }
}

/** 导出在选择路径和启动第二条轨道时继续持有保护，之后由各下载的终态释放。 */
async function withCacheExport(videoId, operation) {
  const leaseId = crypto.randomUUID();
  try {
    const cached = unwrap(await sendToOffscreen({ type: "GET_PLAYBACK_URL", videoId, leaseId }));
    return await operation(buildCachedDownloadPlan(cached), async options => {
      const id = await chrome.downloads.download(options);
      await updateCachePlaybackUse("addDownload", { leaseId, downloadId: id });
      // 小文件可能在 download() 返回或登记之前完成。登记后再查，可覆盖事件与 Promise 任何先后顺序。
      const items = await chrome.downloads.search({ id }).catch(() => null);
      if (items && items[0]?.state !== "in_progress") await updateCachePlaybackUse("endDownload", { downloadId: id });
      return id;
    });
  } finally {
    await updateCachePlaybackUse("finish", { leaseId });
  }
}

function saveCachedVideo(videoId, saveAs) {
  return withCacheExport(videoId, async (plan, download) => {
    const downloadIds = [];
    try {
      for (const item of plan.items) downloadIds.push(await download({
        url: item.url, filename: item.filename, conflictAction: "uniquify", saveAs
      }));
      return { downloadIds, filenames: plan.items.map(item => item.filename), splitTracks: plan.splitTracks };
    } catch (error) {
      if (!saveAs) await Promise.allSettled(downloadIds.map(id => chrome.downloads.cancel(id)));
      throw error;
    }
  });
}

/** 从片库打开浏览器的原生媒体页；文件保留同源 Blob 读取及拖动能力。 */
async function openCachedVideo(videoId) {
  const leaseId = crypto.randomUUID();
  try {
    const cached = unwrap(await sendToOffscreen({ type: "GET_PLAYBACK_URL", videoId, leaseId }));
    const tracks = cached.playback?.tracks || [];
    const url = cached.playbackUrl || (tracks.length === 1 ? tracks[0].url : "");
    if (!url) throw new Error(t("err.localPlaybackSplit"));
    const tab = await chrome.tabs.create({ url });
    await updateCachePlaybackUse("bindTab", { leaseId, tabId: tab.id });
    await chrome.tabs.get(tab.id);
    return { tabId: tab.id };
  } catch (error) {
    await updateCachePlaybackUse("release", { leaseId });
    throw error;
  }
}

function broadcastToPopup(message) {
  chrome.runtime.sendMessage({ ...message, target: "popup" }).catch(() => {});
}

async function restoreActiveDownloads() {
  if (restoringDownloads) return restoringDownloads;
  restoringDownloads = restoreActiveDownloadsNow().finally(() => {
    restoringDownloads = null;
  });
  return restoringDownloads;
}

async function restoreActiveDownloadsNow() {
  try {
    if (await updater.isLocked()) return;
    await syncTemporaryCaches();
    await syncDownloadWatchdog();
    if ((await listVideos()).some(needsDownloadRecovery)) {
      unwrap(await sendToOffscreen({ type: "RECOVER_DOWNLOADS" }));
    }
  } catch (error) {
    console.warn("[海内存知] 无法恢复上次的缓存任务：", error);
  }
}
