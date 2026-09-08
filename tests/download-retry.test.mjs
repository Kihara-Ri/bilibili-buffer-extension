import test from "node:test";
import assert from "node:assert/strict";
import {
  DOWNLOAD_WATCHDOG_MINUTES,
  isDownloadRetryDue,
  isRecoverableDownloadError,
  makeDownloadRetryState,
  makeDownloadWatchdogSchedule
} from "../src/download-retry.js";

test("签名过期、限流和网络中断属于可自动续传错误", () => {
  for (const message of [
    "CDN 拒绝了范围下载（HTTP 403）",
    "CDN 请求过于频繁（HTTP 429）",
    "CDN 分块下载超时",
    "Failed to fetch",
    "CDN 范围响应提前结束"
  ]) assert.equal(isRecoverableDownloadError(new Error(message)), true, message);
});

test("数据库、编码和媒体身份冲突不会无限重试", () => {
  for (const message of [
    "IndexedDB transaction failed",
    "浏览器不支持当前编码",
    "CDN 返回的媒体总大小不一致",
    "CDN 返回了错误的范围起点"
  ]) assert.equal(isRecoverableDownloadError(new Error(message)), false, message);
});

test("长时间断网仍持续续传，退避间隔最多五分钟", () => {
  const now = 1_000_000;
  const first = makeDownloadRetryState({}, new Error("Failed to fetch"), now);
  assert.equal(first.autoRetryCount, 1);
  assert.equal(first.nextRetryAt, now + 60_000);
  assert.equal(isDownloadRetryDue(first, now + 59_999), false);
  assert.equal(isDownloadRetryDue(first, now + 60_000), true);

  const capped = makeDownloadRetryState(
    { autoRetryCount: 100 },
    new Error("Failed to fetch"),
    now
  );
  assert.equal(capped.autoRetryCount, 101);
  assert.equal(capped.nextRetryAt, now + 300_000);
  assert.equal(makeDownloadRetryState({}, new Error("IndexedDB transaction failed"), now), null);
});

test("下载看门狗对齐最早续传时间并保留分钟级巡视", () => {
  const now = 10_000;
  const retryAt = now + 5_000;
  assert.deepEqual(makeDownloadWatchdogSchedule(retryAt, now), {
    when: retryAt,
    periodInMinutes: DOWNLOAD_WATCHDOG_MINUTES
  });
  assert.deepEqual(makeDownloadWatchdogSchedule(0, now), {
    delayInMinutes: DOWNLOAD_WATCHDOG_MINUTES,
    periodInMinutes: DOWNLOAD_WATCHDOG_MINUTES
  });
});
