export const DEFAULT_PREHEAT_COLOR = "#ff8a1f";

export const PREHEAT_COLOR_PRESETS = Object.freeze([
  Object.freeze({ value: "#ff8a1f", label: "橙色" }),
  Object.freeze({ value: "#ffd23f", label: "金黄" }),
  Object.freeze({ value: "#20c997", label: "青绿" }),
  Object.freeze({ value: "#2f80ed", label: "蓝色" }),
  Object.freeze({ value: "#9b5de5", label: "紫色" }),
  Object.freeze({ value: "#f15bb5", label: "粉色" })
]);

export const ASSIST_DEFAULTS = Object.freeze({
  mode: "always",
  slowTtfbMs: 800,
  leadSeconds: 45,
  minWatchedSec: 0,
  minBufferAheadSec: 0,
  maxPrefetchMBPerTrack: 200,
  maxConcurrency: 32,
  cdnMode: "original",
  networkPolicyVersion: 3,
  estimatorGuard: true,
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
  const next = {
    ...ASSIST_DEFAULTS,
    ...(current || {}),
    mode: normalizeAssistMode(current?.mode),
    minWatchedSec: 0,
    minBufferAheadSec: 0,
    progressColor: normalizePreheatColor(current?.progressColor, "#00a1d6"),
    showPreheatHighlight: current?.showPreheatHighlight !== false,
    preheatColor: normalizePreheatColor(current?.preheatColor)
  };
  if (patch && Object.hasOwn(patch, "mode")) {
    next.mode = normalizeAssistMode(patch.mode, next.mode);
  }
  if (patch && typeof patch.estimatorGuard === "boolean") next.estimatorGuard = patch.estimatorGuard;
  if (patch && Object.hasOwn(patch, "preheatColor")) {
    next.preheatColor = normalizePreheatColor(patch.preheatColor, next.preheatColor);
  }
  if (typeof patch?.showPreheatHighlight === "boolean") next.showPreheatHighlight = patch.showPreheatHighlight;
  if (patch && Object.hasOwn(patch, "progressColor")) {
    next.progressColor = normalizePreheatColor(patch.progressColor, next.progressColor);
  }
  for (const [key, min, max] of [
    ["slowTtfbMs", 200, 10000],
    ["leadSeconds", 10, 120],
    ["maxPrefetchMBPerTrack", 16, 1024],
    ["maxConcurrency", 1, 32]
  ]) {
    if (!Object.hasOwn(patch || {}, key)) continue;
    const value = Number(patch[key]);
    if (Number.isFinite(value)) next[key] = Math.max(min, Math.min(max, value));
  }
  // 旧策略升级为 8 路起步、最高 32 路；新策略保留用户主动选择的上限。
  if (current?.networkPolicyVersion !== 3 && !Object.hasOwn(patch || {}, "maxConcurrency")) next.maxConcurrency = 32;
  next.networkPolicyVersion = 3;
  next.cdnMode = ["mainland", "auto", "original"].includes(patch?.cdnMode) ? patch.cdnMode : (["mainland", "auto", "original"].includes(next.cdnMode) ? next.cdnMode : "original");
  return next;
}
