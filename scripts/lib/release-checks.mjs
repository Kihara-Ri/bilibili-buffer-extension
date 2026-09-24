import { createHash } from "node:crypto";

/**
 * 上架合规的纯函数检查。
 *
 * 抽成模块是为了能被单元测试直接喂“坏样本”——只跑真实 dist 的话，
 * 检查逻辑写错（比如条件反了）会表现为“永远通过”，比没有检查更危险。
 * 这里只做判断，不碰文件系统；读文件与退出码留在 scripts/verify-release.mjs。
 */

/** Chrome Web Store 的清单字段上限。 */
export const MAX_NAME_LENGTH = 75;
export const MAX_DESCRIPTION_LENGTH = 132;

/**
 * 当前确实用到的权限白名单。新增权限必须同时更新这里与本注释，
 * 并在提交信息里写清用途——否则 verify 会直接失败。
 */
export const ALLOWED_PERMISSIONS = new Set([
  "activeTab", // 读取当前标签页地址，判断是否为支持的 B 站视频页
  "alarms", // Service Worker 被回收后的分钟级看门狗
  "cookies", // 只查询 SESSDATA 是否存在，用于显示登录状态
  "declarativeNetRequestWithHostAccess", // 为扩展自身请求补 Referer，过 CDN 防盗链
  "downloads", // 把缓存另存为本地文件
  "offscreen", // 后台文档里继续下载与重封装
  "storage", // 偏好、任务进度、界面快照
  "unlimitedStorage" // 允许 IndexedDB 保存超出默认配额的视频缓存
]);

const SEMVER = /^\d+\.\d+\.\d+(\.\d+)?$/;

/**
 * 与 Chrome 一致的方式推导扩展 ID：取公钥 DER 的 SHA-256 前 16 字节，
 * 每个半字节映射到 a–p。DNR 规则的 initiatorDomains 必须写这个值，
 * 所以“换了 key 却忘了改规则”会让防盗链静默失效。
 */
export function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15)))
    .join("");
}

/**
 * 把开发目录里的 manifest 变换成发布包里的样子。
 *
 * 开发态需要 http://127.0.0.1/* 才能连本地热更新服务，发布包绝不能带上它。
 * 这个变换被构建脚本和测试共用：只写一份，才不会出现“构建剔除了、测试还在按旧规则断言”的漂移。
 */
export function toReleaseManifest(manifest) {
  const release = structuredClone(manifest);
  release.host_permissions = (release.host_permissions || []).filter((entry) => !entry.startsWith("http://127.0.0.1/"));
  return release;
}

export function checkManifestFields(manifest, pkg) {
  const failures = [];
  if (manifest.manifest_version !== 3) failures.push("manifest_version 必须是 3");
  if (manifest.version !== pkg.version) {
    failures.push(`manifest 版本 ${manifest.version} 与 package.json 的 ${pkg.version} 不一致`);
  }
  if (!SEMVER.test(manifest.version || "")) failures.push("版本号必须是 Chrome 接受的 1~4 段数字");
  if ((manifest.name || "").length > MAX_NAME_LENGTH) {
    failures.push(`名称 ${manifest.name.length} 字，超过 Chrome Web Store 的 ${MAX_NAME_LENGTH} 字上限`);
  }
  if ((manifest.description || "").length > MAX_DESCRIPTION_LENGTH) {
    failures.push(`描述 ${manifest.description.length} 字，超过 manifest 的 ${MAX_DESCRIPTION_LENGTH} 字上限`);
  }
  if (!manifest.key) failures.push("缺少 key：扩展 ID 会变，DNR 规则与已有缓存全部失效");
  for (const size of [16, 32, 48, 128]) {
    const icon = manifest.icons?.[String(size)];
    if (!icon) failures.push(`icons 缺少 ${size} 尺寸`);
    else if (manifest.action?.default_icon?.[String(size)] !== icon) {
      failures.push(`action.default_icon 的 ${size} 与 icons 不一致`);
    }
  }
  return failures;
}

export function checkHostPermissions(manifest) {
  const failures = [];
  for (const permission of manifest.permissions || []) {
    if (!ALLOWED_PERMISSIONS.has(permission)) {
      failures.push(`出现了未经评审说明的新权限：${permission}`);
    }
  }
  for (const host of manifest.host_permissions || []) {
    if (!host.startsWith("https://")) failures.push(`host_permissions 只允许 https：${host}`);
    // "https://*/*" 与 "*://*/*" 都是“所有站点”，审查时按越权处理，直接拒绝。
    const hostPart = host.replace(/^[a-z*]+:\/\//, "");
    if (hostPart === "*" || hostPart.startsWith("*/")) failures.push(`host_permissions 不允许通配全部站点：${host}`);
    if (/127\.0\.0\.1|localhost/.test(host)) failures.push(`发布包不得包含本地开发域名：${host}`);
  }
  return failures;
}

export function checkDnrRules(rules, extensionId) {
  const failures = [];
  if (!Array.isArray(rules) || rules.length === 0) {
    failures.push("rules/cdn-headers.json 为空");
    return failures;
  }
  for (const rule of rules) {
    const initiators = rule.condition?.initiatorDomains || [];
    if (!initiators.includes(extensionId)) {
      failures.push(
        `DNR 规则 ${rule.id} 的 initiatorDomains 未包含当前扩展 ID ${extensionId}；换 key 后必须同步规则`
      );
    }
    for (const domain of initiators) {
      // DNR 的 initiatorDomains 对扩展自身请求匹配的是扩展 ID 这个“主机名”。
      // 写成站点域名会误改其他页面发起的请求，等于越权修改别人网站的流量。
      if (domain.includes(".")) {
        failures.push(`DNR 规则 ${rule.id} 出现了站点域名 ${domain}，会误改其他页面发起的请求`);
      }
    }
  }
  return failures;
}

/** 单个发布文件的内容检查。relative 用于报错定位。 */
export function checkPackagedText(relative, text) {
  const failures = [];
  if (/startDevReload|devReloadServer|127\.0\.0\.1/.test(text)) {
    failures.push(`${relative} 残留开发态热更新或本地地址代码`);
  }
  if (relative.endsWith(".js")) {
    if (/\beval\s*\(|new\s+Function\s*\(|importScripts\s*\(/.test(text)) {
      failures.push(`${relative} 含 eval / new Function / importScripts，违反 MV3 远程代码限制`);
    }
    if (/chrome\.tabs\.executeScript/.test(text)) failures.push(`${relative} 使用了 MV2 的 tabs.executeScript`);
  }
  if (relative.endsWith(".html")) {
    const inline = [...text.matchAll(/<script\b([^>]*)>/gi)].filter(([, attrs]) => !/\bsrc\s*=/.test(attrs));
    if (inline.length) failures.push(`${relative} 含内联 <script>，会被 MV3 的 CSP 拦截`);
    if (/<script[^>]+src\s*=\s*["']https?:/i.test(text)) failures.push(`${relative} 引用了远程脚本`);
    if (/<link[^>]+href\s*=\s*["']https?:/i.test(text)) failures.push(`${relative} 引用了远程样式`);
  }
  return failures;
}

/** 压缩包条目检查：会直接决定商店是否判为无效包或含垃圾文件。 */
export function checkZipEntries(entries) {
  const failures = [];
  if (!entries.includes("manifest.json")) failures.push("压缩包根目录没有 manifest.json：商店会当成无效包");
  for (const entry of entries) {
    if (/\.DS_Store|__MACOSX|_metadata|dev-reload/.test(entry)) {
      failures.push(`压缩包含有不该发布的文件：${entry}`);
    }
    if (/^yingsao-\d/.test(entry)) failures.push(`压缩包内多了一层目录：${entry}`);
  }
  return failures;
}
