import {t} from './i18n.js';
/**
 * IndexedDB 日志不是互斥锁：多个更新页的恢复、取消及健康提交必须与写文件共享 Web Lock。
 * 页面被关闭／reload 后浏览器自动释放锁，恢复日志仍留在 IndexedDB，不依赖 SW 常驻。
 * @param {Function} operation @param {{locks?:LockManager}} options @returns {Promise<unknown>}
 */
export async function withUpdateFileLock(operation,{locks=globalThis.navigator?.locks}={}) {
  if(!locks)throw new Error('Web Locks API unavailable');
  return locks.request('haineicunzhi-update-files-v1',{mode:'exclusive',ifAvailable:true},lock=>{
    if(!lock)throw new Error(t('update.otherPage'));
    return operation();
  });
}
