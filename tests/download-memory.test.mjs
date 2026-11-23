import test from 'node:test';import assert from 'node:assert/strict';
import {downloadByteRanges} from '../src/range-downloader.js';
import {createDownloadBudget} from '../src/download-budget.js';
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

test('两个离线轨道共享正文额度，慢事务与失败都不会超额或泄漏', async () => {
  const budget = createDownloadBudget({ tasks: 2, requests: 8, playingRequests: 2, bytes: 16 });
  let releaseCommit;
  const disk = new Promise(resolve => { releaseCommit = resolve; });
  const calls = [];
  let firstCommit;
  const committing = new Promise(resolve => { firstCommit = resolve; });
  const failed = new AbortController();
  const run = (name, signal) => downloadByteRanges({
    urls: [url], totalBytes: 32, rangeSize: 4, concurrency: 4, budget, signal,
    fetchImpl: async (_, init) => {
      const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
      calls.push({ name, start: Number(start) });
      return reply(Number(start), Number(end), 32);
    },
    async onCommit() { firstCommit(); await disk; }
  });
  const first = run('A', failed.signal);
  const second = run('B');
  const stopped = assert.rejects(first, { name: 'AbortError' });
  try {
    await committing;
    await delay(40);
    assert.equal(calls.length, 4, '两个轨道等事务的正文应合计至多 16 字节');
    failed.abort();
    await delay(20);
    assert.equal(calls.length, 4, '取消不能提前释放仍由事务持有的正文');
  } finally {
    releaseCommit();
    failed.abort();
    await Promise.allSettled([stopped, second]);
  }
  await stopped;
  assert.equal((await second).metrics.committedBytes, 32);
  const final = await run('C');
  assert.equal(final.metrics.committedBytes, 32, '取消后新任务应可使用全部预算');
});
