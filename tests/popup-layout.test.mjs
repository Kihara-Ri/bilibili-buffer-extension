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

test("播放页只公开开启关闭开关，低频配色按需展开", () => {
  assert.match(html, /id="assist-toggle"[^>]*role="switch"/);
  assert.doesNotMatch(html, /data-assist-mode=/);
  assert.doesNotMatch(html, /class="assist-metrics"/);
  assert.match(html, /<details class="assist-settings">[\s\S]*高亮颜色[\s\S]*id="assist-colors"[\s\S]*<\/details>/);
  assert.match(html, /id="assist-tab-indicator"/);
  assert.match(html, /id="library-count"/);
});
