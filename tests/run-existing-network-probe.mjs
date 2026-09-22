import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createChromeEvaluator} from '../scripts/lib/existing-chrome.mjs';
const [pid,tab]=process.argv.slice(2), evaluate=createChromeEvaluator(pid,tab);
const sources=await Promise.all(['playback-routes','playback-network'].map(s=>readFile(new URL(`../src/${s}.js`,import.meta.url),'utf8')));
// 只在用户已打开的 Chrome 标签执行受控正确性探针；不宣称这是实网测速。
const code=String.raw`(()=>{
 const previous={routes:globalThis.BiliPlaybackRoutes,network:globalThis.BiliPlaybackNetwork};
 ${sources.join('\n')}
 const state=window.__biliNetworkProbe={state:'running'};
 void(async()=>{try{
  const total=2*1024*1024,peaks=[];let active=0,peak=0;
  const n=BiliPlaybackNetwork.createNetwork({cdnMode:'original',fetch:async(_,{headers})=>{
   const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(headers.Range);active++;peak=Math.max(peak,active);
   await new Promise(r=>setTimeout(r,85));active--;
   return new Response(new Uint8Array(+b-+a+1).fill(9),{status:206,headers:{'content-range':'bytes '+a+'-'+b+'/'+total}});
  }});n.tune({ahead:0,demand:true});
  for(let i=0;i<7;i++){peak=0;const r=await n.download('https://probe.bilivideo.com/test.m4s',0,total,total,new AbortController().signal,{priority:100});if(r.bytes.length!==total||!r.bytes.every(b=>b===9))throw Error('body mismatch');peaks.push(peak);}
  state.peaks=peaks;state.active=n.snapshot().active;state.state='done';n.reset();
 }catch(error){state.state='error';state.error=error.message;}finally{globalThis.BiliPlaybackRoutes=previous.routes;globalThis.BiliPlaybackNetwork=previous.network;}})();
 return 'started';
})();`;
new Function(code);assert.equal(await evaluate(code),'started');
let result;
for(let i=0;i<100;i++){
 await new Promise(r=>setTimeout(r,200));
 result=JSON.parse(await evaluate('JSON.stringify(window.__biliNetworkProbe)'));
 if(result.state!=='running')break;
}
assert.equal(result.state,'done',result.error);assert.deepEqual(result.peaks,[8,8,8,4,4,4,8]);assert.equal(result.active,0);
console.log(JSON.stringify({ok:true,kind:'existing-chrome-controlled-probe',...result}));
