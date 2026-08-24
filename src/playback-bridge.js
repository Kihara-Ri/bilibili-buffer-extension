(() => {
  "use strict";

  const CHANNEL = "bili-buffer-playback-assist-v1";
  const CONFIG_KEY = "playbackAssistConfigV1";
  const DEFAULTS = {
    mode: "auto",
    slowTtfbMs: 800,
    leadSeconds: 45,
    minWatchedSec: 20,
    minBufferAheadSec: 10,
    maxPrefetchMBPerTrack: 200,
    maxConcurrency: 4,
    estimatorGuard: true
  };
  let config = { ...DEFAULTS };
  let lastStats = null;
  let lastCommandResult = null;

  const markBridgeReady = () => {
    if (document.documentElement) document.documentElement.dataset.biliBufferAssistBridge = "2.1.1";
  };
  markBridgeReady();
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", markBridgeReady, { once: true });

  function toPage(type, payload) {
    window.postMessage({ channel: CHANNEL, dir: "ext->page", type, payload }, "*");
  }

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      config = { ...DEFAULTS, ...(stored?.[CONFIG_KEY] || {}) };
      toPage("config", config);
    } catch { /* 扩展重载期间忽略。 */ }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.dir !== "page->ext") return;
    if (message.type === "stats" && message.payload && typeof message.payload === "object") {
      lastStats = message.payload;
    } else if (message.type === "commandResult") {
      lastCommandResult = { ...message.payload, at: Date.now() };
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "BILI_BUFFER_GET_ASSIST_STATE") {
      sendResponse({ ok: true, config, stats: lastStats, commandResult: lastCommandResult });
      return false;
    }
    if (message?.type === "BILI_BUFFER_SET_ASSIST_CONFIG") {
      const patch = message.patch && typeof message.patch === "object" ? message.patch : {};
      config = { ...config, ...patch };
      chrome.storage.local.set({ [CONFIG_KEY]: config })
        .then(() => {
          toPage("config", config);
          sendResponse({ ok: true, config });
        })
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === "BILI_BUFFER_ASSIST_COMMAND") {
      toPage("command", { name: message.name });
      sendResponse({ ok: true, sent: true });
      return false;
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CONFIG_KEY]) return;
    config = { ...DEFAULTS, ...(changes[CONFIG_KEY].newValue || {}) };
    toPage("config", config);
  });

  void loadConfig();
  setTimeout(loadConfig, 300);
  setTimeout(loadConfig, 1500);
})();
