import { createServer } from "node:http";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { STORE_EXTENSION_ID } from "./lib/release-checks.mjs";

/**
 * 构建官网 https://haineicunzhi.kihara.cn（GitHub Pages，见 .github/workflows/pages.yml）。
 *
 * 输出纯静态文件到 dist/site/：
 * - site/ 下的页面源码，占位符 {{VERSION}} {{CHANGELOG}} 等在这里填入，版本与更新记录永远来自仓库本身；
 * - privacy.html：商店「隐私权政策网址」指向它，旧的 github.io 地址由 GitHub 自动跳转到自定义域名；
 * - demo/：真实弹窗演示。复用 store/scene 场景夹具（真实 popup.html / popup.css / popup.js，chrome.* 换成固定数据），
 *   只复制弹窗实际 import 到的模块，后台、Offscreen 与热更新代码不会出现在网站上。
 *
 * 运行：npm run site:build（输出 dist/site）；npm run site:preview（构建并在本机预览）。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SITE_URL = "https://haineicunzhi.kihara.cn";
export const STORE_URL = `https://chromewebstore.google.com/detail/${STORE_EXTENSION_ID}`;
export const REPO_URL = "https://github.com/Kihara-Ri/bilibili-buffer-extension";

const escapeHtml = (text) => text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

/** 开发日志里用到的行内 Markdown：代码、粗体、链接。先转义再替换，正文里的尖括号不会变成标签。 */
function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>');
}

/**
 * 从开发日志取最近几个版本，渲染成「版本号 + 标题」列表。
 * 只取标题：日志正文是写给开发者的（提交号、SHA-256、测试文件名），完整内容链接到 GitHub。
 * 只认「## 1.2.3 · 标题」形式的版本小节；「本轮改动总览」之类的汇总不进网站。
 * @param {string} markdown 开发日志全文
 * @param {number} [count] 取多少个版本
 * @returns {{ html: string, versions: string[] }}
 */
export function renderChangelog(markdown, count = 8) {
  const releases = [];
  for (const heading of markdown.match(/^## .+$/gm) || []) {
    const match = heading.match(/^## (\d+\.\d+\.\d+)\s*(?:补充\s*)?·\s*(.+)$/);
    if (!match) continue;
    releases.push({ version: match[1], title: match[2].trim() });
    if (releases.length === count) break;
  }
  const html = releases
    .map((release) => `          <li class="release"><span class="release-version">${escapeHtml(release.version)}</span><span class="release-title">${renderInline(release.title)}</span></li>`)
    .join("\n");
  return { html, versions: releases.map((release) => release.version) };
}

/** 从弹窗入口出发，沿静态 import 收集它真正用到的模块（相对路径）。 */
async function collectModules(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const relative = queue.shift();
    if (seen.has(relative)) continue;
    seen.add(relative);
    const source = await readFile(path.join(root, relative), "utf8");
    for (const match of source.matchAll(/(?:import|export)\s[^"']*?from\s*["'](\.[^"']+)["']/g)) {
      queue.push(path.posix.join(path.posix.dirname(relative), match[1]));
    }
  }
  return [...seen];
}

/**
 * @param {string} [out] 输出目录，默认 dist/site
 * @returns {Promise<{ out: string, version: string, versions: string[] }>}
 */
export async function buildSite(out = path.join(root, "dist", "site")) {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const changelog = renderChangelog(await readFile(path.join(root, "开发日志.md"), "utf8"));
  if (!changelog.versions.length) throw new Error("开发日志里没有找到「## 版本 · 标题」形式的小节");

  await rm(out, { recursive: true, force: true });
  await mkdir(path.join(out, "assets"), { recursive: true });

  const values = { SITE_URL, STORE_URL, REPO_URL, VERSION: manifest.version, CHANGELOG: changelog.html };
  const template = await readFile(path.join(root, "site", "index.html"), "utf8");
  const page = template.replace(/\{\{(\w+)\}\}/g, (whole, key) => {
    if (!(key in values)) throw new Error(`site/index.html 里有未知占位符 ${whole}`);
    return values[key];
  });
  await writeFile(path.join(out, "index.html"), page);
  for (const file of ["site.css", "site.js"]) await cp(path.join(root, "site", file), path.join(out, file));
  for (const icon of ["icon-master.svg", "icon-small.svg", "icon-32.png", "icon-128.png"]) {
    await cp(path.join(root, "assets", icon), path.join(out, "assets", icon));
  }
  await cp(path.join(root, "privacy.html"), path.join(out, "privacy.html"));
  // 社交分享预览图用商店的顶部宣传图（1400×560，与网站同一套配色）。
  await cp(path.join(root, "store", "assets", "marquee-1400x560.png"), path.join(out, "og.png"));
  await writeFile(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
  await writeFile(
    path.join(out, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE_URL}/</loc></url>\n  <url><loc>${SITE_URL}/privacy.html</loc></url>\n</urlset>\n`
  );

  const demo = path.join(out, "demo");
  const demoFiles = [
    "popup.html", "popup.css", "manifest.json", "assets/icon-small.svg",
    "store/scene/popup-scene.html", "store/scene/popup-scene.mjs",
    ...(await collectModules("src/popup.js"))
  ];
  if (demoFiles.includes("src/dev-reload.js")) throw new Error("弹窗演示不应包含开发态热更新代码");
  for (const file of demoFiles) {
    await mkdir(path.dirname(path.join(demo, file)), { recursive: true });
    await cp(path.join(root, file), path.join(demo, file));
  }
  return { out, version: manifest.version, versions: changelog.versions };
}

/**
 * 本机预览与浏览器测试共用的静态服务：只服务构建产物，不暴露仓库其他文件。
 * @param {string} out 构建输出目录
 * @param {number} [port] 0 表示随机端口
 * @returns {Promise<import("node:http").Server>}
 */
export async function serveSite(out, port = 0) {
  const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain", ".xml": "application/xml" };
  const server = createServer(async (request, response) => {
    try {
      let pathname = decodeURIComponent(new URL(request.url, "http://local").pathname);
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = path.resolve(out, "." + pathname);
      if (!file.startsWith(out)) throw new Error("outside site");
      const data = await readFile(file);
      response.writeHead(200, { "Content-Type": `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8` });
      response.end(data);
    } catch {
      response.writeHead(404).end("not found");
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildSite();
  console.log(`官网已构建：${result.out}（v${result.version}，更新记录 ${result.versions.join(" / ")}）`);
  if (process.argv.includes("--preview")) {
    const server = await serveSite(result.out, Number(process.env.PORT) || 4310);
    console.log(`预览：http://127.0.0.1:${server.address().port}/`);
  }
}
