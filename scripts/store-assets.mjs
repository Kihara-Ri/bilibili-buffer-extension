import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { readPngSize } from "./lib/png-alpha.mjs";
import path from "node:path";
import { chromiumLaunchOptions } from "./lib/browser-launch.mjs";
import { fileURLToPath } from "node:url";

/**
 * 生成 Chrome Web Store 需要的图片素材：3 张 1280×800 截图、1 张 440×280 小促销图与 1 张 1400×560 顶部宣传图。
 *
 * 为什么截图也要脚本化：商店要求截图与“最新版本的真实界面”一致，
 * 手工截图一旦忘记随界面更新就会与商店政策冲突（Screenshots should reflect the
 * most up-to-date functionality）。这里复用 store/scene 里加载真实
 * popup.html / popup.css / popup.js 的场景夹具，因此界面元素永远来自源码本身。
 *
 * 中英文各生成一套：中文放 store/assets/，英文放 store/assets/en/。弹窗界面语言由场景的 ?lang= 决定，
 * 左侧文案取自下面的 COPY，两套素材的排版与越界检查完全相同。
 *
 * 运行：npm run store:assets
 * 输出：store/assets/*.png、store/assets/en/*.png（需提交）
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "store", "assets");

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright").catch(() => {
  throw new Error(
    "未找到 Playwright。生成商店素材需要 Chromium：\n" +
      "  npm install --no-save playwright && npx playwright install chromium"
  );
});

/** 弹窗真实尺寸：Chrome 给扩展弹窗的宽度由页面决定，高度上限 600。 */
const POPUP_WIDTH = 360;
const POPUP_HEIGHT = 640;
/** Chrome 给扩展弹窗的最大高度：超过就会出现滚动条，截图里看不出来，必须在这里拦住。 */
const CHROME_POPUP_MAX_HEIGHT = 600;

const scenes = [
  { file: "screenshot-1-cache.png", tab: "current", before: (page) => page.evaluate(() => globalThis.__storeScene.setCacheMode("video")) },
  { file: "screenshot-2-assist.png", tab: "settings", before: null },
  { file: "screenshot-3-library.png", tab: "library", before: null }
];

/**
 * 每种语言的商店文案。brand 是 HTML 片段：中文把「己」紧贴主名、下半句另起一行；
 * 英文名 Kindred Afar 本身就是整句的意思，副行放与弹窗页眉一致的 far, yet near。
 */
const COPY = {
  "zh-CN": {
    output,
    htmlLang: "zh-CN",
    brandName: "海内存知<span>己</span>",
    brandVerse: "天涯若比邻",
    note: "界面为真实扩展截图。非官方扩展，与哔哩哔哩无隶属或授权关系。",
    tagline: "提前加载 · 缓存到本机 · 离线播放",
    marqueeBullets: ["播放时提前加载前方内容，海外看 B 站也少卡顿", "最高可用画质一键缓存到本机，关掉页面也继续", "片库里随时离线播放、暂停续传或导出文件"],
    marqueeNote: "非官方扩展，与哔哩哔哩无隶属或授权关系。",
    scenes: [
      {
        kicker: "完整缓存 · 播放提前加载",
        headline: "一键缓存，播放更跟手",
        bullets: ["默认最高画质，拖动滑杆换档，体积一目了然", "开始后可关闭页面，后台独立完成、断点续传", "播放时提前加载前方内容，实时看到效果"],
        caption: "当前视频：画质滑杆与体积、缓存按钮、提前加载状态"
      },
      {
        kicker: "进度条配色",
        headline: "一眼看出哪段已就绪",
        bullets: ["提前加载的范围在原生进度条上单独着色", "按真实时间索引映射，不按字节比例估算", "只改配色，原生进度条交互不变"],
        caption: "设置：进度条外观、浏览器自检与关于"
      },
      {
        kicker: "本地片库",
        headline: "随时播放、暂停或导出",
        bullets: ["下载中的任务可暂停，随时继续，无需打开原视频", "再次打开原视频即用本地数据播放", "保存为文件，或删除后在提示里撤销"],
        caption: "片库：进度、暂停 / 继续、保存与删除"
      }
    ]
  },
  en: {
    output: path.join(output, "en"),
    htmlLang: "en",
    brandName: "Kindred Afar",
    brandVerse: "far, yet near",
    note: "Real extension screenshots. Unofficial extension, not affiliated with or endorsed by Bilibili.",
    tagline: "Prefetch · Cache locally · Watch offline",
    marqueeBullets: ["Prefetches ahead while you watch, so Bilibili buffers less from abroad", "Caches the best available quality to your device, even after you close the tab", "Play offline, pause, resume or export from your library"],
    marqueeNote: "Unofficial extension, not affiliated with Bilibili.",
    scenes: [
      {
        kicker: "Full cache · Prefetch",
        headline: "One click to cache, smoother playback",
        bullets: ["Starts at the best quality your account gets; drag to change, with the size shown up front", "Close the tab once it starts; it finishes in the background and resumes after drops", "Prefetches ahead while you watch, with live stats"],
        caption: "This video: quality slider and size, Cache button, prefetch status"
      },
      {
        kicker: "Progress bar colors",
        headline: "See at a glance what's ready",
        bullets: ["Prefetched ranges get their own color on the native progress bar", "Mapped from the real time index, not guessed from byte ratios", "Colors only: the native progress bar works as before"],
        caption: "Settings: progress bar, browser check and About"
      },
      {
        kicker: "Local library",
        headline: "Play, pause or export anytime",
        bullets: ["Pause and resume downloads without reopening the video", "Reopen the original video and it plays from local data", "Save as a file, or delete and undo from the toast"],
        caption: "Library: progress, pause / resume, save and delete"
      }
    ]
  }
};

const server = createServer(async (request, response) => {
  try {
    const file = path.resolve(root, "." + decodeURIComponent(new URL(request.url, "http://local").pathname));
    if (!file.startsWith(root)) throw new Error("outside root");
    const data = await readFile(file);
    // SVG 必须给 image/svg+xml：弹窗页眉的 <img> 直接引用矢量图标，按 JS 类型返回会显示成破图。
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : file.endsWith(".png") ? "image/png" : file.endsWith(".svg") ? "image/svg+xml" : "text/javascript";
    response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

// 图标以 data URL 内嵌进合成页：合成页用 setContent 创建，没有基地址可解析相对路径。
const iconBase64 = (await readFile(path.join(root, "assets", "icon-128.png"))).toString("base64");
const iconUrl = `data:image/png;base64,${iconBase64}`;

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  for (const [lang, copy] of Object.entries(COPY)) await renderLanguage(lang, copy);
} finally {
  await browser.close();
  server.close();
}

/** 按一种语言生成整套素材：3 张截图、小促销图、顶部宣传图。 */
async function renderLanguage(lang, copy) {
  await mkdir(copy.output, { recursive: true });
  const popupPage = await browser.newPage({
    viewport: { width: POPUP_WIDTH, height: POPUP_HEIGHT },
    deviceScaleFactor: 2 // 以 2 倍捕获、1 倍显示，等宽数码与中文都保持锐利
  });
  const errors = [];
  popupPage.on("pageerror", (error) => errors.push(error.message));
  await popupPage.goto(`${origin}/store/scene/popup-scene.html?lang=${lang}`);
  await popupPage.waitForFunction(() => globalThis.__storeScene?.ready === true);
  if (errors.length) throw new Error(`场景夹具报错：${errors.join("；")}`);
  const label = path.relative(output, copy.output) || ".";

  let marqueePopup = null;
  for (const [index, base] of scenes.entries()) {
    const scene = { ...base, ...copy.scenes[index] };
    if (scene.before) await scene.before(popupPage);
    await popupPage.evaluate((view) => globalThis.__storeScene.showTab(view), scene.tab);
    await popupPage.waitForTimeout(240);

    // 关键一步：确认这一屏没有被裁掉。截图脚本一旦因为界面变高而截断，
    // 商店里的截图就会与真实功能不符，因此宁可让脚本失败，也不生成坏图。
    const fit = await popupPage.evaluate(() => ({
      scrollHeight: document.querySelector(".app-shell").scrollHeight,
      shellHeight: Math.ceil(document.querySelector(".app-shell").getBoundingClientRect().height),
      footerBottom: Math.round(document.querySelector(".app-footer").getBoundingClientRect().bottom)
    }));
    if (fit.scrollHeight > CHROME_POPUP_MAX_HEIGHT + 1) {
      throw new Error(`${lang}/${scene.file}：弹窗内容高 ${fit.scrollHeight}px，超过 Chrome 弹窗上限 ${CHROME_POPUP_MAX_HEIGHT}px 会出现滚动条`);
    }
    if (fit.footerBottom > POPUP_HEIGHT + 1) {
      throw new Error(`${lang}/${scene.file}：页脚底部 ${fit.footerBottom}px 超出视口`);
    }

    // 只截到内容底部：固定 640 高会在面板下方留一大片空白，看起来像没做完的界面。
    const popup = await popupPage.screenshot({
      clip: { x: 0, y: 0, width: POPUP_WIDTH, height: fit.shellHeight }
    });
    if (scene.tab === "current") marqueePopup = { image: popup, height: fit.shellHeight };
    const file = path.join(copy.output, scene.file);
    await composeFrame(browser, copy, scene, popup, iconUrl, fit.shellHeight, file);
    assertSize(file, 1280, 800);
    console.log(`${label}/${scene.file}  1280×800  弹窗内容 ${fit.shellHeight}px`);
  }
  await popupPage.close();

  const promo = path.join(copy.output, "promo-440x280.png");
  await composePromo(browser, copy, iconUrl, promo);
  assertSize(promo, 440, 280);
  console.log(`${label}/promo-440x280.png  440×280`);

  const marquee = path.join(copy.output, "marquee-1400x560.png");
  await composeMarquee(browser, copy, iconUrl, marqueePopup, marquee);
  assertSize(marquee, 1400, 560);
  console.log(`${label}/marquee-1400x560.png  1400×560`);
}

/**
 * 1280×800 截图 = 左侧文案 + 右侧真实弹窗。
 *
 * 刻意用 1 倍像素：弹窗图片按 2 倍截取、显示时缩到 1 倍，
 * 既满足商店“方角、无内边距、不得模糊”的要求，又让中文保持可读字号。
 */
/** 商店对素材尺寸是硬性要求，生成后立刻回读校验，避免上传时才发现尺寸不对。 */
function assertSize(file, width, height) {
  const buffer = readFileSync(file);
  const actual = readPngSize(buffer);
  if (actual.width !== width || actual.height !== height) {
    throw new Error(`${path.basename(file)} 尺寸为 ${actual.width}×${actual.height}，应为 ${width}×${height}`);
  }
  // 商店要求宣传图为 JPEG 或「24 位 PNG（无 alpha 透明层）」。IHDR 第 25 字节是颜色类型：2 = RGB 真彩色。
  if (buffer[25] !== 2) throw new Error(`${path.basename(file)} 的 PNG 颜色类型为 ${buffer[25]}，应为不带 alpha 的 24 位 RGB`);
}

async function composeFrame(browser, copy, scene, popup, iconUrl, panelHeight, file) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="${copy.htmlLang}"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body {
      width: 1280px; height: 800px; overflow: hidden;
      display: flex; align-items: center; gap: 84px; padding: 0 92px;
      background:
        radial-gradient(1100px 620px at 12% -10%, #ffffff 0%, rgba(255,255,255,0) 62%),
        linear-gradient(152deg, #eaf4fa 0%, #f6fbfd 46%, #e6f1f7 100%);
      font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", sans-serif;
      color: #16323f;
    }
    .copy { width: 430px; flex: none; }
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 38px; }
    .brand img { width: 44px; height: 44px; }
    /* 名字取自「海内存知己，天涯若比邻」：「己」紧贴主名接住上半句，下半句另起一行；主名加粗、诗句减弱。 */
    .brand-name { font-size: 19px; line-height: 1.25; font-weight: 700; color: #17607c; white-space: nowrap; }
    .brand-name span, .brand-verse { font-weight: 400; color: #6f8c99; }
    .brand-verse { font-size: 14px; line-height: 1.4; letter-spacing: 0.04em; }
    .kicker { font-size: 14px; font-weight: 700; letter-spacing: 0.16em; color: #0f7fa8; margin-bottom: 14px; }
    h1 { font-size: 42px; line-height: 1.24; font-weight: 780; letter-spacing: -0.025em; margin-bottom: 30px; }
    ul { list-style: none; display: grid; gap: 16px; }
    li { position: relative; padding-left: 28px; font-size: 17px; line-height: 1.5; color: #33505e; }
    li::before {
      content: ""; position: absolute; left: 0; top: 7px; width: 14px; height: 14px; border-radius: 50%;
      background: #13a9df; box-shadow: inset 0 0 0 4px #d9f0f9;
    }
    .note { margin-top: 34px; font-size: 12px; line-height: 1.6; color: #7b929e; }
    .panel-wrap { flex: none; }
    .panel {
      width: ${POPUP_WIDTH}px; height: ${panelHeight}px; border-radius: 16px; overflow: hidden;
      border: 1px solid rgba(23,96,124,0.14);
      box-shadow: 0 34px 70px -28px rgba(15,70,95,0.42), 0 4px 14px -6px rgba(15,70,95,0.2);
      background: #f8fcfd;
    }
    .panel img { display: block; width: 100%; height: 100%; }
    .panel-caption { margin-top: 16px; text-align: center; font-size: 13px; color: #7b929e; }
  </style></head><body>
    <div class="copy">
      <div class="brand"><img src="${iconUrl}" alt=""><div><div class="brand-name">${copy.brandName}</div><div class="brand-verse">${copy.brandVerse}</div></div></div>
      <p class="kicker">${scene.kicker}</p>
      <h1>${scene.headline}</h1>
      <ul>${scene.bullets.map((item) => `<li>${item}</li>`).join("")}</ul>
      <p class="note">${copy.note}</p>
    </div>
    <div class="panel-wrap">
      <div class="panel"><img src="data:image/png;base64,${popup.toString("base64")}" alt=""></div>
      <p class="panel-caption">${scene.caption}</p>
    </div>
  </body></html>`);

  // 排版越界检查：文案与弹窗面板一旦重叠或溢出画布，截图就不再“清晰、无变形”。
  const layout = await page.evaluate(() => {
    const copy = document.querySelector(".copy").getBoundingClientRect();
    const panel = document.querySelector(".panel").getBoundingClientRect();
    return {
      overlap: copy.right > panel.left,
      overflowX: document.body.scrollWidth > 1280,
      overflowY: document.body.scrollHeight > 800,
      panelInside: panel.right <= 1280 && panel.bottom <= 800 && panel.left >= 0 && panel.top >= 0
    };
  });
  if (layout.overlap || layout.overflowX || layout.overflowY || !layout.panelInside) {
    throw new Error(`${path.basename(file)} 排版越界：${JSON.stringify(layout)}`);
  }
  await page.screenshot({ path: file });
  await page.close();
}

/** 440×280 小促销图：只放图标与名称，缩到一半仍能看清。 */
async function composePromo(browser, copy, iconUrl, file) {
  const page = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="${copy.htmlLang}"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body {
      width: 440px; height: 280px; overflow: hidden;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
      /* 深海军蓝底：图标机身本身是 #13a9df，若背景也用亮蓝会糊成一片看不出轮廓。 */
      background: linear-gradient(148deg, #08283a 0%, #0d425d 56%, #11557a 100%);
      font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", sans-serif;
      color: #ffffff;
    }
    img { width: 104px; height: 104px; filter: drop-shadow(0 8px 18px rgba(4,44,64,0.34)); }
    .title { text-align: center; }
    /* 诗句排法与截图一致：「己」紧贴主名、减弱，「天涯若比邻」另起一行。减弱色在深底上仍约 6:1。 */
    h1 { font-size: 30px; line-height: 1.2; font-weight: 780; letter-spacing: 0.02em; }
    h1 span, .verse { font-weight: 400; color: #9cc3d6; }
    .verse { font-size: 15px; letter-spacing: 0.12em; margin-top: 4px; }
    .tagline { font-size: 12.5px; color: rgba(255,255,255,0.78); }
  </style></head><body>
    <img src="${iconUrl}" alt="">
    <div class="title"><h1>${copy.brandName}</h1><p class="verse">${copy.brandVerse}</p></div>
    <p class="tagline">${copy.tagline}</p>
  </body></html>`);
  await page.screenshot({ path: file });
  await page.close();
}

/**
 * 1400×560 顶部宣传图（Marquee）：左侧诗句与卖点，右侧真实弹窗（「当前视频」页）。
 * 底色与小促销图一致的深海军蓝，商店里两张宣传图看起来是一套。
 */
async function composeMarquee(browser, copy, iconUrl, popup, file) {
  if (!popup) throw new Error("顶部宣传图需要「当前视频」页的弹窗截图");
  const page = await browser.newPage({ viewport: { width: 1400, height: 560 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="${copy.htmlLang}"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body {
      width: 1400px; height: 560px; overflow: hidden;
      display: flex; align-items: center; justify-content: space-between; padding: 0 128px 0 120px;
      background: linear-gradient(148deg, #08283a 0%, #0d425d 56%, #11557a 100%);
      font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", sans-serif;
      color: #ffffff;
    }
    .copy { width: 640px; }
    .brand { display: flex; align-items: center; gap: 22px; margin-bottom: 30px; }
    .brand img { width: 104px; height: 104px; filter: drop-shadow(0 8px 18px rgba(4,44,64,0.34)); }
    /* 诗句排法与小促销图一致：「己」紧贴主名、减弱，「天涯若比邻」另起一行。 */
    h1 { font-size: 56px; line-height: 1.15; font-weight: 780; letter-spacing: 0.02em; white-space: nowrap; }
    h1 span, .verse { font-weight: 400; color: #9cc3d6; }
    .verse { font-size: 24px; letter-spacing: 0.14em; margin-top: 6px; }
    ul { list-style: none; display: grid; gap: 14px; }
    li { position: relative; padding-left: 26px; font-size: 20px; line-height: 1.45; color: rgba(255,255,255,0.9); }
    li::before { content: ""; position: absolute; left: 0; top: 9px; width: 12px; height: 12px; border-radius: 50%; background: #2bb3e6; }
    .note { margin-top: 26px; font-size: 13px; color: #9cc3d6; }
    .panel {
      flex: none; width: 360px; height: ${popup.height}px; border-radius: 16px; overflow: hidden;
      box-shadow: 0 30px 70px -24px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.08);
    }
    .panel img { display: block; width: 100%; height: 100%; }
  </style></head><body>
    <div class="copy">
      <div class="brand"><img src="${iconUrl}" alt=""><div><h1>${copy.brandName}</h1><p class="verse">${copy.brandVerse}</p></div></div>
      <ul>${copy.marqueeBullets.map((item) => `<li>${item}</li>`).join("")}</ul>
      <p class="note">${copy.marqueeNote}</p>
    </div>
    <div class="panel"><img src="data:image/png;base64,${popup.image.toString("base64")}" alt=""></div>
  </body></html>`);
  const layout = await page.evaluate(() => {
    const copy = document.querySelector(".copy").getBoundingClientRect();
    const panel = document.querySelector(".panel").getBoundingClientRect();
    return { overlap: copy.right > panel.left - 40, panelInside: panel.top >= 0 && panel.bottom <= 560 && panel.right <= 1400, copyInside: copy.top >= 0 && copy.bottom <= 560 };
  });
  if (layout.overlap || !layout.panelInside || !layout.copyInside) throw new Error(`marquee-1400x560.png 排版越界：${JSON.stringify(layout)}`);
  await page.screenshot({ path: file });
  await page.close();
}
