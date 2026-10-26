import { compareVersions, UPDATE_LIMITS } from './github-update-protocol.js';
export const GITHUB_ORIGINS = Object.freeze(['https://api.github.com/*', 'https://github.com/*', 'https://release-assets.githubusercontent.com/*', 'https://objects.githubusercontent.com/*']);
const RELEASE_API = 'https://api.github.com/repos/Kihara-Ri/bilibili-buffer-extension/releases?per_page=20';

/** 在读取过程中限制大小，不能只相信 Content-Length，避免畸形更新占满内存。 @param {Response} response @param {number} limit @returns {Promise<object>} */
export async function readLimitedJson(response, limit = UPDATE_LIMITS.envelope) {
  if (!response.ok) throw new Error(`Update server HTTP ${response.status}`);
  if (Number(response.headers.get('Content-Length')) > limit) throw new Error('Update response exceeds limits');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty update response');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, json = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Update response exceeds limits');
      json += decoder.decode(value, { stream: true });
    }
    json += decoder.decode();
    return JSON.parse(json);
  } finally { await reader.cancel().catch(() => {}); }
}
/** @param {string} currentVersion @param {{fetchImpl?:typeof fetch}} options @returns {Promise<{version:string,url:string}|null>} */
export async function findLatestUpdate(currentVersion, { fetchImpl = fetch } = {}) {
  const releases = await readLimitedJson(await fetchImpl(RELEASE_API, { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000) }), 2 * 1024 * 1024);
  if (!Array.isArray(releases)) throw new Error('Invalid release response');
  const candidates = [];
  for (const release of releases) {
    if (release.draft || release.prerelease || !/^v\d+(\.\d+){1,3}$/.test(release.tag_name || '')) continue;
    const version = release.tag_name.slice(1);
    if (compareVersions(version, currentVersion) <= 0) continue;
    const asset = release.assets?.find(item => item.name === `haineicunzhi-github-${version}.update.json`);
    if (!asset) continue;
    const url = new URL(asset.browser_download_url);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith('/Kihara-Ri/bilibili-buffer-extension/releases/download/') || url.username || url.password) throw new Error('Unexpected update asset source');
    candidates.push({ version, url: url.href });
  }
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0] || null;
}
