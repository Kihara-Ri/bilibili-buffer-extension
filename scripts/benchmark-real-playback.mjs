import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createChromeEvaluator } from './lib/existing-chrome.mjs';
import { createHash } from 'node:crypto';
const [pid, tabId] = process.argv.slice(2);
if (!/^\d+$/.test(pid || '') || !/^\d+$/.test(tabId || '')) throw Error('用法: node scripts/benchmark-real-playback.mjs <已有 Chrome PID> <B 站标签 ID>');
const rounds = Number(process.env.BENCH_ROUNDS || 3);
const sampleMiB = Number(process.env.BENCH_MIB || 2);
const cdnMode = process.env.BENCH_CDN || 'original';
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5);
assert([2, 8].includes(sampleMiB));
assert(['original', 'mainland', 'compare'].includes(cdnMode));
const source = await readFile(new URL('../src/playback-network.js', import.meta.url), 'utf8');
const routes = await readFile(new URL('../src/playback-routes.js', import.meta.url), 'utf8');
const matrixCases = sampleMiB === 8
  ? [8, 16, 32, 64, 128].map(concurrency => ({ name: `64k-${concurrency}`, chunkKiB: 64, concurrency }))
  : [{name:'native-single',chunkKiB:2048,concurrency:1}, ...[64,256].flatMap(chunkKiB => [1,4,8,16,32].map(concurrency => ({ name:`${chunkKiB}k-${concurrency}`,chunkKiB,concurrency })))];
const availableCases = [{name:'current-policy',chunkKiB:64,concurrency:32}, ...matrixCases];
const selectedNames = process.env.BENCH_CASES?.split(',');
const selectedCases = selectedNames ? availableCases.filter(c => selectedNames.includes(c.name)) : availableCases;
assert(selectedCases.length && (!selectedNames || selectedCases.length === selectedNames.length), '未知或重复 BENCH_CASES');
const cases = selectedCases.flatMap(c => cdnMode === 'compare' && c.name !== 'native-single'
  ? ['original','auto','mainland'].map(mode => ({...c,mode,name:c.name+'-'+mode}))
  : [{...c,mode:cdnMode === 'compare' ? 'original' : cdnMode}]);
const evaluate = createChromeEvaluator(pid, tabId);
// 实验变体只改分块和内部硬上限，用于测试 64/128；不会改变已加载扩展或用户设置。
assert(source.includes('priority > 0 ? 64*1024 : 256*1024'));
const factories = cases.map(c => {
  const variant = c.name.startsWith('current-policy') ? source : source
    .replace('length:Math.min(ranges.length,requestConcurrency)', 'length:Math.min(ranges.length,ceiling)')
    .replace('priority > 0 ? 64*1024 : 256*1024', `priority > 0 ? ${c.chunkKiB}*1024 : 256*1024`)
    .replaceAll('Math.min(32,','Math.min(128,');
  return `(()=>{${variant}return globalThis.BiliPlaybackNetwork.createNetwork;})()`;
}).join(',');
const browserCode = String.raw`(() => {
  if (!location.href.startsWith('https://www.bilibili.com/video/')) throw Error('必须在 B 站视频页运行');
  if (window.__biliRealBench?.state === 'running') throw Error('已有实验在运行');
  const previousNetwork=globalThis.BiliPlaybackNetwork, previousRoutes=globalThis.BiliPlaybackRoutes;
  ${routes}
  const factories=[${factories}];
  globalThis.BiliPlaybackNetwork=previousNetwork;
  const state=window.__biliRealBench={state:'running',results:[],current:'manifest'};
  const cases=${JSON.stringify(cases)}, rounds=${rounds}, sampleBytes=${sampleMiB}*1024*1024;
  const video=document.querySelector('video'), wasPlaying=video && !video.paused;
  if(video)video.pause();
  const assist=window.__biliBufferPlaybackAssistInternals, oldMode=assist?.cfg.mode;
  if(assist){assist.cfg.mode='off';assist.network?.reset();}
  // 使用同源空 iframe 的原生 fetch，避免被已安装插件缓存/二次拆分污染对照。
  const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);
  const nativeFetch=frame.contentWindow.fetch.bind(frame.contentWindow);
  const controller=new AbortController();state.cancel=()=>controller.abort();
  let network;
  const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  void(async()=>{
    try{
      const bvid=location.pathname.match(/BV[0-9A-Za-z]+/)[0];
      const get=async url=>{
        const r=await nativeFetch(url,{credentials:'include',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
        if(!r.ok)throw Error('API HTTP '+r.status);
        const p=await r.json();if(p.code!==0)throw Error('API code '+p.code);return p.data;
      };
      const view=await get('https://api.bilibili.com/x/web-interface/view?bvid='+bvid);
      const cid=view.pages?.[Math.max(0,Number(new URL(location.href).searchParams.get('p')||1)-1)]?.cid||view.cid;
      const manifest=await get('https://api.bilibili.com/x/player/playurl?bvid='+bvid+'&cid='+cid+'&qn=80&fnval=4048&fourk=1');
      const track=[...(manifest.dash?.video||[])].sort((a,b)=>b.bandwidth-a.bandwidth)[0];if(!track)throw Error('No DASH video track');
      const url=track.baseUrl||track.base_url;
      state.video={bvid,quality:track.id,bandwidth:track.bandwidth,codec:track.codecs,host:new URL(url).hostname};
      // 预检合法 206，文件总长只取响应头，不猜测码率或整个视频大小。
      const probe=await nativeFetch(url,{headers:{Range:'bytes=0-65535'},credentials:'omit',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
      const match=/^bytes 0-65535\/(\d+)$/.exec(probe.headers.get('content-range')||'');
      if(probe.status!==206||!match)throw Error('Probe HTTP '+probe.status+' or invalid Content-Range');
      if((await probe.arrayBuffer()).byteLength!==65536)throw Error('Probe body length');
      const total=Number(match[1]), size=Math.min(sampleBytes,total);state.sampleBytes=size;
      let expected;
      for(let round=0;round<rounds;round++){
        const shift=round*3%cases.length;
        const order=[...cases.slice(shift),...cases.slice(0,shift)];if(round%2)order.reverse();
        for(const candidate of order){
          if(controller.signal.aborted)throw Error('Cancelled');
          state.current={round,candidate:candidate.name};
          let requests=0,peak=0,httpErrors=0,firstHeaderMs=null,receivedBytes=0;
          const started=performance.now();
          network=factories[cases.indexOf(candidate)]({maxConcurrency:candidate.concurrency,cdnMode:candidate.mode,fetch:async(u,init)=>{
            requests++;peak=Math.max(peak,network.snapshot().active);
            const r=await nativeFetch(u,init);if(firstHeaderMs===null)firstHeaderMs=performance.now()-started;
            if(r.status!==206)httpErrors++;return r;
          }});
          network.register({data:{dash:{video:[track]}}});network.tune({ahead:0,demand:true});
          try{
            let bytes;
            if(candidate.name==='native-single'){
              requests++;peak=1;
              const r=await nativeFetch(url,{headers:{Range:'bytes=0-'+(size-1)},cache:'no-store',credentials:'omit',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(25000)])});
              firstHeaderMs=performance.now()-started;if(r.status!==206){httpErrors++;throw Error('HTTP '+r.status);}
              if(r.headers.get('content-range')!=='bytes 0-'+(size-1)+'/'+total)throw Error('Content-Range mismatch');
              bytes=new Uint8Array(await r.arrayBuffer());receivedBytes=bytes.length;
            }else{bytes=(await network.download(url,0,size,total,controller.signal,{priority:100})).bytes;receivedBytes=network.snapshot().receivedBytes;}
            const ms=performance.now()-started;
            if(bytes.length!==size)throw Error('Body length mismatch');
            const checksum=await hash(bytes);if(expected&&expected!==checksum)throw Error('SHA256 mismatch');expected=checksum;
            state.results.push({round,candidate:candidate.name,ok:true,ms,firstHeaderMs,requests,peak,httpErrors,receivedBytes,checksum,rescues:network.snapshot().rescues,host:network.snapshot().host});
          }catch(error){state.results.push({round,candidate:candidate.name,ok:false,error:error.name+': '+error.message,ms:performance.now()-started,requests,peak,httpErrors,receivedBytes:network.snapshot().receivedBytes});}
          finally{network.reset();}
          await new Promise(r=>setTimeout(r,150));
        }
      }
      state.state='done';
    }catch(error){state.state='error';state.error=error.name+': '+error.message;}
    finally{network?.reset();frame.remove();globalThis.BiliPlaybackRoutes=previousRoutes;if(assist)assist.cfg.mode=oldMode;if(wasPlaying)void video.play().catch(()=>{});}
  })();
  return 'started';
})();`;
// 先在本地编译生成的脚本，避免浏览器把语法错误吞成 null。
new Function(browserCode);
assert.equal(await evaluate(browserCode), 'started');
console.log('started');
let result, lastCount=-1;
try {
  for (;;) {
    await new Promise(resolve=>setTimeout(resolve,2000));
    result=JSON.parse(await evaluate(`JSON.stringify((()=>{const s=window.__biliRealBench;return {state:s?.state,error:s?.error,video:s?.video,sampleBytes:s?.sampleBytes,current:s?.current,results:s?.results};})())`));
    if(result.results?.length!==lastCount){lastCount=result.results?.length;console.log(JSON.stringify({state:result.state,completed:lastCount,current:result.current,last:result.results?.at(-1)}));}
    if(result.state!=='running')break;
  }
} catch(error) {
  await evaluate('window.__biliRealBench?.cancel?.(); "cancelled"').catch(()=>{});
  throw error;
}
const summary=cases.map(c=>{
  const rows=(result.results||[]).filter(r=>r.candidate===c.name),success=rows.filter(r=>r.ok), times=success.map(r=>r.ms).sort((a,b)=>a-b);
  return {candidate:c.name,success:success.length,attempts:rows.length,medianMs:times.length?Math.round(times[Math.floor(times.length/2)]):null,maxMs:times.length?Math.round(Math.max(...times)):null,requests:rows.map(r=>r.requests),peak:Math.max(0,...rows.map(r=>r.peak)),httpErrors:rows.reduce((n,r)=>n+r.httpErrors,0),networkBytes:rows.reduce((n,r)=>n+r.receivedBytes,0)};
});
await mkdir(new URL('../.tmp/real-concurrency/',import.meta.url),{recursive:true});
const label=process.env.BENCH_LABEL || '';
assert(/^[a-z0-9-]*$/.test(label));
const name=(result.video?.bvid||'failed')+'-'+sampleMiB+'MiB-'+cdnMode+(label?'-'+label:'')+'.json';
await writeFile(new URL('../.tmp/real-concurrency/'+name,import.meta.url),JSON.stringify({kind:'real-user-chrome-cdn',date:new Date().toISOString(),sourceSha256:createHash('sha256').update(source).digest('hex'),rounds,cdnMode,...result,summary},null,2));
console.log(JSON.stringify({file:'.tmp/real-concurrency/'+name,state:result.state,error:result.error,summary},null,2));
if(result.state!=='done'||(result.results||[]).some(r=>!r.ok))process.exitCode=1;
