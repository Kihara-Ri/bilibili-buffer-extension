import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://www.bilibili.com/**', route => route.fulfill({contentType:'text/html',body:'<!doctype html><video></video>'}));
  const primary = 'https://a.bilivideo.com/browser.m4s';
  const backup = 'https://b.bilivideo.com/browser.m4s';
  const payload = {data:{dash:{video:[{baseUrl:primary,backupUrl:[backup]}]}}};
  await page.route('https://api.bilibili.com/**', route=>route.fulfill({json:payload,headers:{'access-control-allow-origin':'*'}}));
  await page.route('https://*.bilivideo.com/**',async route=>{
    requests.push(route.request().url());
    if(route.request().url()===primary) await new Promise(r=>setTimeout(r,2500));
    await route.fulfill({status:206,body:Buffer.from([1,2,3,4]),headers:{'content-range':'bytes 0-3/4','access-control-allow-origin':'*','access-control-expose-headers':'Content-Range','content-type':'video/mp4'}}).catch(()=>{});
  });
  await page.goto('https://www.bilibili.com/video/BV1test/');
  for(const script of ['playback-cache','playback-routes','playback-network','playback-observer']) await page.addScriptTag({path:fileURLToPath(new URL(`../src/${script}.js`,import.meta.url))});
  // 覆盖真实 fetch 清单捕获、主节点延迟、备用命中及原 URL 缓存复用。
  const result=await page.evaluate(async ({primary})=>{
    await (await fetch('https://api.bilibili.com/x/player/playurl?cid=1')).json();
    await new Promise(r=>setTimeout(r,50));
    const internals=window.__biliBufferPlaybackAssistInternals;
    internals.cfg.mode='always';internals.network.setMode('original');
    const track=internals.trackFor(primary); track.size=4;
    await internals.prefetch({track,start:0,end:4});
    const response=await fetch(primary,{headers:{Range:'bytes=0-3'}});
    return {bytes:[...new Uint8Array(await response.arrayBuffer())],stats:internals.publicStats()};
  },{primary});
  assert.deepEqual(result.bytes,[1,2,3,4]);
  assert.equal(result.stats.networkRescues,1);assert.equal(result.stats.networkHost,'b.bilivideo.com');
  assert.equal(result.stats.cacheHits,1);assert.equal(requests.length,2);
  // XHR 播放清单也走相同注册契约；关闭时不能保留在途任务或旧统计。
  const xhr=await page.evaluate(async()=>{
    const i=window.__biliBufferPlaybackAssistInternals;history.pushState({}, "", "?p=2");
    const registrations=[];const original=i.network.register;i.network.register=p=>{registrations.push(p);return original(p);};
    await new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET','https://api.bilibili.com/x/player/wbi/playurl?cid=1');x.onload=resolve;x.onerror=reject;x.send();});
    const capturedBefore=registrations.length;const t=i.trackFor('https://a.bilivideo.com/browser.m4s');t.size=4;
    await i.prefetch({track:t,start:0,end:4});
    const rescue=i.publicStats().networkRescues;
    window.postMessage({channel:'bili-buffer-playback-assist-v1',dir:'ext->page',type:'config',payload:{mode:'off'}},'*');
    await new Promise(r=>setTimeout(r,30));
    return {rescue,stats:i.publicStats(),registrations,capturedBefore};
  });
  assert.equal(xhr.capturedBefore,1);assert.equal(xhr.rescue,1);assert.equal(xhr.stats.networkActive,0);assert.equal(xhr.stats.networkReceivedMB,0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,fetchManifest:true,xhrManifest:true,backupRescue:true,originalUrlCacheHit:true,disableCleanup:true,requests:requests.length}));
} finally { await browser.close(); }
