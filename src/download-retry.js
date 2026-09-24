export const DOWNLOAD_WATCHDOG_ALARM = "bili-buffer-download-watchdog-v1";
export const DOWNLOAD_WATCHDOG_MINUTES = 1;

const RETRY_DELAYS_MS = Object.freeze([
  60_000,
  120_000,
  300_000,
  300_000,
  300_000,
  300_000,
  300_000,
  300_000
]);

export function isRecoverableDownloadError(error) {
  const message = String(error?.message || error || "");
  if (!message) return false;
  if (/IndexedDB|\u6570\u636e\u5e93|\u7f16\u7801|\u753b\u8d28|\u8f68\u9053\u4e0d\u5b8c\u6574|\u603b\u5927\u5c0f\u4e0d\u4e00\u81f4|\u9519\u8bef\u7684\u8303\u56f4\u8d77\u70b9/i.test(message)) return false;
  if (/Failed to fetch|NetworkError|Load failed|ERR_[A-Z_]+|\u7f51\u7edc|\u8d85\u65f6|timeout|\u63d0\u524d\u7ed3\u675f/i.test(message)) return true;
  // 预算/租约错误是跨上下文协调的暂时状态（SW 刚唤醒、账本串行占用、45 秒租约到期），
  // 设计上就要求退避重试而不是硬失败；见 2.8.2 共享请求预算。
  if (/\u79df\u7ea6|\u9884\u7b97/i.test(message)) return true;
  if (/HTTP\s*(?:403|408|425|429|5\d\d)\b/i.test(message)) return true;
  return /CDN.*(?:\u62d2\u7edd|\u5931\u8d25|\u65e0\u6cd5)|\u6240\u6709 CDN|\u6ca1\u6709\u53ef\u7528\u7684 CDN|\u64ad\u653e\u5730\u5740/i.test(message);
}

export function makeDownloadRetryState(video, error, now = Date.now()) {
  if (!isRecoverableDownloadError(error)) return null;
  const attempt = Math.max(0, Number(video?.autoRetryCount) || 0) + 1;
  const delayMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
  return {
    autoRetryCount: attempt,
    nextRetryAt: now + delayMs,
    retryDelayMs: delayMs,
    error: `\u8fde\u63a5\u4e2d\u65ad\uff0c\u5df2\u4fdd\u7559\u8fdb\u5ea6\uff0c\u5c06\u5728 ${Math.ceil(delayMs / 1000)} \u79d2\u540e\u81ea\u52a8\u7eed\u4f20`
  };
}

export function isDownloadRetryDue(video, now = Date.now()) {
  const retryAt = Number(video?.nextRetryAt) || 0;
  return !retryAt || retryAt <= now;
}

export function makeDownloadWatchdogSchedule(nextRetryAt = 0, now = Date.now()) {
  const retryAt = Number(nextRetryAt) || 0;
  return retryAt > now
    ? { when: retryAt, periodInMinutes: DOWNLOAD_WATCHDOG_MINUTES }
    : { delayInMinutes: DOWNLOAD_WATCHDOG_MINUTES, periodInMinutes: DOWNLOAD_WATCHDOG_MINUTES };
}
