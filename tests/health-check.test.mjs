import test from "node:test";
import assert from "node:assert/strict";
import { collectHealthChecks, detectBrowserVersion, healthSignature } from "../src/health-check.js";

/** 一份“全部能力可用”的 chrome 替身；单项要制造失败时覆写对应字段。 */
function makeApi(overrides = {}) {
  const storage = {
    local: { async set() {}, async remove() {} },
    session: { async set() {} }
  };
  const api = {
    storage,
    runtime: {
      getManifest: () => ({
        minimum_chrome_version: "116",
        declarative_net_request: { rule_resources: [{ id: "bili_cdn_headers" }] }
      }),
      async getContexts() {
        return [];
      }
    },
    declarativeNetRequest: { async getEnabledRulesets() { return ["bili_cdn_headers"]; } },
    offscreen: { async createDocument() {} },
    downloads: { async download() {} },
    cookies: { async get() { return null; } }
  };
  return { ...api, ...overrides };
}

/** 只实现 open / deleteDatabase 的内存 IndexedDB 替身。 */
const workingIndexedDb = {
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = { close() {} };
      request.onsuccess?.();
    });
    return request;
  },
  deleteDatabase() {}
};

const options = { api: makeApi(), indexedDb: workingIndexedDb, browserVersion: "154.0.8037.57" };

test("全部能力可用时自检通过，并报出浏览器版本", async () => {
  const report = await collectHealthChecks(options);
  assert.equal(report.ok, true);
  assert.equal(report.browserVersion, "154.0.8037.57");
  assert.deepEqual(report.checks.map((check) => check.id), [
    "storage-local", "storage-session", "indexeddb", "dnr-rules", "offscreen", "downloads", "cookies", "browser-version"
  ]);
  assert.ok(report.checks.every((check) => check.ok && check.detail === ""));
});

test("单项能力缺失只让该项失败，其它结论保持可用", async () => {
  const api = makeApi({ offscreen: undefined });
  const report = await collectHealthChecks({ ...options, api });
  assert.equal(report.ok, false);
  const failed = report.checks.filter((check) => !check.ok);
  assert.deepEqual(failed.map((check) => check.id), ["offscreen"]);
  assert.match(failed[0].detail, /offscreen/);
});

test("静态规则集未生效必须报出来，否则 CDN 下载会缺 Referer 被拒", async () => {
  const api = makeApi({ declarativeNetRequest: { async getEnabledRulesets() { return []; } } });
  const report = await collectHealthChecks({ ...options, api });
  const dnr = report.checks.find((check) => check.id === "dnr-rules");
  assert.equal(dnr.ok, false);
  assert.match(dnr.detail, /bili_cdn_headers/);
});

test("IndexedDB 打开失败（被策略禁用、隐私模式）判为不可用", async () => {
  const failing = {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.error = new Error("被策略禁用");
        request.onerror?.();
      });
      return request;
    },
    deleteDatabase() {}
  };
  const report = await collectHealthChecks({ ...options, indexedDb: failing });
  const idb = report.checks.find((check) => check.id === "indexeddb");
  assert.equal(idb.ok, false);
  assert.match(idb.detail, /被策略禁用/);
});

test("浏览器版本低于清单要求时单独报错", async () => {
  const report = await collectHealthChecks({ ...options, browserVersion: "110.0.0.0" });
  const version = report.checks.find((check) => check.id === "browser-version");
  assert.equal(version.ok, false);
  assert.match(version.detail, /需要 Chrome 116/);
});

test("存储探测抛错时不向上抛，自检自身必须永远返回结论", async () => {
  const api = makeApi({
    storage: {
      local: { async set() { throw new Error("配额异常"); } },
      session: { async set() { throw new Error("会话存储不可用"); } }
    }
  });
  const report = await collectHealthChecks({ ...options, api });
  assert.equal(report.ok, false);
  assert.match(report.checks.find((check) => check.id === "storage-local").detail, /配额异常/);
  assert.match(report.checks.find((check) => check.id === "storage-session").detail, /会话存储不可用/);
});

test("探测挂住时按超时判失败，不拖住弹窗", async () => {
  const api = makeApi({ declarativeNetRequest: { getEnabledRulesets: () => new Promise(() => {}) } });
  const report = await collectHealthChecks({ ...options, api, timeoutMs: 60 });
  const dnr = report.checks.find((check) => check.id === "dnr-rules");
  assert.equal(dnr.ok, false);
  assert.match(dnr.detail, /超时/);
});

test("从 User-Agent 解析浏览器版本，并识别无头标识", () => {
  assert.equal(detectBrowserVersion({ userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.8037.57 Safari/537.36" }), "154.0.8037.57");
  assert.equal(detectBrowserVersion({ userAgent: "Mozilla/5.0 HeadlessChrome/153.0.8010.12" }), "153.0.8010.12");
  assert.equal(detectBrowserVersion({ userAgent: "" }), "");
});

test("签名只随结论内容变化，供弹窗按稳定 ID 决定是否重建", async () => {
  const first = await collectHealthChecks(options);
  const second = await collectHealthChecks(options);
  assert.equal(healthSignature(first), healthSignature(second));
  const broken = await collectHealthChecks({ ...options, api: makeApi({ offscreen: undefined }) });
  assert.notEqual(healthSignature(broken), healthSignature(first));
  assert.equal(healthSignature(null), "");
});
