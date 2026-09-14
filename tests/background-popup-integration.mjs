import { deleteVideoData, putVideo } from "../src/db.js";

let messageListener;
let cookieChangeListener;
let viewRequests = 0;
let playurlRequests = 0;
let extensionPlayurlRequests = 0;
let offscreenCreates = 0;
let playurlDelayMs = 0;
let pageAvailable = true;
let alarmListener;
const alarms = new Map();
const sessionStorage = {};
const badgeText = new Map();
const badgeHistory = [];
const localStorage = {};

globalThis.chrome = {
  runtime: {
    onMessage: { addListener(listener) { messageListener = listener; } },
    async getPlatformInfo() { return {}; },
    reload() {},
    getURL(path) { return `chrome-extension://test/${path}`; },
    async getContexts() { return []; },
    async sendMessage() { return { ok: true }; }
  },
  cookies: {
    async get() { return { value: "not-exposed" }; },
    onChanged: { addListener(listener) { cookieChangeListener = listener; } }
  },
  storage: {
    local: {
      async get(key) { return { [key]: structuredClone(localStorage[key]) }; },
      async set(values) { Object.assign(localStorage, structuredClone(values)); }
    },
    session: {
      async get(key) { return { [key]: structuredClone(sessionStorage[key]) }; },
      async set(values) { Object.assign(sessionStorage, structuredClone(values)); }
    }
  },
  tabs: {
    async sendMessage(_tabId, message) {
      if (message.type === "BILI_BUFFER_GET_ASSIST_STATE") {
        return { ok: true, stats: { requests: 3, slowRequests: 1 } };
      }
      if (message.type !== "BILI_BUFFER_FETCH_PLAYURL") throw new Error("未知页面消息");
      if (!pageAvailable) throw new Error("页面已关闭");
      playurlRequests += 1;
      if (playurlDelayMs) await delay(playurlDelayMs);
      return { ok: true, payload: makePlayurlPayload() };
    }
  },
  offscreen: {
    async createDocument() { offscreenCreates += 1; }
  },
  alarms: {
    onAlarm: { addListener(listener) { alarmListener = listener; } },
    async create(name, options) { alarms.set(name, options); },
    async clear(name) { return alarms.delete(name); }
  },
  action: {
    async setBadgeBackgroundColor() {},
    async setBadgeText({ text, tabId }) { badgeText.set(tabId, text); badgeHistory.push({ text, tabId }); },
    async setTitle() {}
  },
  downloads: { async download() { return 1; } }
};

const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === "http://127.0.0.1:17321/health") {
    return new Response(JSON.stringify({ ok: false }), { status: 200 });
  }
  if (url.includes("/x/web-interface/view")) {
    viewRequests += 1;
    return new Response(JSON.stringify(makeViewPayload()), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  if (url.includes("/x/player/playurl")) {
    extensionPlayurlRequests += 1;
    return new Response(JSON.stringify(makePlayurlPayload()), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
  return nativeFetch(input, init);
};

await import("../src/background.js");
await waitFor(() => typeof messageListener === "function");

const url = "https://www.bilibili.com/video/BV1Kg8t6NEmN/?spm_id_from=test&t=10";
try {
  const first = await send({ type: "REFRESH_POPUP_DATA", tabId: 7, url });
  assert(first.ok && first.snapshot?.selectedQuality === 112, "首次合并解析失败");
  assert(first.snapshot?.selectedCodec === "auto", "默认编码应为自动省流");
  assert(viewRequests === 1 && playurlRequests === 1, "首次打开应只请求一次视频信息和一次播放清单");

  const reopened = await send({
    type: "GET_POPUP_SNAPSHOT",
    tabId: 7,
    url: "https://www.bilibili.com/video/BV1Kg8t6NEmN/?vd_source=changed&t=99"
  });
  assert(reopened.ok && reopened.snapshot && !reopened.stale, "重新打开没有命中会话快照");
  assert(viewRequests === 1 && playurlRequests === 1, "快照命中后不应重复请求 B 站接口");

  const selection = await send({ type: "SET_POPUP_SELECTION", tabId: 7, url, quality: 80, codec: "av1" });
  assert(selection.ok && selection.saved, "画质选择没有保存");
  const selected = await send({ type: "GET_POPUP_SNAPSHOT", tabId: 7, url });
  assert(selected.snapshot?.selectedQuality === 80, "重新打开没有恢复用户画质");
  assert(selected.snapshot?.selectedCodec === "av1", "重新打开没有恢复用户编码");

  const assist = await send({ type: "GET_ASSIST_STATE", tabId: 7 });
  assert(assist.ok && assist.config.mode === "always" && assist.stats.slowRequests === 1, "播放辅助状态桥接失败");

  const assistColor = await send({
    type: "SET_ASSIST_CONFIG",
    patch: { preheatColor: "#20C997" }
  });
  assert(assistColor.ok && assistColor.config.preheatColor === "#20c997", "高亮颜色没有规范化保存");
  const restoredAssistColor = await send({ type: "GET_ASSIST_STATE", tabId: 7 });
  assert(restoredAssistColor.config.preheatColor === "#20c997", "重新读取时没有恢复高亮颜色");

  const library = await send({ type: "LIST_VIDEOS" });
  assert(library.ok && Array.isArray(library.videos), "片库直接读取失败");
  assert(offscreenCreates === 0, "仅读片库不应创建 Offscreen Document");

  // 自动播放只认能顶替播放器的缓存：仅音频记录必须被排除，合并后的单文件必须保留。
  const audioOnlyId = "BV1Kg8t6NEmN:456:a";
  const mergedId = "BV1Kg8t6NEmN:456:q112:chevc";
  await putVideo({
    id: audioOnlyId,
    pageId: "BV1Kg8t6NEmN:456",
    bvid: "BV1Kg8t6NEmN",
    cid: 456,
    status: "complete",
    mediaKind: "audio",
    cacheMode: "audio",
    qualityLabel: "Hi-Res 无损",
    duration: 60,
    downloadedBytes: 10,
    totalBytes: 10,
    updatedAt: Date.now(),
    tracks: { audio: { representationId: 30251, codecs: "fLaC", mimeType: "audio/mp4", downloadedBytes: 10, resumeBytes: 10, totalBytes: 10, chunkCount: 1 } }
  });
  const audioOnlyLookup = await send({ type: "GET_CACHED_FOR_URL", url });
  assert(audioOnlyLookup.ok && audioOnlyLookup.video === null, "仅音频缓存不应顶替网页播放器");
  await putVideo({
    id: mergedId,
    pageId: "BV1Kg8t6NEmN:456",
    bvid: "BV1Kg8t6NEmN",
    cid: 456,
    status: "complete",
    mediaKind: "dash",
    cacheMode: "video",
    quality: 112,
    qualityLabel: "1080P+",
    duration: 60,
    downloadedBytes: 100,
    totalBytes: 100,
    updatedAt: Date.now(),
    merged: { totalBytes: 100, downloadedBytes: 100, chunkCount: 1, mimeType: "video/mp4" },
    tracks: { video: { codecs: "hev1.1.6.L120.90" }, audio: { codecs: "mp4a.40.2" } }
  });
  const mergedLookup = await send({ type: "GET_CACHED_FOR_URL", url });
  assert(mergedLookup.ok && mergedLookup.video?.id === mergedId, "合并后的单文件缓存应能顶替网页播放器");
  await deleteVideoData(audioOnlyId).catch(() => {});
  await deleteVideoData(mergedId).catch(() => {});

  const otherVideo = await send({
    type: "GET_POPUP_SNAPSHOT",
    tabId: 7,
    url: "https://www.bilibili.com/video/BV1Wt421T7oz/"
  });
  assert(otherVideo.snapshot === null, "切换视频后不得显示上一个视频的快照");

  cookieChangeListener({ cookie: { name: "SESSDATA", domain: ".bilibili.com" } });
  await delay(20);
  const invalidated = await send({ type: "GET_POPUP_SNAPSHOT", tabId: 7, url });
  assert(invalidated.snapshot && invalidated.stale, "登录 Cookie 变化后应保留首屏并标记静默刷新");

  playurlDelayMs = 40;
  const refreshing = send({ type: "REFRESH_POPUP_DATA", tabId: 7, url });
  await delay(8);
  await send({ type: "SET_POPUP_SELECTION", tabId: 7, url, quality: 112 });
  await refreshing;
  const selectionAfterRefresh = await send({ type: "GET_POPUP_SNAPSHOT", tabId: 7, url });
  assert(selectionAfterRefresh.snapshot?.selectedQuality === 112, "静默刷新不得覆盖用户刚选择的画质");

  pageAvailable = false;
  const refreshedAfterClose = await send({
    type: "REFRESH_DOWNLOAD_SOURCE",
    video: {
      bvid: "BV1Kg8t6NEmN",
      cid: 456,
      tabId: 7,
      requestedQuality: 112,
      mediaKind: "dash"
    }
  });
  assert(refreshedAfterClose.ok && refreshedAfterClose.playurlData?.dash, "关闭原页后未能从扩展后台刷新播放地址");
  assert(extensionPlayurlRequests === 1, "关页续传应使用扩展源播放接口");
  assert(typeof alarmListener === "function", "下载看门狗没有注册");

  const taskA = { id: 'badge-a', tabId: 70, status: 'downloading', createdAt: 1, updatedAt: 100, downloadedBytes: 20, resumeBytes: 20, totalBytes: 100, progress: .2 };
  const taskB = { ...taskA, id: 'badge-b', createdAt: 2, downloadedBytes: 80, resumeBytes: 80, progress: .8 };
  await putVideo(taskA); await putVideo(taskB);
  const startBadge = badgeHistory.length;
  await Promise.all([send({ type: 'CACHE_PROGRESS', video: taskA }), send({ type: 'CACHE_PROGRESS', video: taskB })]);
  assert(badgeHistory.slice(startBadge).filter(item => item.tabId === 70).every(item => item.text === '2↓'), '两个任务不能交替写入各自百分比');
  await putVideo({ ...taskB, status: 'complete', updatedAt: 101 });
  await send({ type: 'CACHE_COMPLETE', video: { ...taskB, status: 'complete', updatedAt: 101 } });
  assert(badgeText.get(70) === '20', '另一个任务仍下载时不能显示全体完成');
  await deleteVideoData(taskA.id); await send({ type: 'CACHE_DELETED', videoId: taskA.id, tabId: 70 });
  assert(badgeText.get(70) === '✓', '删除最后活动任务后应重算完成状态');
  await deleteVideoData(taskB.id); await send({ type: 'CACHE_DELETED', videoId: taskB.id, tabId: 70 });
  assert(badgeText.get(70) === '', '删除所有任务后应清空徽标');
  show({
    ok: true,
    multiTaskBadge: true,
    firstOpen: { viewRequests: 1, playurlRequests: 1 },
    repeatedOpen: { additionalViewRequests: 0, additionalPlayurlRequests: 0 },
    selectedQuality: selected.snapshot.selectedQuality,
    selectionDuringRefresh: selectionAfterRefresh.snapshot.selectedQuality,
    preheatColor: restoredAssistColor.config.preheatColor,
    offscreenCreatesForLibrary: offscreenCreates,
    cookieChangeKeepsStaleSnapshot: invalidated.stale,
    closedPageRefreshRequests: extensionPlayurlRequests,
    audioOnlyExcludedFromPlayback: audioOnlyLookup.video === null,
    mergedCacheAcceptedForPlayback: mergedLookup.video?.id === mergedId
  });
} catch (error) {
  show({ ok: false, error: error.stack || error.message });
}

function send(message) {
  return new Promise((resolve) => {
    messageListener({ target: "background", ...message }, {}, resolve);
  });
}

function makeViewPayload() {
  return {
    code: 0,
    data: {
      bvid: "BV1Kg8t6NEmN",
      aid: 123,
      cid: 456,
      title: "Popup 快照测试",
      duration: 60,
      pic: "",
      owner: { mid: 99, name: "测试 UP" },
      pages: [{ cid: 456, page: 1, part: "Popup 快照测试", duration: 60 }]
    }
  };
}

function makePlayurlPayload() {
  return {
    code: 0,
    __fromBiliPage: true,
    data: {
      quality: 112,
      vip_status: 1,
      accept_quality: [112, 80],
      accept_description: ["1080P+", "1080P"],
      support_formats: [
        { quality: 112, display_desc: "1080P+", need_vip: true },
        { quality: 80, display_desc: "1080P" }
      ],
      dash: {
        video: [
          { id: 112, mimeType: "video/mp4", codecs: "avc1.640032" },
          { id: 80, mimeType: "video/mp4", codecs: "av01.0.08M.08", bandwidth: 1_500_000 },
          { id: 80, mimeType: "video/mp4", codecs: "avc1.640028", bandwidth: 3_000_000 }
        ]
      }
    }
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function show(value) {
  document.querySelector("#result").textContent = JSON.stringify(value, null, 2);
}

async function waitFor(check, timeout = 2000) {
  const startedAt = performance.now();
  while (performance.now() - startedAt < timeout) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error("等待背景消息监听器超时");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
