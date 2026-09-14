const openedAt = performance.now();
const calls = [];
let readyAt = 0;
let listener;
let snapshotRequestedAt = 0;
let assistConfig = { mode: "always", estimatorGuard: true, preheatColor: "#ff8a1f" };
let cacheMode = "video";
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
  },
  {
    id: "BV1library003:300:a",
    pageId: "BV1library003:300",
    bvid: "BV1library003",
    cid: 300,
    status: "complete",
    title: "只缓存音频的视频",
    owner: "测试 UP",
    url: "https://www.bilibili.com/video/BV1library003/",
    mediaKind: "audio",
    cacheMode: "audio",
    qualityLabel: "Hi-Res 无损",
    audioLabel: "Hi-Res 无损",
    audioId: 30251,
    duration: 210,
    downloadedBytes: 12 * 1024 * 1024,
    totalBytes: 12 * 1024 * 1024,
    tracks: { audio: { representationId: 30251, codecs: "fLaC", mimeType: "audio/mp4" } }
  },
  {
    id: "BV1library004:400:q120:cav1",
    pageId: "BV1library004:400",
    bvid: "BV1library004",
    cid: 400,
    status: "complete",
    title: "已经合并成单文件的视频",
    owner: "测试 UP",
    url: "https://www.bilibili.com/video/BV1library004/",
    mediaKind: "dash",
    cacheMode: "video",
    qualityLabel: "4K",
    codec: "av1",
    codecLabel: "AV1",
    duration: 300,
    merged: { totalBytes: 300 * 1024 * 1024, downloadedBytes: 300 * 1024 * 1024, chunkCount: 75, mimeType: "video/mp4" },
    tracks: {
      video: { codecs: "av01.0.08M.08", downloadedBytes: 0, resumeBytes: 0, totalBytes: 0, chunkCount: 0 },
      audio: { codecs: "mp4a.40.2", downloadedBytes: 0, resumeBytes: 0, totalBytes: 0, chunkCount: 0 }
    },
    downloadedBytes: 300 * 1024 * 1024,
    totalBytes: 300 * 1024 * 1024
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
            cacheSizeInfo: {
              duration: 60,
              video: [],
              audio: [
                { id: 30280, mimeType: "audio/mp4", codecs: "mp4a.40.2", bandwidth: 128000, hasSource: true },
                { id: 30251, mimeType: "audio/mp4", codecs: "fLaC", bandwidth: 1411000, hasSource: true }
              ],
              progressiveQuality: 80,
              progressiveBytes: 10485760,
              declared: [
                { quality: 112, label: "1080P+", requiresVip: true, requiresLogin: false },
                { quality: 80, label: "1080P", requiresVip: false, requiresLogin: false }
              ]
            },
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
      if (message.type === "GET_CACHE_MODE") return { ok: true, mode: cacheMode };
      if (message.type === "SET_CACHE_MODE") {
        cacheMode = message.mode;
        return { ok: true, mode: cacheMode };
      }
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

// 缓存内容选择：默认视频 + 音频，切到仅音频后显示音频估算并保存偏好。
const defaultModeChecked = document.querySelector("[data-cache-mode='video']").getAttribute("aria-checked") === "true";
document.querySelector("[data-cache-mode='audio']").click();
await delay(40);
const audioModeChecked = document.querySelector("[data-cache-mode='audio']").getAttribute("aria-checked") === "true";
const audioModeSaved = cacheMode === "audio" && calls.includes("SET_CACHE_MODE");
const audioSizeText = document.querySelector("#cache-size").textContent;
const qualityHiddenInAudioMode = document.querySelector("#quality-row").hidden === true;
document.querySelector("[data-cache-mode='video']").click();
await delay(40);
const videoSizeText = document.querySelector("#cache-size").textContent;
const videoModeRestored = cacheMode === "video" && document.querySelector("[data-cache-mode='video']").getAttribute("aria-checked") === "true";

const colorInput = document.querySelector("#assist-progress-color");
colorInput.value = "#2f80ed";
colorInput.dispatchEvent(new Event("change", { bubbles: true }));
await delay(20);
document.querySelector("#assist-show-highlight").click();
await delay(20);
const appearanceSaved = assistConfig.progressColor === "#2f80ed" && assistConfig.showPreheatHighlight === false;
const selectedAssistMode = assistConfig.mode;
const assistEnabled = document.querySelector("#assist-toggle").getAttribute("aria-checked") === "true";
const selectedAssistColor = document.querySelector("[data-assist-color][aria-checked='true']")?.dataset.assistColor;

// 画质阶梯：B 站声明但与当前账号返回不一致时，界面要说明差在哪一档。
const ladderNote = document.querySelector("#auth-note").textContent;
const ladderTitle = document.querySelector("#quality-trigger").title;
const ladder = {
  note: ladderNote,
  title: ladderTitle,
  shown: ladderNote.includes("1 档未返回")
    && ladderTitle.includes("B 站声明可用：1080P+（大会员） / 1080P")
    && ladderTitle.includes("未返回：1080P+（大会员）")
};

// 片库标签：仅音频缓存显示音轨说明，合并缓存保存按钮指向单个 MP4。
const libraryTexts = [...document.querySelectorAll(".video-item")].map((item) => item.textContent);
const audioOnlyRow = libraryTexts.find((text) => text.includes("只缓存音频的视频")) || "";
const mergedRow = libraryTexts.find((text) => text.includes("已经合并成单文件的视频")) || "";
const mergedSaveTitle = [...document.querySelectorAll(".video-item")]
  .find((item) => item.textContent.includes("已经合并成单文件的视频"))
  ?.querySelector(".save-button")?.title || "";
const audioSaveTitle = [...document.querySelectorAll(".video-item")]
  .find((item) => item.textContent.includes("只缓存音频的视频"))
  ?.querySelector(".save-button")?.title || "";
const libraryLabels = {
  audioOnlyRow: audioOnlyRow.replace(/\s+/g, " ").trim(),
  audioRowLabeled: audioOnlyRow.includes("仅音频") && audioOnlyRow.includes("Hi-Res 无损"),
  mergedRowLabeled: mergedRow.includes("4K") && mergedRow.includes("AV1"),
  mergedSaveTitle,
  saveTitleMerged: mergedSaveTitle.includes("单个 MP4"),
  audioSaveTitle,
  audioSaveDescribed: audioSaveTitle.includes("MP4 容器") && audioSaveTitle.includes("FLAC 无损")
};

const result = {
  ok: videoSizeText === "10.0 MB" &&
    libraryLabels.audioRowLabeled &&
    libraryLabels.mergedRowLabeled &&
    libraryLabels.saveTitleMerged &&
    libraryLabels.audioSaveDescribed &&
    ladder.shown &&
    defaultModeChecked &&
    audioModeChecked &&
    audioModeSaved &&
    qualityHiddenInAudioMode &&
    audioSizeText === "约 10.1 MB · Hi-Res 无损" &&
    videoModeRestored &&
    document.querySelector("#current-heading").textContent === "已恢复的视频标题" &&
    document.querySelector("#button-label").textContent === "缓存" &&
    !calls.includes("REFRESH_POPUP_DATA") &&
    calls.includes("SET_ASSIST_CONFIG") &&
    appearanceSaved &&
    disabledAssist &&
    assistEnabled &&
    selectedAssistMode === "always" &&
    selectedAssistColor === "#20c997" &&
    defaultCacheVisible &&
    qualityOpened &&
    qualityClosedOnViewChange &&
    libraryOnlyVisible &&
    keyboardOpenedAssist &&
    document.querySelector("#library-count").textContent === "4",
  moduleLoadMs: Math.round(snapshotRequestedAt - openedAt),
  snapshotToReadyMs: Math.round((readyAt || performance.now()) - snapshotRequestedAt),
  libraryDelayMs: 120,
  cacheModeUi: { defaultModeChecked, audioModeChecked, audioModeSaved, audioSizeText, qualityHiddenInAudioMode, videoSizeText, videoModeRestored },
  libraryLabels,
  ladder,
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
