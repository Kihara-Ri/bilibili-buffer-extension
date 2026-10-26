import {toReleaseManifest} from './release-checks.mjs';
import {GITHUB_ORIGINS} from '../../src/github-update-network.js';
export const STORE_UPDATE_STUB = `export function createRuntimeUpdater(){return {assertUnlocked:async()=>{},isLocked:async()=>false,withSave:fn=>fn(),handle:async()=>null,startup:async()=>{}};}\n`;
/** 商店构建物理剔除更新引擎，避免仅隐藏按钮却仍把远程更新能力打包。 @param {Map} files @param {'store'|'github'} channel @returns {Map} */
export function prepareDistribution(files, channel) {
  if (!['store','github'].includes(channel)) throw new Error('Unknown distribution');
  const source = JSON.parse(files.get('manifest.json'));
  const manifest = toReleaseManifest(source);
  delete manifest.optional_host_permissions;
  if (channel === 'github') { manifest.key = source.key; manifest.optional_host_permissions = [...GITHUB_ORIGINS]; }
  else {
    for (const name of files.keys()) if (/^src\/github-updat/.test(name) || ['update.html','update.css','update-public-key.json'].includes(name)) files.delete(name);
    files.set('src/update-runtime.js', Buffer.from(STORE_UPDATE_STUB));
  }
  files.set('src/distribution.js', Buffer.from(`export const DISTRIBUTION = '${channel}';\nexport const BUILD_VERSION = '${manifest.version}';\nexport const GITHUB_RELEASES = 'https://github.com/Kihara-Ri/bilibili-buffer-extension/releases';\n`));
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
  return files;
}
