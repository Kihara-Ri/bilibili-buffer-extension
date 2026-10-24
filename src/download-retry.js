import { t } from "./i18n.js";

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

/**
 * 判断一次下载失败能否靠稍后重试恢复。错误文案按界面语言生成（src/i18n.js），
 * 所以每条规则同时列出中文与英文的关键字；tests/i18n.test.mjs 会把每条错误文案的两种语言
 * 都跑一遍，保证换了语言后重试判断不变。
 */
export function isRecoverableDownloadError(error) {
  const message = String(error?.message || error || "");
  if (!message) return false;
  if (/IndexedDB|数据库|database|编码|画质|quality|轨道不完整|总大小不一致|total media size|错误的范围起点|wrong range start/i.test(message)) return false;
  if (/Failed to fetch|NetworkError|Load failed|ERR_[A-Z_]+|网络|network|超时|timeout|timed out|提前结束|ended early/i.test(message)) return true;
  if (/HTTP\s*(?:403|408|425|429|5\d\d)\b/i.test(message)) return true;
  return /CDN.*(?:拒绝|失败|无法)|所有 CDN|没有可用的 CDN|播放地址|CDN.*(?:refused|failed|could|can't|cannot)|No CDN address|Every CDN|playback address/i.test(message);
}

export function makeDownloadRetryState(video, error, now = Date.now()) {
  if (!isRecoverableDownloadError(error)) return null;
  const attempt = Math.max(0, Number(video?.autoRetryCount) || 0) + 1;
  const delayMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
  return {
    autoRetryCount: attempt,
    nextRetryAt: now + delayMs,
    retryDelayMs: delayMs,
    error: t("err.retryScheduled", { seconds: Math.ceil(delayMs / 1000) })
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
