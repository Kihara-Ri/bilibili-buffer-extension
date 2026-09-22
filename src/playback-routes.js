(() => {
  'use strict';
  // 节点候选参考 Bilibili-thread-ripper 的 CDN 路由表（见 THIRD_PARTY_NOTICES.md）。
  // 这里只替换已知媒体 CDN 的主机，不修改路径、签名、清晰度或账号权限。
  const mainland = ['upos-sz-mirrorali.bilivideo.com', 'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorbos.bilivideo.com', 'upos-sz-mirror08c.bilivideo.com',
    'upos-sz-mirrorbd.bilivideo.com', 'upos-sz-mirror14b.bilivideo.com',
    'upos-sz-estgoss.bilivideo.com', 'upos-sz-mirrorcos.bilivideo.com'];
  const allowed = /(^|\.)(bilivideo\.(com|cn)|hdslb\.com|akamaized\.net)$/i;
  /** @param {string} value @returns {string|null} 仅接受现有权限内的 HTTPS 媒体地址。 */
  function mediaUrl(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && allowed.test(u.hostname) && /\.(m4s|mp4)$/i.test(u.pathname) && !u.username && !u.password ? u.href : null; } catch { return null; }
  }
  /** @param {string[]} originals @param {'mainland'|'auto'|'original'} mode @returns {string[]} */
  function candidates(originals, mode = 'mainland') {
    const clean = [...new Set(originals.map(mediaUrl).filter(Boolean))];
    if (mode === 'original') return clean;
    // 普通 UPOS 地址优先；仅有 Akamai 时保留其签名尝试，节点拒绝会按地址隔离并回退。
    const donors = clean.filter(u => !new URL(u).hostname.endsWith('.akamaized.net'));
    const synthetic = mainland.flatMap(host => (donors.length ? donors.slice(0, 2) : clean.slice(0, 2)).map(raw => {
      const u = new URL(raw); u.hostname = host; u.port = ''; return u.href;
    }));
    return [...new Set(mode === 'mainland' ? [...synthetic, ...clean] : [...clean, ...synthetic])];
  }
  globalThis.BiliPlaybackRoutes = { candidates, mediaUrl };
})();
