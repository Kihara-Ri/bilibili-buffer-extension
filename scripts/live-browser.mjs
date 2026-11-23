import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { openLiveBrowser } from "./lib/live-browser.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const extension = fileURLToPath(new URL("../", import.meta.url));
const login = process.argv.includes("--login");
const home = "https://www.bilibili.com/";
const url = new URL(process.argv.slice(2).find(arg => !arg.startsWith("--")) || home);
if (url.protocol !== "https:" || url.hostname !== "www.bilibili.com" || url.username || url.password) {
  throw new Error("请提供 www.bilibili.com 的 HTTPS 网页地址。");
}

const browser = await openLiveBrowser(chromium, { extension, mode: "create" });
const { context } = browser;
let closed = false;
const closeEvent = new Promise(resolve => context.once("close", () => { closed = true; resolve(); }));

async function signedIn() {
  try {
    // 使用同一个浏览器上下文的会话请求本站状态，只读取是否已登录。
    const response = await context.request.get("https://api.bilibili.com/x/web-interface/nav", {
      headers: { referer: home },
      timeout: 5000
    });
    try {
      return response.ok() && (await response.json())?.data?.isLogin === true;
    } finally { await response.dispose(); }
  } catch {
    return false;
  }
}

try {
  if (login) {
    let active = await signedIn();
    if (!active) {
      const page = context.pages()[0] || await context.newPage();
      await page.goto("https://passport.bilibili.com/login", { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      console.log("已打开独立测试 Chrome 的 B 站登录页。");
      while (!closed && !active) {
        await delay(2000);
        if (!closed) active = await signedIn();
      }
    }
    if (active) console.log("B 站登录有效。本机测试 Chrome 会保留会话。");
    else process.exitCode = 1;
  } else {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await page.bringToFront();
    await closeEvent;
  }
} finally {
  await browser.close();
}
