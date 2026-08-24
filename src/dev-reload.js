const DEV_RELOAD_ENDPOINT = "http://127.0.0.1:17321/health";
const POLL_INTERVAL = 750;
const PENDING_PAGE_RELOAD_KEY = "devReloadPendingRevisionV2";
const BILI_PAGE_PATTERNS = [
  "https://www.bilibili.com/video/*",
  "https://www.bilibili.com/list/*"
];

let lastRevision = null;
let reloadRequested = false;
let pollInFlight = false;

export function startDevReloadBackground(ensureOffscreenDocument) {
  void reloadPendingBiliPages()
    .finally(() => ensureOffscreenDocument())
    .catch(() => {});
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "dev-reload" || message?.type !== "DEV_RELOAD_EXTENSION") return false;
    void savePendingReload(message.revision)
      .then(() => {
        sendResponse({ ok: true });
        chrome.runtime.reload();
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
}

// Offscreen document 不会像 MV3 Service Worker 那样在空闲时休眠，因此由它持续轮询。
// 重载只替换扩展运行时代码；缓存分块始终留在 IndexedDB 中，由后台自动续传。
export function startDevReloadPolling() {
  void pollRevision();
  setInterval(pollRevision, POLL_INTERVAL);
}

async function pollRevision() {
  if (reloadRequested || pollInFlight) return;
  pollInFlight = true;
  try {
    const response = await fetch(DEV_RELOAD_ENDPOINT, { cache: "no-store" });
    if (!response.ok) return;
    const message = await response.json();
    if (!message.ok || !message.revision) return;
    if (lastRevision === null) {
      lastRevision = message.revision;
      return;
    }
    if (message.revision === lastRevision) return;
    reloadRequested = true;
    // Offscreen 页面只能使用 chrome.runtime，由后台持久化交接标记并执行重载。
    await chrome.runtime.sendMessage({
      target: "dev-reload",
      type: "DEV_RELOAD_EXTENSION",
      revision: message.revision
    });
  } catch {
    reloadRequested = false;
    // 开发服务未启动时保持静默；下次轮询会自动重连。
  } finally {
    pollInFlight = false;
  }
}

async function savePendingReload(revision) {
  // storage.session 可能在 runtime.reload() 时清空；local 才能可靠地把刷新请求交给新后台。
  await chrome.storage.local.set({ [PENDING_PAGE_RELOAD_KEY]: revision || Date.now() });
}

export async function reloadPendingBiliPages() {
  try {
    const stored = await chrome.storage.local.get(PENDING_PAGE_RELOAD_KEY);
    if (!stored?.[PENDING_PAGE_RELOAD_KEY]) return;
    await chrome.storage.local.remove(PENDING_PAGE_RELOAD_KEY);
    const tabs = await chrome.tabs.query({ url: BILI_PAGE_PATTERNS });
    await Promise.allSettled(tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => chrome.tabs.reload(tab.id)));
  } catch {
    // 开发态页面刷新失败不影响扩展本身与已有 IndexedDB 数据。
  }
}
