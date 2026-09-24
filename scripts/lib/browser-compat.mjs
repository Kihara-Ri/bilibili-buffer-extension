// Chrome 版本兼容判定的共用逻辑。
//
// 背景：2026-09-23 用户 Chrome 升到 154 后插件完全不可用，而仓库的浏览器验收
// 仍只跑在 Playwright 自带的 153 上——版本差一档，问题没人发现。这里的职责是
// 把「本机真实 Chrome 版本」「验收实际使用的浏览器版本」和「已验收清单」三者对上。
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** @param {string} version @returns {number} 主版本号；无法解析时为 0 */
export function majorOf(version) {
  const matched = /^(\d+)\./.exec(String(version || "").trim());
  return matched ? Number(matched[1]) : 0;
}

/**
 * 读取已验收清单。每条记录必须写明主版本、验收时的具体构建与证据，
 * 这样「已验收」是可复核的事实，而不是一句声明。
 * 套件列表取顶层 suites；单条记录可用 suites 覆盖，便于某版本只跑部分套件。
 * @param {string} root @returns {Promise<{path:string, note:string, suites:string[], entries:Array<object>}>}
 */
export async function readVerifiedVersions(root) {
  const file = path.join(root, "browser-compat.json");
  const parsed = JSON.parse(await readFile(file, "utf8"));
  const entries = Array.isArray(parsed.verified) ? parsed.verified : [];
  const suites = [...new Set([...(parsed.suites || []), ...entries.flatMap((entry) => entry.suites || [])])];
  return { path: file, note: parsed.note || "", suites, entries };
}

/** 从可执行文件读版本；用于确认某个 chrome 二进制到底是谁。 @returns {string|null} */
export function versionOfExecutable(executable) {
  try {
    const output = execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 20000 }).trim();
    return /(\d+\.\d+\.\d+\.\d+)/.exec(output)?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * 本机用户实际使用的 Chrome。macOS 读 Info.plist；其它平台仅在能定位到时返回。
 * @returns {{version:string, executable:string, source:string}|null}
 */
export function detectInstalledChrome(platform = process.platform) {
  const candidates = platform === "darwin"
    ? ["/Applications/Google Chrome.app"]
    : platform === "win32"
      ? [path.join(process.env["PROGRAMFILES"] || "C:\\Program Files", "Google", "Chrome", "Application")]
      : ["/opt/google/chrome", "/usr/bin/google-chrome"];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (platform === "darwin") {
      const plist = path.join(candidate, "Contents", "Info.plist");
      if (!existsSync(plist)) continue;
      try {
        const version = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], { encoding: "utf8", timeout: 20000 }).trim();
        const executable = path.join(candidate, "Contents", "MacOS", "Google Chrome");
        return { version, executable, source: "本机已安装的 Google Chrome" };
      } catch {
        continue;
      }
    }
    return { version: versionOfExecutable(candidate) || "0.0.0.0", executable: candidate, source: "本机已安装的 Google Chrome" };
  }
  return null;
}

/**
 * Playwright `channel: 'chromium'` 实际会启动的浏览器（Chrome for Testing）。
 * 验收跑在哪个浏览器上必须能报出来，否则「跑过了」可能跑的是另一档版本。
 * @returns {{version:string, executable:string, source:string}|null}
 */
export function detectPlaywrightChromium({ platform = process.platform, arch = process.arch, home = os.homedir(), env = process.env } = {}) {
  const cacheRoots = [env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, "Library", "Caches", "ms-playwright"), path.join(home, ".cache", "ms-playwright")].filter(Boolean);
  // 同一个 chromium-<build> 目录下按平台/架构分文件夹；两种 Mac 架构都要试，否则 Intel 机器会静默探测不到。
  const layouts = {
    darwin: [["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
             ["chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]],
    linux: [["chrome-linux64", "chrome"], ["chrome-linux", "chrome"]],
    win32: [["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"]]
  };
  const candidates = layouts[platform];
  if (!candidates) return null;
  for (const cacheRoot of cacheRoots) {
    if (!existsSync(cacheRoot)) continue;
    let entries = [];
    try {
      entries = readdirSync(cacheRoot);
    } catch {
      continue;
    }
    for (const entry of entries.filter((name) => name.startsWith("chromium-")).sort().reverse()) {
      for (const layout of candidates) {
        const executable = path.join(cacheRoot, entry, ...layout);
        if (!existsSync(executable)) continue;
        const version = versionOfExecutable(executable);
        if (version) return { version, executable, source: `Playwright 自带（${entry}）` };
      }
    }
  }
  return null;
}

/** @param {Array<object>} entries @param {number} major */
export function isVerified(entries, major) {
  return entries.some((entry) => Number(entry.major) === Number(major));
}

/** @param {Array<object>} entries */
export function highestVerifiedMajor(entries) {
  return entries.reduce((max, entry) => Math.max(max, Number(entry.major) || 0), 0);
}
