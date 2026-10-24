/**
 * 「请求评价」的纯逻辑：什么时候出现、点了之后怎么记、多久以后再出现。
 * 不碰 DOM 与 chrome API，弹窗只负责读写 `chrome.storage.local` 并把结果画出来。
 *
 * 合规边界（Chrome 网上应用店「用户评价」相关政策，改动前先确认没有越线）：
 * - 只引导，不奖励：不得以功能、折扣或任何好处交换评价；
 * - 不按情绪筛选：不先问「喜欢吗」再把不满意的用户分流到别处，所有人看到同一个入口，
 *   因此这里没有任何「满意度」输入；
 * - 不骚扰：只在用户确实用出价值之后出现，可以推迟、可以永久关闭，不弹窗、不打断主流程。
 */

/** 商店里的固定扩展 ID；与 scripts/lib/release-checks.mjs 的 STORE_EXTENSION_ID 必须一致（测试校验）。 */
export const STORE_EXTENSION_ID = "bjegpandnhmeinmennpfpkholhmbllam";

/** 评价页：直接落在商店的「评价」标签，写评价只差一步。 */
export const REVIEW_URL = `https://chromewebstore.google.com/detail/${STORE_EXTENSION_ID}/reviews`;

export const REVIEW_PROMPT_KEY = "reviewPromptV1";

/** 至少存成功这么多个视频才算「用出了价值」；一个可能只是试一试。 */
export const MIN_COMPLETED_VIDEOS = 2;
/** 安装（首次打开弹窗）后至少隔这么久才出现，避免第一天就被要评价。 */
export const MIN_INSTALL_AGE_MS = 24 * 60 * 60 * 1000;
/** 「以后再说」之后多久再出现。 */
export const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;
/** 推迟这么多次后不再出现：反复追问同一个人本身就是在打扰。 */
export const MAX_SNOOZES = 2;

/**
 * @typedef {object} ReviewPromptState
 * @property {number} firstSeenAt 首次打开弹窗的时间戳；0 表示尚未记录
 * @property {number} snoozedUntil 推迟到何时，0 表示没有推迟
 * @property {number} snoozeCount 已推迟次数
 * @property {"" | "reviewed" | "never"} closed 永久关闭的原因；空串表示仍可能出现
 */

/** @returns {ReviewPromptState} */
export function defaultReviewState() {
  return { firstSeenAt: 0, snoozedUntil: 0, snoozeCount: 0, closed: "" };
}

const count = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/**
 * 存储里读出来的值不可信（旧版本、手改、损坏）：逐字段收敛到合法值，坏数据按默认处理。
 * @param {unknown} raw
 * @returns {ReviewPromptState}
 */
export function normalizeReviewState(raw) {
  const source = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    firstSeenAt: count(source.firstSeenAt),
    snoozedUntil: count(source.snoozedUntil),
    snoozeCount: count(source.snoozeCount),
    closed: source.closed === "reviewed" || source.closed === "never" ? source.closed : ""
  };
}

/**
 * 首次打开时记下时间；已有记录原样返回（同一个对象，调用方据此判断是否需要写回存储）。
 * @param {ReviewPromptState} state
 * @param {number} now
 */
export function markFirstSeen(state, now) {
  return state.firstSeenAt ? state : { ...state, firstSeenAt: now };
}

/**
 * 是否显示评价卡片。
 * @param {ReviewPromptState} state
 * @param {{ completedCount: number, busy?: boolean, now: number }} context
 *   completedCount：片库里已完成的缓存数；busy：此刻有任务正在下载（不在用户盯着进度时插话）
 */
export function shouldShowReviewPrompt(state, { completedCount, busy = false, now }) {
  if (state.closed) return false;
  if (busy) return false;
  if (completedCount < MIN_COMPLETED_VIDEOS) return false;
  if (!state.firstSeenAt || now - state.firstSeenAt < MIN_INSTALL_AGE_MS) return false;
  if (now < state.snoozedUntil) return false;
  return true;
}

/**
 * 「以后再说」：隔一段时间再出现；推迟次数用完就等同于「不再提示」。
 * @param {ReviewPromptState} state
 * @param {number} now
 * @returns {ReviewPromptState}
 */
export function snoozeReviewPrompt(state, now) {
  const snoozeCount = state.snoozeCount + 1;
  if (snoozeCount > MAX_SNOOZES) return { ...state, snoozeCount, snoozedUntil: 0, closed: "never" };
  return { ...state, snoozeCount, snoozedUntil: now + SNOOZE_MS };
}

/** 「去评价」或设置里的评价入口被点开：不再追问（无从得知是否真的提交，也不该去问）。 */
export function completeReviewPrompt(state) {
  return { ...state, closed: "reviewed", snoozedUntil: 0 };
}

/** 「不再提示」。已经评价过的保持 reviewed，不被覆盖。 */
export function dismissReviewPrompt(state) {
  return state.closed ? state : { ...state, closed: "never", snoozedUntil: 0 };
}
