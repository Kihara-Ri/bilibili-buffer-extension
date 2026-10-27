// 受控浏览器对照：运行旧/新真实调度器；网络故障由路由注入，不能当作真实 CDN 测速。
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chromiumLaunchOptions} from '../scripts/lib/browser-launch.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const baseline=process.env.CDN_BASELINE_ROOT
  ? await readFile(process.env.CDN_BASELINE_ROOT+'/src/playback-network.js','utf8')
  : execFileSync('git',['show','9123e48:src/playback-network.js'],{cwd:root,encoding:'utf8'});
const current=await readFile(new URL('../src/playback-network.js',import.meta.url),'utf8');
const total=8*1024*1024;
const primary='https://upos-hz-mirrorakam.akamaized.net/upgcxcode/01/02/test.m4s?sign=test';
const backup=primary.replace('upos-hz-mirrorakam.akamaized.net','upos-sz-mirrorcosov.bilivideo.com');
const cases=['healthy','high-latency','primary-stall','slots-full','both-stall','native-failed','bad-mirror','all-failed','seek-cancel','dual-track'];
const browser=await chromium.launch(chromiumLaunchOptions({headless:true}));
const results=[];
try{
 for(const scenario of cases){
  for(let trial=0;trial<3;trial++)for(const version of trial%2?['new','old']:['old','new']){
   const page=await browser.newPage();let phase='prime';const requests=[];
   await page.route('https://www.bilibili.com/**',r=>r.fulfill({body:'<!doctype html><video></video>',contentType:'text/html'}));
   await page.route(/https:\/\/[^/]+\/(?:upgcxcode)\//,async route=>{
    const request=route.request(),host=new URL(request.url()).hostname;
    const [,left,right]=/bytes=(\d+)-(\d+)/.exec(request.headers().range);const a=+left,b=+right;
    const trusted=host===new URL(primary).hostname||host===new URL(backup).hostname;
    const entry={host,a,b,status:206,bytes:0};if(phase==='measure')requests.push(entry);
    let wait=scenario==='high-latency'?220:15;
    if(phase==='measure'){
     if((['primary-stall','slots-full'].includes(scenario)&&host===new URL(primary).hostname||scenario==='both-stall'&&trusted))wait=3500;
     if(['native-failed','bad-mirror','all-failed'].includes(scenario)&&(trusted||scenario==='all-failed'))entry.status=503;
     if(scenario==='seek-cancel'&&a<4*1024*1024)wait=1000;
    }
    await new Promise(r=>setTimeout(r,wait));
    const body=Buffer.from(Array.from({length:b-a+1},(_,i)=>((a+i)*7+3)&255));
    if(phase==='measure'&&scenario==='bad-mirror'&&host==='upos-sz-mirrorhw.bilivideo.com')body[0]^=255;
    const success=await route.fulfill({status:entry.status,body:entry.status===206?body:Buffer.from('unavailable'),headers:{
     'content-range':`bytes ${a}-${b}/${total}`,'content-type':'video/mp4','access-control-allow-origin':'*','access-control-expose-headers':'Content-Range'
    }}).then(()=>true,()=>false);if(success)entry.bytes=entry.status===206?body.length:0;
   });
   await page.goto('https://www.bilibili.com/video/BVfixture/');
   await page.addScriptTag({content:version==='old'?baseline:current});
   await page.evaluate(async({primary,backup,total})=>{
    window.net=BiliPlaybackNetwork.createNetwork({fetch:fetch.bind(window),firstByteMs:2500});
    net.register({data:{dash:{video:[{baseUrl:primary,backupUrl:[backup]}]}}});
    await net.get(primary,0,1024,{signal:new AbortController().signal,total});
   },{primary,backup,total});phase='measure';
   const result=await page.evaluate(async({primary,total,scenario})=>{
    const begin=performance.now();let ok=true,error='',aborted=false;
    try{
     if(scenario==='seek-cancel'){
      const controller=new AbortController(),old=net.get(primary,1024*1024,2*1024*1024,{signal:controller.signal,total});old.catch(()=>{});
      await new Promise(r=>setTimeout(r,25));controller.abort();try{await old;}catch(e){aborted=e.name==='AbortError';}
     }
     const count=scenario==='slots-full'?32:scenario==='dual-track'?2:1;
     const jobs=Array.from({length:count},(_,i)=>{
      const start=scenario==='seek-cancel'?4*1024*1024:2048+i*65536;
      const size=scenario==='slots-full'?4:scenario==='dual-track'?65536:262144;
      const url=scenario==='dual-track'&&i===1?primary.replace('test.m4s','audio.m4s'):primary;
      return net.get(url,start,start+size,{signal:new AbortController().signal,total}).then(r=>{
       if(r.bytes.length!==size||!r.bytes.every((byte,at)=>byte===((start+at)*7+3&255)))throw new Error('wrong media bytes');
      });
     });await Promise.all(jobs);
    }catch(e){ok=false;error=e.message;}
    const ms=performance.now()-begin;const receivedBytes=net.snapshot().receivedBytes-1024;net.reset();await new Promise(r=>setTimeout(r,10));
    return {ok,error,aborted,receivedBytes,ms:Math.round(ms),activeAfter:net.snapshot().active};
   },{primary,total,scenario});
   assert.equal(result.activeAfter,0);
   if(['native-failed','bad-mirror','both-stall'].includes(scenario))assert.equal(result.ok,version==='new');
   else assert.equal(result.ok,scenario!=='all-failed',JSON.stringify({scenario,version,result}));
   if(scenario==='seek-cancel')assert(result.aborted);
   if(['healthy','high-latency'].includes(scenario))assert(requests.every(r=>[new URL(primary).hostname,new URL(backup).hostname].includes(r.host)),'健康原线路不应增加镜像请求');
   results.push({scenario,version,trial,...result,requests:requests.length,deliveredBytes:requests.reduce((sum,r)=>sum+r.bytes,0),mirrorRequests:requests.filter(r=>![new URL(primary).hostname,new URL(backup).hostname].includes(r.host)).length});
   await page.close();
  }
  const median=values=>values.sort((a,b)=>a-b)[1];
  const row={scenario,oldMs:median(results.filter(r=>r.scenario===scenario&&r.version==='old').map(r=>r.ms)),newMs:median(results.filter(r=>r.scenario===scenario&&r.version==='new').map(r=>r.ms))};
  console.log(JSON.stringify(row));
  if(scenario==='slots-full')assert(row.newMs<row.oldMs*.8,'饱和时救援应比等待首字节超时更快');
 }
 const out=process.env.CDN_COMPARISON_OUT||root+'.tmp/cdn-recovery/comparison.json';await mkdir(new URL('../.tmp/cdn-recovery/',import.meta.url),{recursive:true});
 await writeFile(out,JSON.stringify({baseline:'9123e48',trials:3,controlled:true,results},null,2));
}finally{await browser.close();}
