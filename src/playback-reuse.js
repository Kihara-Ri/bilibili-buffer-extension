// MAIN world：记录「本次会话 playurl 已授权的精确媒体地址」，并把离线已下载的原始范围取回给播放器。
// 只认识 URL 与总量，不接触 chrome.*；字节经 ISOLATED 桥转发，未授权或异常一律返回未命中。
(() => {
  'use strict';
  const CHANNEL = 'bili-buffer-playback-assist-v1';
  // 单次复用请求上限：既限制消息大小，也限制页面内存里额外复制的一份正文。
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_URLS = 256;
  const TIMEOUT_MS = 1500;
  const PAUSE_AFTER_FAILURES = 3;
  const PAUSE_MS = 60_000;
  const MEDIA_HOST = /(^|\.)(bilivideo\.com|bilivideo\.cn|hdslb\.com|akamaized\.net)$/;
  const URL_KEYS = /^(baseUrl|base_url|backupUrl|backup_url)$/;
  // 能力探测：缺少 base64 或消息通道时整体降级，绝不因为一个缺失的浏览器 API 打断播放。
  const CAPABLE = typeof atob === 'function' && typeof btoa === 'function' && typeof window.postMessage === 'function';
  let idSeed = 0;
  const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `r${Date.now().toString(36)}-${(idSeed += 1).toString(36)}`);
  const authorized = new Map();
  const sizeHints = new Map();

  function isMediaUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && value.length <= 2048 && !url.username && !url.password && MEDIA_HOST.test(url.hostname);
    } catch { return false; }
  }

  function remember(url) {
    if (authorized.has(url)) return 0;
    // 只保留最近授权的有限条数：长会话也不能让地址表无界增长。
    if (authorized.size >= MAX_URLS) authorized.delete(authorized.keys().next().value);
    authorized.set(url, Date.now());
    return 1;
  }

  /** 从 playurl 响应里收集本会话已授权的媒体地址与站点声明的文件大小。
   * @param {object} payload @returns {number} 本次新增的地址数
   */
  function notePlayurl(payload) {
    if (!payload || typeof payload !== 'object') return 0;
    const seen = new Set();
    let added = 0, visited = 0;
    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 6 || visited > 4000 || seen.has(node)) return;
      seen.add(node); visited += 1;
      for (const [key, value] of Object.entries(node)) {
        if (typeof value === 'string') {
          if (URL_KEYS.test(key) && isMediaUrl(value)) added += remember(value);
        } else if (Array.isArray(value)) {
          // 备用地址是数组；它本身也是同一媒体的授权地址，必须一起记住。
          for (const item of value.slice(0, 32)) {
            if (typeof item === 'string') { if (URL_KEYS.test(key) && isMediaUrl(item)) added += remember(item); }
            else walk(item, depth + 1);
          }
        } else walk(value, depth + 1);
      }
      // 站点有时直接给出字节数；只有真的用得上时才作为总量提示，匹配不上仍会回退网络。
      if (Number.isSafeInteger(node.size) && node.size > 0) {
        for (const key of Object.keys(node)) {
          const value = node[key];
          if (typeof value === 'string' && URL_KEYS.test(key) && isMediaUrl(value)) sizeHints.set(value, node.size);
        }
      }
    };
    walk(payload, 0);
    return added;
  }

  /** 该地址是否在本次会话被 playurl 授权过。 @param {string} url @returns {boolean} */
  const isAuthorized = (url) => authorized.has(url);
  /** 站点声明的文件总长（可能为 0）。 @param {string} url @returns {number} */
  const totalHint = (url) => sizeHints.get(url) || 0;

  /** 页面侧读取器：单在途、有超时、连续失败后暂停，任何异常都退化为「未命中」。
   * @returns {{read: Function}} */
  function createReuseClient() {
    const pending = new Map();
    const unavailable = { read: async () => null };
    if (!CAPABLE) return unavailable;
    let inFlight = 0, failures = 0, pausedUntil = 0;
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (event.source !== window || message?.channel !== CHANNEL || message.dir !== 'ext->page' || message.type !== 'reuseReply') return;
      const item = pending.get(message.payload?.rpcId);
      if (!item) return;
      pending.delete(message.payload.rpcId);
      clearTimeout(item.timer);
      item.resolve(message.payload.result || {});
    });
    const decode = (body) => { try { return Uint8Array.from(atob(body), (char) => char.charCodeAt(0)); } catch { return null; } };
    return {
      /** @param {{url:string,start:number,end:number,total:number}} request @returns {Promise<{body:Uint8Array,total:number,contentType:string}|null>} */
      async read(request) {
        const { url, start, end, total } = request || {};
        if (!isAuthorized(url)) return null;
        if (![start, end, total].every(Number.isSafeInteger) || total <= 0 || end <= start || end > total) return null;
        if (end - start > MAX_BYTES) return null;
        if (Date.now() < pausedUntil || inFlight >= 1) return null;
        const rpcId = newId();
        inFlight += 1;
        let result = null;
        try {
          result = await new Promise((resolve) => {
            const timer = setTimeout(() => { pending.delete(rpcId); resolve(null); }, TIMEOUT_MS);
            pending.set(rpcId, { resolve, timer });
            window.postMessage({ channel: CHANNEL, dir: 'page->ext', type: 'reuseRead', payload: { rpcId, url, start, end, total } }, '*');
          });
        } finally { inFlight -= 1; }
        // 超时或桥不可用算失败：连续失败要暂停，避免每个请求都白等一次。
        if (!result) {
          failures += 1;
          if (failures >= PAUSE_AFTER_FAILURES) pausedUntil = Date.now() + PAUSE_MS;
          return null;
        }
        failures = 0;
        const body = result.hit && typeof result.body === 'string' ? decode(result.body) : null;
        if (!body || result.start !== start || result.end !== end || result.total !== total || body.length !== end - start) return null;
        return { body, total, contentType: typeof result.contentType === 'string' ? result.contentType : 'application/octet-stream' };
      }
    };
  }

  globalThis.BiliPlaybackReuse = {
    notePlayurl, isAuthorized, totalHint, createReuseClient, MAX_BYTES,
    authorizedCount: () => authorized.size
  };
})();
