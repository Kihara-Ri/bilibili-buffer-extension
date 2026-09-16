import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkIconPadding } from "./lib/png-alpha.mjs";

/**
 * 从 SVG 母版重新生成扩展要用的全部 PNG 图标。
 *
 * 为什么需要这个脚本：图标 PNG 曾经是被“拍平”导出的（整张 128×128 全是不透明白底），
 * 放到深色主题的工具栏上就是一块白方块，也不符合 Chrome 图标规范里
 * “96×96 图形 + 16 像素透明边距”的要求。手工重导出无法复查，所以把生成过程固定成脚本，
 * 并在结束时用 scripts/lib/png-alpha.mjs 自检透明度与留白，防止再次漂移。
 *
 * 运行：npm run icons
 * 生成结果提交进仓库；构建与测试都不依赖这个脚本，也不依赖浏览器。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "assets");

/** 尺寸 → 母版。16/32 走简化版，48/128 走完整版，避免小尺寸糊成一团。 */
const targets = [
  { size: 16, master: "icon-small.svg" },
  { size: 32, master: "icon-small.svg" },
  { size: 48, master: "icon-master.svg" },
  { size: 128, master: "icon-master.svg" }
];

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright").catch(() => {
  throw new Error(
    "未找到 Playwright。图标重导出用到 Chromium 渲染 SVG：\n" +
      "  npm install --no-save playwright && npx playwright install chromium\n" +
      "已有安装时可用 PLAYWRIGHT_MODULE=/绝对路径/playwright/index.mjs npm run icons"
  );
});

const browser = await chromium.launch({ channel: "chromium" });
try {
  for (const { size, master } of targets) {
    const svg = await readFile(path.join(assets, master), "utf8");
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    // 背景必须保持透明：omitBackground 只清掉页面底色，
    // 所以 SVG 自己也不能带任何铺满画布的填充色。
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
    );
    const element = await page.locator("svg").elementHandle();
    const png = await element.screenshot({ omitBackground: true, type: "png" });
    const { padding, artwork } = checkIconPadding(png, size);
    await writeFile(path.join(assets, `icon-${size}.png`), png);
    console.log(`icon-${size}.png  ${master}  图形 ${artwork[0]}×${artwork[1]}  留白 ${padding}px`);
    await page.close();
  }
} finally {
  await browser.close();
}
