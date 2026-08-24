const DEV_RELOAD_ENDPOINT = "http://127.0.0.1:17321/health";
const POLL_INTERVAL = 750;
const KEEP_ALIVE_INTERVAL = 20000;

let lastRevision = null;
let reloadRequested = false;

// 重载只替换扩展运行时代码；缓存分块始终留在 IndexedDB 中，由后台自动续传。
export function startDevReload() {
  void pollRevision();
  setInterval(pollRevision, POLL_INTERVAL);
  setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), KEEP_ALIVE_INTERVAL);
}

async function pollRevision() {
  if (reloadRequested) return;
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
    chrome.runtime.reload();
  } catch {
    // 开发服务未启动时保持静默；下次轮询会自动重连。
  }
}
