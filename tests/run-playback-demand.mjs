import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
import {chromiumLaunchOptions} from '../scripts/lib/browser-launch.mjs';

const browser=await chromium.launch(chromiumLaunchOptions({headless:true}));
try {
 const page=await browser.newPage();let active=0,peak=0;const ranges=[];
 const total=3*1024*1024, url='https://origin.bilivideo.com/cold.m4s';
 await page.route('https://www.bilibili.com/**',r=>r.fulfill({body:'<!doctype html><video></video>',contentType:'text/html'}));
 await page.route('https://*.bilivideo.com/**',async r=>{
  const [,a,b]=/bytes=(\d+)-(\d+)/.exec(r.request().headers().range);active++;peak=Math.max(peak,active);ranges.push([+a,+b]);
  await new Promise(resolve=>setTimeout(resolve,40));active--;
  await r.fulfill({status:206,body:Buffer.alloc(+b-+a+1,7),headers:{'content-range':`bytes ${a}-${b}/${total}`,'access-control-allow-origin':'*','access-control-expose-headers':'Content-Range'}}).catch(()=>{});
 });
 await page.goto('https://www.bilibili.com/video/BVtest/');
 for(const s of ['playback-cache','playback-routes','playback-network','playback-observer'])await page.addScriptTag({path:fileURLToPath(new URL(`../src/${s}.js`,import.meta.url))});
 const result=await page.evaluate(async({url,total})=>{
  const i=window.__biliBufferPlaybackAssistInternals;i.cfg.mode='always';
  const start=performance.now();const r=await fetch(url,{headers:{Range:`bytes=0-${total-1}`}});const b=new Uint8Array(await r.arrayBuffer());
  return {ms:performance.now()-start,bytes:b.length,valid:b.every(x=>x===7),stats:i.publicStats()};
 },{url,total});
 assert.equal(result.bytes,total);assert(result.valid);assert.equal(peak,12);assert(result.stats.acceleratedRequests>=1);
 // 独立适配器 fixture：覆盖待决网络请求的 XHR 取消、超时、重开与原生回退。
 await page.goto('https://www.bilibili.com/video/BVxhr/');
 await page.addScriptTag({path:fileURLToPath(new URL('../src/playback-cache.js',import.meta.url))});
 const states=await page.evaluate(async({url})=>{
  const c=window.__biliBufferCache;let mode='slow';let aborts=0;
  c.install({enabled:()=>true,loadRange:(_u,_r,signal)=>mode==='fallback'?Promise.resolve(null):new Promise((resolve,reject)=>{
   const t=setTimeout(()=>resolve({body:new Uint8Array([7,7,7,7]),start:0,end:4,total:1048576,type:'video/mp4'}),100);
   signal.addEventListener('abort',()=>{aborts++;clearTimeout(t);reject(signal.reason);},{once:true});
  })});
  async function probe(action){return new Promise(resolve=>{
   const x=new XMLHttpRequest(),events=[];x.open('GET',url);x.responseType='arraybuffer';x.setRequestHeader('Range','bytes=0-3');
   for(const e of ['loadstart','load','abort','timeout','error','loadend'])x.addEventListener(e,()=>{events.push(e);if(e==='loadend')resolve({events,status:x.status,bytes:x.response?.byteLength||0});});
   if(action==='timeout')x.timeout=20;x.send();if(action==='abort')setTimeout(()=>x.abort(),10);
  });}
  const abort=await probe('abort'),timeout=await probe('timeout');mode='fallback';const fallback=await probe('fallback');mode='slow';c.clear();
  const reopen=await new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET',url);x.responseType='arraybuffer';x.setRequestHeader('Range','bytes=0-3');x.send();setTimeout(()=>{x.open('GET',url);x.responseType='arraybuffer';x.setRequestHeader('Range','bytes=0-3');x.onload=()=>resolve({status:x.status,bytes:x.response.byteLength});x.send();},10);});
  return {abort,timeout,fallback,reopen,aborts};
 },{url});
 assert.deepEqual(states.abort.events,['loadstart','abort','loadend']);assert.deepEqual(states.timeout.events,['loadstart','timeout','loadend']);
 assert.deepEqual(states.fallback.events,['loadstart','load','loadend']);assert.equal(states.fallback.bytes,4);assert.equal(states.reopen.bytes,4);assert(states.aborts>=3);
 console.log(JSON.stringify({ok:true,firstDemandParallel:true,peak,pieces:ranges.length,elapsedMs:Math.round(result.ms),xhr:states},null,2));
}finally{await browser.close();}
