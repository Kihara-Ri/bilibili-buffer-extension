import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSite, serveSite } from "../scripts/build-site.mjs";
import { chromiumLaunchOptions } from "../scripts/lib/browser-launch.mjs";

// 官网浏览器检查（npm run test:site）：真实渲染构建产物，覆盖截图看不出来的问题——
// 手机宽度横向溢出、演示弹窗没加载或被裁、首屏信息行把单字挤到下一行、减少动态偏好下仍在动画、深色模式没生效。

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const out = await mkdtemp(path.join(tmpdir(), "haineicunzhi-site-check-"));
await buildSite(out);
const server = await serveSite(out);
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));

/** 打开首页并等演示弹窗就绪、高度自适应完成。 */
async function open(options) {
  const page = await browser.newPage(options);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/`);
  await page.locator(".demo-frame").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector(".demo-frame").contentDocument?.querySelector("#scene-result")?.textContent === "ready", null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector(".demo-frame").style.height !== "");
  return { page, errors };
}

const results = {};
try {
  for (const [name, options] of [["phone", { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }], ["desktop", { viewport: { width: 1280, height: 800 } }]]) {
    const { page, errors } = await open(options);
    const layout = await page.evaluate(() => {
      const frame = document.querySelector(".demo-frame");
      const box = frame.getBoundingClientRect();
      const shell = frame.contentDocument.querySelector(".app-shell");
      const meta = [...document.querySelectorAll(".hero-meta span")].map((span) => span.getClientRects().length);
      const verse = [...document.querySelectorAll(".verse-line")].map((line) => line.getClientRects().length);
      const cards = [...document.querySelectorAll(".food-card")];
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth,
        demoInside: box.left >= 0 && box.right <= innerWidth,
        demoInnerScroll: frame.contentDocument.documentElement.scrollWidth,
        // 演示高度跟随弹窗内容：既不留大片空白，也不裁掉页脚。
        demoFits: Math.abs(frame.clientHeight - Math.min(600, Math.ceil(shell.getBoundingClientRect().height))) <= 2,
        brand: frame.contentDocument.querySelector(".brand-name")?.textContent,
        meta,
        verse,
        // 投喂卡片：电脑上一行四张、手机上两两一排；菜名不折行，卡片不超出视口。
        cardRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
        cardNames: cards.map((card) => card.querySelector(".food-name").getClientRects().length),
        cardsInside: cards.every((card) => card.getBoundingClientRect().right <= innerWidth)
      };
    });
    assert.equal(layout.scrollWidth, layout.innerWidth, `${name}：页面出现横向滚动 ${JSON.stringify(layout)}`);
    assert(layout.demoInside && layout.demoInnerScroll <= 360 && layout.demoFits, `${name}：演示弹窗越界或高度不对 ${JSON.stringify(layout)}`);
    assert.equal(layout.brand, "海内存知", "演示弹窗没有加载真实界面");
    // 「打开支付宝投喂」只在触屏手机上出现：电脑上扫码即可，按钮没有意义。
    const alipayShown = await page.evaluate(() => getComputedStyle(document.querySelector(".button-alipay")).display !== "none");
    assert.equal(alipayShown, name === "phone", `${name}：打开支付宝按钮的显示状态不对`);
    assert.equal(layout.cardRows, name === "phone" ? 2 : 1, `${name}：投喂卡片排布不对 ${JSON.stringify(layout)}`);
    assert(layout.cardNames.every((lines) => lines === 1) && layout.cardsInside, `${name}：投喂卡片菜名折行或越界 ${JSON.stringify(layout)}`);
    assert(layout.meta.every((lines) => lines === 1) && layout.verse.every((lines) => lines === 1), `${name}：信息行或诗句被拆行 ${JSON.stringify(layout)}`);
    // 演示可交互：切到片库后高度随内容变化。
    const before = await page.evaluate(() => document.querySelector(".demo-frame").clientHeight);
    await page.frameLocator(".demo-frame").locator('[data-panel-view="library"]').click();
    await page.waitForFunction((height) => document.querySelector(".demo-frame").clientHeight !== height, before);
    assert.deepEqual(errors, [], `${name}：页面报错`);
    results[name] = { demoHeight: before, meta: layout.meta.length };
    await page.close();
  }

  // 减少动态：首页不应有任何正在运行的动画（漂浮、海浪、进度条、转圈）。
  const calm = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await calm.goto(`${origin}/`);
  const running = await calm.evaluate(() => document.getAnimations().filter((animation) => animation.playState === "running").length);
  assert.equal(running, 0, "减少动态偏好下仍有动画在运行");
  const level = await calm.evaluate(() => document.querySelector(".keep-bottle").style.getPropertyValue("--level"));
  assert.equal(level, "0.5", "减少动态偏好下水位应固定在半瓶");
  await calm.close();

  // 深色模式：正文底色要跟着切换，不能停在浅色。
  const backgrounds = {};
  for (const colorScheme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme });
    await page.goto(`${origin}/`);
    backgrounds[colorScheme] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.close();
  }
  assert.notEqual(backgrounds.light, backgrounds.dark, "深色模式没有生效");

  console.log(JSON.stringify({ ok: true, ...results, reducedMotion: true, backgrounds }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(out, { recursive: true, force: true });
}
