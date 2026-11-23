(() => {
  "use strict";

  const CHANNEL = "bili-buffer-playback-assist-v1";
  const CONFIG_KEY = "playbackAssistConfigV1";
  const PRESSURE_HEARTBEAT_MS = 6_000;
  const COMMITTED_READ_MS = 580;
  const DEFAULT_PREHEAT_COLOR = "#ff8a1f";
  const DEFAULTS = {
    mode: "always",
    bufferMode: "adaptive",
    progressColor: "#00a1d6",
    showPreheatHighlight: true,
    preheatColor: DEFAULT_PREHEAT_COLOR
  };
  let config = { ...DEFAULTS };
  let lastStats = null;
  let lastPressure = "idle";
  let lastFullSpeed = false;
  let pressureSentAt = 0;
  let leaving = false;
  let catalogueTimer;
  let catalogueSequence = 0;
  let committedReads = 0;

  const markBridgeReady = () => {
    if (document.documentElement) document.documentElement.dataset.biliBufferAssistBridge = "2.5.0";
  };
  markBridgeReady();
  if (!document.documentElement) document.addEventListener("DOMContentLoaded", markBridgeReady, { once: true });

  function toPage(type, payload, transfer = []) {
    window.postMessage({ channel: CHANNEL, dir: "ext->page", type, payload }, "*", transfer);
  }

  // 桥直读 storage：只转发已知的用户字段，历史存储里的旧网络策略字段不会传到页面。
  function normalizedConfig(input) {
    const next = {};
    for (const key of Object.keys(DEFAULTS)) next[key] = input && Object.hasOwn(input, key) ? input[key] : DEFAULTS[key];
    next.mode = ["off", "observe"].includes(next.mode) ? "off" : "always";
    next.bufferMode = ["complete", "complete-before-play", "full-speed"].includes(next.bufferMode) ? "full-speed" : "adaptive";
    const color = String(next.preheatColor || "").trim().toLowerCase();
    next.preheatColor = /^#[0-9a-f]{6}$/.test(color) ? color : DEFAULT_PREHEAT_COLOR;
    return next;
  }

  async function loadConfig() {
    try {
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      config = normalizedConfig(stored?.[CONFIG_KEY]);
      toPage("config", config);
      void reportPlaybackPressure();
      queueCommittedSources();
    } catch { /* 扩展重载期间忽略。 */ }
  }

  function playbackPressure() {
    let level = "idle";
    for (const video of document.querySelectorAll("video")) {
      // 历史双轨缓存也在页面域里建 MediaSource，需要用内容脚本的本地播放标记识别。
      const local = video.dataset.biliCachePlayback === "local" || video.currentSrc.startsWith("blob:chrome-extension://");
      if (video.paused || video.ended || local) continue;
      const buffered = video.buffered;
      const position = video.currentTime;
      // 开始让行与恢复使用不同阈值，缓冲在边界波动时不反复取消离线请求。
      const threshold = (lastPressure === "urgent" ? 4 : 2) * (video.playbackRate || 1);
      const needed = Math.min(threshold, Number.isFinite(video.duration) ? Math.max(0, video.duration - position) : threshold);
      let ahead = 0;
      for (let index = 0; index < buffered.length; index++) {
        if (buffered.start(index) <= position + 0.1 && buffered.end(index) > position) {
          ahead = buffered.end(index) - position;
          break;
        }
      }
      if (video.seeking || video.readyState < 3 || ahead < needed) return "urgent";
      level = "playing";
    }
    return level;
  }

  async function reportPlaybackPressure(force = false) {
    const level = leaving ? "idle" : playbackPressure();
    const fullSpeed = level === "playing" && config.mode === "always" && config.bufferMode === "full-speed";
    const sampledAt = Date.now();
    if (!force && level === lastPressure && fullSpeed === lastFullSpeed &&
        (level === "idle" || sampledAt - pressureSentAt < PRESSURE_HEARTBEAT_MS)) return;
    lastPressure = level;
    lastFullSpeed = fullSpeed;
    pressureSentAt = sampledAt;
    // 只报播放器状态及低频心跳。网页取分块时继续使用页内队列，无需逐块询问扩展。
    try {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "PLAYBACK_PRESSURE", level, sampledAt, fullSpeed });
    } catch { /* 没有下载文档或扩展刚重载时，下一次状态变化会重新上报。 */ }
  }

  function queueCommittedSources() {
    if (!catalogueTimer) catalogueTimer = setTimeout(() => {
      catalogueTimer = null;
      void refreshCommittedSources();
    }, 130);
  }

  async function refreshCommittedSources() {
    const sequence = ++catalogueSequence;
    const pageUrl = location.href;
    if (config.mode !== "always" || leaving) { toPage("committedSources", { pageUrl, sources: [] }); return; }
    if (document.hidden || !document.documentElement?.dataset.biliBufferQuality) return;
    try {
      const response = await chrome.runtime.sendMessage({ target: "background", type: "GET_COMMITTED_SOURCES", pageUrl });
      if (sequence !== catalogueSequence || pageUrl !== location.href || config.mode !== "always") return;
      toPage("committedSources", { pageUrl, sources: response?.sources || [] });
    } catch {
      // 回包失效时先撤下标记，下一次提交或心跳再读片库。
      if (sequence === catalogueSequence && pageUrl === location.href) toPage("committedSources", { pageUrl, sources: [] });
    }
  }

  async function readCommittedRange(rpcId, request) {
    const start = performance.now();
    const pageUrl = location.href;
    let url;
    let result = null;
    committedReads++;
    try {
      if (config.mode !== "always") return;
      const reply = await chrome.runtime.sendMessage({ target: "background", type: "READ_COMMITTED_SOURCE", pageUrl, request });
      url = reply?.range?.url;
      // 只在隔离世界消费临时 URL。向网页交付的只有范围正文，传输 ArrayBuffer 的所有权免去 Base64。
      if (typeof url !== "string" || !url.startsWith(`blob:chrome-extension://${chrome.runtime.id}/`)) return;
      const remaining = Math.floor(COMMITTED_READ_MS - (performance.now() - start));
      if (remaining <= 0 || pageUrl !== location.href) return;
      const response = await fetch(url, { signal: AbortSignal.timeout(remaining) });
      if (!response.ok) return;
      const body = await response.arrayBuffer();
      if (pageUrl !== location.href || config.mode !== "always" || body.byteLength !== request.end - request.start) return;
      result = { body, total: reply.range.total, contentType: reply.range.contentType };
    } catch {
      // 播放优先，读取失败立即走旧的请求路径。
    } finally {
      committedReads--;
      const release = url && chrome.runtime.sendMessage({ target: "offscreen", type: "RELEASE_COMMITTED_SOURCE", url }).catch(() => {});
      // 预读逐片交还 Offscreen 名额，下一片才开始。前台正文走原来的即时交付。
      if (request.speculative && release) await release;
      toPage("committedReply", { rpcId, result }, result ? [result.body] : []);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.dir !== "page->ext") return;
    if (message.type === "committedRead") {
      const { rpcId, request } = message.payload || {};
      if (typeof rpcId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(rpcId)) return;
      const { id, createdAt, runStartedAt, role, url, start, end, total, speculative } = request || {};
      if (committedReads >= 4 || typeof id !== "string" || id.length > 256 || typeof role !== "string" || role.length > 5 ||
          typeof url !== "string" || url.length > 4096 || ![createdAt, runStartedAt, start, end, total].every(Number.isSafeInteger)) {
        toPage("committedReply", { rpcId, result: null });
      } else void readCommittedRange(rpcId, { id, createdAt, runStartedAt, role, url, start, end, total, speculative: speculative === true });
      return;
    }
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
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "BILI_BUFFER_COMMITTED_CHANGED") {
      queueCommittedSources();
      return false;
    }
    if (message?.type === "BILI_BUFFER_SYNC_PLAYBACK_PRESSURE") {
      void reportPlaybackPressure(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (message?.type === "BILI_BUFFER_GET_ASSIST_STATE") {
      sendResponse({ ok: true, config, stats: lastStats, fullPhase: document.documentElement?.dataset.biliBufferFull });
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
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CONFIG_KEY]) return;
    config = normalizedConfig(changes[CONFIG_KEY].newValue);
    toPage("config", config);
    void reportPlaybackPressure();
    queueCommittedSources();
  });

  void loadConfig();
  setTimeout(loadConfig, 300);
  setTimeout(loadConfig, 1500);
  for (const event of ["play", "playing", "waiting", "seeking", "seeked", "progress", "timeupdate", "pause", "ended", "emptied", "error"]) {
    document.addEventListener(event, (event) => {
      if (event.target instanceof HTMLVideoElement) void reportPlaybackPressure();
    }, true);
  }
  document.addEventListener("bili-buffer-site-quality", queueCommittedSources);
  document.addEventListener("visibilitychange", queueCommittedSources);
  window.navigation?.addEventListener("currententrychange", queueCommittedSources);
  window.addEventListener("pagehide", () => { leaving = true; void reportPlaybackPressure(); queueCommittedSources(); });
  window.addEventListener("pageshow", () => { leaving = false; void reportPlaybackPressure(); queueCommittedSources(); });
  setInterval(() => { void reportPlaybackPressure(); queueCommittedSources(); }, PRESSURE_HEARTBEAT_MS);
})();
