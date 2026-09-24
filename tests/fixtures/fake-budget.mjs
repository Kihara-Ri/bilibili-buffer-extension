// 浏览器夹具用的下载预算应答器。
//
// 在线加速与离线下载共用同一套租约（见 src/request-budget.js 与 2.8.2 说明），
// 夹具若自己造一个「永远返回 ok」的桩，下载器会一直等不到 lease，整条离线链路
// 在夹具里表现为超时——2026-09-22 引入预算后 tests/offscreen-integration.mjs
// 就是这样静默失效的。这里直接复用生产状态机，夹具只需要提供消息入口。
import { transitionBudget } from "../../src/request-budget.js";

/**
 * @param {{capacity?:number, owner?:string, now?:()=>number}} options
 *   capacity 与后台默认一致；owner 固定为 Offscreen（夹具里只有一个下载方）。
 * @returns {{handle:Function, leaseCount:number, acquireCount:number, releaseCount:number}}
 */
export function createFakeBudget({ capacity = 32, owner = "offscreen", now = () => Date.now() } = {}) {
  let saved = null;
  let acquireCount = 0;
  let releaseCount = 0;
  return {
    /** 处理一条后台消息；非预算消息返回 undefined，交回夹具原有逻辑。 */
    handle(message) {
      if (message?.type !== "DOWNLOAD_BUDGET") return undefined;
      const request = message.request || {};
      const { state, reply } = transitionBudget(saved, request, owner, capacity, now());
      saved = state;
      if (request.op === "release") releaseCount += 1;
      else acquireCount += 1;
      return { ok: true, ...reply };
    },
    get leaseCount() {
      return saved?.leases?.length || 0;
    },
    get acquireCount() {
      return acquireCount;
    },
    get releaseCount() {
      return releaseCount;
    }
  };
}
