import { newerTask, taskBadge } from "./task-presentation.js";
import { buildCacheSizeInfo } from "./cache-size.js";
import {
  AUTO_QUALITY,
  CACHE_MODES,
  buildCachedDownloadPlan,
  buildMediaCodecOptions,
  buildMediaQualityOptions,
  getCacheMode,
  getCodecFamily,
  getVideoPageId,
  hasCompleteByteCount,
  isAudioOnlyCache,
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
import { listVideos, putVideo } from "./db.js";
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
  isDownloadRetryDue,
  makeDownloadWatchdogSchedule
} from "./download-retry.js";
import { ASSIST_DEFAULTS, sanitizeAssistConfig } from "./assist-config.js";
import { createBudgetService, budgetOwner } from "./request-budget.js";
import { createSourceRepository, createSourceService, sourceRangeScope } from "./source-range-store.js";

const requestBudget = createBudgetService(chrome.storage.session, async () => (await getAssistConfig()).maxConcurrency);
// 离线已下载的源范围镜像：只接收逐字节校验过的 CDN 范围，供播放侧按「路径 + 总长」复用。
const sourceRanges = createSourceService({
  repository: typeof indexedDB === "undefined" ? null : createSourceRepository(),
  account: biliAccountFingerprint
});

/** 用 SESSDATA 的不可逆摘要做账户分区；原始 cookie 值不落盘、不进消息、不进日志。
 * @returns {Promise<string>}
 */
async function biliAccountFingerprint() {
  try {
    const cookie = await chrome.cookies.get({ url: "https://www.bilibili.com/", name: "SESSDATA" });
    if (!cookie?.value || !globalThis.crypto?.subtle) return "anonymous";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookie.value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  } catch { return "anonymous"; }
}
const OFFSCREEN_PATH = "offscreen.html";
const POPUP_SNAPSHOTS_KEY = "popupPageSnapshotsV1";
const ASSIST_CONFIG_KEY = "playbackAssistConfigV1";
const CACHE_MODE_KEY = "cacheModeV1";
let creatingOffscreen;
let restoringDownloads;
let popupSnapshotQueue = Promise.resolve();
let badgeQueue = Promise.resolve();
const popupSnapshotMemory = new Map();

if (chrome.runtime.id) startDevReloadBackground(ensureOffscreenDocument);
void restoreActiveDownloads();
void restoreTaskBadges();
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === DOWNLOAD_WATCHDOG_ALARM) void restoreActiveDownloads();
});
chrome.cookies.onChanged.addListener((changeInfo) => {
  const cookie = changeInfo?.cookie;
  if (cookie?.name === "SESSDATA" && String(cookie.domain || "").endsWith("bilibili.com")) {
    void invalidatePopupSnapshots();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target && message.target !== "background") return false;

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: toPublicError(error) }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "SOURCE_RANGE": {
      const request = message.request;
      if (!request || typeof request !== "object") return {};
      // 写入只允许扩展自己的下载文档，读取只允许 B 站视频页；其余来源直接拒绝。
      const scope = sourceRangeScope(sender, {
        runtimeId: chrome.runtime.id,
        offscreenUrl: chrome.runtime.getURL(OFFSCREEN_PATH)
      });
      if (!scope || (request.op === "write") !== (scope === "writer")) return {};
      return sourceRanges.handle(request, scope);
    }
    case "DOWNLOAD_BUDGET": {
      const owner=budgetOwner(sender,chrome.runtime.id);
      if(!owner) throw new Error("下载预算来源无效");
      return requestBudget(message.request || {},owner);
    }
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
    case "GET_CACHE_MODE":
      return { mode: await getCacheModePreference() };
    case "SET_CACHE_MODE":
      return { mode: await setCacheModePreference(message.mode) };
    case "SET_ASSIST_CONFIG":
      return { config: await setAssistConfig(message.patch) };
    case "ASSIST_COMMAND":
      return sendAssistCommand(message.tabId, message.name);
    case "GET_PAGE_INFO":
      return { pageInfo: await getPageInfo(message.url) };
    case "GET_QUALITY_OPTIONS": {
      const pageInfo = await getPageInfo(message.url);
      if (!pageInfo.supported) throw new Error(pageInfo.message);
      const auth = await getBiliSessionState();
      const playurl = await requestPlayurl(pageInfo, AUTO_QUALITY, message.tabId, auth);
      const qualities = buildMediaQualityOptions(playurl.data);
      if (!qualities.length) throw new Error("B 站没有返回可缓存的 MP4 或 DASH 画质");
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
      if (!pageInfo.supported) throw new Error(pageInfo.message);
      pageInfo.tabId = message.tabId;
      pageInfo.requestedQuality = normalizeQualityId(message.quality, AUTO_QUALITY);
      pageInfo.requestedQualityExplicit = normalizeQualityId(message.quality) > 0;
      pageInfo.requestedCodec = normalizeCodecPreference(message.codec);
      pageInfo.cacheMode = normalizeCacheMode(message.mode);
      const pageId = pageInfo.id;
      const matchingCache = (await listVideos()).find((video) => {
        if (getVideoPageId(video) !== pageId) return false;
        if (pageInfo.cacheMode === CACHE_MODES.AUDIO) return getCacheMode(video) === CACHE_MODES.AUDIO;
        return getCacheMode(video) === CACHE_MODES.VIDEO &&
          Number(video.requestedQuality || video.quality) === pageInfo.requestedQuality &&
          isVideoCodecSelectionMatch(video, pageInfo.requestedCodec);
      });
      pageInfo.pageId = pageId;
      pageInfo.id = matchingCache?.id || (pageInfo.cacheMode === CACHE_MODES.AUDIO
        ? makeAudioCacheVideoId(pageId)
        : makeQualityVideoId(pageId, pageInfo.requestedQuality, pageInfo.requestedCodec));
      const auth = await getBiliSessionState();
      const playurl = await requestPlayurl(pageInfo, pageInfo.requestedQuality, message.tabId, auth);
      pageInfo.auth = playurl.auth;
      pageInfo.playurlData = playurl.data;
      const result = await sendToOffscreen({ type: "START_DOWNLOAD", video: pageInfo });
      if (!result.ok) throw new Error(result.error);
      await ensureDownloadWatchdog();
      const { auth: _auth, playurlData: _playurlData, ...publicPageInfo } = pageInfo;
      return { pageInfo: publicPageInfo, ...result };
    }
    case "LIST_VIDEOS":
      return { videos: await listVideos() };
    case "GET_VIDEO":
      return unwrap(await sendToOffscreen({ type: "GET_VIDEO", videoId: message.videoId }));
    case "GET_PLAYBACK_URL":
      return unwrap(await sendToOffscreen({ type: "GET_PLAYBACK_URL", videoId: message.videoId }));
    case "SAVE_VIDEO":
      return saveCachedVideo(message.videoId);
    case "GET_CACHED_FOR_URL": {
      const pageInfo = await getPageInfo(message.url);
      if (!pageInfo.supported) return { pageInfo, video: null };
      const cached = (await listVideos())
        .filter((video) => (
          getVideoPageId(video) === pageInfo.id &&
          video.status === "complete" &&
          hasCompleteByteCount(video) &&
          // 仅音频缓存不能顶替网页播放器，否则会变成没有画面的本地播放。
          !isAudioOnlyCache(video)
        ))
        .sort((left, right) => (
          (Number(right.quality) || 0) - (Number(left.quality) || 0) ||
          (Number(right.completedAt) || 0) - (Number(left.completedAt) || 0)
        ))[0] || null;
      return { pageInfo, video: cached };
    }
    case "DELETE_VIDEO":
      return unwrap(await sendToOffscreen({ type: "DELETE_VIDEO", videoId: message.videoId }));
    case "CACHE_PROGRESS":
      await handleCacheEvent(message);
      return { received: true };
    case "CACHE_RETRY":
      await ensureDownloadWatchdog(message.video?.nextRetryAt);
      await handleCacheEvent(message);
      return { received: true };
    case "CACHE_COMPLETE":
    case "CACHE_ERROR":
      await handleCacheEvent(message);
      void syncDownloadWatchdog();
      return { received: true };
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
        await chrome.action.setBadgeText({ text: "本地", tabId: sender.tab.id });
      }
      return { received: true };
    default:
      throw new Error("未知的扩展指令");
  }
}

async function refreshPopupSnapshot(inputUrl, tabId) {
  if (!Number.isInteger(tabId)) throw new Error("无法识别当前标签页");
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
  if (!qualities.length) throw new Error("B 站没有返回可缓存的 MP4 或 DASH 画质");
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

async function getAssistState(tabId) {
  const config = await getAssistConfig();
  if (!Number.isInteger(tabId)) return { config, stats: null };
  try {
    const state = await chrome.tabs.sendMessage(tabId, { type: "BILI_BUFFER_GET_ASSIST_STATE" });
    return { config, stats: state?.stats || null, commandResult: state?.commandResult || null };
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

async function sendAssistCommand(tabId, name) {
  if (!Number.isInteger(tabId)) throw new Error("无法识别当前标签页");
  if (!["clearEstimator", "restoreEstimator"].includes(name)) throw new Error("未知的播放辅助指令");
  const result = await chrome.tabs.sendMessage(tabId, { type: "BILI_BUFFER_ASSIST_COMMAND", name });
  if (!result?.ok) throw new Error(result?.error || "当前 B 站页面没有响应");
  return { sent: true };
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
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_PATH);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length > 0) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["BLOBS"],
    justification: "持续下载大视频并将媒体 Blob 分块写入扩展本地数据库"
  }).finally(() => {
    creatingOffscreen = null;
  });
  return creatingOffscreen;
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function refreshDownloadSource(video) {
  if (!video?.bvid || !video?.cid) throw new Error("缓存任务缺少视频身份，无法刷新播放地址");
  const auth = await getBiliSessionState();
  const requestedQuality = normalizeQualityId(video.requestedQuality ?? video.quality, AUTO_QUALITY);
  const fnval = video.mediaKind === "dash" || video.mediaKind === "audio" ? "4048" : "1";
  const playurl = await requestPlayurl(video, requestedQuality, video.tabId, auth, fnval);
  return { auth: playurl.auth, playurlData: playurl.data };
}

async function ensureDownloadWatchdog(nextRetryAt = 0) {
  await chrome.alarms.create(DOWNLOAD_WATCHDOG_ALARM, makeDownloadWatchdogSchedule(nextRetryAt));
}

async function syncDownloadWatchdog() {
  const active = (await listVideos()).filter((video) => video.status === "downloading");
  const nextRetryAt = active.reduce((earliest, video) => {
    const retryAt = Number(video.nextRetryAt) || 0;
    return retryAt > Date.now() && (!earliest || retryAt < earliest) ? retryAt : earliest;
  }, 0);
  if (active.length) await ensureDownloadWatchdog(nextRetryAt);
  else await chrome.alarms.clear(DOWNLOAD_WATCHDOG_ALARM);
}

function unwrap(result) {
  if (!result?.ok) throw new Error(result?.error || "缓存后台没有响应");
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
      if (pageResult?.ok && pageResult.payload) payload = pageResult.payload;
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
    if (!response.ok) throw new Error(`播放地址请求失败（HTTP ${response.status}）`);
    payload = await response.json();
  }

  if (payload.code !== 0 || !payload.data) {
    const authenticationHint = session.hasSessionCookie
      ? "已尝试使用当前 Chrome 的 B 站登录状态，但账号可能没有观看权限或登录已失效"
      : "未检测到 B 站登录 Cookie，请先在当前 Chrome 登录后重试";
    throw new Error(`${payload.message || `B 站接口返回错误 ${payload.code}`}；${authenticationHint}`);
  }

  return {
    data: payload.data,
    auth: {
      ...session,
      viaPageSession: Boolean(payload.__fromBiliPage),
      vipActive: Number(payload.data.vip_status) === 1 || Number(payload.data.vip_type) > 0
    }
  };
}

async function getPageInfo(inputUrl) {
  const parsed = parseBiliVideoUrl(inputUrl);
  if (!parsed.supported) {
    const messages = {
      notBilibili: "这里不是 B 站页面",
      notVideo: "请打开一个 B 站标准视频页",
      invalidUrl: "当前页面地址无效"
    };
    return { supported: false, reason: parsed.reason, message: messages[parsed.reason] };
  }

  const endpoint = new URL("https://api.bilibili.com/x/web-interface/view");
  if (parsed.bvid) endpoint.searchParams.set("bvid", parsed.bvid);
  if (parsed.aid) endpoint.searchParams.set("aid", String(parsed.aid));
  const response = await fetch(endpoint, {
    cache: "no-store",
    credentials: "include",
    headers: { Accept: "application/json" }
  });
  if (!response.ok) throw new Error(`视频信息请求失败（HTTP ${response.status}）`);
  const payload = await response.json();
  if (payload.code !== 0 || !payload.data) {
    throw new Error(payload.message || `无法识别当前视频（${payload.code}）`);
  }

  const data = payload.data;
  const pages = Array.isArray(data.pages) && data.pages.length
    ? data.pages
    : [{ cid: data.cid, page: 1, part: data.title, duration: data.duration }];
  const pageNumber = Math.min(Math.max(parsed.page, 1), pages.length);
  const page = pages[pageNumber - 1];
  const bvid = data.bvid || parsed.bvid;
  const ownerId = Number(data.owner?.mid) || 0;
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
    url: `https://www.bilibili.com/video/${bvid}/${pages.length > 1 ? `?p=${pageNumber}` : ""}`,
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
      await updateTaskBadge(tabId, video);
      if (message.type === 'CACHE_COMPLETE') chrome.tabs.sendMessage(tabId, { type: 'CACHE_READY', videoId: video.id }).catch(() => {});
    }
  } catch {
    // 原标签页关闭不能中断下载或 Popup 推送。
  } finally { broadcastToPopup(message); }
}

async function saveCachedVideo(videoId) {
  const cached = unwrap(await sendToOffscreen({ type: "GET_PLAYBACK_URL", videoId }));
  const plan = buildCachedDownloadPlan(cached);
  const downloadIds = [];
  for (const item of plan.items) {
    downloadIds.push(await chrome.downloads.download({
      url: item.url,
      filename: item.filename,
      conflictAction: "uniquify",
      saveAs: true
    }));
  }
  return { downloadIds, splitTracks: plan.splitTracks };
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
    const interrupted = [];
    for (const video of await listVideos()) {
      if (video.status === "complete" && !hasCompleteByteCount(video)) {
        const repaired = {
          ...video,
          status: "downloading",
          progress: video.totalBytes ? Math.min(video.downloadedBytes / video.totalBytes, 0.999) : 0,
          completedAt: null,
          error: "",
          updatedAt: Date.now()
        };
        await putVideo(repaired);
        interrupted.push(repaired);
      } else if (video.status === "downloading") {
        interrupted.push(video);
      }
    }
    if (!interrupted.length) {
      await chrome.alarms.clear(DOWNLOAD_WATCHDOG_ALARM);
      return;
    }
    const nextRetryAt = interrupted.reduce((earliest, video) => {
      const retryAt = Number(video.nextRetryAt) || 0;
      return retryAt > Date.now() && (!earliest || retryAt < earliest) ? retryAt : earliest;
    }, 0);
    await ensureDownloadWatchdog(nextRetryAt);
    const activeResult = await sendToOffscreen({ type: "GET_ACTIVE_DOWNLOADS" }).catch(() => ({ videoIds: [] }));
    const activeIds = new Set(activeResult?.videoIds || []);
    const auth = interrupted.length ? await getBiliSessionState() : null;
    for (const video of interrupted) {
      if (activeIds.has(video.id) || !isDownloadRetryDue(video)) continue;
      try {
        const requestedQuality = normalizeQualityId(video.requestedQuality ?? video.quality, AUTO_QUALITY);
        const persistedCodec = getCodecFamily(video.tracks?.video?.codecs);
        const fnval = video.mediaKind === "dash" || video.mediaKind === "audio" ? "4048" : "1";
        const playurl = await requestPlayurl(video, requestedQuality, video.tabId, auth, fnval);
        const result = await sendToOffscreen({
          type: "START_DOWNLOAD",
          video: {
            ...video,
            requestedCodec: normalizeCodecPreference(
              video.requestedCodec,
              persistedCodec === "other" ? "auto" : persistedCodec
            ),
            auth: playurl.auth,
            playurlData: playurl.data
          }
        });
        if (!result?.ok) console.warn("[Bili 缓冲站] 自动续传失败：", result?.error);
      } catch (error) {
        const fallback = await sendToOffscreen({ type: "START_DOWNLOAD", video }).catch((fallbackError) => ({
          ok: false,
          error: toPublicError(fallbackError)
        }));
        if (!fallback?.ok) {
          console.warn("[Bili 缓冲站] 无法从已保存的播放地址恢复任务：", fallback?.error || error);
        }
      }
    }
    await syncDownloadWatchdog();
  } catch (error) {
    console.warn("[Bili 缓冲站] 无法恢复上次的缓存任务：", error);
  }
}
