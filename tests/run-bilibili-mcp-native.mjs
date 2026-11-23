import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromiumLaunchOptions } from "../scripts/lib/browser-launch.mjs";
import { extensionIdFromKey } from "../scripts/lib/release-checks.mjs";
import { writeBilibiliNativeHost } from "../scripts/lib/register-bilibili-mcp-host.mjs";
import { createBilibiliNativeBrowser } from "../scripts/lib/bilibili-native-browser.mjs";
import { createBilibiliDownloadJobs } from "../scripts/lib/bilibili-mcp-jobs.mjs";

if (process.platform === "win32") {
  console.log("SKIP Chrome Native Messaging 临时资料测试需要 POSIX 清单路径，Windows 安装使用用户注册表。");
  process.exit(0);
}

const root = fileURLToPath(new URL("../", import.meta.url));
const url = "https://www.bilibili.com/video/BVfixture/";
const directory = await mkdtemp(join(await realpath(tmpdir()), "hainei-native-mcp-"));
const extension = join(directory, "extension"), profile = join(directory, "profile");
const bridge = join(directory, "bridge"), output = join(directory, "output"), chromeDownloads = join(directory, "chrome-downloads");
const fixture = await readFile(new URL("./fixtures/progressive-avc-aac.mp4", import.meta.url));
let context, jobs, server, apiServer;
try {
  await mkdir(extension);
  const entries = ["src", "_locales", "assets", "rules", "manifest.json", "offscreen.html", "mcp.html", "mcp.css", "popup.html", "popup.css", "privacy.html", "update-public-key.json"];
  await Promise.all(entries.map(name => cp(join(root, name), join(extension, name), { recursive: true })));
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"));
  assert(manifest.optional_permissions.includes("nativeMessaging"));
  // 无头测试的临时扩展预授予权限。生产包仍由设置页按钮触发 Chrome 的许可对话框。
  manifest.optional_permissions = manifest.optional_permissions.filter(permission => permission !== "nativeMessaging");
  manifest.permissions.push("nativeMessaging");
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest));
  await mkdir(join(profile, "Default"), { recursive: true });
  await mkdir(chromeDownloads);
  await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({
    // Chrome 的普通资料也可能关闭第三方 Cookie。账号检查仍应沿用 B 站自身会话。
    profile: { cookie_controls_mode: 1 },
    download: { default_directory: chromeDownloads, prompt_for_download: false }
  }));
  await writeBilibiliNativeHost({ registryDirectory: join(profile, "NativeMessagingHosts"), bridgeDirectory: bridge,
    script: join(root, "scripts/bilibili-mcp-host.mjs"), ids: [extensionIdFromKey(manifest.key)] });
  server = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
    const start = match ? Number(match[1]) : 0;
    const end = Math.min(match?.[2] ? Number(match[2]) : fixture.length - 1, fixture.length - 1);
    response.writeHead(match ? 206 : 200, { "Content-Type": "video/mp4", "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes", ...(match ? { "Content-Range": `bytes ${start}-${end}/${fixture.length}` } : {}) });
    response.end(fixture.subarray(start, end + 1));
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;

  const play = { code: 0, data: { quality: 120, format: "mp4", accept_quality: [120], accept_description: ["4K"],
    durl: [{ url: `${origin}/asset.mp4`, size: fixture.length }] } };
  let navUnavailable = false;
  const keyFile = join(directory, "api-key.pem"), certFile = join(directory, "api-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=api.bilibili.com", "-days", "1",
    "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
  const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
  const publicKey = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
  const fixturePin = createHash("sha256").update(publicKey).digest("base64");
  apiServer = createHttpsServer({ key, cert }, (request, response) => {
    const path = new URL(request.url, "https://api.bilibili.com").pathname;
    const reply = (data, headers) => response.writeHead(200, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(data));
    if (path === "/x/web-interface/nav") {
      if (navUnavailable) return response.writeHead(503).end();
      // 到达 HTTPS 夹具的 Cookie 由 Chrome 按真实资料和权限附加，拦截层不替它构造请求头。
      const isLogin = /(?:^|;\s*)SESSDATA=fixture-only(?:;|$)/.test(request.headers.cookie || "");
      return reply({ code: 0, data: { isLogin } });
    }
    if (path.endsWith("/playurl")) return reply(play, { "Access-Control-Allow-Origin": "https://www.bilibili.com", "Access-Control-Allow-Credentials": "true" });
    return reply({ code: 0, data: { bvid: "BVfixture", title: "当前 Chrome 会话",
      pages: [{ cid: 601, page: 1, part: "原始标题", duration: 6 }] } });
  }).listen(0, "127.0.0.1");
  await once(apiServer, "listening");

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const launch = () => chromium.launchPersistentContext(profile, {
    ...chromiumLaunchOptions({ headless: true }), args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--host-resolver-rules=MAP api.bilibili.com 127.0.0.1:${apiServer.address().port}`, `--ignore-certificate-errors-spki-list=${fixturePin}`]
  });
  context = await launch();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
  await context.route("https://www.bilibili.com/**", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><video muted></video>" }));

  // 先在这份 Chrome 资料里模拟已经登录，再连接 MCP。另开一页验收关闭 MCP 后 Chrome 继续运行。
  const fixtureSession = { name: "SESSDATA", value: "fixture-only", domain: ".bilibili.com", path: "/", secure: true, sameSite: "Strict" };
  await context.addCookies([fixtureSession]);
  const everyday = await context.newPage();
  await everyday.goto("about:blank");
  const settings = await context.newPage();
  await settings.goto(new URL("/mcp.html", worker.url()).href);
  const cdp = await context.newCDPSession(settings);
  await cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  await settings.locator("#connect").click();
  await settings.waitForFunction(() => document.querySelector("#connect").hidden, null, { timeout: 20_000 });
  const descriptor = JSON.parse(await readFile(join(bridge, "connection.json"), "utf8"));
  const endpoint = `http://127.0.0.1:${descriptor.port}/rpc`;
  assert.equal((await fetch(endpoint, { method: "POST" })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { Origin: "https://www.bilibili.com", Authorization: `Bearer ${descriptor.token}` } })).status, 403);
  jobs = createBilibiliDownloadJobs(signal => createBilibiliNativeBrowser({ bridgeDirectory: bridge, outputDirectory: output, signal }), {
    jobDirectory: join(directory, "jobs"), outputDirectory: output
  });

  assert.deepEqual(await jobs.accountStatus(), { status: "signed_in" });
  assert.equal((await jobs.inspect(url)).title, "当前 Chrome 会话");
  const original = await jobs.start({ url });
  const saved = await finish(jobs, original.jobId);
  assert.equal(saved.state, "complete", JSON.stringify(saved));
  assert.deepEqual(await readFile(saved.files[0].path), fixture);
  assert.equal(everyday.isClosed(), false);

  await context.clearCookies({ name: "SESSDATA" });
  const signedOut = await jobs.accountStatus();
  assert.deepEqual(signedOut, { status: "signed_out", loginUrl: "https://passport.bilibili.com/login" });
  await assert.rejects(jobs.inspect(url), { code: "LOGIN_REQUIRED" });
  const waiting = await finish(jobs, (await jobs.start({ url, quality: 120 })).jobId);
  assert.equal(waiting.state, "paused", JSON.stringify(waiting));
  assert.equal(waiting.error.code, "LOGIN_REQUIRED");
  assert(context.pages().every(page => !page.url().includes("passport.bilibili.com")), "MCP 只在确认登出时给出链接，浏览器标签由用户打开");

  navUnavailable = true;
  assert.deepEqual(await jobs.accountStatus(), { status: "unavailable" });
  await assert.rejects(jobs.inspect(url), error => error.code === "ACCOUNT_CHECK_UNAVAILABLE" && !error.details?.loginUrl);
  navUnavailable = false;
  await context.addCookies([fixtureSession]);
  await jobs.control(waiting.jobId, "resume");
  assert.equal((await finish(jobs, waiting.jobId)).state, "complete");
  await jobs.close();
  assert.equal(everyday.isClosed(), false);
  await context.close();
  context = null;
  context = await launch();
  // 浏览器重开前先不访问扩展页，单独验证 onStartup 从已保存的授权选择恢复连接。
  let restored = false;
  for (let attempt = 0; attempt < 75 && !restored; attempt++) {
    const current = await readFile(join(bridge, "connection.json"), "utf8").then(JSON.parse).catch(() => null);
    restored = Boolean(current && current.token !== descriptor.token);
    if (!restored) await delay(200);
  }
  assert(restored, "Chrome 重启后应自动恢复连接");
  const reloadedSettings = await context.newPage();
  await reloadedSettings.goto(new URL("/mcp.html", worker.url()).href);
  await reloadedSettings.locator("#disconnect").click();
  await reloadedSettings.waitForFunction(() => document.querySelector("#disconnect").hidden);
  console.log("真实 Chrome Native Messaging、已有登录、确认登出、会话检查故障、同资料继续和文件导出通过");
} finally {
  await jobs?.close();
  await context?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (apiServer) await new Promise(resolve => apiServer.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

async function finish(jobs, id) {
  for (let i = 0; i < 40; i++) {
    const result = await jobs.status(id, 2);
    if (["complete", "failed", "paused"].includes(result.state)) return result;
  }
  assert.fail(`Native Chrome job did not settle: ${JSON.stringify(await jobs.status(id))}`);
}
