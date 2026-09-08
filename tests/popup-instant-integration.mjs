const openedAt = performance.now();
const calls = [];
let readyAt = 0;
let listener;
let snapshotRequestedAt = 0;
let assistConfig = { mode: "always", estimatorGuard: true, preheatColor: "#ff8a1f" };
const libraryVideos = [
  {
    id: "BV1library001:100:q80:cavc",
    pageId: "BV1library001:100",
    bvid: "BV1library001",
    cid: 100,
    status: "complete",
    title: "海外线路测试：已经完整缓存的视频",
    partTitle: "节点切换与预取效果",
    owner: "测试 UP",
    ownerId: 99,
    ownerUrl: "https://space.bilibili.com/99",
    url: "https://www.bilibili.com/video/BV1library001/",
    qualityLabel: "1080P",
    codec: "avc",
    codecLabel: "AVC",
    duration: 186,
    mediaKind: "progressive",
    downloadedBytes: 86 * 1024 * 1024,
    totalBytes: 86 * 1024 * 1024
  },
  {
    id: "BV1library002:200:q112:chevc",
    pageId: "BV1library002:200",
    bvid: "BV1library002",
    cid: 200,
    status: "downloading",
    title: "正在后台续传的长视频",
    partTitle: "第二分段",
    owner: "另一位 UP",
    ownerId: 100,
    ownerUrl: "https://space.bilibili.com/100",
    url: "https://www.bilibili.com/video/BV1library002/?p=2",
    qualityLabel: "1080P+",
    codec: "hevc",
    codecLabel: "HEVC",
    duration: 420,
    mediaKind: "dash",
    progress: 0.64,
    downloadedBytes: 134 * 1024 * 1024,
    totalBytes: 210 * 1024 * 1024
  }
];

const observer = new MutationObserver(() => {
  if (!readyAt && document.querySelector("#button-label").textContent === "缓存") {
    readyAt = performance.now();
  }
});
observer.observe(document.querySelector("#button-label"), { childList: true, characterData: true, subtree: true });

globalThis.chrome = {
  tabs: {
    async query() {
      return [{ id: 7, url: "https://www.bilibili.com/video/BV1Kg8t6NEmN/?t=20" }];
    },
    async create() {}
  },
  runtime: {
    onMessage: { addListener(callback) { listener = callback; } },
    async sendMessage(message) {
      calls.push(message.type);
      if (message.type === "GET_POPUP_SNAPSHOT") {
        snapshotRequestedAt = performance.now();
        return {
          ok: true,
          stale: false,
          snapshot: {
            tabId: 7,
            pageKey: "video:bv:BV1KG8T6NEMN:p1",
            pageInfo: {
              supported: true,
              id: "BV1Kg8t6NEmN:456",
              bvid: "BV1Kg8t6NEmN",
              cid: 456,
              page: 1,
              pageCount: 1,
              title: "已恢复的视频标题",
              partTitle: "",
              owner: "测试 UP",
              ownerId: 99,
              ownerUrl: "https://space.bilibili.com/99",
              duration: 60,
              url: "https://www.bilibili.com/video/BV1Kg8t6NEmN/"
            },
            qualities: [{ quality: 80, label: "1080P", requiresVip: false, requiresLogin: false }],
            codecOptionsByQuality: {
              "80": [
                { codec: "auto", label: "自动（省流）", minBandwidth: 1_600_000 },
                { codec: "avc", label: "AVC", minBandwidth: 1_600_000 }
              ]
            },
            cacheSizeInfo: { duration: 60, video: [], audio: [], progressiveQuality: 80, progressiveBytes: 10485760 },
            defaultQuality: 80,
            selectedQuality: 80,
            defaultCodec: "auto",
            selectedCodec: "avc",
            auth: { viaPageSession: true, vipActive: false },
            savedAt: Date.now()
          }
        };
      }
      if (message.type === "LIST_VIDEOS") {
        await delay(120);
        return { ok: true, videos: libraryVideos };
      }
      if (message.type === "GET_ASSIST_STATE") {
        return {
          ok: true,
          config: assistConfig,
          stats: {
            activeTracks: 2,
            hosts: { "upos-test.bilivideo.com": { ttfbP95: 940 } },
            slowRequests: 3,
            bufferAheadSec: 18.4,
            prefetchMB: 42.7,
            prefetching: 2,
            stalls: 1,
            estimator: { suspect: false }
          }
        };
      }
      if (message.type === "SET_ASSIST_CONFIG") {
        assistConfig = { ...assistConfig, ...message.patch };
        return { ok: true, config: assistConfig };
      }
      if (message.type === "SET_POPUP_SELECTION") return { ok: true, saved: true };
      throw new Error(`未预期的请求：${message.type}`);
    }
  }
};

await import("../src/popup.js");
await delay(180);
observer.disconnect();
const defaultCacheVisible = !document.querySelector("#cache-view").hidden &&
  document.querySelector("#assist-view").hidden &&
  document.querySelector("#library-view").hidden;
document.querySelector("#quality-trigger").click();
const qualityOpened = document.querySelector("#quality-menu").matches(":popover-open");
document.querySelector("#library-tab").click();
const qualityClosedOnViewChange = !document.querySelector("#quality-menu").matches(":popover-open");
const libraryOnlyVisible = document.querySelector("#cache-view").hidden &&
  document.querySelector("#assist-view").hidden &&
  !document.querySelector("#library-view").hidden;
document.querySelector("#library-tab").focus();
document.querySelector("#library-tab").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
const keyboardOpenedAssist = document.querySelector("#assist-tab").getAttribute("aria-selected") === "true" &&
  !document.querySelector("#assist-view").hidden;
document.querySelector("#assist-toggle").click();
await delay(20);
const disabledAssist = document.querySelector("#assist-toggle").getAttribute("aria-checked") === "false";
document.querySelector("#assist-toggle").click();
await delay(20);
document.querySelector("[data-assist-color='#20c997']").click();
await delay(20);
document.querySelector("#cache-tab").click();

const selectedAssistMode = assistConfig.mode;
const assistEnabled = document.querySelector("#assist-toggle").getAttribute("aria-checked") === "true";
const selectedAssistColor = document.querySelector("[data-assist-color][aria-checked='true']")?.dataset.assistColor;

const result = {
  ok: document.querySelector("#cache-size").textContent === "10.0 MB" &&
    document.querySelector("#current-heading").textContent === "已恢复的视频标题" &&
    document.querySelector("#button-label").textContent === "缓存" &&
    !calls.includes("REFRESH_POPUP_DATA") &&
    calls.includes("SET_ASSIST_CONFIG") &&
    disabledAssist &&
    assistEnabled &&
    selectedAssistMode === "always" &&
    selectedAssistColor === "#20c997" &&
    defaultCacheVisible &&
    qualityOpened &&
    qualityClosedOnViewChange &&
    libraryOnlyVisible &&
    keyboardOpenedAssist &&
    document.querySelector("#library-count").textContent === "2",
  moduleLoadMs: Math.round(snapshotRequestedAt - openedAt),
  snapshotToReadyMs: Math.round((readyAt || performance.now()) - snapshotRequestedAt),
  libraryDelayMs: 120,
  calls,
  title: document.querySelector("#current-heading").textContent,
  button: document.querySelector("#button-label").textContent,
  selectedAssistMode,
  assistEnabled,
  selectedAssistColor,
  hierarchy: {
    defaultCacheVisible,
    qualityOpened,
    qualityClosedOnViewChange,
    libraryOnlyVisible,
    keyboardOpenedAssist,
    libraryCount: document.querySelector("#library-count").textContent
  },
  listenerInstalled: typeof listener === "function"
};
document.querySelector("#result").textContent = JSON.stringify(result, null, 2);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
