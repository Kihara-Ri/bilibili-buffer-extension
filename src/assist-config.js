export const DEFAULT_PREHEAT_COLOR = "#ff8a1f";

// name 对应界面文案 color.<name>（见 src/locales），颜色值本身是存储格式，不随语言变化。
export const PREHEAT_COLOR_PRESETS = Object.freeze([
  Object.freeze({ value: "#ff8a1f", name: "orange" }),
  Object.freeze({ value: "#ffd23f", name: "gold" }),
  Object.freeze({ value: "#20c997", name: "teal" }),
  Object.freeze({ value: "#2f80ed", name: "blue" }),
  Object.freeze({ value: "#9b5de5", name: "purple" }),
  Object.freeze({ value: "#f15bb5", name: "pink" })
]);

// 只保存用户可见的开关与外观；预热窗口、并发、分片大小等网络策略是页面侧内部常量
// （见 playback-observer.js / playback-network.js），不进存储，也就不会被旧版本的保存值卡住。
export const ASSIST_DEFAULTS = Object.freeze({
  mode: "always",
  progressColor: "#00a1d6",
  showPreheatHighlight: true,
  preheatColor: DEFAULT_PREHEAT_COLOR
});

export function normalizeAssistMode(value, fallback = ASSIST_DEFAULTS.mode) {
  if (["always", "auto", "on"].includes(value)) return "always";
  if (["off", "observe"].includes(value)) return "off";
  return fallback;
}

export function normalizePreheatColor(value, fallback = DEFAULT_PREHEAT_COLOR) {
  const color = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
}

export function sanitizeAssistConfig(patch, current = ASSIST_DEFAULTS) {
  // 只挑已知字段：历史存储里的 cdnMode / maxConcurrency / leadSeconds 等旧策略字段在此丢弃。
  const next = {
    mode: normalizeAssistMode(current?.mode),
    progressColor: normalizePreheatColor(current?.progressColor, "#00a1d6"),
    showPreheatHighlight: current?.showPreheatHighlight !== false,
    preheatColor: normalizePreheatColor(current?.preheatColor)
  };
  if (patch && Object.hasOwn(patch, "mode")) {
    next.mode = normalizeAssistMode(patch.mode, next.mode);
  }
  if (patch && Object.hasOwn(patch, "preheatColor")) {
    next.preheatColor = normalizePreheatColor(patch.preheatColor, next.preheatColor);
  }
  if (typeof patch?.showPreheatHighlight === "boolean") next.showPreheatHighlight = patch.showPreheatHighlight;
  if (patch && Object.hasOwn(patch, "progressColor")) {
    next.progressColor = normalizePreheatColor(patch.progressColor, next.progressColor);
  }
  return next;
}
