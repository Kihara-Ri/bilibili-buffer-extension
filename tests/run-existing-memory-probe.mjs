import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createChromeEvaluator} from '../scripts/lib/existing-chrome.mjs';
const [pid,tab]=process.argv.slice(2),evaluate=createChromeEvaluator(pid,tab);
const routes=await readFile(new URL('../src/playback-routes.js',import.meta.url),'utf8'),source=await readFile(new URL('../src/playback-network.js',import.meta.url),'utf8');
const code=String.raw`(()=>{const result=window.__biliMemoryProbe={state:'running'},fixture={};((globalThis)=>{${routes};${source}})(fixture);
 void(async()=>{try{const network=fixture.BiliPlaybackNetwork.createNetwork({fetch:async(_,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}))});
 const jobs=Array.from({length:6},()=>network.download('https://probe.bilivideo.com/v.m4s',0,16*1024*1024,32*1024*1024,new AbortController().signal,{priority:100}));
 await new Promise(r=>setTimeout(r,40));const before=network.snapshot();network.reset();const outcomes=await Promise.allSettled(jobs);const after=network.snapshot();
 Object.assign(result,{state:'done',queued:before.memoryQueued,peak:before.memoryPeak,limit:before.memoryLimit,remaining:after.memoryBytes,rejected:outcomes.every(r=>r.status==='rejected')});
 }catch(error){Object.assign(result,{state:'error',error:error.message});}})();return 'started';})();`;
new Function(code);await evaluate(code);let result;for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,100));result=JSON.parse(await evaluate('JSON.stringify(window.__biliMemoryProbe)'));if(result.state!=='running')break;}
assert.equal(result.state,'done',result.error);assert(result.queued>0);assert(result.peak<=result.limit);assert.equal(result.remaining,0);assert(result.rejected);console.log(JSON.stringify({ok:true,kind:'existing-chrome-memory-admission-probe',...result}));
