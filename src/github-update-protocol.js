/** GitHub 更新包协议：先验证签名覆盖的原始字节，再解码和校验各文件，绝不执行包内代码。 */
export const UPDATE_LIMITS = Object.freeze({ envelope: 64 * 1024 * 1024, total: 32 * 1024 * 1024, file: 8 * 1024 * 1024, count: 1024 });
const text = new TextDecoder('utf-8', { fatal: true });
const bytes = new TextEncoder();
const TOP_FILES = new Set(['manifest.json', 'popup.html', 'popup.css', 'offscreen.html', 'privacy.html', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'update.html', 'update.css', 'update-public-key.json']);

/** @param {string} input @returns {number[]} */
function versionParts(input) {
  if (typeof input !== 'string' || !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(input)) throw new Error('Invalid version');
  const parts = input.split('.').map(Number);
  if (parts.some(value => value > 65535)) throw new Error('Invalid version');
  return [...parts, ...Array(4 - parts.length).fill(0)];
}
/** @param {string} left @param {string} right @returns {number} */
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  for (let index = 0; index < 4; index++) if (a[index] !== b[index]) return Math.sign(a[index] - b[index]);
  return 0;
}
/** @param {string} value @returns {Uint8Array} */
export function decodeBase64(value) {
  // 大包不能使用嵌套重复分组正则：V8 会在合法的多 MB 输入上耗尽正则执行栈。
  if (typeof value !== 'string' || value.length > UPDATE_LIMITS.envelope || value.length % 4 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error('Invalid base64');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (value.slice(0, value.length-padding).includes('=')) throw new Error('Invalid base64');
  const decoded = atob(value), output = new Uint8Array(decoded.length);
  for (let index=0; index<decoded.length; index++) output[index]=decoded.charCodeAt(index);
  return output;
}
/** @param {ArrayBuffer|Uint8Array} data @returns {Promise<string>} */
export async function sha256(data) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(value => value.toString(16).padStart(2, '0')).join('');
}
/** @param {string} path @returns {string} */
export function validateUpdatePath(path) {
  if (typeof path !== 'string' || path.length > 180 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))) throw new Error('Invalid update path');
  if (!TOP_FILES.has(path) && !/^(src|assets|rules|_locales)\//.test(path)) throw new Error('Unmanaged update path');
  if (/dev-reload|\.map$/.test(path)) throw new Error('Development file in update');
  return path;
}
/**
 * @param {{payload:string,signature:string}} envelope @param {JsonWebKey} publicKey
 * @param {{currentVersion:string,chromeVersion?:string}} options
 * @returns {Promise<{version:string,files:Map<string,Uint8Array>,manifest:object,packageHash:string}>}
 */
export async function verifyUpdateEnvelope(envelope, publicKey, { currentVersion, chromeVersion } = {}) {
  if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256') throw new Error('Update signing key is not configured');
  const payload = decodeBase64(envelope?.payload), signature = decodeBase64(envelope?.signature);
  if (payload.length > UPDATE_LIMITS.total * 1.6 || signature.length !== 64) throw new Error('Update package exceeds limits');
  const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, payload)) throw new Error('Invalid update signature');
  const data = JSON.parse(text.decode(payload));
  if (data.schema !== 1 || data.channel !== 'github' || data.dataCompatibility !== 'backward-compatible' || data.identityPolicy !== 'preserve-install-identity-v1') throw new Error('Unsupported update protocol');
  if (compareVersions(data.version, currentVersion) <= 0) throw new Error('Update must be newer than the installed version');
  if (!Array.isArray(data.files) || !data.files.length || data.files.length > UPDATE_LIMITS.count) throw new Error('Invalid file count');
  const files = new Map(), names = new Set();
  let total = 0;
  for (const entry of data.files) {
    const path = validateUpdatePath(entry.path), name = path.toLowerCase();
    if (names.has(name)) throw new Error('Duplicate update file');
    names.add(name);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > UPDATE_LIMITS.file || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid file metadata');
    const body = decodeBase64(entry.data);
    total += body.length;
    if (total > UPDATE_LIMITS.total || body.length !== entry.size || await sha256(body) !== entry.sha256) throw new Error('Update file checksum mismatch');
    files.set(path, body);
  }
  for (const path of names) for (let at = path.indexOf('/'); at >= 0; at = path.indexOf('/', at + 1)) if (names.has(path.slice(0, at))) throw new Error('Conflicting update paths');
  if (!files.has('manifest.json')) throw new Error('Missing manifest');
  const manifest = JSON.parse(text.decode(files.get('manifest.json')));
  if (manifest.manifest_version !== 3 || manifest.version !== data.version) throw new Error('Manifest version mismatch');
  if (chromeVersion && manifest.minimum_chrome_version && compareVersions(chromeVersion, manifest.minimum_chrome_version) < 0) throw new Error('Chrome upgrade required');
  const referenced = [manifest.background?.service_worker, manifest.action?.default_popup, ...(manifest.content_scripts || []).flatMap(item => [...(item.js || []), ...(item.css || [])]), ...(manifest.declarative_net_request?.rule_resources || []).map(item => item.path)];
  for (const path of referenced.filter(Boolean)) if (!files.has(validateUpdatePath(path))) throw new Error('Missing manifest resource');
  return { version: data.version, files, manifest, packageHash: await sha256(payload) };
}
/**
 * 保留既有安装身份是唯一受限的本地转换：签名验证仍针对原包，读回校验针对转换后的文件。
 * @param {{files:Map<string,Uint8Array>,manifest:object}} verified @param {object} currentManifest
 * @param {string} runtimeId @returns {Map<string,Uint8Array>}
 */
export function prepareUpdateFiles(verified, currentManifest, runtimeId) {
  if (!/^[a-p]{32}$/.test(runtimeId)) throw new Error('Invalid extension identity');
  const next = structuredClone(verified.manifest);
  if (next.background?.service_worker !== currentManifest.background?.service_worker || next.action?.default_popup !== currentManifest.action?.default_popup) throw new Error('Package is for a different extension');
  for (const field of ['permissions', 'host_permissions', 'optional_permissions', 'optional_host_permissions']) {
    const existing = new Set(currentManifest[field] || []);
    if ((next[field] || []).some(permission => !existing.has(permission))) throw new Error('Permission changes require a manual update');
  }
  for (const field of ['externally_connectable', 'update_url']) if (JSON.stringify(next[field]) !== JSON.stringify(currentManifest[field])) throw new Error('External access changes require a manual update');
  const oldMatches = new Set((currentManifest.content_scripts || []).flatMap(item => item.matches || []));
  if ((next.content_scripts || []).some(item => (item.matches || []).some(match => !oldMatches.has(match)))) throw new Error('Site access changes require a manual update');
  if (Object.hasOwn(currentManifest, 'key')) next.key = currentManifest.key;
  else delete next.key;
  const files = new Map(verified.files);
  files.set('manifest.json', bytes.encode(JSON.stringify(next, null, 2) + '\n'));
  const rulesPath = 'rules/cdn-headers.json';
  if (files.has(rulesPath)) {
    const rules = JSON.parse(text.decode(files.get(rulesPath)));
    if (!Array.isArray(rules)) throw new Error('Invalid DNR rules');
    for (const rule of rules) {
      if (!rule.condition || !Array.isArray(rule.condition.initiatorDomains)) throw new Error('Invalid DNR initiators');
      rule.condition.initiatorDomains = [...new Set([...rule.condition.initiatorDomains, runtimeId])].sort();
    }
    files.set(rulesPath, bytes.encode(JSON.stringify(rules, null, 2) + '\n'));
  }
  return files;
}
