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

test("低频高亮配色放入按需展开的播放设置", () => {
  assert.match(html, /<details class="assist-settings">[\s\S]*进度条高亮[\s\S]*id="assist-colors"[\s\S]*<\/details>/);
  assert.match(html, /id="assist-tab-indicator"/);
  assert.match(html, /id="library-count"/);
});
