import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readPngSize } from "../scripts/lib/png-alpha.mjs";
import {
  checkDnrRules,
  checkHostPermissions,
  checkManifestFields,
  checkPackagedText,
  checkZipEntries,
  extensionIdFromKey,
  toReleaseManifest
} from "../scripts/lib/release-checks.mjs";

// 上架合规测试：把 Chrome Web Store 的硬性要求钉在测试里。
// 这里同时测“真实文件符合要求”和“检查函数能识别坏样本”，
// 后者是为了防止检查条件写反导致 verify 永远通过——那比没有检查更危险。

const root = new URL("../", import.meta.url);
const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, root), "utf8"));
const readText = (relative) => readFile(new URL(relative, root), "utf8");

const manifest = await readJson("manifest.json");
const pkg = await readJson("package.json");
// 权限与站点范围的断言都针对“发布态清单”：开发目录里额外带的热更新域名
// 由 scripts/lib/release-checks.mjs 的 toReleaseManifest 负责剔除。
const releaseManifest = toReleaseManifest(manifest);
const EXPECTED_ID = "ppoagkhgdcfchiodhgadpenibndbnhcj";

test("清单字段满足商店与 manifest 的硬性上限", () => {
  assert.deepEqual(checkManifestFields(manifest, pkg), []);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.name.length <= 75, "名称上限 75 字");
  assert.ok(manifest.description.length <= 132, "描述上限 132 字");
});

test("坏清单会被拒绝：超长描述、缺图标、版本不一致、缺 key", () => {
  const base = structuredClone(manifest);
  const broken = (patch) => checkManifestFields({ ...base, ...patch }, pkg);
  assert.ok(broken({ description: "字".repeat(133) }).some((m) => m.includes("132")));
  assert.ok(broken({ name: "字".repeat(76) }).some((m) => m.includes("75")));
  assert.ok(broken({ version: "9.9.9" }).some((m) => m.includes("package.json")));
  assert.ok(broken({ key: undefined }).some((m) => m.includes("key")));
  assert.ok(broken({ manifest_version: 2 }).some((m) => m.includes("manifest_version")));
  const noIcon = structuredClone(base);
  delete noIcon.icons["128"];
  assert.ok(checkManifestFields(noIcon, pkg).some((m) => m.includes("缺少 128")));
  const mismatched = structuredClone(base);
  mismatched.action.default_icon["48"] = "assets/icon-128.png";
  assert.ok(checkManifestFields(mismatched, pkg).some((m) => m.includes("不一致")));
});

test("权限不超出已评审范围，且不含本地开发地址", () => {
  assert.deepEqual(checkHostPermissions(releaseManifest), []);
  // 开发目录必须保留本地热更新域名，发布包必须剔除；两个方向都要钉住。
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1/*"));
  assert.ok(!releaseManifest.host_permissions.some((host) => host.includes("127.0.0.1")));
  assert.ok(checkHostPermissions(manifest).some((m) => m.includes("本地开发域名")));
  assert.deepEqual(manifest.permissions.slice().sort(), [
    "activeTab",
    "alarms",
    "cookies",
    "declarativeNetRequestWithHostAccess",
    "downloads",
    "offscreen",
    "storage",
    "unlimitedStorage"
  ]);
  const extra = checkHostPermissions({ ...manifest, permissions: [...manifest.permissions, "tabs"] });
  assert.ok(extra.some((m) => m.includes("新权限")));
  assert.ok(checkHostPermissions({ host_permissions: ["http://127.0.0.1/*"] }).length === 2);
  for (const broad of ["https://*/*", "*://*/*", "https://*"]) {
    assert.ok(checkHostPermissions({ host_permissions: [broad] }).some((m) => m.includes("通配")), `未拦截过宽权限：${broad}`);
  }
});

test("扩展 ID 与 key 一致，DNR 规则只作用于本扩展发起的请求", () => {
  const id = extensionIdFromKey(manifest.key);
  assert.equal(id, EXPECTED_ID, "换 key 会让 DNR 规则失效并改变扩展 ID");
  return readJson("rules/cdn-headers.json").then((rules) => {
    assert.deepEqual(checkDnrRules(rules, id), []);
    assert.ok(checkDnrRules(rules, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").some((m) => m.includes("未包含当前扩展 ID")));
    const wrong = structuredClone(rules);
    wrong[0].condition.initiatorDomains = ["www.bilibili.com"];
    assert.ok(checkDnrRules(wrong, id).some((m) => m.includes("站点域名")));
  });
});

test("发布包内容检查能识破远程代码、内联脚本与开发态残留", () => {
  assert.deepEqual(checkPackagedText("src/background.js", "export const a = 1;"), []);
  assert.ok(checkPackagedText("src/a.js", "eval('x')").length);
  assert.ok(checkPackagedText("src/a.js", "new Function('return 1')").length);
  assert.ok(checkPackagedText("src/a.js", "importScripts('https://x')").length);
  assert.ok(checkPackagedText("src/a.js", "chrome.tabs.executeScript({})").length);
  assert.ok(checkPackagedText("src/a.js", "const host = 'http://127.0.0.1:8788'").length);
  assert.ok(checkPackagedText("src/a.js", "startDevReloadBackground()").length);
  assert.ok(checkPackagedText("popup.html", "<script>alert(1)</script>").length);
  assert.ok(checkPackagedText("popup.html", '<script src="https://cdn.example.com/a.js"></script>').length);
  assert.deepEqual(checkPackagedText("popup.html", '<script type="module" src="src/popup.js"></script>'), []);
});

test("压缩包结构检查：根目录清单、无垃圾文件、无多余目录层", () => {
  assert.deepEqual(checkZipEntries(["manifest.json", "src/background.js"]), []);
  assert.ok(checkZipEntries(["src/background.js"]).some((m) => m.includes("根目录")));
  assert.ok(checkZipEntries(["manifest.json", "_metadata/verified.json"]).length);
  assert.ok(checkZipEntries(["manifest.json", "assets/.DS_Store"]).length);
  assert.ok(checkZipEntries(["manifest.json", "src/dev-reload.js"]).length);
  assert.ok(checkZipEntries(["manifest.json", "bili-buffer-extension-2.6.3/manifest.json"]).length);
});

test("隐私页面包含 Limited Use 声明、全部权限说明与联系方式", async () => {
  const privacy = await readText("privacy.html");
  const plain = privacy.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const STATEMENT = "The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.";
  // 要求原样连续出现：商店抓取的是页面文本，被标签切断就有被判为“未声明”的风险。
  assert.ok(privacy.includes(STATEMENT), "Limited Use 声明必须原样连续出现在 HTML 中");
  assert.ok(plain.includes(STATEMENT), "去掉标签后仍应能读到完整的 Limited Use 声明");
  for (const permission of releaseManifest.permissions) {
    assert.ok(privacy.includes(`<code>${permission}</code>`), `隐私页面缺少权限说明：${permission}`);
  }
  for (const host of releaseManifest.host_permissions) {
    const domain = host.replace("https://", "").replace("/*", "");
    assert.ok(privacy.includes(domain), `隐私页面缺少域名说明：${domain}`);
  }
  assert.match(privacy, /github\.com\/Kihara-Ri\/bilibili-buffer-extension\/issues/);
  // 页面必须自包含：商店抓取与离线打开时都不能依赖外部资源。
  assert.doesNotMatch(privacy, /<script/i);
  assert.doesNotMatch(privacy, /<link[^>]+href="https?:/i);
});

test("弹窗常驻隐私入口，且隐私页面会随发布包一起分发", async () => {
  const popup = await readText("popup.html");
  assert.match(popup, /<a id="privacy-link"[^>]*href="privacy\.html"/);
  const css = await readText("popup.css");
  assert.match(css, /\.app-footer\s*\{/);
  const build = await readText("scripts/build-release.mjs");
  assert.ok(build.includes('"privacy.html"'), "发布构建必须把 privacy.html 复制进包里");
  const verify = await readText("scripts/verify-release.mjs");
  assert.ok(verify.includes('"privacy.html"'), "发布校验必须确认 privacy.html 存在于包内");
});

test("商店文案与清单保持一致，且覆盖全部权限与素材", async () => {
  const listing = await readText("store/listing.md");
  assert.ok(listing.includes(manifest.description), "listing.md 的摘要必须与 manifest 的 description 一致");
  for (const permission of releaseManifest.permissions) {
    assert.ok(listing.includes(`\`${permission}\``), `listing.md 缺少权限理由：${permission}`);
  }
  for (const host of releaseManifest.host_permissions) {
    assert.ok(listing.includes(host), `listing.md 缺少站点权限说明：${host}`);
  }
  for (const asset of ["screenshot-1-cache.png", "screenshot-2-assist.png", "screenshot-3-library.png", "promo-440x280.png"]) {
    assert.ok(listing.includes(asset), `listing.md 未登记素材：${asset}`);
  }
});

test("商店图片素材存在且尺寸符合商店要求", async () => {
  const expected = [
    ["store/assets/screenshot-1-cache.png", 1280, 800],
    ["store/assets/screenshot-2-assist.png", 1280, 800],
    ["store/assets/screenshot-3-library.png", 1280, 800],
    ["store/assets/promo-440x280.png", 440, 280]
  ];
  for (const [file, width, height] of expected) {
    const buffer = await readFile(new URL(file, root));
    const size = readPngSize(buffer);
    assert.deepEqual(size, { width, height }, `${file} 尺寸不符`);
    assert.ok(buffer.length > 20_000, `${file} 体积过小，可能是空白图`);
  }
});

test("发布构建剥离开发态入口：源仓库保留，脚本负责移除", async () => {
  const source = await readText("src/background.js");
  assert.ok(source.includes("startDevReloadBackground"), "开发目录本身仍需热更新能力");
  const build = await readText("scripts/build-release.mjs");
  assert.ok(build.includes("无法从发布构建中剥离开发态热更新入口"));
  assert.ok(build.includes("toReleaseManifest"), "发布构建必须走共享的发布态清单变换");
  const checks = await readText("scripts/lib/release-checks.mjs");
  // 可复现构建：zip 会写入文件 mtime，必须在打包前统一，否则记录的哈希无法核对。
  assert.ok(build.includes("normalizeTimestamps"), "发布构建必须统一 mtime 与权限位以保证 zip 可复现");
  assert.ok(build.includes(".sort()"), "发布构建必须按排序后的文件列表打包，否则 zip 字节随文件系统变化");
  assert.ok(checks.includes("http://127.0.0.1/"));
  // 直接验证行为，而不是匹配源码字符串——字符串检查在重构后会失效。
  assert.ok(!toReleaseManifest(manifest).host_permissions.some((host) => host.includes("127.0.0.1")));
});
