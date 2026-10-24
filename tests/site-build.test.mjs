import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSite, renderChangelog, REPO_URL, STORE_URL } from "../scripts/build-site.mjs";
import { STORE_EXTENSION_ID } from "../scripts/lib/release-checks.mjs";

// 官网构建（scripts/build-site.mjs）：版本、更新记录、隐私页与弹窗演示都来自仓库本身，
// 这里钉住「构建产物自洽」——占位符全部填上、引用的文件都在、不加载第三方资源、不带开发态代码。

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const out = await mkdtemp(path.join(tmpdir(), "haineicunzhi-site-"));
test.after(() => rm(out, { recursive: true, force: true }));
const result = await buildSite(out);
const page = await readFile(path.join(out, "index.html"), "utf8");

test("首页填好版本、商店链接与诗句，没有残留占位符", () => {
  assert.doesNotMatch(page, /\{\{\w+\}\}/);
  assert.ok(page.includes(`v${manifest.version}`));
  assert.ok(STORE_URL.endsWith(STORE_EXTENSION_ID));
  assert.ok(page.includes(`href="${STORE_URL}"`));
  assert.match(page, /<span class="verse-name">海内存知<\/span><span class="verse-soft">己，<\/span>/);
  assert.match(page, /<meta name="viewport"/);
});

test("GitHub 入口在顶栏与首屏都带图标", () => {
  const topbar = page.slice(page.indexOf('<header class="topbar">'), page.indexOf("</header>"));
  assert.match(topbar, new RegExp(`<a class="github-link" href="${REPO_URL}"[^>]*aria-label="GitHub[^"]*"><svg class="gh"`));
  const hero = page.slice(page.indexOf('<section class="hero">'), page.indexOf("</section>"));
  assert.match(hero, new RegExp(`href="${REPO_URL}"[^>]*><svg class="gh"`));
});

test("更新记录折叠在页尾，第一条就是当前版本：发版时忘了写开发日志会在这里失败", () => {
  assert.equal(result.versions[0], manifest.version);
  const footer = page.slice(page.indexOf('<footer class="footer">'));
  assert.match(footer, /<details id="changelog" class="changelog">/, "更新记录必须在页尾且默认折叠（不带 open）");
  assert.doesNotMatch(page.slice(0, page.indexOf('<footer class="footer">')), /class="release"/);
  assert.match(page, new RegExp(`<span class="release-version">${manifest.version.replaceAll(".", "\\.")}</span>`));
});

test("renderChangelog 只取版本小节、处理「补充」、转义正文", () => {
  const markdown = "# 标题\n\n## 本轮改动总览\n\n## 1.2.0 补充 · 测试 <b>\n正文\n## 1.1.0 · 用 `code` 修复\n- 条目\n";
  const { html, versions } = renderChangelog(markdown);
  assert.deepEqual(versions, ["1.2.0", "1.1.0"]);
  assert.ok(html.includes("测试 &lt;b&gt;"));
  assert.ok(html.includes("用 <code>code</code> 修复"));
  assert.ok(!html.includes("正文") && !html.includes("条目"), "网站只放标题，正文留在 GitHub 的开发日志里");
  assert.equal(renderChangelog(markdown, 1).versions.length, 1);
});

test("页面引用的本地文件都存在，且不加载任何第三方资源", async () => {
  const local = [...page.matchAll(/\s(?:src|href)="([^"#]+)"/g)].map((match) => match[1]).filter((url) => !/^(https?:|mailto:)/.test(url) && !url.includes("{{"));
  assert.ok(local.length >= 5);
  for (const url of local) await stat(path.join(out, url.split("?")[0]));
  // 外链只能是可点击的 <a>：脚本、样式、图片、iframe 都必须同源。
  const external = [...page.matchAll(/<(script|link|img|iframe)\b[^>]*\s(?:src|href)="(https?:[^"]+)"/g)].filter((match) => !(match[1] === "link" && /rel="canonical"/.test(match[0])));
  assert.deepEqual(external.map((match) => match[2]), []);
});

test("隐私页原样发布，旧地址跳转到新域名后内容不变", async () => {
  assert.equal(await readFile(path.join(out, "privacy.html"), "utf8"), await readFile(new URL("privacy.html", root), "utf8"));
});

test("弹窗演示只带弹窗用到的模块，不含后台、Offscreen 与热更新代码", async () => {
  await stat(path.join(out, "demo", "src", "popup.js"));
  await stat(path.join(out, "demo", "store", "scene", "popup-scene.mjs"));
  for (const file of ["background.js", "offscreen.js", "content.js", "dev-reload.js"]) {
    await assert.rejects(stat(path.join(out, "demo", "src", file)), `演示里不应出现 src/${file}`);
  }
});
