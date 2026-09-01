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
  mode: "auto",
  slowTtfbMs: 800,
  leadSeconds: 45,
  minWatchedSec: 20,
  minBufferAheadSec: 10,
  maxPrefetchMBPerTrack: 200,
  maxConcurrency: 4,
  estimatorGuard: true,
  preheatColor: DEFAULT_PREHEAT_COLOR
});

export function normalizePreheatColor(value, fallback = DEFAULT_PREHEAT_COLOR) {
  const color = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : fallback;
}

export function sanitizeAssistConfig(patch, current = ASSIST_DEFAULTS) {
  const next = {
    ...ASSIST_DEFAULTS,
    ...(current || {}),
    preheatColor: normalizePreheatColor(current?.preheatColor)
  };
  if (patch && ["off", "observe", "auto", "always"].includes(patch.mode)) next.mode = patch.mode;
  if (patch && typeof patch.estimatorGuard === "boolean") next.estimatorGuard = patch.estimatorGuard;
  if (patch && Object.hasOwn(patch, "preheatColor")) {
    next.preheatColor = normalizePreheatColor(patch.preheatColor, next.preheatColor);
  }
  for (const [key, min, max] of [
    ["slowTtfbMs", 200, 10000],
    ["leadSeconds", 10, 120],
    ["minWatchedSec", 0, 120],
    ["minBufferAheadSec", 3, 60],
    ["maxPrefetchMBPerTrack", 16, 1024],
    ["maxConcurrency", 1, 6]
  ]) {
    if (!Object.hasOwn(patch || {}, key)) continue;
    const value = Number(patch[key]);
    if (Number.isFinite(value)) next[key] = Math.max(min, Math.min(max, value));
  }
  return next;
}
