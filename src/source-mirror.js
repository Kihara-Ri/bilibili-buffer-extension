// 离线下载的源范围镜像写入器：有配额、有熔断、串行发送，任何失败都静默降级。
// 只镜像「CDN 直接下载并逐字节校验过」的范围，合并/抽音轨产物永不进入；
// 与 IndexedDB 镜像库（source-range-store.js）通过后台消息解耦，便于单独测试。
export const SOURCE_MIRROR_BUDGET = 96 * 1024 * 1024;
export const SOURCE_MIRROR_RANGE = 2 * 1024 * 1024;
export const SOURCE_MIRROR_FAILURES = 3;

/** 把 Blob 转成 base64；分块拼接避免大范围触发参数上限。 @param {Blob} blob @returns {Promise<string>} */
export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(text);
}

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
    // 严格串行：并发的 base64 与消息往返只会推高内存峰值，收益为 0。
    queue = queue.then(async () => {
      const result = await send({ op: "write", url, start, end, total, contentType, body: await blobToBase64(data) });
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
