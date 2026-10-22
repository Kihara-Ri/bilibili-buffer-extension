import test from 'node:test';import assert from 'node:assert/strict';
import {downloadByteRanges} from '../src/range-downloader.js';
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
