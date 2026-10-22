import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSIST_DEFAULTS,
  DEFAULT_PREHEAT_COLOR,
  normalizeAssistMode,
  normalizePreheatColor,
  PREHEAT_COLOR_PRESETS,
  sanitizeAssistConfig
} from "../src/assist-config.js";

test("预热高亮默认使用高对比橙色并提供多组预设", () => {
  assert.equal(DEFAULT_PREHEAT_COLOR, "#ff8a1f");
  assert.equal(ASSIST_DEFAULTS.preheatColor, DEFAULT_PREHEAT_COLOR);
  assert.ok(PREHEAT_COLOR_PRESETS.length >= 5);
  assert.equal(PREHEAT_COLOR_PRESETS[0].value, DEFAULT_PREHEAT_COLOR);
});

test("自定义颜色会规范化并随播放辅助配置持久保存", () => {
  const config = sanitizeAssistConfig({ preheatColor: " #AABBCC " }, ASSIST_DEFAULTS);
  assert.equal(config.preheatColor, "#aabbcc");
  assert.equal(config.mode, "always");
});

test("旧播放模式迁移为开启或关闭，不保留准备流程", () => {
  assert.equal(normalizeAssistMode("auto"), "always");
  assert.equal(normalizeAssistMode("always"), "always");
  assert.equal(normalizeAssistMode("observe"), "off");
  assert.equal(normalizeAssistMode("off"), "off");
});

test("无效颜色不会覆盖用户已有颜色或其他合法配置", () => {
  const current = sanitizeAssistConfig({ mode: "always", preheatColor: "#20c997" });
  const config = sanitizeAssistConfig({ preheatColor: "transparent", maxConcurrency: 99 }, current);
  assert.equal(config.preheatColor, "#20c997");
  assert.equal(config.mode, "always");
  assert.equal(normalizePreheatColor("white"), DEFAULT_PREHEAT_COLOR);
});

test("显示开关独立于提前加载，旧配置默认保留高亮并验证播放颜色", () => {
  const legacy = sanitizeAssistConfig({ mode: "off" });
  assert.equal(legacy.showPreheatHighlight, true);
  assert.equal(legacy.progressColor, "#00a1d6");
  const hidden = sanitizeAssistConfig({ showPreheatHighlight: false, progressColor: "#ABCDEF" });
  assert.equal(hidden.mode, "always");
  assert.equal(hidden.showPreheatHighlight, false);
  assert.equal(hidden.progressColor, "#abcdef");
  const invalid = sanitizeAssistConfig({ showPreheatHighlight: "true", progressColor: "red" }, hidden);
  assert.equal(invalid.showPreheatHighlight, false);
  assert.equal(invalid.progressColor, "#abcdef");
});

test('网络策略不进配置：历史保存的路线、并发与窗口字段被丢弃，补丁也写不进去', () => {
  const legacy = { mode: 'always', maxConcurrency: 4, cdnMode: 'mainland', leadSeconds: 45, networkPolicyVersion: 3, minWatchedSec: 30 };
  const migrated = sanitizeAssistConfig({ maxConcurrency: 8, cdnMode: 'auto', leadSeconds: 10 }, legacy);
  assert.deepEqual(Object.keys(migrated).sort(), Object.keys(ASSIST_DEFAULTS).sort());
  assert.equal(migrated.mode, 'always');
});
