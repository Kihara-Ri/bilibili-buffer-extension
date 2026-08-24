import {
  AUTO_QUALITY,
  buildCachedDownloadPlan,
  buildMediaQualityOptions,
  getVideoPageId,
  hasCompleteByteCount,
  makeBiliSpaceUrl,
  makeVideoId,
  makeQualityVideoId,
  normalizeQualityId,
  parseBiliVideoUrl,
  toPublicError
} from "./utils.js";
import { listVideos, putVideo } from "./db.js";
import { startDevReload } from "./dev-reload.js";
import {
  choosePopupQuality,
  isPopupSnapshotFresh,
  isPopupSnapshotMatch,
  makePopupPageKey,
  POPUP_SNAPSHOT_MAX_AGE
} from "./popup-snapshot.js";

const OFFSCREEN_PATH = "offscreen.html";
const POPUP_SNAPSHOTS_KEY = "popupPageSnapshotsV1";
let creatingOffscreen;
let popupSnapshotQueue = Promise.resolve();
const popupSnapshotMemory = new Map();

startDevReload();
void restoreActiveDownloads();
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
    case "GET_POPUP_SNAPSHOT": {
      const snapshot = await readPopupSnapshot(message.tabId, message.url);
      return { snapshot, stale: snapshot ? !isPopupSnapshotFresh(snapshot) : true };
    }
    case "REFRESH_POPUP_DATA":
      return { snapshot: await refreshPopupSnapshot(message.url, message.tabId) };
    case "SET_POPUP_SELECTION":
      return { saved: await savePopupSelection(message.tabId, message.url, message.quality) };
    case "GET_PAGE_INFO":
      return { pageInfo: await getPageInfo(message.url) };
    case "GET_QUALITY_OPTIONS": {
      const pageInfo = await getPageInfo(message.url);
      if (!pageInfo.supported) throw new Error(pageInfo.message);
      const auth = await getBiliSessionState();
      const playurl = await requestPlayurl(pageInfo, AUTO_QUALITY, message.tabId, auth);
      const qualities = buildMediaQualityOptions(playurl.data);
      if (!qualities.length) throw new Error("B 站没有返回可缓存的 MP4 或 DASH 画质");
      return {
        pageInfo,
        qualities,
        defaultQuality: qualities[0].quality,
        auth: playurl.auth
      };
    }
    case "START_CACHE": {
      const pageInfo = await getPageInfo(message.url);
      if (!pageInfo.supported) throw new Error(pageInfo.message);
      pageInfo.tabId = message.tabId;
      pageInfo.requestedQuality = normalizeQualityId(message.quality, AUTO_QUALITY);
      pageInfo.requestedQualityExplicit = normalizeQualityId(message.quality) > 0;
      const pageId = pageInfo.id;
      const matchingCache = (await listVideos()).find((video) => (
        getVideoPageId(video) === pageId &&
        Number(video.requestedQuality || video.quality) === pageInfo.requestedQuality
      ));
      pageInfo.pageId = pageId;
      pageInfo.id = matchingCache?.id || makeQualityVideoId(pageId, pageInfo.requestedQuality);
      const auth = await getBiliSessionState();
      const playurl = await requestPlayurl(pageInfo, pageInfo.requestedQuality, message.tabId, auth);
      pageInfo.auth = playurl.auth;
      pageInfo.playurlData = playurl.data;
      const result = await sendToOffscreen({ type: "START_DOWNLOAD", video: pageInfo });
      if (!result.ok) throw new Error(result.error);
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
          hasCompleteByteCount(video)
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
    case "CACHE_COMPLETE":
    case "CACHE_ERROR":
      await handleCacheEvent(message);
      return { received: true };
    case "CACHE_DELETED":
      broadcastToPopup(message);
      return { received: true };
    case "PLAYBACK_ACTIVE":
      if (sender.tab?.id) {
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
      schemaVersion: 1,
      tabId,
      pageKey: makePopupPageKey(inputUrl),
      pageInfo,
      qualities: [],
      defaultQuality: 0,
      selectedQuality: 0,
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
  const snapshot = {
    schemaVersion: 1,
    tabId,
    pageKey: makePopupPageKey(inputUrl),
    pageInfo,
    qualities,
    defaultQuality,
    selectedQuality,
    auth: playurl.auth,
    savedAt,
    selectionUpdatedAt: Number(selectionSnapshot?.selectionUpdatedAt) || savedAt
  };
  await storePopupSnapshot(snapshot);
  return snapshot;
}

async function savePopupSelection(tabId, inputUrl, requestedQuality) {
  const snapshot = await readPopupSnapshot(tabId, inputUrl);
  if (!snapshot) return false;
  const selectedQuality = choosePopupQuality(snapshot.qualities, requestedQuality);
  if (!selectedQuality || selectedQuality !== normalizeQualityId(requestedQuality)) return false;
  await storePopupSnapshot({
    ...snapshot,
    selectedQuality,
    selectionUpdatedAt: Date.now()
  });
  return true;
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

async function handleCacheEvent(message) {
  const { video } = message;
  if (!video) return;
  const tabId = Number.isInteger(video.tabId) ? video.tabId : undefined;
  try {
    if (tabId !== undefined) {
      if (message.type === "CACHE_COMPLETE") {
        await chrome.action.setBadgeBackgroundColor({ color: "#1682a7", tabId });
        await chrome.action.setBadgeText({ text: "✓", tabId });
        chrome.tabs.sendMessage(tabId, { type: "CACHE_READY", videoId: video.id }).catch(() => {});
      } else if (message.type === "CACHE_ERROR") {
        await chrome.action.setBadgeBackgroundColor({ color: "#8b5b64", tabId });
        await chrome.action.setBadgeText({ text: "!", tabId });
      } else {
        const percent = Math.max(0, Math.min(99, Math.round((video.progress || 0) * 100)));
        await chrome.action.setBadgeBackgroundColor({ color: "#fb7299", tabId });
        await chrome.action.setBadgeText({ text: String(percent), tabId });
      }
    }
  } catch {
    // 原标签页可能已经关闭；缓存任务与弹窗状态仍应继续更新。
  } finally {
    broadcastToPopup(message);
  }
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
    const auth = interrupted.length ? await getBiliSessionState() : null;
    for (const video of interrupted) {
      try {
        const requestedQuality = normalizeQualityId(video.requestedQuality ?? video.quality, AUTO_QUALITY);
        const fnval = video.mediaKind === "dash" ? "4048" : "1";
        const playurl = await requestPlayurl(video, requestedQuality, video.tabId, auth, fnval);
        const result = await sendToOffscreen({
          type: "START_DOWNLOAD",
          video: { ...video, auth: playurl.auth, playurlData: playurl.data }
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
  } catch (error) {
    console.warn("[Bili 缓冲站] 无法恢复上次的缓存任务：", error);
  }
}
