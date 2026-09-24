// Chrome 版本兼容门禁：本机 Chrome 或验收浏览器跑到未验收的主版本时必须失败。
//
// 只在能探测到浏览器时判定；探测不到（纯 CI、没有 Chrome）时明确跳过而不是假装通过。
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectInstalledChrome,
  detectPlaywrightChromium,
  highestVerifiedMajor,
  isVerified,
  majorOf,
  readVerifiedVersions
} from "./lib/browser-compat.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { entries, note } = await readVerifiedVersions(root);
if (!entries.length) {
  console.error("browser-compat.json 里没有 verified 记录：无法判断 Chrome 兼容性");
  process.exit(1);
}

const installed = detectInstalledChrome();
const acceptance = detectPlaywrightChromium();
const problems = [];

function report(label, browser) {
  if (!browser) {
    console.log(`· ${label}：未探测到（跳过）`);
    return;
  }
  const major = majorOf(browser.version);
  const verified = isVerified(entries, major);
  console.log(`· ${label}：${browser.version}（${browser.source}）—— ${verified ? "已验收" : "未验收"}`);
  if (!verified) {
    problems.push({ label, browser, major, verified });
  }
}

report("本机 Chrome", installed);
report("验收浏览器", acceptance);

if (problems.length) {
  const highest = highestVerifiedMajor(entries);
  console.error("\nChrome 兼容门禁未通过：");
  for (const { label, browser, major } of problems) {
    console.error(`  ${label} ${browser.version}（主版本 ${major}）不在已验收列表中，最高已验收主版本为 ${highest}。`);
  }
  console.error(`
Chrome 更新后必须先在新版本上重跑浏览器验收，再提交：
  npm run test:chrome          # 自动取与本机 Chrome 同版本的 Chrome for Testing 并跑全部浏览器套件
然后把它写进 browser-compat.json 的 verified 列表（含具体构建号与证据）。
说明：${note}`);
  process.exit(1);
}
console.log(`Chrome 兼容门禁通过：已验收主版本 ${entries.map((entry) => entry.major).join("、")}`);
