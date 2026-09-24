import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { readPngSize } from "./lib/png-alpha.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 生成 Chrome Web Store 需要的图片素材：3 张 1280×800 截图与 1 张 440×280 小促销图。
 *
 * 为什么截图也要脚本化：商店要求截图与“最新版本的真实界面”一致，
 * 手工截图一旦忘记随界面更新就会与商店政策冲突（Screenshots should reflect the
 * most up-to-date functionality）。这里复用 store/scene 里加载真实
 * popup.html / popup.css / popup.js 的场景夹具，因此界面元素永远来自源码本身。
 *
 * 运行：npm run store:assets
 * 输出：store/assets/*.png（需提交）
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

const scenes = [
  {
    file: "screenshot-1-cache.png",
    tab: "cache",
    before: (page) => page.evaluate(() => globalThis.__storeScene.setCacheMode("video")),
    kicker: "完整缓存",
    headline: "一键把视频缓存到本机",
    bullets: ["按账号实际返回的最高画质下载", "音视频在本机合并为单个 MP4，不转码", "关掉页面也会继续，断点自动续传"],
    caption: "缓存页：画质、体积、进度与多任务徽标"
  },
  {
    file: "screenshot-2-assist.png",
    tab: "assist",
    before: null,
    kicker: "播放提前加载",
    headline: "拖动进度条更跟手",
    bullets: ["取得首个媒体范围后立即预热前方分段", "完整命中直接用本机数据回给播放器", "只改配色，原生进度条交互不变"],
    caption: "播放页：提前加载开关与进度条配色"
  },
  {
    file: "screenshot-3-library.png",
    tab: "library",
    before: null,
    kicker: "本地片库",
    headline: "随时播放或导出文件",
    bullets: ["列出已缓存视频的体积与状态", "再次打开原视频即用本地数据播放", "保存为文件或删除，释放空间"],
    caption: "片库页：缓存列表、保存与删除"
  }
];

const server = createServer(async (request, response) => {
  try {
    const file = path.resolve(root, "." + decodeURIComponent(new URL(request.url, "http://local").pathname));
    if (!file.startsWith(root)) throw new Error("outside root");
    const data = await readFile(file);
    const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : file.endsWith(".png") ? "image/png" : "text/javascript";
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

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chromium" });
try {
  const popupPage = await browser.newPage({
    viewport: { width: POPUP_WIDTH, height: POPUP_HEIGHT },
    deviceScaleFactor: 2 // 以 2 倍捕获、1 倍显示，等宽数码与中文都保持锐利
  });
  const errors = [];
  popupPage.on("pageerror", (error) => errors.push(error.message));
  await popupPage.goto(`${origin}/store/scene/popup-scene.html`);
  await popupPage.waitForFunction(() => globalThis.__storeScene?.ready === true);
  if (errors.length) throw new Error(`场景夹具报错：${errors.join("；")}`);

  for (const scene of scenes) {
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
    if (fit.scrollHeight > POPUP_HEIGHT + 1) {
      throw new Error(`${scene.file}：弹窗内容高 ${fit.scrollHeight}px，超过 ${POPUP_HEIGHT}px 会被裁断`);
    }
    if (fit.footerBottom > POPUP_HEIGHT + 1) {
      throw new Error(`${scene.file}：页脚底部 ${fit.footerBottom}px 超出视口`);
    }

    // 只截到内容底部：固定 640 高会在面板下方留一大片空白，看起来像没做完的界面。
    const popup = await popupPage.screenshot({
      clip: { x: 0, y: 0, width: POPUP_WIDTH, height: fit.shellHeight }
    });
    const file = path.join(output, scene.file);
    await composeFrame(browser, scene, popup, iconUrl, fit.shellHeight, file);
    assertSize(file, 1280, 800);
    console.log(`${scene.file}  1280×800  弹窗内容 ${fit.shellHeight}px`);
  }
  await popupPage.close();

  const promo = path.join(output, "promo-440x280.png");
  await composePromo(browser, iconUrl, promo);
  assertSize(promo, 440, 280);
  console.log("promo-440x280.png  440×280");
} finally {
  await browser.close();
  server.close();
}

/**
 * 1280×800 截图 = 左侧文案 + 右侧真实弹窗。
 *
 * 刻意用 1 倍像素：弹窗图片按 2 倍截取、显示时缩到 1 倍，
 * 既满足商店“方角、无内边距、不得模糊”的要求，又让中文保持可读字号。
 */
/** 商店对素材尺寸是硬性要求，生成后立刻回读校验，避免上传时才发现尺寸不对。 */
function assertSize(file, width, height) {
  const actual = readPngSize(readFileSync(file));
  if (actual.width !== width || actual.height !== height) {
    throw new Error(`${path.basename(file)} 尺寸为 ${actual.width}×${actual.height}，应为 ${width}×${height}`);
  }
}

async function composeFrame(browser, scene, popup, iconUrl, panelHeight, file) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
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
    .brand span { font-size: 19px; font-weight: 700; letter-spacing: -0.01em; color: #17607c; }
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
      <div class="brand"><img src="${iconUrl}" alt=""><span>影哨</span></div>
      <p class="kicker">${scene.kicker}</p>
      <h1>${scene.headline}</h1>
      <ul>${scene.bullets.map((item) => `<li>${item}</li>`).join("")}</ul>
      <p class="note">界面为真实扩展截图。非官方扩展，与哔哩哔哩无隶属或授权关系。</p>
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
async function composePromo(browser, iconUrl, file) {
  const page = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
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
    h1 { font-size: 30px; font-weight: 780; letter-spacing: -0.02em; }
    p { font-size: 14px; color: rgba(255,255,255,0.86); }
  </style></head><body>
    <img src="${iconUrl}" alt="">
    <h1>影哨</h1>
    <p>提前加载 · 缓存到本机 · 离线播放</p>
  </body></html>`);
  await page.screenshot({ path: file });
  await page.close();
}
