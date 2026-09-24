// 在与本机 Chrome 同版本的浏览器上跑全部浏览器验收套件。
//
// 为什么需要它：验收默认跑 Playwright 自带的 Chrome for Testing，它的版本通常比
// 用户实际使用的 Chrome 落后一档。2026-09-23 用户升到 154、仓库还在 153 上验收，
// 于是「套件全绿」和「插件不可用」同时成立。这里把本机 Chrome 的版本对齐到
// 一个可自动化的构建（Chrome for Testing 与本机 Chrome 同构建号），再跑套件。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectInstalledChrome, majorOf, readVerifiedVersions } from "./lib/browser-compat.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheRoot = path.join(root, ".tmp", "cft-cache");
const indexPath = path.join(cacheRoot, "known-good-versions.json");
const INDEX_URL = "https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json";
const INDEX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const PLATFORM_KEYS = {
  "darwin-arm64": "mac-arm64",
  "darwin-x64": "mac-x64",
  "linux-x64": "linux64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "win64"
};
const EXECUTABLE_PATHS = {
  mac: ["chrome-mac-arm64", "chrome-mac-x64"],
  linux: ["chrome-linux64", "chrome-linux"],
  win: ["chrome-win64", "chrome-win"]
};

const platformKey = PLATFORM_KEYS[`${process.platform}-${process.arch}`];
if (!platformKey) {
  console.error(`不支持的平台：${process.platform}-${process.arch}`);
  process.exit(1);
}

const installed = detectInstalledChrome();
if (!installed) {
  console.error("没有探测到本机安装的 Google Chrome；请直接使用 npm run test:playback / test:network / test:popup / test:extension");
  process.exit(1);
}
const targetMajor = majorOf(installed.version);
console.log(`本机 Chrome：${installed.version}（主版本 ${targetMajor}）`);

const { entries, suites } = await readVerifiedVersions(root);
if (!suites.length) {
  console.error("browser-compat.json 没有记录任何套件，无法确定要跑什么");
  process.exit(1);
}
if (!entries.some((entry) => Number(entry.major) === targetMajor)) {
  console.log(`注意：主版本 ${targetMajor} 尚未写入 browser-compat.json 的 verified 列表，本轮通过后再补记录。`);
}

/**
 * 取与本机 Chrome 同主版本的 Chrome for Testing。
 * 优先精确同构建号；没有时退到该主版本下最新的构建，并明确打印差异。
 */
async function loadIndex() {
  await mkdir(cacheRoot, { recursive: true });
  // 缓存 24 小时：Chrome 刚更新时需要能立刻查到新版本，又不想每跑一次都联网。
  const fresh = existsSync(indexPath) && Date.now() - statSync(indexPath).mtimeMs < INDEX_MAX_AGE_MS;
  if (fresh) return JSON.parse(await readFile(indexPath, "utf8"));
  try {
    const response = await fetch(INDEX_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    await writeFile(indexPath, text);
    return JSON.parse(text);
  } catch (error) {
    if (existsSync(indexPath)) {
      console.warn(`无法刷新版本清单（${error.message}），改用本地缓存`);
      return JSON.parse(await readFile(indexPath, "utf8"));
    }
    throw new Error(`无法获取 Chrome for Testing 版本清单：${error.message}`);
  }
}

function pickBuild(index) {
  const candidates = index.versions
    .map((entry) => ({ version: entry.version, url: (entry.downloads.chrome || []).find((item) => item.platform === platformKey)?.url }))
    .filter((entry) => entry.url && majorOf(entry.version) === targetMajor);
  if (!candidates.length) throw new Error(`Chrome for Testing 没有 ${targetMajor} 主版本的 ${platformKey} 构建`);
  const exact = candidates.find((entry) => entry.version === installed.version);
  // 没有完全同构建号时退到该主版本下最新的构建，调用方会打印这处差异。
  return exact || candidates[candidates.length - 1];
}

/** 解压 zip：按可用工具依次尝试，避免引入额外依赖。 */
function extract(zipPath, into) {
  const attempts = [
    ["unzip", ["-q", "-o", zipPath, "-d", into]],
    ["python3", ["-m", "zipfile", "-e", zipPath, into]],
    ["tar", ["-xf", zipPath, "-C", into]]
  ];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status === 0) return;
  }
  throw new Error(`无法解压 ${zipPath}（unzip / python3 / tar 都失败）`);
}

function locateExecutable(directory) {
  const layouts = process.platform === "darwin"
    ? EXECUTABLE_PATHS.mac.map((folder) => [folder, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"])
    : process.platform === "win32"
      ? EXECUTABLE_PATHS.win.map((folder) => [folder, "chrome.exe"])
      : EXECUTABLE_PATHS.linux.map((folder) => [folder, "chrome"]);
  for (const layout of layouts) {
    const candidate = path.join(directory, ...layout);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function ensureBrowser() {
  const cached = locateExecutable(path.join(cacheRoot, installed.version));
  if (cached) return { executable: cached, version: installed.version, downloaded: false };
  const build = pickBuild(await loadIndex());
  const directory = path.join(cacheRoot, build.version);
  const existing = locateExecutable(directory);
  if (existing) {
    if (build.version !== installed.version) console.warn(`本机 Chrome ${installed.version} 没有对应测试构建，改用同主版本的 ${build.version}`);
    return { executable: existing, version: build.version, downloaded: false };
  }
  console.log(`下载 Chrome for Testing ${build.version}（${platformKey}）…`);
  const response = await fetch(build.url);
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const zipPath = path.join(cacheRoot, `${build.version}.zip`);
  await writeFile(zipPath, Buffer.from(await response.arrayBuffer()));
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  extract(zipPath, directory);
  await rm(zipPath, { force: true });
  const executable = locateExecutable(directory);
  if (!executable) throw new Error(`解压后没有找到可执行文件：${directory}`);
  return { executable, version: build.version, downloaded: true };
}

const browser = await ensureBrowser();
const actual = /(\d+\.\d+\.\d+\.\d+)/.exec(execFileSync(browser.executable, ["--version"], { encoding: "utf8" }))?.[1];
if (!actual || majorOf(actual) !== targetMajor) {
  throw new Error(`测试浏览器版本与预期不一致：期望主版本 ${targetMajor}，实际 ${actual}`);
}
if (browser.version !== installed.version) {
  console.warn(`提示：本轮验收跑在 ${actual} 上，与本机 Chrome ${installed.version} 有构建号差异（同主版本）。`);
  console.warn("同主版本内的补丁差异不会引入扩展 API 变更，但如果本次是要写入 browser-compat.json，请按实际构建号记录。");
}
console.log(`验收浏览器：${actual}\n`);

const failures = [];
for (const suite of suites) {
  console.log(`=== npm run ${suite}（Chrome ${actual}）===`);
  const result = spawnSync("npm", ["run", suite], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, PLAYWRIGHT_CHROMIUM_EXECUTABLE: browser.executable }
  });
  if (result.status !== 0) failures.push(suite);
  console.log("");
}

if (failures.length) {
  console.error(`以下套件在 Chrome ${actual} 上失败：${failures.join("、")}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, chrome: actual, suites, platform: platformKey }, null, 2));
console.log("全部套件通过。请把这次已验收的版本追加到 browser-compat.json 的 verified 列表。");
