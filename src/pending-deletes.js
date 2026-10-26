/**
 * 撤销期内的删除：弹窗 ↔ 后台经长连接 port 交接，弹窗关闭时由后台提交。
 *
 * 为什么不能在弹窗 pagehide 里补发 DELETE_VIDEO：工具栏弹窗失焦关闭时 pagehide 确实会触发，
 * 但此时发出的 runtime.sendMessage 到不了后台（实测 0/3），删除就此丢失，任务带着撤销期开始时
 * 落下的「暂停」状态，在下次打开弹窗时重新出现。port 的 onDisconnect 由浏览器在后台一侧派发，
 * 弹窗无论怎么关闭都会送达。
 *
 * 消息契约（弹窗 → 后台，经 port，无应答）：
 *   { type: "schedule", videoId }  进入撤销期；弹窗关闭时仍在其中的删除由后台提交。
 *   { type: "release",  videoId }  已撤销，或弹窗自己已提交（无论成败），后台不再处理。
 * 弹窗自己的 6 秒计时到点仍走 DELETE_VIDEO 请求，这样失败能当场提示；release 在请求结束后才发，
 * 期间若弹窗被关，后台会再删一次，对已删除的任务是无害的空操作。
 */
export const PENDING_DELETE_PORT = "pending-deletes";

/**
 * 后台侧登记表。待删集合跟着 port 存在 SW 内存里：SW 休眠或重启会断开 port，弹窗那边会重连并
 * 重报全部待删（见 connectPendingDeletes），所以不需要另存 storage——也不应该：弹窗还开着时，
 * 撤销权仍在用户手里，SW 重启不能替用户提交。
 * @param {{commit:(videoId:string)=>Promise<unknown>, onError?:(error:unknown, videoId:string)=>void}} deps
 * @returns {{attach:(port:chrome.runtime.Port)=>boolean}}
 */
export function createPendingDeleteRegistry({ commit, onError = () => {} }) {
  return {
    attach(port) {
      if (port?.name !== PENDING_DELETE_PORT) return false;
      const pending = new Set();
      port.onMessage.addListener((message) => {
        const videoId = typeof message?.videoId === "string" ? message.videoId : "";
        if (!videoId) return;
        if (message.type === "schedule") pending.add(videoId);
        else if (message.type === "release") pending.delete(videoId);
      });
      port.onDisconnect.addListener(() => {
        const ids = [...pending];
        pending.clear();
        for (const videoId of ids) {
          Promise.resolve().then(() => commit(videoId)).catch((error) => onError(error, videoId));
        }
      });
      return true;
    }
  };
}

/**
 * 弹窗侧客户端。port 意外断开（SW 被回收或重启）时立即重连，并把 getPending() 里的待删重新登记；
 * 只有弹窗本身被销毁时 port 才不再重连，而那正是后台该提交的时刻。
 * @param {{connect:(info:{name:string})=>chrome.runtime.Port, getPending:()=>Iterable<string>}} deps
 * @returns {{schedule:(videoId:string)=>void, release:(videoId:string)=>void}}
 */
export function connectPendingDeletes({ connect, getPending }) {
  let port = null;
  const post = (message) => {
    try { open().postMessage(message); }
    catch { port = null; try { open().postMessage(message); } catch { /* 后台暂不可达：下次重连时会重报 */ } }
  };
  function open() {
    if (port) return port;
    const current = connect({ name: PENDING_DELETE_PORT });
    port = current;
    current.onDisconnect.addListener(() => {
      if (port !== current) return;
      port = null;
      const ids = [...getPending()];
      if (ids.length) for (const videoId of ids) post({ type: "schedule", videoId });
    });
    return current;
  }
  open();
  return {
    schedule: (videoId) => post({ type: "schedule", videoId }),
    release: (videoId) => post({ type: "release", videoId })
  };
}
