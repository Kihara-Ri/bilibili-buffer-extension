import { t } from "./i18n.js";

// 浏览器侧能力自检。
//
// 为什么需要：所有增强能力都按 docs/architecture/compat-fallback.md 静默降级——这对播放是
// 对的，对用户却很糟。2026-09-23 Chrome 升到 154 后插件完全不可用，用户只能得到
// 「貌似不能用了」这种结论。这里把「本机浏览器上哪些能力不可用」变成弹窗里能读到
// 的结论，避免让用户对着没有反应的按钮猜。
//
// 结论里的文字按 Service Worker 的界面语言生成（src/i18n.js）。
// 只探测能力与开关：不发网络请求、不读 Cookie 原始值；存储探测只写一个随即删除的自检键。

/** 从 User-Agent 取浏览器版本；SW 与弹窗都能拿到 navigator。 @returns {string} */
export function detectBrowserVersion(navigatorLike = globalThis.navigator) {
  const matched = /(?:HeadlessChrome|Chrome|Chromium)\/(\d+(?:\.\d+){0,3})/.exec(String(navigatorLike?.userAgent || ""));
  return matched ? matched[1] : "";
}

/** @returns {number} 主版本号；无法解析时为 0 */
function majorOf(version) {
  const matched = /^(\d+)/.exec(String(version || "").trim());
  return matched ? Number(matched[1]) : 0;
}

/** 给单次探测加超时，避免某个 API 挂住让自检永远不返回。 */
function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/** 真实开一次库再删掉：只判断 API 存在会把「被策略禁用」误判为可用。 */
async function probeIndexedDb(indexedDb, timeoutMs) {
  if (!indexedDb || typeof indexedDb.open !== "function") throw new Error(t("probe.unavailable", { api: "indexedDB" }));
  const name = `bili-buffer-health-${Date.now().toString(36)}`;
  const request = indexedDb.open(name, 1);
  await withTimeout(new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error(request.error?.message || t("probe.dbOpenFailed")));
    request.onblocked = () => reject(new Error(t("probe.dbBlocked")));
  }), timeoutMs, t("probe.dbTimeout")).then((database) => database.close());
  indexedDb.deleteDatabase?.(name);
}

/**
 * @param {object} options
 * @param {object} [options.api] chrome 命名空间
 * @param {object} [options.indexedDb] 传 null 可模拟本地数据库不可用
 * @param {string} [options.browserVersion]
 * @param {object} [options.manifest]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.now]
 * @returns {Promise<{ok:boolean, browserVersion:string, checkedAt:number, checks:Array<{id:string,label:string,ok:boolean,detail:string}>}>}
 */
export async function collectHealthChecks({
  api = globalThis.chrome,
  indexedDb = globalThis.indexedDB,
  browserVersion = detectBrowserVersion(),
  manifest = api?.runtime?.getManifest?.() || {},
  timeoutMs = 3000,
  now = Date.now
} = {}) {
  const probes = [
    {
      id: "storage-local",
      label: t("probe.storage"),
      run: async () => {
        if (typeof api?.storage?.local?.set !== "function") throw new Error(t("probe.unavailable", { api: "storage.local" }));
        await api.storage.local.set({ healthProbe: 1 });
        await api.storage.local.remove?.("healthProbe");
      }
    },
    {
      id: "storage-session",
      label: t("probe.session"),
      run: async () => {
        if (typeof api?.storage?.session?.set !== "function") throw new Error(t("probe.unavailable", { api: "storage.session" }));
        await api.storage.session.set({ healthProbe: 1 });
      }
    },
    {
      id: "indexeddb",
      label: t("probe.database"),
      run: () => probeIndexedDb(indexedDb, timeoutMs)
    },
    {
      id: "dnr-rules",
      label: t("probe.rules"),
      run: async () => {
        if (typeof api?.declarativeNetRequest?.getEnabledRulesets !== "function") throw new Error(t("probe.unavailable", { api: "declarativeNetRequest" }));
        const enabled = await api.declarativeNetRequest.getEnabledRulesets();
        // 规则未生效时 CDN 下载会因缺少 Referer 被拒，属于必须暴露的失效。
        const expected = (manifest.declarative_net_request?.rule_resources || []).map((entry) => entry.id);
        const missing = expected.filter((id) => !enabled.includes(id));
        if (missing.length) throw new Error(t("probe.rulesMissing", { list: missing.join(t("sep.list")) }));
      }
    },
    {
      id: "offscreen",
      label: t("probe.offscreen"),
      run: async () => {
        if (typeof api?.offscreen?.createDocument !== "function") throw new Error(t("probe.unavailable", { api: "offscreen" }));
        // 判断是否已存在依赖 getContexts；缺失会在创建时重复开文档。
        if (typeof api?.runtime?.getContexts !== "function") throw new Error(t("probe.unavailable", { api: "runtime.getContexts" }));
      }
    },
    {
      id: "downloads",
      label: t("probe.downloads"),
      run: async () => {
        if (typeof api?.downloads?.download !== "function") throw new Error(t("probe.unavailable", { api: "downloads" }));
      }
    },
    {
      id: "cookies",
      label: t("probe.cookies"),
      run: async () => {
        if (typeof api?.cookies?.get !== "function") throw new Error(t("probe.unavailable", { api: "cookies" }));
      }
    },
    {
      id: "browser-version",
      label: t("probe.browser"),
      run: async () => {
        const required = majorOf(manifest.minimum_chrome_version);
        const actual = majorOf(browserVersion);
        if (!actual) throw new Error(t("probe.versionUnknown", { version: browserVersion || t("unknown") }));
        if (required && actual < required) throw new Error(t("probe.versionTooOld", { required, version: browserVersion }));
      }
    }
  ];

  // 单项失败只影响该项结论，绝不让自检自身抛错。
  const checks = [];
  for (const probe of probes) {
    try {
      await withTimeout(probe.run(), timeoutMs, t("probe.timeout", { label: probe.label }));
      checks.push({ id: probe.id, label: probe.label, ok: true, detail: "" });
    } catch (error) {
      checks.push({ id: probe.id, label: probe.label, ok: false, detail: String(error?.message || error) });
    }
  }
  return {
    ok: checks.every((check) => check.ok),
    browserVersion,
    checkedAt: now(),
    checks
  };
}

/** 自检结论的稳定签名：只有内容变化才需要更新界面。 @param {object} report */
export function healthSignature(report) {
  if (!report) return "";
  return [report.browserVersion, ...(report.checks || []).map((check) => `${check.id}:${check.ok ? 1 : 0}:${check.detail}`)].join("|");
}
