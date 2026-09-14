import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/offscreen.js', import.meta.url), 'utf8');
const start = source.indexOf('function createDownloadCoordinator(');
const factorySource = source.slice(start, source.indexOf('\nfunction publicDownloadMetrics', start));
test('事务悬而未决或失败时不能发布暂存水位，成功后才增加已缓存量', async () => {
  let now = 1000, resolveWrite, rejectWrite;
  let transaction = new Promise((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; });
  const broadcasts = [], writes = [];
  // 运行生产函数本体，只替换 I/O 和时钟，确定性复现 receive 与事务提交交错。
  const factory = vm.runInNewContext(`(${factorySource})`, {
    performance: { now:()=>now }, Date, Map, Object, Number, Math, Promise,
    DEFAULT_RANGE_CONCURRENCY:4, DEFAULT_RANGE_SIZE:2*1024*1024, PROGRESS_WRITE_INTERVAL:450, META_WRITE_INTERVAL:1500,
    publicDownloadMetrics:()=>({}), aggregateDownloadMetrics:()=>({}), addDbWriteTime(){},
    putVideo:async()=>{}, putChunksAndVideo:async(snapshot)=>{ writes.push(snapshot); await transaction; },
    broadcastProgress:snapshot=>broadcasts.push(snapshot)
  });
  const coordinator = factory({id:'one',mediaKind:'progressive'}, {media:{resumeBytes:0,chunkCount:0,totalBytes:1000}});
  coordinator.receive('media',100);
  const batch = [{range:{start:0,end:99},data:new Blob([new Uint8Array(100)])}];
  const failing = coordinator.commit('media',batch);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(writes[0].committedBytes,100,'原子数据库快照包括将要一起提交的水位');
  now = 2000; coordinator.receive('media',20);
  assert.equal(broadcasts.at(-1).committedBytes,0,'提交完成前的广播不能宣布成功');
  rejectWrite(new Error('transaction aborted'));
  await assert.rejects(failing,/transaction aborted/);
  assert.equal(coordinator.snapshot().committedBytes,0);
  assert.equal(coordinator.snapshot().resumeBytes,0);
  transaction = new Promise(resolve=>{ resolveWrite=resolve; });
  const succeeding = coordinator.commit('media',batch);
  await new Promise(resolve=>setImmediate(resolve));
  resolveWrite(); await succeeding;
  assert.equal(coordinator.snapshot().committedBytes,100);
  coordinator.receive('media',-20);
  assert.equal(coordinator.snapshot().committedBytes,100,'在途回滚不影响已确认落盘');
});
