import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkIconPadding } from "./lib/png-alpha.mjs";
import {
  checkDnrRules,
  checkHostPermissions,
  checkManifestFields,
  checkPackagedText,
  checkZipEntries,
  extensionIdFromKey
} from "./lib/release-checks.mjs";
import { readZip } from "./lib/zip.mjs";

/**
 * 发布包上架前的自动化体检。
 *
 * 对着 dist/unpacked 与 dist/*.zip 做静态检查，覆盖的是“构建成功但审不过”的问题：
 * 清单字段超长、图标带不透明底、开发态热更新代码漏进包里、权限超范围、
 * 换了 key 却没同步 DNR 规则、打包进 .DS_Store 之类。
 * 判断逻辑在 scripts/lib/release-checks.mjs（有单元测试），这里只负责读文件与退出码。
 *
 * 运行：npm run verify（npm run build 结束时自动执行）
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.resolve(process.argv[2] || path.join(root, "dist"));
const unpacked = path.join(dist, "unpacked");

const failures = [];
const notes = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
  return condition;
};

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

let manifest;
try {
  manifest = await readJson(path.join(unpacked, "manifest.json"));
} catch (error) {
  console.error(`无法读取发布清单 ${path.join(unpacked, "manifest.json")}：${error.message}`);
  process.exit(1);
}
const pkg = await readJson(path.join(root, "package.json"));

failures.push(...checkManifestFields(manifest, pkg));
failures.push(...checkHostPermissions(manifest));

for (const size of [16, 32, 48, 128]) {
  const declared = manifest.icons?.[String(size)];
  if (!declared) continue;
  try {
    const buffer = await readFile(path.join(unpacked, declared));
    const { padding, artwork } = checkIconPadding(buffer, size);
    notes.push(`图标 ${size}：图形 ${artwork[0]}×${artwork[1]}，透明留白 ${padding}px`);
  } catch (error) {
    failures.push(`图标 ${declared} 不符合上架要求：${error.message}`);
  }
}

await expect(
  stat(path.join(unpacked, "src", "dev-reload.js")).then(() => false, () => true),
  "发布包含有 src/dev-reload.js"
);

const packagedFiles = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full);
    else packagedFiles.push(full);
  }
}
await walk(unpacked);
for (const file of packagedFiles) {
  const relative = path.relative(unpacked, file);
  failures.push(...checkPackagedText(relative, await readFile(file, "utf8")));
}

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
  ...(manifest.declarative_net_request?.rule_resources || []).map((entry) => entry.path),
  "offscreen.html",
  "popup.css",
  "privacy.html"
].filter(Boolean);
for (const entry of new Set(referenced)) {
  await expect(
    stat(path.join(unpacked, entry)).then(() => true, () => false),
    `清单或页面引用的文件不存在：${entry}`
  );
}

if (manifest.key) {
  const derivedId = extensionIdFromKey(manifest.key);
  try {
    failures.push(...checkDnrRules(await readJson(path.join(unpacked, "rules", "cdn-headers.json")), derivedId));
  } catch (error) {
    failures.push(`无法读取 rules/cdn-headers.json：${error.message}`);
  }
}

const archive = path.join(dist, `haineicunzhi-${manifest.version}.zip`);
const archiveStats = await stat(archive).then((value) => value, () => null);
if (!archiveStats) {
  failures.push(`未找到发布压缩包 ${path.basename(archive)}`);
} else {
  // 用内置读取器检查压缩包（不依赖系统 unzip）：条目结构、与 dist/unpacked 逐字节一致、manifest 版本。
  let zipped = null;
  try {
    zipped = readZip(await readFile(archive));
  } catch (error) {
    failures.push(`压缩包无法读取：${error.message}`);
  }
  if (zipped) {
    failures.push(...checkZipEntries([...zipped.keys()]));
    // ZIP 条目统一用 / 分隔；Windows 上 path.relative 给的是反斜杠。
    const unpackedFiles = packagedFiles.map((file) => path.relative(unpacked, file).split(path.sep).join("/")).sort();
    expect(
      unpackedFiles.length === zipped.size && unpackedFiles.every((name) => zipped.has(name)),
      "压缩包的文件列表与 dist/unpacked 不一致"
    );
    for (const name of unpackedFiles) {
      if (zipped.has(name) && !zipped.get(name).equals(await readFile(path.join(unpacked, ...name.split("/"))))) {
        failures.push(`压缩包里的 ${name} 与 dist/unpacked 不一致`);
      }
    }
    const zipManifest = zipped.get("manifest.json");
    expect(
      zipManifest && JSON.parse(zipManifest.toString("utf8")).version === manifest.version,
      "压缩包里的 manifest 版本与 dist/unpacked 不一致"
    );
  }
  const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
  notes.push(`压缩包 ${path.basename(archive)}  ${(archiveStats.size / 1024).toFixed(1)} KiB  sha256=${digest}`);
}

for (const note of notes) console.log(`· ${note}`);
if (failures.length) {
  console.error("\n发布包检查未通过：");
  for (const message of failures) console.error(`  ✗ ${message}`);
  process.exit(1);
}
console.log("\n✓ 发布包检查通过（清单字段、图标规范、权限范围、无开发态代码、压缩包结构）");
