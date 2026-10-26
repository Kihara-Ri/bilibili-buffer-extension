/** 更新目录句柄、文件恢复快照独立于片库，不能改名或清空片库数据库。 */
const DB_NAME = 'haineicunzhi-updater-v1';
let ready;
function open() {
  if (!ready) ready = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { ready = null; reject(request.error); };
  });
  return ready;
}
/** @param {string} key @returns {Promise<unknown>} */
export async function readUpdateState(key) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('state');
    const request = tx.objectStore('state').get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onabort = () => reject(tx.error);
    request.onerror = () => reject(request.error);
  });
}
/** @param {string} key @param {unknown} value @returns {Promise<void>} */
export async function writeUpdateState(key, value) {
  const db = await open();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('state', 'readwrite');
    if (value === null) tx.objectStore('state').delete(key);
    else tx.objectStore('state').put(value, key);
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
export const updateJournal = { get: () => readUpdateState('journal'), set: value => writeUpdateState('journal', value) };
