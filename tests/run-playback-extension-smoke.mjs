import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = fileURLToPath(new URL('../dist/unpacked/', import.meta.url));
const bundlePath = extension + "src/playback-cache.js";
const originalBundle = await readFile(bundlePath, "utf8");
const probeLine = `
window.__biliCacheReloadProbe = ${JSON.stringify(String(Date.now()))};
`;
const profile = await mkdtemp(tmpdir() + '/bili-cache-smoke-');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  // 新建专用 profile 必须启用开发者模式，否则 Chromium 会在 runtime.reload 时禁用未打包扩展。
  const manager = await context.newPage();
  await manager.goto("chrome://extensions/");
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await manager.close();
  const workers = context.serviceWorkers();
  let worker = workers[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage();
  await page.route('https://www.bilibili.com/video/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><video></video></body></html>' }));
  let mediaRequests = 0;
  await page.route('https://cache-test.bilivideo.com/**', route => { mediaRequests++; return route.abort(); });
  const check = async () => {
    await page.goto('https://www.bilibili.com/video/BV1fixture/');
    await page.waitForFunction(() => window.__biliBufferPlaybackAssistInternals?.cfg.mode === 'always' && document.documentElement.dataset.biliBufferAssistBridge);
    return page.evaluate(async () => {
      const cache = window.__biliBufferCache;
      const url = 'https://cache-test.bilivideo.com/smoke.m4s';
      cache.put(url, 0, new Uint8Array([7, 9]), 2);
      const response = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      const data = [...new Uint8Array(await response.arrayBuffer())];
      const xhrData = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.responseType = 'arraybuffer'; xhr.setRequestHeader('Range', 'bytes=0-1');
        xhr.onload = () => resolve([...new Uint8Array(xhr.response)]); xhr.onerror = reject; xhr.send();
      });
      return { data, xhrData, hits: cache.stats.hits, reloadProbe: window.__biliCacheReloadProbe || null, main: Boolean(document.documentElement.dataset.biliBufferAssistMain), bridge: Boolean(document.documentElement.dataset.biliBufferAssistBridge) };
    });
  };
  const first = await check();
  const extensionId = new URL(worker.url()).host;
  await writeFile(bundlePath, originalBundle + probeLine);
  await worker.evaluate(() => chrome.runtime.reload()).catch(error => {
    if (!/closed|destroyed|Target/.test(error.message)) throw error;
  });
  const popup = await context.newPage();
  // runtime.reload 返回时扩展可能仍处于卸载窗口；等待可访问再检查新页面，而非假定 SW 自动启动。
  for (let attempt = 0; ; attempt++) {
    try { await popup.goto(`chrome-extension://${extensionId}/popup.html`); break; }
    catch (error) { if (attempt >= 9 || !/ERR_BLOCKED_BY_CLIENT|ERR_FAILED/.test(error.message)) {
      const diagnostic = await context.newPage();
      await diagnostic.goto("chrome://extensions/");
      const state = await diagnostic.evaluate(() => new Promise(resolve => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, entries => resolve(entries.map(({ id, state, disableReasons, runtimeErrors, manifestErrors }) => ({ id, state, disableReasons, runtimeErrors, manifestErrors }))))));
      throw new Error("reload failed: " + JSON.stringify(state));
    } await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  const second = await check();
  const loadedSource = await popup.evaluate(async () => (await fetch(chrome.runtime.getURL('src/playback-cache.js'))).text());
  const diskSource = await readFile(new URL('../src/playback-cache.js', import.meta.url), 'utf8');
  const hash = source => createHash('sha256').update(source).digest('hex');
  assert.equal(hash(loadedSource), hash(diskSource + probeLine));
  assert.equal(first.reloadProbe, null); assert(second.reloadProbe);
  for (const result of [first, second]) {
    assert.deepEqual(result.data, [7, 9]); assert.deepEqual(result.xhrData, [7, 9]); assert.equal(result.hits, 2); assert(result.main && result.bridge);
  }
  assert.equal(mediaRequests, 0);
  console.log(JSON.stringify({ ok: true, extensionInjection: first, afterRuntimeReload: second, bundleSha256: hash(loadedSource), mediaRequests }));
} finally {
  await writeFile(bundlePath, originalBundle);
  await context.close();
  // Chromium 会在刚构建的目录生成校验元数据；移除测试残留，恢复与发布 zip 的逐文件一致。
  await rm(extension + "_metadata", { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
