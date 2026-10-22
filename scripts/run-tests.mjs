// npm test 的入口：由 Node 自己定位测试文件，并固定以仓库根为工作目录。
//
// 为什么不直接写 `node --test tests/*.test.mjs`：Windows 的 npm 经 cmd.exe 执行脚本，
// cmd 既不展开 *，也不支持 UNC 工作目录（WSL 里的仓库是 \\wsl.localhost\...），会静默退回
// C:\Windows。结果是一个测试都没找到却以 0 退出——「测试通过」是假的。
// 这里一律用脚本自身位置推出仓库根；找不到任何测试文件时直接失败。
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(path.join(root, "tests")).filter((name) => name.endsWith(".test.mjs")).sort();
if (!files.length) {
  console.error(`在 ${path.join(root, "tests")} 下没有找到任何 *.test.mjs`);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...files.map((name) => path.join("tests", name))], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
