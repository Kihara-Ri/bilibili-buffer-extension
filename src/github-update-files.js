import { sha256, validateUpdatePath } from './github-update-protocol.js';

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

/**
 * 选择另一份同名扩展不能当成选中了当前运行目录；写入一次性文件，由当前扩展读取验证。
 * @param {FileSystemDirectoryHandle} directory
 * @param {{manifest:object,readResource:(path:string)=>Promise<string>}} options @returns {Promise<void>}
 */
export async function bindInstallDirectory(directory, { manifest, readResource }) {
  try { await directory.getDirectoryHandle('.git'); throw new Error('Choose an unpacked release folder, not a development repository'); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
  const local = JSON.parse(await (await (await directory.getFileHandle('manifest.json')).getFile()).text());
  if (local.version !== manifest.version || local.background?.service_worker !== manifest.background?.service_worker) throw new Error('The selected folder does not match this installation');
  const nonce = crypto.randomUUID(), path = `.haineicunzhi-update-${nonce}.json`;
  try {
    const writable = await (await directory.getFileHandle(path, { create: true })).createWritable();
    try { await writable.write(nonce); await writable.close(); }
    catch (error) { await writable.abort?.().catch(() => {}); throw error; }
    if (await readResource(path) !== nonce) throw new Error('The selected folder is not the running extension');
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
