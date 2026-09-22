import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/playback-routes.js';
import '../src/playback-network.js';
const {createNetwork}=globalThis.BiliPlaybackNetwork;
const primary='https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/video.m4s?deadline=123&sign=x';
const total=1024*1024;
const response=(start,end,size=total)=>new Response(new Uint8Array(end-start).fill(start/65536),{status:206,headers:{'content-range':`bytes ${start}-${end-1}/${size}`}});
test('冷海外节点可发现大陆候选，保留签名路径与原地址回退',()=>{
 const urls=globalThis.BiliPlaybackRoutes.candidates([primary],'mainland');
 assert(urls.some(u=>new URL(u).hostname==='upos-sz-mirrorali.bilivideo.com'));
 assert(urls.includes(primary));
 for(const u of urls){assert.equal(new URL(u).search,new URL(primary).search);assert.equal(new URL(u).pathname,new URL(primary).pathname);}
 assert.deepEqual(globalThis.BiliPlaybackRoutes.candidates(['https://evil.test/a.m4s'],'mainland'),[]);
 assert.deepEqual(globalThis.BiliPlaybackRoutes.candidates([primary],'original'),[primary]);
});
test('单个播放器媒体请求分成多个真实 Range 并发，按位置重组',async()=>{
 let active=0,peak=0;const ranges=[];
 const n=createNetwork({maxConcurrency:8,cdnMode:'original',fetch:async(_,{headers})=>{
  active++;peak=Math.max(peak,active);const [,a,b]=/bytes=(\d+)-(\d+)/.exec(headers.Range);ranges.push([+a,+b]);
  await new Promise(r=>setTimeout(r,10));active--;return response(+a,+b+1);
 }});
 const r=await n.download(primary,0,total,total,new AbortController().signal,{priority:100});
 assert(peak>=4);assert(peak<=8);assert(ranges.length>=4);assert.equal(r.bytes.length,total);
 for(const [a] of ranges)assert.equal(r.bytes[a],a/65536);
});
test('冷缓存超时不会把急需缓冲的并发压到 1；失败节点隔离而非全局减半',()=>{
 const n=createNetwork({maxConcurrency:16,fetch:async()=>{throw Error('timeout');}});
 n.tune({ahead:0,demand:true,rate:0,failed:true,now:3000});assert(n.snapshot().limit>=8);
 n.tune({ahead:0,demand:true,rate:0,failed:true,now:6000});assert(n.snapshot().limit>=8);
 n.tune({ahead:60,demand:false,rate:0,now:9000});assert(n.snapshot().limit>=4);
});
test('故障副本与请求取消不导致块混合；reset 主动取消全部队列',async()=>{
 const n=createNetwork({fetch:async(_,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),cdnMode:'original'});
 const jobs=[n.download(primary,0,total,total,new AbortController().signal)];
 await new Promise(r=>setTimeout(r,10));n.reset();
 assert((await Promise.allSettled(jobs)).every(r=>r.status==='rejected'));
 assert.equal(n.snapshot().active,0);
});

test('8 路起步，缺缓冲立即扩至 32；吞吐不足即使有余量也翻倍增援',()=>{
 const n=createNetwork({fetch:async()=>response(0,4)});
 assert.equal(n.snapshot().limit,8);
 n.tune({ahead:2,demand:true,rate:0,requiredRate:1000000,now:1});
 assert.equal(n.snapshot().limit,32);
 n.reset();assert.equal(n.snapshot().limit,8);
 n.tune({ahead:20,demand:true,rate:1000,requiredRate:1000000,now:1000});
 assert.equal(n.snapshot().limit,16);
 n.tune({ahead:19,demand:true,rate:1000,requiredRate:1000000,now:1500});
 assert.equal(n.snapshot().limit,32);
});
test('急需的 8 MiB 大片段可实际使用 32 路，不只是显示上限',async()=>{
 let active=0,peak=0;
 const size=8*1024*1024;
 const n=createNetwork({cdnMode:'original',fetch:async(_,{headers})=>{
  const [,a,b]=/bytes=(\d+)-(\d+)/.exec(headers.Range);active++;peak=Math.max(peak,active);
  await new Promise(r=>setTimeout(r,20));active--;return response(+a,+b+1,size);
 }});
 n.tune({ahead:0,demand:true,now:1});
 const result=await n.download(primary,0,size,size,new AbortController().signal,{priority:100});
 assert.equal(peak,32);assert.equal(result.bytes.length,size);
});
