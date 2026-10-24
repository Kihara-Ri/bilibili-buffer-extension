import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALIPAY_URL, buildSite, renderChangelog, REPO_URL, STORE_URL } from "../scripts/build-site.mjs";
import { STORE_EXTENSION_ID } from "../scripts/lib/release-checks.mjs";

// 官网构建（scripts/build-site.mjs）：版本、更新记录、隐私页与弹窗演示都来自仓库本身，
// 这里钉住「构建产物自洽」——占位符全部填上、引用的文件都在、不加载第三方资源、不带开发态代码。

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const out = await mkdtemp(path.join(tmpdir(), "haineicunzhi-site-"));
test.after(() => rm(out, { recursive: true, force: true }));
const result = await buildSite(out);
const page = await readFile(path.join(out, "index.html"), "utf8");
const enPage = await readFile(path.join(out, "en", "index.html"), "utf8");
const sectionIds = (html) => [...html.matchAll(/<section id="(\w+)"/g)].map((match) => match[1]);

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

test("各节标题把导航关键字写进句子里：不再单独放一行小标题", () => {
  assert.doesNotMatch(page, /class="kicker"/);
  const nav = page.slice(page.indexOf('<nav class="topbar-links"'), page.indexOf("</nav>"));
  for (const [, id, label] of nav.matchAll(/<a href="#(\w+)">([^<]+)<\/a>/g)) {
    const start = page.indexOf(`id="${id}"`);
    const heading = page.slice(start, page.indexOf("</section>", start)).match(/<h2>(.*?)<\/h2>/)?.[1] || "";
    assert.ok(heading.includes(`<em class="key">${label}</em>`), `#${id} 的标题应包含高亮的「${label}」：${heading}`);
  }
});

test("「知己」一节讲自己人更懂自己人，隐私承诺单独成节", () => {
  const start = page.indexOf('id="friend"');
  const friend = page.slice(start, page.indexOf("</section>", start));
  assert.match(friend, /同胞/);
  assert.match(friend, /class="danmaku" aria-hidden="true"/, "弹幕只是装饰，读屏应跳过");
  assert.doesNotMatch(friend, /class="promises"/);
  const privacy = page.slice(page.indexOf('id="privacy"'));
  assert.match(privacy, /<h2>只有你知道<\/h2>[\s\S]*class="promises"/);
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
  for (const [html, base] of [[page, out], [enPage, path.join(out, "en")]]) {
    const local = [...html.matchAll(/\s(?:src|href)="([^"#]+)"/g)].map((match) => match[1]).filter((url) => !/^(https?:|mailto:)/.test(url) && !url.includes("{{"));
    assert.ok(local.length >= 5);
    for (const url of local) await stat(path.join(base, url.split("?")[0]));
    // 外链只能是可点击的 <a>：脚本、样式、图片、iframe 都必须同源；canonical / hreflang 只是给搜索引擎的声明。
    const external = [...html.matchAll(/<(script|link|img|iframe)\b[^>]*\s(?:src|href)="(https?:[^"]+)"/g)].filter((match) => !(match[1] === "link" && /rel="(?:canonical|alternate)"/.test(match[0])));
    assert.deepEqual(external.map((match) => match[2]), []);
  }
});

test("投喂区：收款码图片与「打开支付宝」链接都在，并写明自愿、不解锁功能", async () => {
  const tip = page.slice(page.indexOf('<section id="tip"'), page.indexOf("</section>", page.indexOf('<section id="tip"')));
  assert.match(tip, /<img src="assets\/alipay-qr\.png" alt="[^"]+"/);
  await stat(path.join(out, "assets", "alipay-qr.png"));
  assert.ok(ALIPAY_URL.startsWith("https://qr.alipay.com/"));
  assert.ok(tip.includes(`href="${ALIPAY_URL}"`));
  assert.match(tip, /完全自愿，不会解锁任何功能/);
  // 菜单卡片：四档参考价各配一个自绘图标，图标引用的 symbol 必须真的定义在页面里。
  const cards = [...tip.matchAll(/<li class="food-card[^"]*">.*?<use href="#(food-[\w-]+)"\/>.*?<span class="food-name">([^<]+)<\/span><span class="food-price">([^<]+)<\/span><\/li>/g)];
  assert.deepEqual(cards.map((card) => card[3]), ["¥5", "¥10", "¥20", "自定"]);
  for (const [, id] of cards) assert.ok(page.includes(`<symbol id="${id}"`), `缺少图标 ${id}`);
  assert.match(page, /<a href="#tip">投喂<\/a>/, "顶栏导航要有投喂入口");
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

test("英文页：/en/ 与中文首页 hreflang 互指，分节与导航一一对应", async () => {
  assert.doesNotMatch(enPage, /\{\{\w+\}\}/);
  assert.match(enPage, /<html lang="en">/);
  assert.ok(enPage.includes(`v${manifest.version}`));
  for (const html of [page, enPage]) {
    assert.ok(html.includes('<link rel="alternate" hreflang="zh-CN" href="https://haineicunzhi.kihara.cn/">'));
    assert.ok(html.includes('<link rel="alternate" hreflang="en" href="https://haineicunzhi.kihara.cn/en/">'));
    assert.ok(html.includes('<link rel="alternate" hreflang="x-default" href="https://haineicunzhi.kihara.cn/en/">'));
  }
  assert.match(page, /<a class="lang-switch" href="en\/" hreflang="en"/);
  assert.match(enPage, /<a class="lang-switch" href="\.\.\/" hreflang="zh-CN"/);
  assert.deepEqual(sectionIds(enPage), sectionIds(page), "两页的分节必须一致，改版时要一起改");
  // 导航关键字同样写进标题句
  const nav = enPage.slice(enPage.indexOf('<nav class="topbar-links"'), enPage.indexOf("</nav>"));
  const labels = [...nav.matchAll(/<a href="#(\w+)">([^<]+)<\/a>/g)];
  assert.equal(labels.length, 5);
  for (const [, id, label] of labels) {
    const start = enPage.indexOf(`id="${id}"`);
    const heading = enPage.slice(start, enPage.indexOf("</section>", start)).match(/<h2>(.*?)<\/h2>/)?.[1] || "";
    // 英文关键字可能在句中，大小写随句子走
    assert.ok(heading.toLowerCase().includes(`<em class="key">${label.toLowerCase()}</em>`), `#${id} 的标题应包含高亮的「${label}」：${heading}`);
  }
  assert.match(enPage, /<iframe class="demo-frame" src="\.\.\/demo\/store\/scene\/popup-scene\.html\?lang=en"/, "英文页的演示弹窗用英文界面");
  assert.ok(enPage.includes(`href="${ALIPAY_URL}"`));
  await stat(path.join(out, "og-en.png"));
  assert.match(await readFile(path.join(out, "sitemap.xml"), "utf8"), /\/en\/<\/loc>/);
});

test("英文页除了弹幕装饰、中文入口和中文更新记录，不留中文", () => {
  const visible = enPage
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<div class="danmaku"[\s\S]*?<div class="section-head">/, "")
    .replace(/<ol class="changelog-list">[\s\S]*?<\/ol>/, "")
    .replace(/<a [^>]*lang="zh-CN"[^>]*>[^<]*<\/a>/g, "");
  assert.deepEqual(visible.match(/[\u4e00-\u9fff][^<]*/g) || [], []);
});

test("中文首页的英文入口默认隐藏，由脚本按浏览器语言显示", async () => {
  assert.match(page, /<p class="lang-hint" lang="en" hidden><a href="en\/" hreflang="en">/);
  assert.match(await readFile(path.join(out, "site.js"), "utf8"), /navigator\.languages/);
});
