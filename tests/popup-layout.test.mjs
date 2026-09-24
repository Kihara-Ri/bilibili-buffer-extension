import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");

test("Popup 使用缓存、播放和片库三个互斥一级视图", () => {
  const tabs = [...html.matchAll(/data-panel-view="(cache|assist|library)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["cache", "assist", "library"]);
  assert.match(html, /id="cache-view"[^>]*role="tabpanel"/);
  assert.match(html, /id="assist-view"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(html, /id="library-view"[^>]*role="tabpanel"[^>]*hidden/);
});

test("缓存页提供视频 + 音频与仅音频两种缓存内容", () => {
  assert.match(html, /id="cache-mode"[^>]*role="radiogroup"/);
  const modes = [...html.matchAll(/data-cache-mode="(video|audio)"/g)].map((match) => match[1]);
  assert.deepEqual(modes, ["video", "audio"]);
  const videoButton = html.match(/<button[^>]*id="mode-video"[^>]*>/)?.[0] || "";
  const audioButton = html.match(/<button[^>]*id="mode-audio"[^>]*>/)?.[0] || "";
  assert.match(videoButton, /data-cache-mode="video"/);
  assert.match(videoButton, /aria-checked="true"/);
  assert.match(audioButton, /data-cache-mode="audio"/);
  assert.match(audioButton, /aria-checked="false"/);
  assert.match(html, /缓存内容/);
});

test("播放页概览紧凑，外观与详细统计分区折叠", () => {
  assert.match(html, /id="assist-toggle"[^>]*role="switch"/);
  assert.doesNotMatch(html, /data-assist-mode=/);
  // 概览条只保留三个常驻数字，其余诊断计数必须留在折叠的详细统计里。
  assert.match(html, /class="assist-summary"/);
  for (const id of ["assist-speed", "assist-hit", "assist-ready"]) {
    const metric = html.match(new RegExp(`<dd id="${id}"[^>]*>—</dd>`));
    assert.ok(metric, `概览缺少 ${id}`);
    assert.ok(html.indexOf('class="assist-summary"') < html.indexOf(`id="${id}"`), `${id} 应位于概览条内`);
  }
  const summaryStart = html.indexOf('class="assist-summary"');
  const summaryEnd = html.indexOf("</dl>", summaryStart);
  for (const id of ["assist-buffer", "assist-connections", "assist-node"]) {
    assert.ok(!(html.indexOf(`id="${id}"`) > summaryStart && html.indexOf(`id="${id}"`) < summaryEnd), `诊断指标 ${id} 不应出现在概览条`);
  }
  // CDN 路线与并发上限由系统策略决定，界面不再提供选择。
  assert.doesNotMatch(html, /id="assist-cdn-mode"/);
  assert.doesNotMatch(html, /id="assist-concurrency"/);
  // 外观折叠区：摘要行的示意条是唯一预览，展开后只有图例与控件，不重复标题与第二条进度条。
  assert.match(html, /<details id="assist-appearance"/);
  assert.match(html, /<summary class="appearance-summary">/);
  assert.match(html, /class="appearance-summary-preview timeline-preview"/);
  assert.doesNotMatch(html, /id="assist-timeline-preview"/);
  assert.doesNotMatch(html, /id="appearance-heading"/);
  assert.match(html, /class="timeline-legend"/);
  assert.match(html, /id="assist-appearance-reset"/);
  // 详细统计独立折叠，包含剩余指标与说明。
  assert.match(html, /class="assist-diagnostics"/);
  assert.match(html, /class="assist-metrics"/);
  assert.match(html, /class="assist-metrics-note"/);
  assert.match(html, /id="assist-tab-indicator"/);
  assert.match(html, /id="library-count"/);
});
