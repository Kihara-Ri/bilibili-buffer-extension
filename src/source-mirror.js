// 离线下载的源范围镜像写入器：有配额、有熔断、串行发送，任何失败都静默降级。
// 只镜像「CDN 直接下载并逐字节校验过」的范围，合并/抽音轨产物永不进入；
// 真正的写入由 send 决定（下载文档里是 source-range-store.js 的 createSourceWriter 直写镜像库），便于单独测试。
// 配额与镜像库总上限（SOURCE_LIMIT）一致：库按最旧优先回收，多写的部分只会把本视频开头挤掉。
export const SOURCE_MIRROR_BUDGET = 64 * 1024 * 1024;
export const SOURCE_MIRROR_RANGE = 2 * 1024 * 1024;
export const SOURCE_MIRROR_FAILURES = 3;

/**
 * @param {{send:(request:object)=>Promise<{ok?:boolean}|any>, budget?:number, failures?:number}} options
 * @returns {{onVerifiedRange:Function, sent:number, skipped:number, disabled:boolean}}
 */
export function createSourceMirror({ send, budget = SOURCE_MIRROR_BUDGET, failures: maxFailures = SOURCE_MIRROR_FAILURES } = {}) {
  let remaining = budget, failed = 0, disabled = false, sent = 0, skipped = 0, queue = Promise.resolve();
  const onVerifiedRange = ({ url, start, end, total, data, contentType } = {}) => {
    const size = Number(end) - Number(start);
    if (disabled || !send || !data || !Number.isSafeInteger(size) || size <= 0 || size > SOURCE_MIRROR_RANGE || remaining < size) { skipped += 1; return; }
    remaining -= size;
    // 严格串行：一次只有一个镜像事务，不与分块提交抢 IndexedDB。
    // 原始 Blob 原样交出：不在下载文档主线程上做 base64，后台降优先级时这正是吃掉 CPU 的地方。
    queue = queue.then(async () => {
      const result = await send({ op: "write", url, start, end, total, contentType, data });
      if (result?.ok === false) throw new Error("源范围未写入镜像");
      failed = 0; sent += 1;
    }).catch(() => {
      // 连续失败说明后台或存储不可用：本任务内停止镜像，绝不影响下载。
      failed += 1;
      if (failed >= maxFailures) disabled = true;
    });
  };
  return {
    onVerifiedRange,
    get sent() { return sent; },
    get skipped() { return skipped; },
    get disabled() { return disabled; },
    /** 等待已排队的镜像写入结束；仅测试与收尾需要。 */
    drain: () => queue.catch(() => {})
  };
}
