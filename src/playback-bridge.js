(() => {
  "use strict";

  const CHANNEL = "bili-buffer-playback-assist-v1";
  const CONFIG_KEY = "playbackAssistConfigV1";
  const DEFAULT_PREHEAT_COLOR = "#ff8a1f";
  const DEFAULTS = {
    mode: "always",
    slowTtfbMs: 800,
    leadSeconds: 45,
    minWatchedSec: 0,
    minBufferAheadSec: 0,
    maxPrefetchMBPerTrack: 200,
    maxConcurrency: 32,
    cdnMode: "original",
    networkPolicyVersion: 3,
    estimatorGuard: true,
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

  function normalizedConfig(input) {
    const next = { ...DEFAULTS, ...(input || {}) };
    next.mode = ["off", "observe"].includes(next.mode) ? "off" : "always";
    // 2.8.10：CDN 路线与并发上限不再可配置，钉死系统默认；桥直读 storage，
    // 必须在这里挡掉历史存储里的用户选择，否则旧值会在页面侧继续生效。
    next.maxConcurrency = 32;
    next.cdnMode = "original";
    next.networkPolicyVersion = 3;
    next.minWatchedSec = 0;
    next.minBufferAheadSec = 0;
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
    if(message.type==='budgetRpc'){
      const p=message.payload;
      if(!p || !/^[a-zA-Z0-9-]{1,80}$/.test(p.id||'') || !/^[a-zA-Z0-9-]{1,80}$/.test(p.rpcId||'') || !['acquire','release'].includes(p.op))return;
      const started=Date.now();
      // tab/document 身份由 SW 的 sender 推导，页面不得提供其他标签的 owner。
      void chrome.runtime.sendMessage({target:'background',type:'DOWNLOAD_BUDGET',request:{op:p.op,id:p.id,priority:p.priority>0?1:0}}).then(result=>{
        if(result?.lease && Date.now()-started>1800){
          void chrome.runtime.sendMessage({target:'background',type:'DOWNLOAD_BUDGET',request:{op:'release',id:p.id}}).catch(()=>{});
          result={ok:false};
        }
        toPage('budgetReply',{rpcId:p.rpcId,result:result||{ok:false}});
      }).catch(()=>toPage('budgetReply',{rpcId:p.rpcId,result:{ok:false}}));
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
