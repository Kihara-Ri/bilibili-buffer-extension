import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
const between = (startMarker, endMarker) => {
  const start = html.indexOf(startMarker);
  return html.slice(start, html.indexOf(endMarker, start));
};

test("页眉：主名接着诗句下半句，右侧是设置入口；GitHub 链接在设置的「关于」里", () => {
  // 名字取自「海内存知己，天涯若比邻」：主名与下半句在同一个 h1 里紧贴，整句可以一口气读完。
  // 两段文字由 data-i18n 换成当前语言；静态 HTML 里保留中文原文，英文由 tests/i18n.test.mjs 校验。
  assert.match(html, /<h1 class="brand-title"><span class="brand-name" data-i18n="ext.name">海内存知<\/span><span class="brand-verse" data-i18n="brand.verse">己，天涯若比邻<\/span><\/h1>/);
  assert.doesNotMatch(html, /brand-subtitle|bilibili buffer/);
  const masthead = between('<header class="masthead">', "</header>");
  assert.match(masthead, /id="settings-button"[^>]*aria-controls="settings-view"/);
  assert.doesNotMatch(masthead, /github/i);
  const about = between('aria-labelledby="about-heading"', "</section>");
  const link = about.match(/<a class="github-link"[^>]*>/)?.[0] || "";
  assert.match(link, /href="https:\/\/github\.com\/Kihara-Ri\/bilibili-buffer-extension"/);
  assert.match(link, /aria-label="GitHub 项目页面"/);
  assert.match(link, /rel="noopener noreferrer"/);
});

test("一级导航只有「当前视频」「片库」两个页签；设置是独立的二级视图", () => {
  const tabs = [...html.matchAll(/data-panel-view="(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ["current", "library"]);
  assert.match(html, /id="current-view"[^>]*role="tabpanel"/);
  assert.match(html, /id="library-view"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(html, /id="settings-view"[^>]*hidden/);
  assert.doesNotMatch(html, /id="settings-view"[^>]*role="tabpanel"/);
  assert.match(html, /id="library-count"/);
  // 旧的「缓存 / 播放」页签与播放页不再存在。
  assert.doesNotMatch(html, /id="(cache|assist)-(tab|view)"/);
});

test("当前视频：内容二选一、画质是一根滑杆（无下拉）、大会员标记与分段控件同行、账号说明在画质下方、暂停在主按钮内", () => {
  assert.match(html, /id="cache-mode"[^>]*role="radiogroup"/);
  const modes = [...html.matchAll(/data-cache-mode="(video|audio)"/g)].map((match) => match[1]);
  assert.deepEqual(modes, ["video", "audio"]);
  assert.match(html.match(/<button[^>]*id="mode-video"[^>]*>/)?.[0] || "", /aria-checked="true"/);
  assert.match(html.match(/<button[^>]*id="mode-audio"[^>]*>/)?.[0] || "", /aria-checked="false"/);
  // 画质是一根原生 range 滑杆（拖动、方向键与读屏都由浏览器提供）：没有下拉触发器、没有 popover 菜单。
  const quality = between('id="quality-row"', 'id="auth-note"');
  assert.match(quality, /<input[^>]*id="quality-slider"[^>]*type="range"/);
  assert.match(quality, /id="quality-slider"[^>]*aria-labelledby="quality-label"/);
  assert.doesNotMatch(html, /quality-options|aria-haspopup|popovertarget|\bpopover\b|<select/);
  // 看得见的拇指与登顶水花是装饰层，放在 range 之后（CSS 用相邻选择器把悬停 / 焦点状态传给拇指）。
  assert.match(quality, /id="quality-slider"[^>]*>\s*(?:<!--[\s\S]*?-->\s*)?<span class="quality-knob" aria-hidden="true"><\/span>\s*<span class="quality-splash" aria-hidden="true"><\/span>/);
  assert.match(quality, /<span class="quality-fill" aria-hidden="true"><span class="quality-surge"><\/span><\/span>/);
  // 读取页面：初始就是 reading 态（没有进度水波），骨架占位是纯装饰。
  assert.match(html, /<button id="cache-button"[^>]*data-state="reading"/);
  assert.match(html, /<div class="current-skeleton" aria-hidden="true">/);
  assert.match(html, /id="audio-summary"/);
  const modeRow = between('class="mode-row"', "</div>\n\n");
  assert.match(modeRow, /id="cache-mode"/);
  assert.match(modeRow, /id="account-chip"[^>]*hidden/);
  assert.doesNotMatch(modeRow, /id="auth-note"/);
  // 账号说明紧跟在画质滑杆之后，未登录时带「去登录」。
  assert.match(between('id="auth-note"', "</p>"), /id="auth-action"[^>]*hidden/);
  // 暂停是主按钮所在容器里的图标按钮，不再占一行文字链接。
  const control = between('class="cache-control"', 'id="action-hint"');
  assert.match(control, /id="cache-button"/);
  assert.match(control, /id="pause-button"[^>]*hidden/);
  assert.match(control, /id="pause-button"[^>]*aria-label="暂停缓存"/);
});

test("提前加载并入当前视频：开关、三个概览数字，其余诊断折叠在标题行「详情」之后", () => {
  const preload = between('id="assist-panel"', "</section>");
  assert.match(preload, /id="assist-toggle"[^>]*role="switch"/);
  const summary = between('class="assist-summary"', "</dl>");
  for (const id of ["assist-speed", "assist-ready", "assist-hit"]) assert.match(summary, new RegExp(`<dd id="${id}"[^>]*>—</dd>`), `概览缺少 ${id}`);
  for (const id of ["assist-buffer", "assist-stalls", "assist-node"]) assert.doesNotMatch(summary, new RegExp(`id="${id}"`), `诊断 ${id} 不应出现在概览`);
  assert.match(preload, /id="assist-details-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="assist-metrics-panel"/);
  const diagnostics = between('id="assist-metrics-panel"', "</dl>");
  assert.match(diagnostics, /^[^>]*hidden/, "详细数据默认折叠");
  for (const id of ["assist-buffer", "assist-stalls", "assist-residency", "assist-accelerated", "assist-trouble", "assist-node"]) {
    assert.match(diagnostics, new RegExp(`id="${id}"`), `详细数据缺少 ${id}`);
  }
  // 诊断说明放在各指标的 title 里，不再堆一段长说明文字。
  assert.doesNotMatch(html, /class="assist-metrics-note"/);
  // 网络策略是页面侧常量，界面不提供选择。
  assert.doesNotMatch(html, /id="assist-(cdn-mode|concurrency)"/);
});

test("设置：进度条外观（唯一一条预览）、浏览器自检、关于", () => {
  const settings = between('id="settings-view"', "</main>");
  assert.equal((settings.match(/class="timeline-preview"/g) || []).length, 1);
  for (const id of ["assist-progress-color", "assist-show-highlight", "assist-colors", "assist-custom-color", "assist-appearance-reset", "browser-health-refresh", "browser-health-status", "about-version"]) {
    assert.match(settings, new RegExp(`id="${id}"`), `设置缺少 ${id}`);
  }
  // 自检失败时主视图顶部有提示条，可直接跳到设置里的详情。
  assert.match(html, /id="health-banner"[^>]*hidden/);
  assert.match(html, /id="settings-alert"[^>]*hidden/);
});

test("每个视图底部常驻隐私说明，删除提示带撤销按钮", () => {
  assert.match(html, /<footer class="app-footer">[\s\S]*href="privacy\.html"/);
  assert.match(html, /id="toast-action"[^>]*hidden/);
});
