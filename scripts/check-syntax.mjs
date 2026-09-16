import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 语法体检：对仓库里所有 .js / .mjs 跑一遍 node --check。
 *
 * 以前这里是一串手写的文件列表，新增文件忘了加就静默漏检；
 * 改成遍历目录后，新脚本、新测试自动纳入。
 * 跳过 node_modules / dist / 临时目录，避免检查构建产物。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipDirectories = new Set(["node_modules", "dist", ".git", ".tmp", ".pi", ".playwright-mcp", "fixtures"]);
const files = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) await walk(full);
    } else if (/\.m?js$/.test(entry.name)) {
      files.push(full);
    }
  }
}
await walk(root);
files.sort();

const failed = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failed.push(`${path.relative(root, file)}\n${result.stderr.trim()}`);
}
if (failed.length) {
  console.error(`语法检查失败 ${failed.length} 个文件：\n\n${failed.join("\n\n")}`);
  process.exit(1);
}
console.log(`语法检查通过：${files.length} 个 JS 文件`);
