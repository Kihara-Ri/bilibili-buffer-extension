import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toReleaseManifest } from "./lib/release-checks.mjs";
import { createZip } from "./lib/zip.mjs";

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

// 用 Node 内置 zlib 打包（Windows 没有 zip 命令）。条目按路径排序、时间戳固定，
// 同一份源码重复构建得到完全相同的 zip，商店包的 SHA-256 可复核（SOURCE_DATE_EPOCH 可覆盖时间戳）。
const archive = path.join(dist, `haineicunzhi-${manifest.version}.zip`);
const files = (await listFiles(unpacked)).sort();
const date = new Date((Number(process.env.SOURCE_DATE_EPOCH) || 1767225600) * 1000); // 2026-01-01T00:00:00Z
const entries = await Promise.all(files.map(async (name) => ({ name, data: await readFile(path.join(unpacked, ...name.split("/"))) })));
await writeFile(archive, createZip(entries, { date }));

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
