import test from 'node:test';import assert from 'node:assert/strict';
import {downloadByteRanges} from '../src/range-downloader.js';
import '../src/playback-routes.js';import '../src/playback-network.js';
import {loadCache} from './playback-cache-helpers.mjs';
test('并发部分拼接总预留有界，取消后归零',async()=>{
 const url='https://a.bilivideo.com/v.m4s',size=16*1024*1024,window={fetch:async()=>{throw Error('unexpected fallback');}};
 const cache=loadCache({window,performance,AbortController});cache.put(url,0,new Uint8Array(size/2),size);const ranges=[],signals=[];
 cache.install({loadRange:async(_,range,signal)=>{ranges.push(range);signals.push(signal);return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
 const controller=new AbortController();const requests=Array.from({length:2},()=>window.fetch(url,{headers:{Range:`bytes=0-${size-1}`},signal:controller.signal}));
 await new Promise(r=>setTimeout(r,10));assert.equal(cache.stats.partialPeak,32*1024*1024);assert(ranges.includes(`bytes=0-${size-1}`));
 controller.abort();assert.deepEqual(signals.map(s=>s.aborted),[true,true]);await Promise.race([Promise.allSettled(requests),new Promise((_,reject)=>setTimeout(()=>reject(Error("拼接取消未完成")),200))]);assert.equal(cache.stats.partialBytes,0);
});

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const url='https://a.bilivideo.com/v.m4s';
function reply(a,b,total){return new Response(Uint8Array.from({length:b-a+1},(_,i)=>(a+i)%251),{status:206,headers:{'content-range':`bytes ${a}-${b}/${total}`}});}
test('慢首块和慢事务不会让离线乱序正文超过字节窗口',async()=>{
 let releaseHead,releaseCommit;const head=new Promise(r=>releaseHead=r),commit=new Promise(r=>releaseCommit=r);const calls=[],ordinals=[];
 const job=downloadByteRanges({urls:[url],totalBytes:100,rangeSize:4,maxBufferedBytes:16,concurrency:4,fetchImpl:async(_,init)=>{
  const [,a,b]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range);calls.push(+a);if(+a===0)await head;return reply(+a,+b,100);
 },onCommit:async batch=>{await commit;ordinals.push(...batch.map(e=>e.range.ordinal));}});
 await delay(30);assert.equal(calls.length,4);releaseHead();await delay(30);assert.equal(calls.length,4,'事务成功前不释放窗口');releaseCommit();
 const {metrics}=await job;assert(metrics.peakBufferedBytes<=16);assert.equal(metrics.committedBytes,100);assert.deepEqual(ordinals,Array.from({length:25},(_,i)=>i));
});
test('落盘失败取消正文并唤醒窗口等待者，不死锁',async()=>{
 const error=Error('disk failure');let aborted=0;
 const job=downloadByteRanges({urls:[url],totalBytes:100,rangeSize:4,maxBufferedBytes:8,concurrency:2,fetchImpl:async(_,init)=>{
  const [,a,b]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range);if(+a===0)return reply(+a,+b,100);
  return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>{aborted++;reject(init.signal.reason);},{once:true}));
 },onCommit:async()=>{throw error;}});
 await assert.rejects(job,/disk failure/);assert.equal(aborted,1);
});
test('外部取消唤醒已满的离线窗口',async()=>{
 const controller=new AbortController();
 const job=downloadByteRanges({urls:[url],totalBytes:100,rangeSize:4,maxBufferedBytes:8,concurrency:2,signal:controller.signal,fetchImpl:async(_,init)=>{
  const [,a,b]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range);if(+a!==0)return reply(+a,+b,100);
  return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));
 },onCommit:async()=>{}});
 await delay(20);controller.abort();await assert.rejects(job);});
test('在线多任务按字节排队，取消与 reset 后不残留预留',async()=>{
 const network=BiliPlaybackNetwork.createNetwork({fetch:async(_,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}))});
 const signal=new AbortController().signal;const jobs=Array.from({length:6},()=>network.download(url,0,16*1024*1024,32*1024*1024,signal,{priority:100}));
 await delay(20);const snapshot=network.snapshot();assert(snapshot.memoryQueued>0);assert(snapshot.memoryPeak<=64*1024*1024);network.reset();
 assert((await Promise.allSettled(jobs)).every(r=>r.status==='rejected'));assert.equal(network.snapshot().memoryBytes,0);assert.equal(network.snapshot().memoryQueued,0);
});
test('在线有界任务仍返回完整正确字节且释放预留',async()=>{
 const total=512*1024;const network=BiliPlaybackNetwork.createNetwork({fetch:async(_,init)=>{const [,a,b]=/bytes=(\d+)-(\d+)/.exec(init.headers.Range);return reply(+a,+b,total);}});
 const outputs=await Promise.all(Array.from({length:5},()=>network.download(url,0,total,total,new AbortController().signal,{priority:100})));
 assert(outputs.every(o=>o.bytes.length===total&&o.bytes.every((b,i)=>b===i%251)));assert.equal(network.snapshot().memoryBytes,0);assert(network.snapshot().memoryPeak<=network.snapshot().memoryLimit);
});
