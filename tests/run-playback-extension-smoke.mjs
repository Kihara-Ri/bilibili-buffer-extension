import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import { chromiumLaunchOptions } from '../scripts/lib/browser-launch.mjs';

const extension = fileURLToPath(new URL('../dist/unpacked/', import.meta.url));
const bundlePath = extension + "src/playback-cache.js";
const originalBundle = await readFile(bundlePath, "utf8");
const probeLine = `
window.__biliCacheReloadProbe = ${JSON.stringify(String(Date.now()))};
`;
const profile = await mkdtemp(tmpdir() + '/bili-cache-smoke-');
const context = await chromium.launchPersistentContext(profile, {
  ...chromiumLaunchOptions({ headless: true }),
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
  await page.route('https://www.bilibili.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><video></video></body></html>' }));
  let mediaRequests = 0;
  await page.route('https://cache-test.bilivideo.com/**', route => { mediaRequests++; return route.abort(); });
  const check = async (pathname = "/video/BV1fixture/") => {
    await page.goto('https://www.bilibili.com' + pathname);
    await page.waitForFunction(() => window.__biliBufferPlaybackAssistInternals?.cfg.mode === 'always' && document.documentElement.dataset.biliBufferAssistBridge, null, {timeout: 5000});
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
  const localized = [];
  for (const path of ["/zh-Hans/video/BV1fixture/", "/zh-Hant/video/BV1fixture/", "/en/video/BV1fixture/", "/zh-Hans/list/watchlater?bvid=BV1fixture"]) localized.push({path, ...await check(path)});
  const first = await check();
  const extensionId = new URL(worker.url()).host;
  // MV3 SW 禁止动态 import；从扩展页面写同源 IndexedDB，随后验证全新 SW 的恢复。
  const seed = await context.newPage();
  await seed.goto(`chrome-extension://${extensionId}/popup.html`);
  const playbackPriority = await checkDownloadPriority(page, seed);
  const badgeTabId = await seed.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: "https://www.bilibili.com/video/*" });
    const { putVideo } = await import(chrome.runtime.getURL("src/db.js"));
    await putVideo({ id: "smoke-complete", tabId: tab.id, status: "complete", createdAt: Date.now(), updatedAt: Date.now(), downloadedBytes: 2, totalBytes: 2, progress: 1 });
    await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
    return tab.id;
  });
  await seed.close();
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
  await waitUntil(() => popup.evaluate(async tabId => await chrome.action.getBadgeText({ tabId }) === "✓", badgeTabId),
    'SW 重启后未从 IndexedDB 恢复徽标');
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
  console.log(JSON.stringify({ ok: true, extensionInjection: first, localized, playbackPriority, afterRuntimeReload: second, bundleSha256: hash(loadedSource), badgeRestoredAfterRestart: true, mediaRequests }));
} finally {
  await writeFile(bundlePath, originalBundle);
  await context.close();
  // Chromium 会在刚构建的目录生成校验元数据；移除测试残留，恢复与发布 zip 的逐文件一致。
  await rm(extension + "_metadata", { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}

async function checkDownloadPriority(page, extensionPage) {
  const id = 'smoke-download-priority';
  const total = 12 * 1024 * 1024;
  const session = await page.context().newCDPSession(page);
  const realms = [];
  session.on('Runtime.executionContextCreated', ({ context }) => realms.push(context));
  await session.send('Runtime.enable');
  const extensionId = new URL(extensionPage.url()).host;
  const contexts = await Promise.all(realms.filter(({ auxData }) => auxData?.type === 'isolated').map(async context => {
    const { result } = await session.send('Runtime.evaluate', { contextId: context.id, expression: 'globalThis.chrome?.runtime?.id' });
    return result.value === extensionId ? context.id : null;
  }));
  const contextId = contexts.find(Boolean);
  assert(contextId, '找不到实际内容脚本的隔离环境');
  // DOM 节点在各 world 有独立的 JS 包装，必须让隔离桥看到夹具中的媒体状态。
  async function inPlaybackBridge(fn, args) {
    const result = await session.send('Runtime.evaluate', {
      contextId, expression: `(${fn})(${JSON.stringify(args)})`, returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.result.description);
  }
  const held = new Map();
  let requests = 0;
  let releaseTransfers = false;
  const server = createServer((request, response) => {
    // 生产包无 loopback 权限，这个测试服务器按正常跨域规则提供自造媒体。
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Range');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Headers', 'Range');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      return response.writeHead(204).end();
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
    if (request.url !== '/cache.mp4' || !match) return response.writeHead(404).end();
    requests++;
    const start = Number(match[1]), end = Math.min(Number(match[2]), total - 1);
    const size = end - start + 1;
    response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': size });
    if (releaseTransfers || size <= 64 * 1024) return response.end(Buffer.alloc(size));
    // 有响应头、有少量正文但未完成，验证取消的是真实传输。
    response.write(Buffer.alloc(1));
    held.set(response, size - 1);
    response.once('close', () => held.delete(response));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/cache.mp4`;
  const updateVideo = (patch, event) => inPlaybackBridge(({ patch, event }) => {
    Object.assign(window.downloadPriorityVideo, patch);
    const video = document.querySelector('video');
    if (patch.local) video.dataset.biliCachePlayback = 'local';
    video.dispatchEvent(new Event(event));
  }, { patch, event });
  try {
    await extensionPage.evaluate(() => {
      window.downloadPressureEvents = [];
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message.type === 'PLAYBACK_PRESSURE') window.downloadPressureEvents.push({
          level: message.level, documentId: sender.documentId, frameId: sender.frameId, url: sender.url
        });
      });
    });
    await inPlaybackBridge(() => {
      const video = document.querySelector('video');
      const state = window.downloadPriorityVideo = { paused: false, seeking: false, ahead: 0 };
      Object.defineProperties(video, {
        paused: { get: () => state.paused },
        seeking: { get: () => state.seeking },
        readyState: { get: () => state.ahead ? 4 : 2 },
        currentTime: { get: () => 10 },
        duration: { get: () => 60 },
        buffered: { get: () => ({ length: 1, start: () => 0, end: () => 10 + state.ahead }) }
      });
      video.dispatchEvent(new Event('waiting'));
    });
    const started = await extensionPage.evaluate(async ({ id, url, total }) => {
      if ((await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length) {
        await chrome.offscreen.closeDocument();
      }
      const setup = await chrome.runtime.sendMessage({ target: 'background', type: 'GET_VIDEO', videoId: id });
      if (!setup?.ok) throw new Error(setup?.error || 'Offscreen 启动失败');
      return chrome.runtime.sendMessage({
        target: 'offscreen', type: 'START_DOWNLOAD', video: {
          id, bvid: 'BV1fixture', cid: 77, requestedQuality: 16, requestedQualityExplicit: true,
          playurlData: { quality: 16, format: 'mp4', durl: [{ url, size: total }] }
        }
      });
    }, { id, url, total });
    assert(started?.started, '实际扩展没有登记缓存任务');
    await delay(250);
    assert.equal(requests, 0, 'Offscreen 创建时遗漏了已经缓冲告急的播放页');

    await updateVideo({ ahead: 10 }, 'playing');
    await waitUntil(() => held.size >= 2, '稳定播放后离线传输未恢复');
    await delay(80);
    assert.equal(held.size, 2, '稳定播放期间离线占用超过两路');
    const mode = await extensionPage.evaluate(() => chrome.runtime.sendMessage({
      target: 'background', type: 'SET_ASSIST_CONFIG', patch: { bufferMode: 'full-speed' }
    }));
    assert.equal(mode.config?.bufferMode, 'full-speed');
    await waitUntil(() => held.size > 2, '切到全速档后实际播放页没有放开下载连接');
    const fullSpeedRequests = held.size;
    assert(fullSpeedRequests <= 8, '全速档超过共享连接上限');
    const seekUrl = 'https://priority-test.bilivideo.com/seek.m4s';
    let seekRequested = false;
    await page.route(seekUrl, async route => {
      seekRequested = true;
      try {
        // 用共享线路夹具把网页请求放在尚未让出的离线连接之后。
        await waitUntil(() => held.size === 0, '急需请求等不到离线让行');
        await route.fulfill({
          status: 206, body: Buffer.from([3, 7]),
          headers: {
            'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range',
            'Content-Range': 'bytes 0-1/2'
          }
        });
      } catch { await route.abort(); }
    });
    const seekBytes = page.evaluate(async url => {
      const response = await fetch(url, { headers: { Range: 'bytes=0-1' } });
      return [...new Uint8Array(await response.arrayBuffer())];
    }, seekUrl).catch(() => []);
    await waitUntil(() => seekRequested, '网页急需请求未送达');
    await updateVideo({ seeking: true, ahead: 0 }, 'seeking');
    await waitUntil(() => held.size === 0, '拖动后已启动的离线传输没有让行');
    assert.deepEqual(await seekBytes, [3, 7], '拖动后网页急需请求未取得正文');
    const seekingRequests = requests;
    await delay(100);
    assert.equal(requests, seekingRequests, '拖动期间仍有离线请求发出');

    releaseTransfers = true;
    // 历史双轨缓存使用页面域的 MediaSource，同一个 video 可从在线切换到本地。
    await updateVideo({ local: true, seeking: false }, 'playing');
    const complete = await waitUntil(() => extensionPage.evaluate(async id => {
      const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'GET_VIDEO', videoId: id });
      return reply?.video?.status === 'complete' ? reply.video : null;
    }, id), '切换到本地播放后离线预算未恢复', 6000);
    assert.equal(complete.runStartedAt, started.video.runStartedAt);
    assert.equal(complete.committedBytes, total);
    assert.equal(complete.downloadMetrics.retryCount, 0);
    return { bufferedStartupYielded: true, stableRequests: 2, fullSpeedRequests, seekYielded: true, webRequestDelivered: true, localPlaybackReleasedBudget: true, resumedBytes: total };
  } catch (error) {
    const diagnostic = await extensionPage.evaluate(async id => {
      const { video } = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'GET_VIDEO', videoId: id });
      return { status: video?.status, error: video?.error, events: window.downloadPressureEvents };
    }, id).catch(() => ({}));
    throw new Error(`${error.message}，${JSON.stringify({ ...diagnostic, requests, held: held.size })}`, { cause: error });
  } finally {
    await extensionPage.evaluate(() => chrome.runtime.sendMessage({
      target: 'background', type: 'SET_ASSIST_CONFIG', patch: { bufferMode: 'adaptive' }
    })).catch(() => {});
    await extensionPage.evaluate(id =>
      chrome.runtime.sendMessage({ target: 'offscreen', type: 'DELETE_VIDEO', videoId: id }), id).catch(() => {});
    await session.detach();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitUntil(check, message, timeout = 4500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}
