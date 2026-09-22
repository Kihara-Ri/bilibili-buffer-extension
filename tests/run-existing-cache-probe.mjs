import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createChromeEvaluator} from '../scripts/lib/existing-chrome.mjs';
const [pid,tab]=process.argv.slice(2),evaluate=createChromeEvaluator(pid,tab);
const source=await readFile(new URL('../src/playback-cache.js',import.meta.url),'utf8');
const code=String.raw`(()=>{
 const result=window.__biliCacheProbe={state:'running'};
 const fixture={XMLHttpRequest:window.XMLHttpRequest,fetch:async()=>{throw Error('unexpected native network');}};
 // 使用词法 window 隔离包装器，不修改用户真实页面的 fetch/XHR 或缓存。
 const cache=((window)=>{${source};return window.__biliBufferCache;})(fixture);
 void(async()=>{try{
  const url='https://probe.bilivideo.com/cache.m4s',total=1000,calls=[];
  const bytes=(a,b)=>Uint8Array.from({length:b-a},(_,i)=>(a+i)%251);
  cache.put(url,0,bytes(0,100),total);cache.put(url,200,bytes(200,300),total);
  cache.install({loadRange:async(_url,range)=>{calls.push(range);const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(range);return {body:bytes(+a,+b+1),start:+a,end:+b+1,total,contentType:'video/mp4'};}});
  const response=await fixture.fetch(url,{headers:{Range:'bytes=0-299'}});const body=new Uint8Array(await response.arrayBuffer());
  if(body.length!==300||!body.every((b,i)=>b===i%251))throw Error('fetch bytes');
  const xhr=await new Promise((resolve,reject)=>{const x=new fixture.XMLHttpRequest();x.open('GET',url);x.responseType='arraybuffer';x.setRequestHeader('Range','bytes=0-299');x.onload=()=>resolve({status:x.status,bytes:Array.from(new Uint8Array(x.response))});x.onerror=reject;x.send();});
  if(xhr.status!==206||xhr.bytes.length!==300||!xhr.bytes.every((b,i)=>b===i%251))throw Error('xhr bytes');
  result.calls=calls;result.partialHits=cache.stats.partialHits;
  if(cache.retain){cache.clear();cache.setLimit(160);cache.retain(url,{position:50,duration:100,ahead:5,rewind:5,protectInit:false});cache.put(url,500,bytes(500,600),total);cache.put(url,0,bytes(0,100),total);result.retention=!!cache.match(url,'bytes=500-599')&&!cache.match(url,'bytes=0-99')&&cache.stats.bytes<=160;}
  result.state='done';
 }catch(error){result.state='error';result.error=error.message;}})();return 'started';
})();`;
new Function(code);assert.equal(await evaluate(code),'started');let result;
for(let i=0;i<50;i++){await new Promise(r=>setTimeout(r,100));result=JSON.parse(await evaluate('JSON.stringify(window.__biliCacheProbe)'));if(result.state!=='running')break;}
assert.equal(result.state,'done',result.error);assert.deepEqual(result.calls,['bytes=100-199','bytes=100-199']);assert.equal(result.partialHits,2);if('retention' in result)assert(result.retention);
console.log(JSON.stringify({ok:true,kind:'existing-chrome-cache-probe',...result}));
