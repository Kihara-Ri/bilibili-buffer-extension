import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { STORE_EXTENSION_ID as RELEASE_STORE_ID } from "../scripts/lib/release-checks.mjs";
import { MESSAGES } from "../src/i18n.js";
import {
  completeReviewPrompt,
  defaultReviewState,
  dismissReviewPrompt,
  markFirstSeen,
  MAX_SNOOZES,
  MIN_COMPLETED_VIDEOS,
  MIN_INSTALL_AGE_MS,
  normalizeReviewState,
  REVIEW_URL,
  shouldShowReviewPrompt,
  SNOOZE_MS,
  snoozeReviewPrompt,
  STORE_EXTENSION_ID
} from "../src/review-prompt.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);
const ready = { ...defaultReviewState(), firstSeenAt: T0 };
const later = T0 + MIN_INSTALL_AGE_MS + 1;

test("评价链接指向商店的评价页，且扩展 ID 与发布校验使用的商店 ID 一致", () => {
  assert.equal(STORE_EXTENSION_ID, RELEASE_STORE_ID);
  assert.equal(REVIEW_URL, `https://chromewebstore.google.com/detail/${RELEASE_STORE_ID}/reviews`);
});

test("用出价值之前不出现：已完成数不足、刚安装、正在下载都不显示", () => {
  assert.equal(shouldShowReviewPrompt(ready, { completedCount: MIN_COMPLETED_VIDEOS, now: later }), true);
  assert.equal(shouldShowReviewPrompt(ready, { completedCount: MIN_COMPLETED_VIDEOS - 1, now: later }), false);
  assert.equal(shouldShowReviewPrompt(ready, { completedCount: 9, now: T0 + MIN_INSTALL_AGE_MS - 1 }), false);
  assert.equal(shouldShowReviewPrompt(ready, { completedCount: 9, busy: true, now: later }), false);
  // 没有首次打开记录（还没来得及写入）时也不显示。
  assert.equal(shouldShowReviewPrompt(defaultReviewState(), { completedCount: 9, now: later }), false);
});

test("markFirstSeen 只记录一次，已有记录时原样返回同一个对象", () => {
  const first = markFirstSeen(defaultReviewState(), T0);
  assert.equal(first.firstSeenAt, T0);
  assert.equal(markFirstSeen(first, T0 + DAY), first);
});

test("以后再说：隔 14 天再出现；推迟次数用完等同于不再提示", () => {
  let state = snoozeReviewPrompt(ready, later);
  assert.equal(state.snoozeCount, 1);
  assert.equal(shouldShowReviewPrompt(state, { completedCount: 5, now: later + SNOOZE_MS - 1 }), false);
  assert.equal(shouldShowReviewPrompt(state, { completedCount: 5, now: later + SNOOZE_MS }), true);
  for (let i = 1; i < MAX_SNOOZES; i += 1) state = snoozeReviewPrompt(state, later + SNOOZE_MS);
  assert.equal(state.closed, "", "最后一次推迟仍然允许再出现一次");
  state = snoozeReviewPrompt(state, later + 2 * SNOOZE_MS);
  assert.equal(state.closed, "never");
  assert.equal(shouldShowReviewPrompt(state, { completedCount: 5, now: later + 99 * DAY }), false);
});

test("去评价与不再提示都是永久关闭；已评价不会被「不再提示」覆盖", () => {
  const reviewed = completeReviewPrompt(snoozeReviewPrompt(ready, later));
  assert.equal(reviewed.closed, "reviewed");
  assert.equal(reviewed.snoozedUntil, 0);
  assert.equal(shouldShowReviewPrompt(reviewed, { completedCount: 5, now: later + 99 * DAY }), false);
  assert.equal(dismissReviewPrompt(reviewed).closed, "reviewed");
  assert.equal(dismissReviewPrompt(ready).closed, "never");
});

test("存储里的脏数据被收敛为合法状态，不会让提示异常常驻或崩溃", () => {
  assert.deepEqual(normalizeReviewState(undefined), defaultReviewState());
  assert.deepEqual(normalizeReviewState("x"), defaultReviewState());
  assert.deepEqual(
    normalizeReviewState({ firstSeenAt: -5, snoozedUntil: "soon", snoozeCount: 1.9, closed: "maybe" }),
    { firstSeenAt: 0, snoozedUntil: 0, snoozeCount: 1, closed: "" }
  );
  const saved = { firstSeenAt: T0, snoozedUntil: T0 + DAY, snoozeCount: 1, closed: "reviewed" };
  assert.deepEqual(normalizeReviewState(saved), saved);
});

test("没有任何情绪筛选：状态里没有评分 / 满意度字段，函数也不接收这类输入", () => {
  assert.deepEqual(Object.keys(defaultReviewState()).sort(), ["closed", "firstSeenAt", "snoozeCount", "snoozedUntil"]);
});

test("弹窗接入：片库卡片与设置入口都指向同一评价链接，文案中英齐全，且没有奖励措辞", async () => {
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  assert.match(html, /id="review-card"[^>]*data-open="false"/);
  for (const id of ["review-go", "review-later", "review-never", "about-review"]) assert.match(html, new RegExp(`id="${id}"`));
  const keys = [...html.matchAll(/data-i18n="(review\.[^"]+|about\.review[^"]*)"/g)].map((match) => match[1]);
  assert.ok(keys.length >= 5, "评价相关的静态文案都应走 data-i18n");
  for (const locale of ["zh-CN", "en"]) {
    for (const key of keys) assert.ok(MESSAGES[locale][key], `${locale} 缺少 ${key}`);
    const text = Object.entries(MESSAGES[locale]).filter(([key]) => key.startsWith("review.")).map(([, value]) => value).join(" ");
    assert.doesNotMatch(text, /解锁|奖励|免费送|优惠|unlock|reward|free |discount|5\s*星|five.?star/i);
  }
  const popup = await readFile(new URL("../src/popup.js", import.meta.url), "utf8");
  assert.match(popup, /REVIEW_URL/);
});
