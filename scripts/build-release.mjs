import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDistribution } from "./lib/distribution-build.mjs";
import { createSignedUpdate } from "./lib/github-update-package.mjs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { createZip } from "./lib/zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const github = process.argv.includes("--github");
const outIndex = process.argv.indexOf("--out");
const dist = outIndex >= 0 ? path.resolve(process.argv[outIndex + 1]) : path.join(root, "dist", ...(github ? ["github"] : []));
// 发布密钥只从本机环境指定的文件读取，不复制进任何产物。
let signingKey;
if (github) {
  if (!process.env.UPDATE_SIGNING_KEY) throw new Error("GitHub 构建需要 UPDATE_SIGNING_KEY 指向签名私钥；先运行 npm run update:key -- /安全目录/key.pem");
  signingKey = createPrivateKey(await readFile(process.env.UPDATE_SIGNING_KEY));
  const pinned = JSON.parse(await readFile(path.join(root, "update-public-key.json"), "utf8")).publicKey;
  const actual = createPublicKey(signingKey).export({format:"jwk"});
  if (!pinned || pinned.x !== actual.x || pinned.y !== actual.y || pinned.crv !== actual.crv) throw new Error("签名私钥与固定公钥不匹配");
}
const unpacked = path.join(dist, "unpacked");

await rm(unpacked, { recursive: true, force: true });
await mkdir(unpacked, { recursive: true });
// privacy.html 会随包发布：弹窗底部的“隐私说明”指向本地副本，
// 这样即使离线也能看到完整的隐私政策，不必依赖外部网址。
// LICENSE 同样随包：GPL-3.0 要求分发（商店 zip 即分发）时附带许可证全文。
// _locales 提供清单里 __MSG_extName__ 等占位符的中英文，缺了 Chrome 会拒绝加载。
for (const entry of ["LICENSE", "THIRD_PARTY_NOTICES.md", "_locales", "assets", "rules", "src", "manifest.json", "offscreen.html", "popup.css", "popup.html", "privacy.html", ...(github ? ["update.html", "update.css", "update-public-key.json"] : [])]) {
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
const snapshot = new Map(await Promise.all((await listFiles(unpacked)).map(async name => [name, await readFile(path.join(unpacked,name))])));
const prepared = prepareDistribution(snapshot, github ? 'github' : 'store');
// 先删除被渠道规则剔除的文件，再写变换后的集合，zip 与 unpacked 来自同一快照。
for (const name of await listFiles(unpacked)) if (!prepared.has(name)) await rm(path.join(unpacked,name));
for (const [name,data] of prepared) { await mkdir(path.dirname(path.join(unpacked,name)),{recursive:true}); await writeFile(path.join(unpacked,name),data); }
const manifest = JSON.parse(prepared.get('manifest.json'));

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
const archive = path.join(dist, `haineicunzhi-${github ? "github-" : ""}${manifest.version}.zip`);
const files = (await listFiles(unpacked)).sort();
const date = new Date((Number(process.env.SOURCE_DATE_EPOCH) || 1767225600) * 1000); // 2026-01-01T00:00:00Z
const entries = await Promise.all(files.map(async (name) => ({ name, data: await readFile(path.join(unpacked, ...name.split("/"))) })));
await writeFile(archive, createZip(entries, { date }));

if (github) await writeFile(path.join(dist, `haineicunzhi-github-${manifest.version}.update.json`), JSON.stringify(createSignedUpdate(prepared, signingKey)));
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
