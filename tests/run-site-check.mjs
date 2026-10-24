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

/** 打开首页（中文 / 或英文 /en/）并等演示弹窗就绪、高度自适应完成。 */
async function open(options, pathname = "/") {
  const page = await browser.newPage(options);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}${pathname}`);
  await page.locator(".demo-frame").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector(".demo-frame").contentDocument?.querySelector("#scene-result")?.textContent === "ready", null, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector(".demo-frame").style.height !== "");
  return { page, errors };
}

const results = {};
try {
  // 320 宽是最窄的常见手机：顶栏要同时放下图标、语言切换、GitHub 与添加按钮。
  const devices = [["small", { viewport: { width: 320, height: 640 }, isMobile: true, hasTouch: true }], ["phone", { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true }], ["desktop", { viewport: { width: 1280, height: 800 } }]];
  const pages = [["zh", "/", "海内存知"], ["en", "/en/", "Kindred Afar"]];
  for (const [[device, options], [lang, pathname, brandName]] of devices.flatMap((entry) => pages.map((target) => [entry, target]))) {
    const name = `${lang}/${device}`;
    const { page, errors } = await open(options, pathname);
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
        cardsInside: cards.every((card) => card.getBoundingClientRect().right <= innerWidth),
        // 顶栏：品牌、语言切换、GitHub、添加按钮依次排开，互不重叠、不越出右边
        topbar: [...document.querySelector(".topbar").children].filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect()).map((box) => [Math.round(box.left), Math.round(box.right)])
      };
    });
    assert.equal(layout.scrollWidth, layout.innerWidth, `${name}：页面出现横向滚动 ${JSON.stringify(layout)}`);
    assert(layout.demoInside && layout.demoInnerScroll <= 360 && layout.demoFits, `${name}：演示弹窗越界或高度不对 ${JSON.stringify(layout)}`);
    assert.equal(layout.brand, brandName, `${name}：演示弹窗没有加载真实界面或语言不对`);
    assert(layout.topbar.every(([left, right], index) => right <= layout.innerWidth && (index === 0 || left >= layout.topbar[index - 1][1])), `${name}：顶栏元素重叠或越界 ${JSON.stringify(layout.topbar)}`);
    // 「打开支付宝投喂」只在触屏手机上出现：电脑上扫码即可，按钮没有意义。
    const alipayShown = await page.evaluate(() => getComputedStyle(document.querySelector(".button-alipay")).display !== "none");
    assert.equal(alipayShown, device !== "desktop", `${name}：打开支付宝按钮的显示状态不对`);
    assert.equal(layout.cardRows, device !== "desktop" ? 2 : 1, `${name}：投喂卡片排布不对 ${JSON.stringify(layout)}`);
    assert(layout.cardNames.every((lines) => lines === 1) && layout.cardsInside, `${name}：投喂卡片菜名折行或越界 ${JSON.stringify(layout)}`);
    assert(layout.meta.every((lines) => lines === 1) && layout.verse.every((lines) => lines === 1), `${name}：信息行或诗句被拆行 ${JSON.stringify(layout)}`);
    // 演示可交互：切到片库后高度随内容变化。
    const before = await page.evaluate(() => document.querySelector(".demo-frame").clientHeight);
    const libraryTab = page.frameLocator(".demo-frame").locator('[data-panel-view="library"]');
    // 窄于 360 时演示 iframe 用 CSS zoom 缩小，Playwright 按未缩放坐标点击会落空；这里只验证高度联动，改用 DOM 点击。
    if (device === "small") await libraryTab.evaluate((tab) => tab.click());
    else await libraryTab.click();
    await page.waitForFunction((height) => document.querySelector(".demo-frame").clientHeight !== height, before);
    // 顶栏不得用 backdrop-filter：它每帧重新采样下方正在动画的漂流瓶、海浪和演示 iframe，
    // Chrome 合成时会闪烁，偶尔把下方合成层画到顶栏之上。顶栏改为不透明底色，正文单独成一个层叠上下文。
    const stacking = await page.evaluate(() => {
      const bar = getComputedStyle(document.querySelector(".topbar"));
      return { backdrop: bar.backdropFilter, background: bar.backgroundColor, isolation: getComputedStyle(document.querySelector("main")).isolation };
    });
    assert.equal(stacking.backdrop, "none", `${name}：顶栏仍在用 backdrop-filter`);
    // 顶栏底色随滚动在深海蓝与正文底色之间混合，计算值可能是 rgb() 或 color(srgb …)；只要求不带透明度。
    assert.match(stacking.background, /^(?:rgb\(|color\(srgb )/, `${name}：顶栏底色应不透明 ${stacking.background}`);
    assert.doesNotMatch(stacking.background, /rgba|\//, `${name}：顶栏底色应不透明 ${stacking.background}`);
    assert.equal(stacking.isolation, "isolate", `${name}：正文应隔离为独立层叠上下文`);
    // 滚到演示与动画区域时，顶栏区域的命中目标必须仍是顶栏自身。
    for (const selector of [".hero-bottle", ".demo-frame", ".bar"]) {
      await page.evaluate((target) => { document.documentElement.style.scrollBehavior = "auto"; const el = document.querySelector(target); scrollTo(0, el.getBoundingClientRect().top + scrollY - 20); }, selector);
      const onTop = await page.evaluate(() => [0.1, 0.5, 0.9].every((x) => document.elementFromPoint(innerWidth * x, 30)?.closest(".topbar")));
      assert(onTop, `${name}：滚到 ${selector} 时顶栏被下方内容盖住`);
    }
    await page.evaluate(() => scrollTo(0, 0));
    assert.deepEqual(errors, [], `${name}：页面报错`);
    results[name] = { demoHeight: before, meta: layout.meta.length };
    await page.close();
  }

  // 顶栏随滚动变色：首屏是深海蓝，顶栏也是深色；滚进浅色正文后顶栏变成正文底色、文字变深，
  // 并且每个入口的文字对比度都够读。深色模式下正文本身是深色，顶栏保持深色。
  const barColors = await (async () => {
    const result = {};
    for (const colorScheme of ["light", "dark"]) {
      for (const pathname of ["/", "/en/"]) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme });
        await page.goto(`${origin}${pathname}`);
        const sample = async (y) => {
          await page.evaluate((top) => { document.documentElement.style.scrollBehavior = "auto"; scrollTo(0, top); }, y);
          await page.waitForTimeout(260); // 等 160ms 的颜色过渡结束
          return page.evaluate(() => {
            const parse = (value) => {
              const rgb = value.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
              if (rgb) return rgb.slice(1, 4).map((part) => Number(part) / 255);
              const srgb = value.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/);
              return srgb.slice(1, 4).map(Number);
            };
            const luminance = (value) => {
              const [r, g, b] = parse(value).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
              return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            };
            const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
            const bar = document.querySelector(".topbar");
            const background = luminance(getComputedStyle(bar).backgroundColor);
            const texts = [".topbar-brand span", ".topbar-links a", ".lang-switch", ".github-link span"].map((selector) => {
              const element = bar.querySelector(selector);
              return [selector, Number(contrast(background, luminance(getComputedStyle(element).color)).toFixed(2))];
            });
            return { background: Number(background.toFixed(3)), texts };
          });
        };
        const top = await sample(0);
        // 混合中段：首屏底边在顶栏下方 0–120px 之间，-60 正好是切换点。底色与文字同时渐变时这里会变成灰底灰字。
        const heroBottom = await page.evaluate(() => document.querySelector(".hero").getBoundingClientRect().bottom + scrollY - document.querySelector(".topbar").offsetHeight);
        for (const offset of [-110, -84, -61, -60, -36, -10]) {
          const middle = await sample(heroBottom + offset);
          for (const [selector, ratio] of middle.texts) assert(ratio >= 3, `${colorScheme}${pathname}：变色中段（${offset}px）${selector} 对比度只有 ${ratio}`);
        }
        const far = await page.evaluate(() => document.querySelector("#far").getBoundingClientRect().top + scrollY);
        const below = await sample(far);
        const key = `${colorScheme}${pathname}`;
        result[key] = { top: top.background, below: below.background };
        assert(top.background < 0.05, `${key}：首屏处顶栏应为深色 ${JSON.stringify(top)}`);
        if (colorScheme === "light") assert(below.background > 0.85, `${key}：滚进浅色正文后顶栏应变浅 ${JSON.stringify(below)}`);
        else assert(below.background < 0.05, `${key}：深色模式下顶栏应保持深色 ${JSON.stringify(below)}`);
        for (const [state, data] of [["首屏", top], ["正文", below]]) {
          for (const [selector, ratio] of data.texts) assert(ratio >= 4.5, `${key}：${state}处 ${selector} 对比度只有 ${ratio}`);
        }
        await page.close();
      }
    }
    return result;
  })();

  // 中文首页的英文入口：浏览器语言不含中文才显示，中文浏览器里不打扰。
  for (const [locale, shown] of [["en-US", true], ["zh-CN", false]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale });
    await page.goto(`${origin}/`);
    const visible = await page.evaluate(() => !document.querySelector(".lang-hint").hidden);
    assert.equal(visible, shown, `${locale}：英文入口提示的显示状态不对`);
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

  console.log(JSON.stringify({ ok: true, ...results, reducedMotion: true, backgrounds, barColors }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(out, { recursive: true, force: true });
}
