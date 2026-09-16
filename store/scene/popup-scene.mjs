// 商店截图用的界面场景。
//
// 为什么不直接加载真实扩展：真实弹窗依赖当前标签页是 B 站视频页、且需要登录会话，
// 无法在无人值守的截图脚本里稳定复现。这里复用真实的 popup.html / popup.css / popup.js，
// 只把 chrome.* 接口换成本文件里的固定数据，因此截出来的界面与用户实际看到的一致，
// 差别只在演示数据的文案。
//
// 这个文件不参与发布包，也不会被 tests/*.test.mjs 收集。

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CURRENT_VIDEO = {
  supported: true,
  id: "BV1xx411c7mD:778899",
  bvid: "BV1xx411c7mD",
  cid: 778899,
  page: 1,
  pageCount: 1,
  title: "夜航｜官方现场版 MV（4K 修复）",
  partTitle: "",
  owner: "示例音乐站",
  ownerId: 10086,
  ownerUrl: "https://space.bilibili.com/10086",
  duration: 312,
  url: "https://www.bilibili.com/video/BV1xx411c7mD/"
};

const QUALITIES = [
  { quality: 120, label: "4K", requiresVip: true, requiresLogin: true },
  { quality: 116, label: "1080P60", requiresVip: false, requiresLogin: true },
  { quality: 80, label: "1080P", requiresVip: false, requiresLogin: false },
  { quality: 64, label: "720P", requiresVip: false, requiresLogin: false }
];

const CACHE_SIZE_INFO = {
  duration: 312,
  video: [
    { quality: 120, mimeType: "video/mp4", codecs: "av01.0.12M.08", bandwidth: 8_200_000 },
    { quality: 116, mimeType: "video/mp4", codecs: "avc1.640033", bandwidth: 4_100_000 },
    { quality: 80, mimeType: "video/mp4", codecs: "avc1.640032", bandwidth: 2_300_000 }
  ],
  audio: [
    { id: 30280, mimeType: "audio/mp4", codecs: "mp4a.40.2", bandwidth: 192_000, hasSource: true },
    { id: 30251, mimeType: "audio/mp4", codecs: "fLaC", bandwidth: 1_411_000, hasSource: true }
  ],
  progressiveQuality: 80,
  progressiveBytes: 96_000_000,
  declared: [
    { quality: 120, label: "4K", requiresVip: true, requiresLogin: true },
    { quality: 116, label: "1080P60", requiresVip: false, requiresLogin: true },
    { quality: 112, label: "1080P+", requiresVip: true, requiresLogin: false },
    { quality: 80, label: "1080P", requiresVip: false, requiresLogin: false },
    { quality: 64, label: "720P", requiresVip: false, requiresLogin: false }
  ]
};

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;
const LIBRARY = [
  {
    id: "BV1xx411c7mD:778899:q120:cav1",
    pageId: "BV1xx411c7mD:778899",
    bvid: "BV1xx411c7mD",
    cid: 778899,
    status: "complete",
    title: "夜航｜官方现场版 MV（4K 修复）",
    owner: "示例音乐站",
    url: "https://www.bilibili.com/video/BV1xx411c7mD/",
    qualityLabel: "4K",
    codec: "av1",
    codecLabel: "AV1",
    duration: 312,
    mediaKind: "dash",
    cacheMode: "video",
    merged: { totalBytes: 402 * MiB, downloadedBytes: 402 * MiB, chunkCount: 201, mimeType: "video/mp4" },
    tracks: {
      video: { codecs: "av01.0.12M.08", downloadedBytes: 0, resumeBytes: 0, totalBytes: 0, chunkCount: 0 },
      audio: { codecs: "mp4a.40.2", downloadedBytes: 0, resumeBytes: 0, totalBytes: 0, chunkCount: 0 }
    },
    downloadedBytes: 402 * MiB,
    totalBytes: 402 * MiB
  },
  {
    id: "BV1Ab4y1z7Kq:334455:a",
    pageId: "BV1Ab4y1z7Kq:334455",
    bvid: "BV1Ab4y1z7Kq",
    cid: 334455,
    status: "downloading",
    title: "城市夜行 Vol.7｜整场录音",
    partTitle: "P2 返场",
    owner: "示例音乐站",
    ownerId: 10086,
    ownerUrl: "https://space.bilibili.com/10086",
    url: "https://www.bilibili.com/video/BV1Ab4y1z7Kq/?p=2",
    qualityLabel: "Hi-Res 无损",
    audioLabel: "Hi-Res 无损",
    audioId: 30251,
    duration: 3720,
    mediaKind: "audio",
    cacheMode: "audio",
    progress: 0.68,
    committedBytes: 742 * MiB,
    downloadedBytes: 754 * MiB,
    totalBytes: 1.1 * GiB,
    speed: 5.4 * MiB,
    tracks: { audio: { representationId: 30251, codecs: "fLaC", mimeType: "audio/mp4", downloadedBytes: 754 * MiB, totalBytes: 1.1 * GiB, chunkCount: 377 } }
  },
  {
    id: "BV1cP4y1k7Tz:556677:q80:cavc",
    pageId: "BV1cP4y1k7Tz:556677",
    bvid: "BV1cP4y1k7Tz",
    cid: 556677,
    status: "complete",
    title: "从零实现一个分块下载器（上）",
    owner: "示例技术频道",
    url: "https://www.bilibili.com/video/BV1cP4y1k7Tz/",
    qualityLabel: "1080P",
    codec: "avc",
    codecLabel: "AVC",
    duration: 1_540,
    mediaKind: "dash",
    cacheMode: "video",
    merged: { totalBytes: 268 * MiB, downloadedBytes: 268 * MiB, chunkCount: 134, mimeType: "video/mp4" },
    tracks: {
      video: { codecs: "avc1.640032", downloadedBytes: 0, resumeBytes: 0, totalBytes: 0, chunkCount: 0 },
      audio: { codecs: "mp4a.40.2", downloadedBytes: 0, resumeBytes: 0, totalBytes: 0, chunkCount: 0 }
    },
    downloadedBytes: 268 * MiB,
    totalBytes: 268 * MiB
  },
  {
    id: "BV1dQ4y1w7Rm:990011:q64:cavc",
    pageId: "BV1dQ4y1w7Rm:990011",
    bvid: "BV1dQ4y1w7Rm",
    cid: 990011,
    status: "paused",
    title: "纪录片：季风与海岸线",
    owner: "示例纪录片频道",
    url: "https://www.bilibili.com/video/BV1dQ4y1w7Rm/",
    qualityLabel: "720P",
    codec: "avc",
    codecLabel: "AVC",
    duration: 2_760,
    mediaKind: "dash",
    cacheMode: "video",
    progress: 0.23,
    committedBytes: 61 * MiB,
    downloadedBytes: 63 * MiB,
    totalBytes: 272 * MiB,
    tracks: {
      video: { codecs: "avc1.64001F", downloadedBytes: 51 * MiB, totalBytes: 232 * MiB, chunkCount: 25 },
      audio: { codecs: "mp4a.40.2", downloadedBytes: 12 * MiB, totalBytes: 40 * MiB, chunkCount: 5 }
    }
  }
];

const ASSIST_CONFIG = { mode: "always", estimatorGuard: true, preheatColor: "#ff8a1f", progressColor: "#00a1d6", showPreheatHighlight: true };
const ASSIST_STATS = {
  activeTracks: 2,
  hosts: { "upos-sz-mirror08c.bilivideo.com": { ttfbP95: 412 } },
  slowRequests: 0,
  bufferAheadSec: 46.2,
  prefetchMB: 138.4,
  prefetching: 3,
  stalls: 0,
  estimator: { suspect: false }
};

let listener = () => {};
let library = structuredClone(LIBRARY);
let assistConfig = { ...ASSIST_CONFIG };
let cacheMode = "video";

globalThis.chrome = {
  tabs: {
    async query() {
      return [{ id: 1, url: CURRENT_VIDEO.url }];
    },
    async create() {}
  },
  runtime: {
    onMessage: { addListener(callback) { listener = callback; } },
    async sendMessage(message) {
      switch (message.type) {
        case "GET_POPUP_SNAPSHOT":
          return {
            ok: true,
            stale: false,
            snapshot: {
              tabId: 1,
              pageKey: "video:bv:BV1XX411C7MD:p1",
              pageInfo: CURRENT_VIDEO,
              qualities: QUALITIES,
              cacheSizeInfo: CACHE_SIZE_INFO,
              defaultQuality: 120,
              selectedQuality: 120,
              defaultCodec: "auto",
              selectedCodec: "auto",
              auth: { viaPageSession: true, vipActive: true },
              savedAt: Date.now()
            }
          };
        case "LIST_VIDEOS":
          return { ok: true, videos: structuredClone(library) };
        case "GET_ASSIST_STATE":
          return { ok: true, config: assistConfig, stats: ASSIST_STATS };
        case "SET_ASSIST_CONFIG":
          assistConfig = { ...assistConfig, ...message.patch };
          return { ok: true, config: assistConfig };
        case "SET_CACHE_MODE":
          cacheMode = message.mode;
          return { ok: true, mode: cacheMode };
        case "GET_CACHE_MODE":
          return { ok: true, mode: cacheMode };
        case "SET_POPUP_SELECTION":
          return { ok: true, saved: true };
        case "REFRESH_POPUP_DATA":
          return { ok: true, pageInfo: CURRENT_VIDEO, qualities: QUALITIES, cacheSizeInfo: CACHE_SIZE_INFO, auth: { viaPageSession: true, vipActive: true } };
        case "START_CACHE":
          return { ok: true, video: { ...library[1], status: "downloading" } };
        case "SAVE_VIDEO":
        case "DELETE_VIDEO":
          return { ok: true };
        default:
          throw new Error(`场景夹具未实现的请求：${message.type}`);
      }
    }
  }
};

// 与真实扩展一样，先把 popup.html 的节点搬进文档，再执行 popup.js。
const response = await fetch("../../popup.html");
const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
for (const node of [...parsed.body.children]) {
  if (node.tagName === "SCRIPT") continue;
  const element = document.importNode(node, true);
  for (const asset of element.querySelectorAll?.("[src], [href]") || []) {
    for (const attribute of ["src", "href"]) {
      const value = asset.getAttribute(attribute);
      if (value && !/^(https?:|\.\.\/|#|data:)/.test(value)) asset.setAttribute(attribute, "../../" + value);
    }
  }
  document.body.append(element);
}
await import("../../src/popup.js");
await delay(400);

// 场景切换入口，供 scripts/store-assets.mjs 调用。
globalThis.__storeScene = {
  async showTab(view) {
    document.querySelector(`[data-panel-view="${view}"]`).click();
    await delay(260);
  },
  async setCacheMode(mode) {
    document.querySelector(`[data-cache-mode="${mode}"]`).click();
    await delay(160);
  },
  ready: true
};
document.querySelector("#scene-result").textContent = "ready";
