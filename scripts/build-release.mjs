import { chmod, cp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toReleaseManifest } from "./lib/release-checks.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const unpacked = path.join(dist, "unpacked");

await rm(unpacked, { recursive: true, force: true });
await mkdir(unpacked, { recursive: true });
// privacy.html 会随包发布：弹窗底部的“隐私说明”指向本地副本，
// 这样即使离线也能看到完整的隐私政策，不必依赖外部网址。
for (const entry of ["THIRD_PARTY_NOTICES.md", "assets", "rules", "src", "manifest.json", "offscreen.html", "popup.css", "popup.html", "privacy.html"]) {
  await cp(path.join(root, entry), path.join(unpacked, entry), { recursive: true });
}

await rm(path.join(unpacked, "src", "dev-reload.js"), { force: true });
const backgroundPath = path.join(unpacked, "src", "background.js");
const background = await readFile(backgroundPath, "utf8");
const releaseBackground = background
  .replace('import { startDevReloadBackground } from "./dev-reload.js";\n', "")
  .replace("\nif (chrome.runtime.id) startDevReloadBackground(ensureOffscreenDocument);\n", "\n");
if (releaseBackground === background || releaseBackground.includes("startDevReloadBackground")) {
  throw new Error("无法从发布构建中剥离开发态热更新入口");
}
await writeFile(backgroundPath, releaseBackground);

const offscreenPath = path.join(unpacked, "src", "offscreen.js");
const offscreen = await readFile(offscreenPath, "utf8");
const releaseOffscreen = offscreen
  .replace('import { startDevReloadPolling } from "./dev-reload.js";\n', "")
  .replace("\nif (chrome.runtime.id) startDevReloadPolling();\n", "\n");
if (releaseOffscreen === offscreen || releaseOffscreen.includes("startDevReloadPolling")) {
  throw new Error("无法从发布构建中剥离 Offscreen 热更新轮询器");
}
await writeFile(offscreenPath, releaseOffscreen);

const manifestPath = path.join(unpacked, "manifest.json");
// 发布态清单的变换规则与校验共用 scripts/lib/release-checks.mjs，
// 避免构建剔除了本地域名、而校验仍按旧规则判断。
const manifest = toReleaseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
  ...(manifest.declarative_net_request?.rule_resources || []).map((entry) => entry.path),
  "offscreen.html",
  "popup.css",
  "privacy.html"
].filter(Boolean);
for (const entry of new Set(referenced)) {
  await stat(path.join(unpacked, entry));
}

// zip 会把每个文件的 mtime 写进压缩包，导致同样的源码每次构建出不同的字节、
// 也就无法用 SHA-256 校验“商店里发布的包 = 这个源码构建出来的包”。
// 统一时间戳后，同一份源码重复构建得到完全相同的 zip（SOURCE_DATE_EPOCH 可覆盖）。
await normalizeTimestamps(unpacked);

const archive = path.join(dist, `yingsao-${manifest.version}.zip`);
await rm(archive, { force: true });
// 用排序后的文件列表打包，而不是 zip -r .：目录遍历顺序取决于文件系统，
// 在开发目录与解包目录里会不一样，压缩包字节也就跟着变。
const files = (await listFiles(unpacked)).sort();
const zipped = spawnSync("zip", ["-q", "-X", archive, ...files], { cwd: unpacked, encoding: "utf8" });
if (zipped.status !== 0) throw new Error(zipped.stderr || "zip 构建失败");

console.log(`发布目录：${unpacked}`);
console.log(`发布压缩包：${archive}`);

/** 递归收集相对路径，供排序后打包使用。 */
async function listFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(directory, entry.name), relative)));
    else files.push(relative);
  }
  return files;
}

/**
 * 把目录内所有条目的 mtime 与权限位固定下来，保证 zip 可复现。
 *
 * zip 会把 mtime 和 Unix 权限写进压缩包，两者都随构建环境变化，
 * 于是同一份源码在不同机器上构建出的字节不同，记录 SHA-256 就没有意义。
 * 权限位统一成 644 / 755，与 git 跟踪的形态一致。
 */
async function normalizeTimestamps(directory) {
  const seconds = Number(process.env.SOURCE_DATE_EPOCH) || 1767225600; // 2026-01-01T00:00:00Z
  const stamp = new Date(seconds * 1000);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeTimestamps(full);
      await chmod(full, 0o755);
    } else {
      await chmod(full, 0o644);
    }
    await utimes(full, stamp, stamp);
  }
}
