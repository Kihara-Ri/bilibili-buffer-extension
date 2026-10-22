(() => {
  "use strict";

  const CHANNEL = "bili-buffer-playback-assist-v1";
  const CONFIG_KEY = "playbackAssistConfigV1";
  const DEFAULT_PREHEAT_COLOR = "#ff8a1f";
  const DEFAULTS = {
    mode: "always",
    estimatorGuard: true,
    progressColor: "#00a1d6",
    showPreheatHighlight: true,
    preheatColor: DEFAULT_PREHEAT_COLOR
  };
  let config = { ...DEFAULTS };
  let lastStats = null;
  let lastCommandResult = null;

  const markBridgeReady = () => {
    if (document.documentElement) document.documentElement.dataset.biliBufferAssistBridge = "2.5.0";
  };
  markBridgeReady();
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", markBridgeReady, { once: true });

  function toPage(type, payload) {
    window.postMessage({ channel: CHANNEL, dir: "ext->page", type, payload }, "*");
  }

  // 桥直读 storage：只转发已知的用户字段，历史存储里的旧网络策略字段不会传到页面。
  function normalizedConfig(input) {
    const next = {};
    for (const key of Object.keys(DEFAULTS)) next[key] = input && Object.hasOwn(input, key) ? input[key] : DEFAULTS[key];
    next.mode = ["off", "observe"].includes(next.mode) ? "off" : "always";
    const color = String(next.preheatColor || "").trim().toLowerCase();
    next.preheatColor = /^#[0-9a-f]{6}$/.test(color) ? color : DEFAULT_PREHEAT_COLOR;
    return next;
  }

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      config = normalizedConfig(stored?.[CONFIG_KEY]);
      toPage("config", config);
    } catch { /* 扩展重载期间忽略。 */ }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.dir !== "page->ext") return;
    if(message.type==='reuseRead'){
      const p=message.payload;
      // 页面只能请求播放器自己正在用的范围；请求参数在这里再次收敛，不信任页面输入。
      if(!p || !/^[a-zA-Z0-9-]{1,80}$/.test(p.rpcId||'') || typeof p.url!=='string' || ![p.start,p.end,p.total].every(Number.isSafeInteger))return;
      const started=Date.now();
      void chrome.runtime.sendMessage({target:'background',type:'SOURCE_RANGE',request:{op:'read',url:p.url,start:p.start,end:p.end,total:p.total}}).then(result=>{
        // 页面已超时的迟到回包直接丢弃，避免把过期字节写进缓存。
        toPage('reuseReply',{rpcId:p.rpcId,result:Date.now()-started>1400?{}:result||{}});
      }).catch(()=>toPage('reuseReply',{rpcId:p.rpcId,result:{}}));
      return;
    }
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
      config = normalizedConfig({ ...config, ...patch });
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
    config = normalizedConfig(changes[CONFIG_KEY].newValue);
    toPage("config", config);
  });

  void loadConfig();
  setTimeout(loadConfig, 300);
  setTimeout(loadConfig, 1500);
})();
