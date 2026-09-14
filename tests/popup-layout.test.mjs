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

test("播放页使用直接预览和明确的外观控制，不再嵌套折叠设置", () => {
  assert.match(html, /id="assist-toggle"[^>]*role="switch"/);
  assert.doesNotMatch(html, /data-assist-mode=/);
  assert.doesNotMatch(html, /class="assist-metrics"/);
  assert.match(html, /id="assist-appearance"/);
  assert.match(html, /id="assist-timeline-preview"/);
  assert.match(html, /id="assist-appearance-reset"/);
  assert.doesNotMatch(html, /<details class="assist-settings">/);
  assert.match(html, /id="assist-tab-indicator"/);
  assert.match(html, /id="library-count"/);
});
