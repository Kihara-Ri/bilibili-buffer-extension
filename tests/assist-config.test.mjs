import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSIST_DEFAULTS,
  DEFAULT_PREHEAT_COLOR,
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
  assert.equal(config.mode, "auto");
});

test("无效颜色不会覆盖用户已有颜色或其他合法配置", () => {
  const current = sanitizeAssistConfig({ mode: "always", preheatColor: "#20c997" });
  const config = sanitizeAssistConfig({ preheatColor: "transparent", maxConcurrency: 99 }, current);
  assert.equal(config.preheatColor, "#20c997");
  assert.equal(config.mode, "always");
  assert.equal(config.maxConcurrency, 6);
  assert.equal(normalizePreheatColor("white"), DEFAULT_PREHEAT_COLOR);
});
