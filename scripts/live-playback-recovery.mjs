// 真实 B 站播放验收：匿名独立 profile；可选择注入主备域网络故障后 seek，镜像仍直连真实 CDN。
// 只保存聚合统计/主机名，不保存签名地址、Cookie 或账号信息。
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {chromiumLaunchOptions} from './lib/browser-launch.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const videoUrl=process.argv.find(a=>a.startsWith('https://www.bilibili.com/'))||'https://www.bilibili.com/video/BV11En46qETe/';
const injectFailure=process.argv.includes('--fail-originals');
const profile=await mkdtemp(tmpdir()+'/bili-playback-recovery-');
const context=await chromium.launchPersistentContext(profile,{
 ...chromiumLaunchOptions({headless:false}),ignoreDefaultArgs:['--enable-automation'],
 args:[`--disable-extensions-except=${root}`,`--load-extension=${root}`,'--disable-blink-features=AutomationControlled']
});
const report={video:videoUrl,injectFailure,samples:[],requests:{},blockedRequests:0,errors:[]};
try{
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 page.on('request',r=>{try{const u=new URL(r.url());if(u.pathname.endsWith('.m4s'))report.requests[u.hostname]=(report.requests[u.hostname]||0)+1;}catch{}});
 await page.goto(videoUrl,{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForFunction(()=>window.__biliBufferPlaybackAssistInternals?.cfg.mode==='always'&&document.querySelector('video'),null,{timeout:15000});
 await page.evaluate(()=>{const v=document.querySelector('video');v.muted=true;return v.play();});
 await page.waitForTimeout(5000);
 report.before=await page.evaluate(()=>({path:location.pathname,time:document.querySelector('video').currentTime,width:document.querySelector('video').videoWidth,height:document.querySelector('video').videoHeight,quality:window.__playinfo__?.data?.quality,stats:window.__biliBufferPlaybackAssistInternals.publicStats()}));
 if(injectFailure){
  // 保留真实页面、播放器和镜像请求，仅把本轮清单域模拟为网络失败；并非自然线路故障复现。
  const hosts=await page.evaluate(()=>{
   const dash=window.__playinfo__?.data?.dash;
   const tracks=[...(dash?.video||[]),...(dash?.audio||[])];
   // 页面内联清单不一定含 DASH；同时使用真正被播放器请求、由观察器登记的原始轨道。
   // 这里只保存主机名，避免站点改变内联字段后故障注入悄悄变成零次命中。
   const actual=[...(window.__biliBufferPlaybackAssistInternals?.tracks?.values()||[])].map(track=>track.host);
   return [...new Set([...tracks.flatMap(t=>[t.baseUrl||t.base_url,...(t.backupUrl||t.backup_url||[])]).filter(Boolean).map(u=>new URL(u).hostname),...actual])].filter(Boolean);
  });report.blockedHosts=hosts;
  assert(hosts.length>0,'未识别到原始媒体主机，不能声称已注入故障');
  await context.route(/https:\/\/[^/]+\/upgcxcode\/.*\.m4s/,route=>{
   if(hosts.includes(new URL(route.request().url()).hostname)){report.blockedRequests++;return route.abort('failed');}
   return route.continue();
  });
 }
 report.seek=await page.evaluate(()=>{const v=document.querySelector('video');v.currentTime=Math.min(v.duration-15,Math.max(30,v.duration*.55));return v.currentTime;});
 for(let k=0;k<22;k++){
  report.samples.push(await page.evaluate(()=>{const v=document.querySelector('video');return {time:v.currentTime,ready:v.readyState,error:v.error?.code,stats:window.__biliBufferPlaybackAssistInternals.publicStats()};}));
  await page.waitForTimeout(1000);
 }
 report.after=report.samples.at(-1);
 assert(report.after.time>report.seek+3,'seek 后视频没有恢复前进');assert(!report.after.error);
 if(injectFailure)assert(report.blockedRequests>0,'未实际阻断任何原线路请求');
 if(injectFailure)assert(Object.keys(report.requests).some(h=>/upos-sz-mirror(hw|ali|alib|hwb)\.bilivideo\.com/.test(h)&&!report.blockedHosts.includes(h)),'未观察到真实镜像下载');
 report.ok=true;
 await page.screenshot({path:root+`.tmp/cdn-recovery/live-${injectFailure?'fault':'seek'}.png`});
}catch(e){report.ok=false;report.failure=e.message;}
finally{
 await mkdir(new URL('../.tmp/cdn-recovery/',import.meta.url),{recursive:true});
 const out=root+`.tmp/cdn-recovery/live-${injectFailure?'fault':'seek'}.json`;
 await writeFile(out,JSON.stringify(report,null,2));
 console.log(JSON.stringify({ok:report.ok,failure:report.failure,video:report.video,injectFailure,before:report.before?.time,seek:report.seek,after:report.after?.time,requests:report.requests,blockedRequests:report.blockedRequests,finalStats:report.after?.stats}));
 await context.close();await rm(profile,{recursive:true,force:true});
}
if(!report.ok)process.exitCode=1;
