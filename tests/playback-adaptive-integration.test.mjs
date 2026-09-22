import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/playback-routes.js';
import '../src/playback-network.js';

test('下载主链路实际应用学习预算，较低并发变慢后恢复',async()=>{
  const total=2*1024*1024, peaks=[];let active=0,peak=0;
  const n=globalThis.BiliPlaybackNetwork.createNetwork({cdnMode:'original',fetch:async(_,{headers})=>{
    const [,a,b]=/^bytes=(\d+)-(\d+)$/.exec(headers.Range);active++;peak=Math.max(peak,active);
    await new Promise(r=>setTimeout(r,85));active--;
    return new Response(new Uint8Array(+b-+a+1),{status:206,headers:{'content-range':`bytes ${a}-${b}/${total}`}});
  }});
  n.tune({ahead:0,demand:true});
  for(let i=0;i<7;i++){
    peak=0;const r=await n.download('https://a.bilivideo.com/test.m4s',0,total,total,new AbortController().signal,{priority:100});
    assert.equal(r.bytes.length,total);peaks.push(peak);
  }
  assert.deepEqual(peaks,[8,8,8,4,4,4,8]);assert.equal(n.snapshot().active,0);
});
