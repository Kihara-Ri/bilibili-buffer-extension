const openedAt = performance.now();
const calls = [];
let readyAt = 0;
let listener;
let snapshotRequestedAt = 0;

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
            defaultQuality: 80,
            selectedQuality: 80,
            defaultCodec: "auto",
            selectedCodec: "auto",
            auth: { viaPageSession: true, vipActive: false },
            savedAt: Date.now()
          }
        };
      }
      if (message.type === "LIST_VIDEOS") {
        await delay(120);
        return { ok: true, videos: [] };
      }
      if (message.type === "GET_ASSIST_STATE") {
        return { ok: true, config: { mode: "auto", estimatorGuard: true }, stats: null };
      }
      if (message.type === "SET_ASSIST_CONFIG") {
        return { ok: true, config: { mode: message.patch.mode, estimatorGuard: true } };
      }
      if (message.type === "SET_POPUP_SELECTION") return { ok: true, saved: true };
      throw new Error(`未预期的请求：${message.type}`);
    }
  }
};

await import("../src/popup.js");
await delay(180);
observer.disconnect();
document.querySelector("[data-assist-mode='always']").click();
await delay(20);

const selectedAssistMode = document.querySelector("[data-assist-mode][aria-checked='true']")?.dataset.assistMode;

const result = {
  ok: document.querySelector("#current-heading").textContent === "已恢复的视频标题" &&
    document.querySelector("#button-label").textContent === "缓存" &&
    !calls.includes("REFRESH_POPUP_DATA") &&
    calls.includes("SET_ASSIST_CONFIG") &&
    selectedAssistMode === "always",
  moduleLoadMs: Math.round(snapshotRequestedAt - openedAt),
  snapshotToReadyMs: Math.round((readyAt || performance.now()) - snapshotRequestedAt),
  libraryDelayMs: 120,
  calls,
  title: document.querySelector("#current-heading").textContent,
  button: document.querySelector("#button-label").textContent,
  selectedAssistMode,
  listenerInstalled: typeof listener === "function"
};
document.querySelector("#result").textContent = JSON.stringify(result, null, 2);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
