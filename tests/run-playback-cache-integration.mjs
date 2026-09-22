import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://test').pathname);
    if (!file.startsWith(root)) throw new Error('outside root');
    const data = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : 'text/javascript'); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const fixtures = {};
  for (const role of ['video', 'audio']) {
    const bytes = Buffer.from(await readFile(path.join(root, `tests/fixtures/dash-${role}-2frag.mp4`)));
    let indexAt = 0;
    for (let p = 0; p + 8 < bytes.length; p += bytes.readUInt32BE(p)) {
      if (bytes.toString('ascii', p + 4, p + 8) === 'sidx') { indexAt = p; break; }
    }
    // 原夹具只保存两个真实片段；索引引用数量收敛为 2，不改变盒大小/媒体偏移。
    bytes.writeUInt16BE(2, indexAt + (bytes[indexAt + 8] === 1 ? 38 : 30));
    fixtures[role] = { bytes, initEnd: indexAt + bytes.readUInt32BE(indexAt) };
  }
  const network = [];
  let failNextMedia = false;
  await page.exposeFunction("readNetworkCount", () => network.length);
  await page.route('https://*.bilivideo.com/**', async route => {
    const req = route.request(), url = new URL(req.url()), role = url.pathname.includes('audio') ? 'audio' : 'video';
    const source = fixtures[role].bytes;
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers().range || '');
    network.push({ role, range: req.headers().range, method: req.method() });
    await new Promise(resolve => setTimeout(resolve, 180));
    if (!range) return route.fulfill({ status: 200, body: source, headers: { 'access-control-allow-origin': '*' } });
    if (failNextMedia && url.searchParams.has("prefetch-failure") && Number(range[1]) > 0) { failNextMedia = false; return route.fulfill({ status: 503, body: "temporary failure", headers: { "access-control-allow-origin": "*" } }); }
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), source.length - 1) : source.length - 1;
    await route.fulfill({ status: 206, body: source.subarray(start, end + 1), headers: {
      'content-type': `${role}/mp4`, 'content-range': `bytes ${start}-${end}/${source.length}`,
      'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range,Content-Length',
      'content-length': String(end - start + 1)
    } });
  });
  await page.goto(origin + '/tests/playback-progress-integration.html');
  await page.waitForFunction(() => document.querySelector('#result').textContent !== 'running');
  const progress = JSON.parse(await page.locator('#result').textContent()); assert.equal(progress.ok, true, JSON.stringify(progress));
  await page.goto(origin + '/tests/playback-cache-integration.html');
  const initial = Object.fromEntries(Object.entries(fixtures).map(([key, value]) => [key, { initEnd: value.initEnd, total: value.bytes.length }]));
  await page.evaluate(value => window.fixtureInfo = value, initial);
  await page.addScriptTag({ path: path.join(root, 'src/playback-cache.js') });
  await page.addScriptTag({ path: path.join(root, 'src/playback-routes.js') });
  await page.addScriptTag({ path: path.join(root, 'src/playback-network.js') });
  await page.addScriptTag({ path: path.join(root, 'src/playback-observer.js') });
  const run = async (warm, xhr) => {
    const before = network.length;
    const result = await page.evaluate(async ({ warm, xhr }) => {
      const cache = window.__biliBufferCache, observer = window.__biliBufferPlaybackAssistInternals;
      observer.cfg.mode = warm ? 'always' : 'off'; cache.clear(); observer.tracks.clear();
      const video = document.querySelector('video'); video.pause();
      const media = new MediaSource(), objectUrl = URL.createObjectURL(media); video.src = objectUrl;
      const once = (target, name) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout: ' + name)), 8000);
        target.addEventListener(name, event => { clearTimeout(timer); resolve(event); }, { once: true });
      });
      await once(media, 'sourceopen');
      const buffers = {};
      const urls = Object.fromEntries(['video', 'audio'].map(role => [role, `https://cache-test.bilivideo.com/${role}.m4s`]));
      const request = async (url, start, end) => {
        if (!xhr) return (await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } })).arrayBuffer();
        return new Promise((resolve, reject) => {
          const request = new XMLHttpRequest(); request.open('GET', url); request.responseType = 'arraybuffer';
          request.setRequestHeader('Range', `bytes=${start}-${end - 1}`);
          request.onload = () => request.status === 206 ? resolve(request.response) : reject(new Error('XHR status ' + request.status));
          request.onerror = () => reject(new Error('XHR error')); request.send();
        });
      };
      const append = async (buffer, bytes) => { const done = once(buffer, 'updateend'); buffer.appendBuffer(bytes); await done; };
      for (const role of ['video', 'audio']) {
        const codec = role === 'video' ? 'avc1.64001F' : 'mp4a.40.2';
        try { buffers[role] = media.addSourceBuffer(`${role}/mp4; codecs="${codec}"`); } catch (error) { throw new Error(`${warm ? "warm" : "cold"} ${role}: ${error.message}; state=${media.readyState}; buffers=${media.sourceBuffers.length}`); }
      }
      // 两个 SourceBuffer 必须在首个初始化段触发 demuxer 初始化前创建。
      for (const role of ["video", "audio"]) {
        const info = window.fixtureInfo[role];
        await append(buffers[role], await request(urls[role], 0, info.initEnd));
      }
      media.duration = 10;
      // 冷路径用同一 SIDX 解析器读取夹具头，仅取索引，不预热媒体正文。
      if (!warm) for (const role of ['video', 'audio']) {
        const info = window.fixtureInfo[role];
        cache.put(urls[role], 0, new Uint8Array(await request(urls[role], 0, info.initEnd)), info.total, { prefetched: false });
      }
      for (const role of ['video', 'audio']) {
        const first = cache.index(urls[role])?.segments[0];
        if (!first) throw new Error('Missing SIDX for ' + role);
        await append(buffers[role], await request(urls[role], first.start, first.end));
      }
      if (warm) {
        const deadline = performance.now() + 8000;
        while (!['video', 'audio'].every(role => cache.timeRanges(urls[role]).some(([a, b]) => a <= 6 && b > 6))) {
          if (performance.now() > deadline) throw new Error('prefetch did not produce playable yellow: ' + JSON.stringify(observer.publicStats()));
          await new Promise(resolve => setTimeout(resolve, 30));
        }
      }
      const seekNetworkBefore = await window.readNetworkCount();
      const hitsBefore = cache.stats.hits, start = performance.now();
      video.currentTime = 6;
      const playing = once(video, 'playing');
      await Promise.all(['video', 'audio'].map(async role => {
        const second = cache.index(urls[role]).segments[1];
        await append(buffers[role], await request(urls[role], second.start, second.end));
      }));
      await video.play(); await playing;
      const seekMs = performance.now() - start;
      const yellow = observer.normalizedPrefetchedRanges();
      const seekNetworkRequests = await window.readNetworkCount() - seekNetworkBefore;
      const decodedFrames = video.getVideoPlaybackQuality().totalVideoFrames;
      video.pause();
      for (const buffer of Object.values(buffers)) media.removeSourceBuffer(buffer);
      video.removeAttribute("src"); video.load(); URL.revokeObjectURL(objectUrl);
      return { warm, xhr, seekNetworkRequests, seekMs: Math.round(seekMs), newHits: cache.stats.hits - hitsBefore, yellow, decodedFrames, cacheStats: { ...cache.stats } };
    }, { warm, xhr });
    result.networkRequests = network.length - before;
    return result;
  };
  const cold = await run(false, false);
  const warmFetch = await run(true, false);
  const warmXhr = await run(true, true);
  assert.equal(warmFetch.newHits, 2, '两轨 Fetch 均命中'); assert.equal(warmXhr.newHits, 2, '两轨 XHR 均命中');
  assert(warmFetch.seekMs < cold.seekMs && warmXhr.seekMs < cold.seekMs, JSON.stringify({ cold, warmFetch, warmXhr }));
  assert(warmFetch.yellow.length && warmXhr.yellow.length);
  assert.equal(warmFetch.seekNetworkRequests, 0); assert.equal(warmXhr.seekNetworkRequests, 0); assert.equal(cold.seekNetworkRequests, 2);
  const beforeProbes = network.length;
  const probes = await page.evaluate(async () => {
    const cache = window.__biliBufferCache, url = 'https://cache-test.bilivideo.com/video.m4s';
    const result = {};
    const response = await fetch(new Request(url, { headers: { Range: 'bytes=1-17' } }));
    result.fetch = response.status === 206 && response.url === url && response.headers.get('content-range') === `bytes 1-17/${window.fixtureInfo.video.total}` && (await response.arrayBuffer()).byteLength === 17;
    const abort = new AbortController(); abort.abort();
    result.fetchAbort = await fetch(url, { headers: { Range: 'bytes=1-17' }, signal: abort.signal }).then(() => false, error => error.name === 'AbortError');
    result.xhr = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(), states = [], events = [];
      xhr.open('GET', url); xhr.responseType = 'arraybuffer'; xhr.setRequestHeader('Range', 'bytes=1-17');
      xhr.onreadystatechange = () => states.push(xhr.readyState);
      for (const name of ['loadstart', 'progress', 'load', 'loadend']) xhr.addEventListener(name, () => events.push(name));
      xhr.onloadend = () => resolve({ states, events, status: xhr.status, bytes: xhr.response?.byteLength, url: xhr.responseURL, headers: xhr.getAllResponseHeaders() });
      xhr.onerror = reject; xhr.send();
    });
    result.xhrAbort = await new Promise(resolve => {
      const xhr = new XMLHttpRequest(), events = [];
      xhr.open('GET', url); xhr.responseType = 'arraybuffer'; xhr.setRequestHeader('Range', 'bytes=1-17');
      xhr.onabort = () => events.push('abort'); xhr.onload = () => events.push('load');
      xhr.send(); xhr.abort(); setTimeout(() => resolve({ events, state: xhr.readyState, status: xhr.status }), 20);
    });
    return result;
  });
  assert.equal(network.length, beforeProbes, '完整命中和取消都不能产生网络请求');
  assert(probes.fetch && probes.fetchAbort); assert.deepEqual(probes.xhr.states, [2, 3, 4]);
  assert.equal(probes.xhr.bytes, 17); assert.equal(probes.xhr.status, 206);
  assert.deepEqual(probes.xhrAbort, { events: ['abort'], state: 0, status: 0 });
  const beforeMiss = network.length;
  await page.evaluate(async () => {
    const url = 'https://cache-test.bilivideo.com/video.m4s?new-quality=1';
    await fetch(url, { headers: { Range: 'bytes=1-17' } });
    await new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('GET', url); xhr.responseType = 'arraybuffer'; xhr.setRequestHeader('Range', 'bytes=1-17'); xhr.onload = resolve; xhr.onerror = reject; xhr.send(); });
  });
  assert.equal(network.slice(beforeMiss).filter(request => request.range === "bytes=1-17").length, 1, '新 URL 首次未命中应被加速，随后 XHR 复用缓存');
  const navigation = await page.evaluate(async () => {
    const cache = window.__biliBufferCache, observer = window.__biliBufferPlaybackAssistInternals;
    const pending = fetch('https://cache-test.bilivideo.com/video.m4s?late-old-page=1', { headers: { Range: 'bytes=0-1859' } });
    history.pushState({}, '', '?p=2'); observer.resetTracksAfterNavigation();
    await pending.then(response => response.arrayBuffer()).catch(error => { if (error.name !== "AbortError") throw error; }); await new Promise(resolve => setTimeout(resolve, 30));
    return { bytes: cache.stats.bytes, tracks: observer.tracks.size };
  });
  assert.deepEqual(navigation, { bytes: 0, tracks: 0 }, '导航前的迟到响应不能重建旧缓存/轨道');
  failNextMedia = true;
  const prefetchFailure = await page.evaluate(async () => {
    const cache = window.__biliBufferCache, observer = window.__biliBufferPlaybackAssistInternals;
    const url = 'https://cache-test.bilivideo.com/video.m4s?prefetch-failure=1';
    const response = await fetch(url, { headers: { Range: 'bytes=1860-1870' } });
    const bytes = (await response.arrayBuffer()).byteLength;
    observer.cfg.mode = 'off'; observer.network.reset(); cache.clear();
    return { status: response.status, bytes };
  });
  assert.deepEqual(prefetchFailure, { status: 206, bytes: 11 }, '单节点失败后应在加速链路内换节点恢复');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, progress, cold, warmFetch, warmXhr, probes, navigation, prefetchFailure, acceleratedMissAndReuse: true }, null, 2));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
