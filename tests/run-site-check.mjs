import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BOTTLES_API, buildSite, serveSite } from "../scripts/build-site.mjs";
import { chromiumLaunchOptions } from "../scripts/lib/browser-launch.mjs";

// 官网浏览器检查（npm run test:site）：真实渲染构建产物，覆盖截图看不出来的问题——
// 手机宽度横向溢出、演示弹窗没加载或被裁、首屏信息行把单字挤到下一行、减少动态偏好下仍在动画、深色模式没生效。

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const out = await mkdtemp(path.join(tmpdir(), "haineicunzhi-site-check-"));
await buildSite(out);
const server = await serveSite(out);
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));

// 「扔一只漂流瓶」的计数接口在作者的服务器上：测试里每个页面都换成本地假接口，绝不碰线上数据。
// 每个页面一份独立计数；POST 记录收到的请求体，供下面的漂流瓶检查断言。
const bottleRequests = [];
const openPage = browser.newPage.bind(browser);
browser.newPage = async (options) => {
  const page = await openPage(options);
  const counts = { total: 41, tags: { smooth: 20, offline: 9, quality: 0 } };
  let thrown = false;
  await page.route(BOTTLES_API, async (route) => {
    const request = route.request();
    if (page.bottleMode === "down") return route.fulfill({ status: 503, body: "" });
    if (request.method() === "POST") {
      const body = request.postDataJSON();
      bottleRequests.push({ body, headers: await request.allHeaders() });
      const accepted = !thrown;
      thrown = true;
      if (accepted) { counts.total += 1; if (body.tag) counts.tags[body.tag] += 1; }
      return route.fulfill({ json: { accepted, ...counts }, headers: { "Access-Control-Allow-Origin": "*" } });
    }
    return route.fulfill({ json: counts, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  return page;
};

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
        // 功能与隐私卡片：图标按 34px 显示；隐私卡片四张并排，标题文字必须一行，否则同排卡片高低不齐。
        cardIcons: [...document.querySelectorAll(".feature .card-icon, .promise .card-icon")].map((icon) => { const box = icon.getBoundingClientRect(); return `${Math.round(box.width)}x${Math.round(box.height)}`; }),
        promiseTitleLines: [...document.querySelectorAll(".promise h3")].map((title) => { const range = document.createRange(); range.selectNodeContents(title.lastChild); return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size; }),
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
    assert.deepEqual(layout.cardIcons, Array(7).fill("34x34"), `${name}：卡片图标缺失或尺寸不对`);
    assert(layout.promiseTitleLines.every((lines) => lines === 1), `${name}：隐私卡片标题折行 ${JSON.stringify(layout.promiseTitleLines)}`);
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

  // 顶栏小瓶：水位＝阅读进度；滚动时摇一下，减少动态时不摇。
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${origin}/`);
    const read = () => page.evaluate(() => document.querySelector(".bar-bottle").style.getPropertyValue("--read"));
    assert.equal(await read(), "0.00", "页首时顶栏小瓶应几乎是空的");
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; scrollTo(0, document.documentElement.scrollHeight); });
    await page.waitForTimeout(150);
    assert.equal(await read(), "1.00", "读到页尾时顶栏小瓶应装满");
    assert.ok(await page.evaluate(() => document.querySelector(".bar-bottle").classList.contains("is-rocking")), "滚动时小瓶应摇一下");
    // 水面真的在动：同一块水在页首与页尾的位置不同
    const water = await page.evaluate(() => getComputedStyle(document.querySelector(".bar-water")).transform);
    assert.notEqual(water, "none");
    await page.close();
    const calmBar = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    await calmBar.goto(`${origin}/`);
    await calmBar.evaluate(() => scrollTo(0, 900));
    await calmBar.waitForTimeout(150);
    assert.ok(!(await calmBar.evaluate(() => document.querySelector(".bar-bottle").classList.contains("is-rocking"))), "减少动态时小瓶不应摇");
    await calmBar.close();
  }

  // 时差钟：用固定时区（都不实行夏令时）验证文案与时间。
  const clocks = {};
  for (const [pathname, timezoneId, pattern] of [
    ["/", "Asia/Tokyo", /^B 站那里比你慢 1 小时/],
    ["/", "Asia/Shanghai", /^你和 B 站在同一个时区/],
    ["/en/", "Asia/Kolkata", /^Bilibili is 2\.5 hours ahead of you/],
    ["/en/", "Pacific/Honolulu", /^Bilibili is 18 hours ahead of you/]
  ]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, timezoneId });
    await page.goto(`${origin}${pathname}`);
    const clock = await page.evaluate(() => ({
      hidden: document.querySelector(".clock").hidden,
      local: document.querySelector('[data-clock="local"]').textContent,
      bilibili: document.querySelector('[data-clock="bilibili"]').textContent,
      note: document.querySelector("[data-clock-note]").textContent,
      expectedLocal: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date()),
      expectedBeijing: new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" }).format(new Date())
    }));
    assert.equal(clock.hidden, false, `${timezoneId}：有脚本时应显示时差钟`);
    assert.equal(clock.local, clock.expectedLocal, `${timezoneId}：本地时间不对 ${JSON.stringify(clock)}`);
    assert.equal(clock.bilibili, clock.expectedBeijing, `${timezoneId}：北京时间不对 ${JSON.stringify(clock)}`);
    assert.match(clock.note, pattern, `${timezoneId}：时差说明不对 ${JSON.stringify(clock)}`);
    clocks[timezoneId] = clock.note;
    await page.close();
  }

  // 发一条弹幕：文字只走 textContent，不发请求、不改地址；飘完自动移除。
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${origin}/`);
    // 先滚到输入框并等懒加载图片（如投喂二维码）加载完，之后再统计请求
    await page.locator("#danmaku-input").scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    const before = page.url();
    await page.fill("#danmaku-input", "<b>海外党</b>报到");
    await page.press("#danmaku-input", "Enter");
    const sent = await page.evaluate(() => {
      const item = document.querySelector(".danmaku-mine");
      return { text: item?.textContent, children: item?.children.length, distance: item?.style.getPropertyValue("--distance"), input: document.querySelector("#danmaku-input").value, status: document.querySelector("[data-danmaku-status]").textContent };
    });
    assert.equal(sent.text, "<b>海外党</b>报到", "弹幕文字应原样显示");
    assert.equal(sent.children, 0, "弹幕文字不得被当成 HTML 解析");
    assert.match(sent.distance, /^\d+px$/);
    assert.equal(sent.input, "");
    assert.match(sent.status, /已发送/);
    assert.equal(page.url(), before, "发弹幕不应改变地址");
    // 漂流瓶计数会在滚到这一带时取一次，与发弹幕无关，不计入。
    const danmakuRequests = requests.filter((url) => url !== BOTTLES_API);
    assert.deepEqual(danmakuRequests, [], `发弹幕不应发出任何请求：${danmakuRequests.join(", ")}`);
    await page.evaluate(() => document.querySelector(".danmaku-mine").dispatchEvent(new AnimationEvent("animationend")));
    assert.equal(await page.evaluate(() => document.querySelectorAll(".danmaku-mine").length), 0, "飘完应移除");
    // 空白不发送；连发 8 条最多同时留 6 条
    await page.fill("#danmaku-input", "   ");
    await page.press("#danmaku-input", "Enter");
    assert.equal(await page.evaluate(() => document.querySelectorAll(".danmaku-mine").length), 0);
    for (let index = 0; index < 8; index += 1) {
      await page.fill("#danmaku-input", `第 ${index} 条`);
      await page.press("#danmaku-input", "Enter");
    }
    assert.equal(await page.evaluate(() => document.querySelectorAll(".danmaku-mine").length), 6);
    await page.close();
  }

  // 扔一只漂流瓶：首屏不发请求；滚到附近才取计数并显示；选标签扔一只后计数 +1、按钮停用、出现评价入口；
  // 刷新后记得扔过；接口不可用时整节保持隐藏。
  const bottles = {};
  for (const [pathname, unitPattern] of [["/", /只瓶子已经漂到这里/], ["/en/", /bottles have washed up here/]]) {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const fetched = [];
    page.on("request", (request) => { if (request.url() === BOTTLES_API) fetched.push(request.method()); });
    await page.goto(`${origin}${pathname}`);
    await page.waitForTimeout(300);
    assert.deepEqual(fetched, [], `${pathname}：只看首屏时不应请求漂流瓶计数`);
    assert.ok(await page.evaluate(() => document.querySelector(".bottles").hidden), `${pathname}：取到计数前漂流瓶一节应隐藏`);
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; document.querySelector("#friend").scrollIntoView(); });
    await page.waitForFunction(() => !document.querySelector(".bottles").hidden);
    const shown = await page.evaluate(() => ({
      total: document.querySelector("[data-bottles-total]").textContent,
      unit: document.querySelector("[data-bottles-unit]").textContent,
      tagCounts: [...document.querySelectorAll("[data-tag-count]")].map((item) => item.textContent),
      scrollWidth: document.documentElement.scrollWidth,
      unitLines: document.querySelector("[data-bottles-unit]").getClientRects().length
    }));
    assert.equal(shown.total, "41");
    assert.match(shown.unit, unitPattern);
    assert.deepEqual(shown.tagCounts, ["20", "9", ""], `${pathname}：标签计数不对`);
    assert.equal(shown.scrollWidth, 375, `${pathname}：漂流瓶一节导致横向滚动`);
    assert.equal(shown.unitLines, 1, `${pathname}：计数单位不应折行`);
    // 标签单选、可取消：先点「离线缓存」再点「画质」，最后只剩「画质」。
    await page.locator('.bottles-tag[data-tag="offline"]').click();
    await page.locator('.bottles-tag[data-tag="quality"]').click();
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".bottles-tag")].map((tag) => tag.getAttribute("aria-pressed"))), ["false", "false", "true"]);
    const throwButton = page.locator(".bottles-throw");
    const identity = await throwButton.evaluate((button) => { window.__throwButton = button; return true; });
    assert.ok(identity);
    const before = bottleRequests.length;
    await throwButton.click();
    await page.waitForFunction(() => document.querySelector(".bottles-throw").disabled && !document.querySelector(".bottles-throw").classList.contains("is-pending"));
    const after = await page.evaluate(() => ({
      total: document.querySelector("[data-bottles-total]").textContent,
      quality: document.querySelector('.bottles-tag[data-tag="quality"] [data-tag-count]').textContent,
      status: document.querySelector("[data-bottles-status]").textContent,
      review: !document.querySelector(".bottles-review").hidden,
      sameButton: window.__throwButton === document.querySelector(".bottles-throw"),
      flying: document.querySelector(".bottles-fly").classList.contains("is-flying"),
      stored: localStorage.getItem("haineicunzhi.bottle")
    }));
    assert.equal(after.total, "42");
    assert.equal(after.quality, "1");
    assert.ok(after.review && after.sameButton && after.flying, `${pathname}：扔出后的状态不对 ${JSON.stringify(after)}`);
    assert.match(after.stored, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(bottleRequests.length, before + 1);
    const sent = bottleRequests.at(-1);
    assert.deepEqual(sent.body, { tag: "quality" }, "只应发送预设标签");
    assert.equal(sent.headers.cookie, undefined, "扔瓶子不应带 Cookie");
    // 刷新：本机记得扔过，按钮直接停用。
    await page.reload();
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; document.querySelector("#friend").scrollIntoView(); });
    await page.waitForFunction(() => !document.querySelector(".bottles").hidden);
    assert.ok(await page.evaluate(() => document.querySelector(".bottles-throw").disabled), `${pathname}：刷新后应记得已经扔过`);
    bottles[pathname] = after.status;
    await page.close();
  }
  {
    // 接口挂了（503）时一节保持隐藏，页面不报错。
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.bottleMode = "down";
    await page.goto(`${origin}/`);
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; document.querySelector("#friend").scrollIntoView(); });
    await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => document.querySelector(".bottles").hidden), "接口不可用时漂流瓶一节应保持隐藏");
    assert.deepEqual(errors, []);
    await page.close();
  }

  // 页尾靠岸：页面很长时瓶子先在海里，滚到页尾才上岸；减少动态时直接在岸上。
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${origin}/en/`);
    assert.ok(await page.evaluate(() => document.querySelector(".shore").classList.contains("is-waiting")), "页尾不在视口时瓶子应先在海里");
    await page.locator(".shore").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => !document.querySelector(".shore").classList.contains("is-waiting"));
    await page.close();
    const calmShore = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
    await calmShore.goto(`${origin}/`);
    assert.ok(!(await calmShore.evaluate(() => document.querySelector(".shore").classList.contains("is-waiting"))), "减少动态时瓶子应直接在岸上");
    await calmShore.close();
  }

  // 404：不存在的路径返回「瓶子漂丢了」，状态码 404，样式正常加载。
  {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const response = await page.goto(`${origin}/no/such/page`);
    assert.equal(response.status(), 404);
    const lost = await page.evaluate(() => ({ title: document.querySelector("h1").textContent, styled: getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)", bottle: document.querySelector(".hero-bottle").naturalWidth > 0, scrollWidth: document.documentElement.scrollWidth }));
    assert.equal(lost.title, "这只瓶子漂丢了");
    assert.ok(lost.styled && lost.bottle, `404 页样式或图标没加载 ${JSON.stringify(lost)}`);
    assert.equal(lost.scrollWidth, 375, "404 页不应横向滚动");
    await page.close();
  }

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

  console.log(JSON.stringify({ ok: true, ...results, reducedMotion: true, backgrounds, barColors, clocks, bottles }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(out, { recursive: true, force: true });
}
