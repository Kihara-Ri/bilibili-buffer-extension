import { sha256, validateUpdatePath } from './github-update-protocol.js';
import { t } from './i18n.js';

/** @param {FileSystemDirectoryHandle} directory @returns {{read:Function,write:Function,remove:Function}} */
export function directoryIO(directory) {
  async function parent(path, create) {
    const parts = validateUpdatePath(path).split('/'), name = parts.pop();
    let folder = directory;
    for (const part of parts) folder = await folder.getDirectoryHandle(part, { create });
    return { folder, name };
  }
  return {
    async read(path) {
      try { const { folder, name } = await parent(path, false); return new Uint8Array(await (await (await folder.getFileHandle(name)).getFile()).arrayBuffer()); }
      catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
    },
    async write(path, data) {
      const { folder, name } = await parent(path, true);
      const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
      try { await writable.write(data); await writable.close(); }
      catch (error) { await writable.abort().catch(() => {}); throw error; }
    },
    async remove(path) {
      try { const { folder, name } = await parent(path, false); await folder.removeEntry(name); }
      catch (error) { if (error.name !== 'NotFoundError') throw error; }
    }
  };
}

/** 错误码与界面语言分开，查找时只跳过明确的不匹配，不能吞掉权限或设备故障。 @param {string} key @returns {Error & {code:string}} */
function directoryError(key) { return Object.assign(new Error(t(key)), {code:key}); }

/** 只读预检，查找目录时不得先向所有文件夹写探针。 @param {FileSystemDirectoryHandle} directory @param {{manifest:object}} options @returns {Promise<object>} */
export async function inspectInstallDirectory(directory, { manifest }) {
  let repository = false;
  try { await directory.getDirectoryHandle('.git'); repository = true; }
  catch (error) {
    // worktree 的 .git 是文件；TypeMismatch 同样说明选中了受版本控制的源码目录。
    if (error.name === 'TypeMismatchError') repository = true;
    else if (error.name !== 'NotFoundError') throw error;
  }
  if (repository) throw directoryError('update.directoryRepository');
  let text;
  try { text = await (await (await directory.getFileHandle('manifest.json')).getFile()).text(); }
  catch (error) {
    // 空目录／数据目录要指出缺少的安装文件；权限和设备故障仍保留原始错误。
    if (error.name === 'NotFoundError' || error.name === 'TypeMismatchError') throw directoryError('update.directoryMissingManifest');
    throw error;
  }
  let local;
  try { local = JSON.parse(text); }
  catch { throw directoryError('update.directoryInvalidManifest'); }
  if (!local || typeof local !== 'object' || Array.isArray(local)) throw directoryError('update.directoryInvalidManifest');
  if (local.version !== manifest.version || local.background?.service_worker !== manifest.background?.service_worker) throw directoryError('update.directoryWrongInstallation');
  return local;
}

/** 随机探针必须由当前扩展读回，防止把下载副本当作安装目录。 @param {FileSystemDirectoryHandle} directory @param {{manifest:object,readResource:Function}} options @returns {Promise<void>} */
export async function bindInstallDirectory(directory, { manifest, readResource }) {
  await inspectInstallDirectory(directory, {manifest});
  const nonce = crypto.randomUUID(), path = `.haineicunzhi-update-${nonce}.json`;
  try {
    const writable = await (await directory.getFileHandle(path, { create: true })).createWritable();
    try { await writable.write(nonce); await writable.close(); }
    catch (error) { await writable.abort?.().catch(() => {}); throw error; }
    let actual;
    try { actual = await readResource(path); }
    catch (cause) { throw Object.assign(directoryError('update.directoryWrongInstallation'), {cause}); }
    if (actual !== nonce) throw directoryError('update.directoryWrongInstallation');
  } finally { await directory.removeEntry(path).catch(() => {}); }
}

/**
 * 多文件写入不具备整体原子性。先把所有旧字节持久化，再写文件，manifest 最后提交。
 * @param {Map<string,Uint8Array>} files @param {object} io @param {object} journal
 * @param {{fromVersion:string,toVersion:string,packageHash?:string,onProgress?:Function}} options @returns {Promise<void>}
 */
export async function applyUpdate(files, io, journal, { fromVersion, toVersion, packageHash = '', onProgress = () => {} }) {
  const previous = await journal.get();
  if (previous && previous.stage !== 'complete') throw new Error('An unfinished update must be recovered first');
  const paths = [...files.keys()].sort((a, b) => a === 'manifest.json' ? 1 : b === 'manifest.json' ? -1 : a.localeCompare(b));
  if (!paths.includes('manifest.json')) throw new Error('Missing update manifest');
  const backups = [];
  for (const path of paths) { validateUpdatePath(path); backups.push({ path, data: await io.read(path) }); }
  const state = { stage: 'writing', fromVersion, toVersion, packageHash, backups, createdAt: Date.now() };
  // set 失败（如配额不足）时不进入写入；旧版本不受影响。
  await journal.set(state);
  try {
    for (const [index, path] of paths.entries()) {
      const data = files.get(path);
      await io.write(path, data);
      const actual = await io.read(path);
      if (!actual || await sha256(actual) !== await sha256(data)) throw new Error(`Readback mismatch: ${path}`);
      onProgress(index + 1, paths.length);
    }
    await journal.set({ ...state, stage: 'awaiting-reload' });
  } catch (error) {
    try { await rollbackUpdate(io, journal); }
    catch (recoveryError) { throw new AggregateError([error, recoveryError], 'Update failed; recovery is still required'); }
    throw error;
  }
}

/** @param {object} io @param {object} journal @returns {Promise<void>} */
export async function rollbackUpdate(io, journal) {
  const state = await journal.get();
  if (!Array.isArray(state?.backups)) throw new Error('No recovery snapshot');
  // 恢复同样最后写 manifest；错误时保留日志，下一次可继续，不丢掉唯一恢复副本。
  const backups = [...state.backups].sort((a, b) => a.path === 'manifest.json' ? 1 : b.path === 'manifest.json' ? -1 : a.path.localeCompare(b.path));
  for (const { path, data } of backups) {
    validateUpdatePath(path);
    if (data === null) await io.remove(path);
    else {
      await io.write(path, data);
      const actual = await io.read(path);
      if (!actual || await sha256(actual) !== await sha256(data)) throw new Error(`Recovery readback mismatch: ${path}`);
    }
  }
  await journal.set(null);
}
