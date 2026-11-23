import { normalizeCacheMode, normalizeQualityId, parseBiliVideoUrl } from "./utils.js";
import { readMcpAccountStatus, readMcpBrowserJson } from "./mcp-browser-requests.js";

export const MCP_NATIVE_HOST = "cn.kihara.haineicunzhi";
export const MCP_BRIDGE_PROTOCOL = 1;
const ENABLED = "mcpNativeBridgeEnabled";
const RETRY = "mcp-native-bridge-reconnect";
const identifier = /^[a-f\d-]{36}$/i;
const cacheIdentifier = /^(?:BV[a-z\d]+|av\d+):\d+(?::[a-z\d_-]+)*$/i;

const taskFields = ["id", "pageId", "createdAt", "status", "mediaKind", "cacheMode", "stage", "mergeStage", "quality", "qualityLabel", "audioLabel",
  "codec", "codecLabel", "progress", "cachedBytes", "committedBytes", "downloadedBytes", "resumeBytes", "totalBytes"];

function videoState(video) {
  if (!video) return null;
  return {
    ...Object.fromEntries(taskFields.filter(key => Object.hasOwn(video, key)).map(key => [key, video[key]])),
    ...(video.merged ? { merged: { totalBytes: video.merged.totalBytes, downloadedBytes: video.merged.downloadedBytes } } : {}),
    ...(video.tracks?.audio ? { tracks: { audio: { codecs: video.tracks.audio.codecs } } } : {})
  };
}

function mediaUrl(value) {
  const url = new URL(value);
  if (url.origin !== "https://www.bilibili.com" || url.username || url.password || !parseBiliVideoUrl(url.href).supported) {
    throw new Error("Unsupported video address");
  }
  return url.href;
}

/** @param {typeof chrome} api @param {Function} handle 扩展后台已有消息实现 @param {Function} exportCache 受保护的缓存导出 */
export function createMcpNativeBridge(api, handle, exportCache) {
  let port, connecting, connected = false;
  let retry = false;
  let enabled = false;
  const sessions = new Map();

  async function closeOwnedTab(tabId, requestedUrl) {
    const tab = await api.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    const expected = parseBiliVideoUrl(requestedUrl), current = parseBiliVideoUrl(tab.url);
    // 用户可以在普通 Chrome 接管这个标签。跳去别处后就由用户继续使用。
    if (tab.pendingUrl === requestedUrl || (current.supported && current.bvid === expected.bvid && current.aid === expected.aid && current.page === expected.page)) {
      await api.tabs.remove(tabId).catch(() => {});
    }
  }

  const disposeSession = async session => {
    session.closed = true;
    const tabs = [...session.tabs];
    session.tabs.clear();
    for (const group of session.exports.values()) await disposeExport(group);
    await Promise.allSettled(tabs.map(([id, url]) => closeOwnedTab(id, url)));
  };

  async function disposeExport(group) {
    group.closed = true;
    await Promise.allSettled(group.files.map(async ({ id }) => {
      const item = (await api.downloads.search({ id }))[0];
      if (item?.state === "in_progress") await api.downloads.cancel(id);
      // 只处理这个会话自己启动的下载，已由 MCP 移出的文件不受影响。
      if (item?.state === "complete" && ownedDownload(item.filename, group.key)) await api.downloads.removeFile(id).catch(() => {});
      await api.downloads.erase({ id });
    }));
  }

  async function run(session, method, args = {}) {
    const requireTab = () => {
      if (!session.tabs.has(args.tabId) || (args.url && session.tabs.get(args.tabId) !== mediaUrl(args.url))) throw new Error("Video tab is outside this MCP session");
      return args.tabId;
    };
    const checkVideo = () => {
      if (!cacheIdentifier.test(args.videoId || "")) throw new Error("Invalid cache identity");
      return args.videoId;
    };
    switch (method) {
      case "account": return readMcpAccountStatus();
      case "readJson": return readMcpBrowserJson(args.address, args.kind);
      case "openVideo": {
        const url = mediaUrl(args.url);
        const tab = await api.tabs.create({ active: false, url });
        if (session.closed) { await api.tabs.remove(tab.id).catch(() => {}); throw new Error("MCP session closed"); }
        session.tabs.set(tab.id, url);
        // tabs.create 可在首个导航提交之前返回。等目标页就绪后再尝试借用页面的取源消息。
        const deadline = Date.now() + 18_000;
        for (;;) {
          const current = await api.tabs.get(tab.id);
          if (current.url?.startsWith("https://www.bilibili.com/") && (current.status === "complete" || Date.now() >= deadline)) return { tabId: tab.id };
          if (Date.now() >= deadline) throw new Error("Bilibili page did not open");
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      case "closeVideo": {
        const tabId = requireTab();
        const url = session.tabs.get(tabId);
        session.tabs.delete(tabId);
        await closeOwnedTab(tabId, url);
        return {};
      }
      case "GET_PAGE_INFO": return handle({ type: method, url: mediaUrl(args.url), includeParts: true });
      case "REFRESH_POPUP_DATA": return handle({ type: method, url: mediaUrl(args.url), tabId: requireTab() });
      case "START_CACHE": {
        if (!cacheIdentifier.test(args.expectedPageId || "")) throw new Error("Missing planned part identity");
        const result = await handle({ type: method, url: mediaUrl(args.url), tabId: requireTab(),
          mode: normalizeCacheMode(args.mode), quality: normalizeQualityId(args.quality), expectedPageId: args.expectedPageId });
        return { video: videoState(result.video), pageChanged: result.pageChanged };
      }
      case "GET_VIDEO":
      case "PAUSE_CACHE":
      case "RESUME_CACHE": {
        const videoId = checkVideo();
        const tabId = method === "RESUME_CACHE" ? requireTab() : undefined;
        const result = await handle({ type: method, videoId, tabId, createdAt: Number.isFinite(args.createdAt) ? args.createdAt : undefined });
        return { video: videoState(result.video) };
      }
      case "exportStart": {
        if (!identifier.test(args.key || "") || session.exports.has(args.key)) throw new Error("Invalid export identity");
        return exportCache(checkVideo(), async (plan, download) => {
          if (session.closed) throw new Error("MCP session closed");
          const group = { key: args.key, files: [], splitTracks: plan.splitTracks };
          session.exports.set(group.key, group);
          try {
            for (const item of plan.items) {
              const id = await download({ url: item.url, filename: `Haineicunzhi-MCP/${group.key}/${item.filename}`,
                saveAs: false, conflictAction: "uniquify" });
              group.files.push({ id, name: item.filename });
              if (group.closed) throw new Error("MCP export ended");
            }
          } catch (error) {
            await disposeExport(group);
            session.exports.delete(group.key);
            throw error;
          }
          return {};
        });
      }
      case "exportStatus": {
        const group = session.exports.get(args.key);
        if (!group) throw new Error("MCP export not found");
        const items = await Promise.all(group.files.map(async file => {
          const item = (await api.downloads.search({ id: file.id }))[0];
          if (!item || item.state === "interrupted") throw new Error("Chrome download interrupted");
          if (item.state !== "complete") return null;
          if (!ownedDownload(item.filename, group.key)) throw new Error("Chrome download has a different destination");
          return { name: file.name, path: item.filename, bytes: item.totalBytes };
        }));
        return items.every(Boolean) ? { files: items, splitTracks: group.splitTracks } : {};
      }
      case "exportDispose": {
        const group = session.exports.get(args.key);
        if (group) { session.exports.delete(args.key); await disposeExport(group); }
        return {};
      }
      default: throw new Error("Unsupported MCP request");
    }
  }

  function disconnect() {
    const current = port;
    port = null;
    connected = false;
    current?.disconnect();
    for (const session of sessions.values()) void disposeSession(session);
    sessions.clear();
  }

  async function onRequest(current, message) {
    if (current !== port) return;
    if (message?.type === "ready" && message.protocol === MCP_BRIDGE_PROTOCOL) {
      connected = true;
      await api.alarms.clear(RETRY);
      return;
    }
    if (!connected || message?.type !== "request" || !identifier.test(message.session) || !identifier.test(message.id)) return;
    try {
      let session = sessions.get(message.session);
      if (message.method === "close") {
        if (session) { sessions.delete(message.session); await disposeSession(session); }
        if (current === port) current.postMessage({ type: "result", id: message.id, value: {} });
        return;
      }
      if (!session) {
        session = { tabs: new Map(), exports: new Map() };
        sessions.set(message.session, session);
      }
      const value = await run(session, message.method, message.args);
      if (current === port) current.postMessage({ type: "result", id: message.id, value });
    } catch {
      if (current === port) current.postMessage({ type: "result", id: message.id, error: "Chrome 无法完成扩展请求，请重试。" });
    }
  }

  async function connect() {
    enabled = (await api.storage.local.get(ENABLED))[ENABLED] === true;
    if (!enabled || !await api.permissions?.contains({ permissions: ["nativeMessaging"] })) {
      disconnect();
      await api.alarms?.clear(RETRY);
      return;
    }
    if (port) return;
    // 连不上或 Chrome 重启后，由闹钟重新唤醒。启用意愿保存在资料里，端口仅表示当下连接。
    await api.alarms.create(RETRY, { periodInMinutes: 1 });
    if (!enabled) return;
    try {
      const current = api.runtime.connectNative(MCP_NATIVE_HOST);
      port = current;
      current.onDisconnect.addListener(() => {
        void api.runtime.lastError;
        if (port !== current) return;
        disconnect();
        if (enabled) void api.alarms.create(RETRY, { periodInMinutes: 1 }).catch(() => {});
      });
      current.onMessage.addListener(message => { void onRequest(current, message).catch(() => {}); });
      current.postMessage({ type: "hello", protocol: MCP_BRIDGE_PROTOCOL });
    } catch { disconnect(); }
  }

  function restore() {
    if (connecting) { retry = true; return connecting; }
    connecting = connect().finally(() => {
      connecting = null;
      if (retry) { retry = false; void restore().catch(() => {}); }
    });
    return connecting;
  }

  api.alarms?.onAlarm?.addListener(alarm => { if (alarm.name === RETRY) void restore().catch(() => {}); });
  api.runtime.onStartup?.addListener(() => { void restore().catch(() => {}); });
  api.storage.onChanged?.addListener((changes, area) => { if (area === "local" && changes[ENABLED]) void restore().catch(() => {}); });
  api.permissions?.onRemoved?.addListener(({ permissions }) => { if (permissions?.includes("nativeMessaging")) void restore().catch(() => {}); });
  void restore().catch(() => {});

  return {
    status: () => ({ enabled, connected }),
    async set(value) {
      await api.storage.local.set({ [ENABLED]: value === true });
      if (value !== true) { enabled = false; disconnect(); }
      await restore();
      return { enabled, connected };
    }
  };
}

function ownedDownload(filename, key) {
  const parts = String(filename || "").split(/[\\/]/);
  return parts.at(-3) === "Haineicunzhi-MCP" && parts.at(-2) === key && Boolean(parts.at(-1));
}
