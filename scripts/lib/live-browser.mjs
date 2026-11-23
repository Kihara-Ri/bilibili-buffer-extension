import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { chromiumLaunchOptions } from "./browser-launch.mjs";

const appData = process.platform === "darwin" ? join(homedir(), "Library", "Application Support")
  : process.platform === "win32" ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    : join(homedir(), ".local", "share");

export const LIVE_BROWSER_PROFILE = join(appData, "Haineicunzhi", "Bilibili Test Chrome");

async function hasProfile(directory) {
  try {
    if ((await stat(directory)).isDirectory()) return true;
    throw new Error("独立测试 Chrome 的资料路径不是目录。");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * 真实 B 站测试共用仓库外的专用 Chrome 资料目录。只有本次创建的匿名目录随关闭清理。
 * @param {import("playwright").BrowserType} chromium
 * @param {{extension: string, mode?: "saved" | "create" | "anonymous", profileDirectory?: string, headless?: boolean}} options
 * @returns {Promise<{context: import("playwright").BrowserContext, persistent: boolean, close: () => Promise<void>}>}
 */
export async function openLiveBrowser(chromium, { extension, mode = "saved", profileDirectory = LIVE_BROWSER_PROFILE, headless = false }) {
  if (mode === "create") await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const persistent = mode !== "anonymous" && await hasProfile(profileDirectory);
  const directory = persistent ? profileDirectory : await mkdtemp(join(tmpdir(), "haineicunzhi-live-"));
  const cleanup = async () => {
    if (!persistent) await rm(directory, { recursive: true, force: true });
  };
  try {
    const context = await chromium.launchPersistentContext(directory, chromiumLaunchOptions({
      headless,
      // 沿用真实站点测试的启动参数，避免把站点的 412 拒绝当成扩展故障。
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        "--disable-blink-features=AutomationControlled"
      ]
    }));
    return {
      context,
      persistent,
      async close() {
        try { await context.close(); } finally { await cleanup(); }
      }
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
