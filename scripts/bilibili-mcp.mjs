import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { BilibiliDownloadError, createBilibiliDownloadBrowser } from "./lib/bilibili-download-browser.mjs";
import { createBilibiliMcpServer } from "./lib/bilibili-mcp.mjs";
import { openLiveBrowser } from "./lib/live-browser.mjs";
import { MCP_JOB_DIRECTORY } from "./lib/bilibili-mcp-connection.mjs";
import { createBilibiliNativeBrowser } from "./lib/bilibili-native-browser.mjs";

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const extension = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.env.HAINEICUNZHI_DOWNLOAD_DIR || join(homedir(), "Downloads", "海内存知"));
const isolated = process.argv.includes("--isolated");

const handle = serveStdio(() => createBilibiliMcpServer(async signal => {
  if (!isolated) return createBilibiliNativeBrowser({ outputDirectory: output, signal });
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  let browser;
  try {
    browser = await openLiveBrowser(chromium, { extension, mode: "create", headless: true });
  } catch {
    throw new BilibiliDownloadError("BROWSER_UNAVAILABLE", "无法启动专用 Chromium。请确认已安装 Playwright Chromium，并关闭占用同一资料目录的窗口或任务。");
  }
  return createBilibiliDownloadBrowser(browser, output, signal);
}, version, { jobDirectory: isolated ? join(MCP_JOB_DIRECTORY, "isolated") : MCP_JOB_DIRECTORY, outputDirectory: output }));

// stdout 由 MCP 协议独占。宿主关闭管道、终止进程时释放专用浏览器。
for (const name of ["SIGINT", "SIGTERM"]) process.once(name, () => { void handle.close(); });
