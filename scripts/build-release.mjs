import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const unpacked = path.join(dist, "unpacked");

await rm(unpacked, { recursive: true, force: true });
await mkdir(unpacked, { recursive: true });
for (const entry of ["assets", "rules", "src", "manifest.json", "offscreen.html", "popup.css", "popup.html"]) {
  await cp(path.join(root, entry), path.join(unpacked, entry), { recursive: true });
}

await rm(path.join(unpacked, "src", "dev-reload.js"), { force: true });
const backgroundPath = path.join(unpacked, "src", "background.js");
const background = await readFile(backgroundPath, "utf8");
const releaseBackground = background
  .replace('import { startDevReload } from "./dev-reload.js";\n', "")
  .replace("\nstartDevReload();\n", "\n");
if (releaseBackground === background || releaseBackground.includes("startDevReload")) {
  throw new Error("无法从发布构建中剥离开发态热更新入口");
}
await writeFile(backgroundPath, releaseBackground);

const manifestPath = path.join(unpacked, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
manifest.host_permissions = manifest.host_permissions.filter((entry) => !entry.startsWith("http://127.0.0.1/"));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon || {}),
  ...Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
  ...(manifest.declarative_net_request?.rule_resources || []).map((entry) => entry.path),
  "offscreen.html",
  "popup.css"
].filter(Boolean);
for (const entry of new Set(referenced)) {
  await stat(path.join(unpacked, entry));
}

const archive = path.join(dist, `bili-buffer-extension-${manifest.version}.zip`);
await rm(archive, { force: true });
const zipped = spawnSync("zip", ["-q", "-r", archive, "."], { cwd: unpacked, encoding: "utf8" });
if (zipped.status !== 0) throw new Error(zipped.stderr || "zip 构建失败");

console.log(`发布目录：${unpacked}`);
console.log(`发布压缩包：${archive}`);
