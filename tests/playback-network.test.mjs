import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/playback-routes.js';
import '../src/playback-network.js';
const { createNetwork } = globalThis.BiliPlaybackNetwork;
const primary = 'https://a.bilivideo.com/video.m4s?sign=secret';
const backup = 'https://b.bilivideo.com/video.m4s?sign=secret';
const manifest = { data: { dash: { video: [{ baseUrl: primary, backupUrl: [backup, 'https://evil.example/media'] }] } } };
const response = (start = 0, total = 4) => new Response(new Uint8Array(4), {status:206,headers:{'content-range':`bytes ${start}-${start+3}/${total}`}});

test('仅使用清单里同一轨道的合法 CDN；错误范围不写入，转备用节点', async () => {
  const calls=[];
  const network=createNetwork({cdnMode:"original",fetch:async url=>{calls.push(url);return response(url===primary?1:0);}});
  network.register(manifest);
  const result=await network.download(primary,0,4,4,new AbortController().signal);
  assert.equal(result.bytes.length,4); assert.deepEqual(calls,[primary,backup]);
  assert.equal(network.snapshot().rescues,1);
  assert(!JSON.stringify(network.snapshot()).includes('secret'));
});
test('慢节点启动救援，胜出后取消原请求，总并发受限', async () => {
  let aborted=false, active=0, peak=0;
  const network=createNetwork({cdnMode:"original",hedgeMs:10,fetch:async (url,{signal})=>{
    active++;peak=Math.max(peak,active);
    if(url===backup){active--;return response();}
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;active--;reject(signal.reason);},{once:true}));
  }});
  network.register(manifest);
  await network.download(primary,0,4,4,new AbortController().signal);
  await new Promise(r=>setTimeout(r,0));
  assert(aborted); assert(peak<=2); assert.equal(network.snapshot().active,0);
});
test('正文停滞也可救援，不必等首字节超时', async()=>{
  const network=createNetwork({cdnMode:"original",hedgeMs:10,fetch:async url=>url===backup?response():new Response(new ReadableStream({start(){}}),{status:206,headers:{'content-range':'bytes 0-3/4'}})});
  network.register(manifest);
  assert.equal((await network.download(primary,0,4,4,new AbortController().signal)).bytes.length,4);
});
test('取消排队请求与正在下载的请求，旧世代不污染统计', async()=>{
  const network=createNetwork({cdnMode:"original",fetch:async (_,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  const controller=new AbortController();
  const jobs=Array.from({length:4},()=>network.download(primary,0,4,4,controller.signal));
  controller.abort();network.reset();
  assert((await Promise.allSettled(jobs)).every(r=>r.status==='rejected'));
  assert.equal(network.snapshot().receivedBytes,0);
});
test('用户明确选择的低上限不会被饥饿增援突破',()=>{
  const n=createNetwork({cdnMode:"original",fetch:async()=>response(),maxConcurrency:4});
  assert.equal(n.snapshot().limit,4);
  n.tune({ahead:0,demand:true,rate:100,now:3000}); assert.equal(n.snapshot().limit,4);
  n.tune({ahead:0,demand:true,rate:150,now:6000}); assert.equal(n.snapshot().limit,4);
  n.tune({ahead:0,demand:true,rate:150,now:9000,failed:true}); assert.equal(n.snapshot().limit,4);
  n.tune({ahead:60,demand:false,rate:0,now:12000}); assert.equal(n.snapshot().limit,4);
});
test('范围总长不一致拒绝',async()=>{
  const n=createNetwork({cdnMode:"original",fetch:async()=>response(0,5)});
  await assert.rejects(n.download(primary,0,4,4,new AbortController().signal));
});

test('单连接模式救援替换慢请求，不被并发上限饿死', async()=>{
  let active=0,peak=0;
  const n=createNetwork({cdnMode:"original",maxConcurrency:1,hedgeMs:10,fetch:async(url,{signal})=>{
    active++;peak=Math.max(peak,active);
    if(url===backup){active--;return response();}
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>{active--;reject(signal.reason);},{once:true}));
  }});
  n.register(manifest);
  await n.download(primary,0,4,4,new AbortController().signal);
  assert.equal(peak,1); assert.equal(n.snapshot().rescues,1);
});

test('默认初始与重置并发为 8，同时尊重较低配置上限',()=>{
  const n=createNetwork({cdnMode:"original",fetch:async()=>response()});
  assert.equal(n.snapshot().limit,8);
  n.tune({ahead:60,demand:false,rate:0,now:3000});
  n.reset();assert.equal(n.snapshot().limit,8);
  n.setMax(2);n.reset();assert.equal(n.snapshot().limit,2);
  n.setMax(32);assert.equal(n.snapshot().limit,8);
});
