import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/playback-network.js';
const create = () => globalThis.BiliPlaybackNetwork.createAdaptiveBudget();
const url = 'https://cdn.bilivideo.com/test.m4s?sign=private';
const size = 2 * 1024 * 1024;
function samples(budget, rate, count=3, extra={}) {
  for(let i=0;i<count;i++) {const ticket=budget.choose(url,size,32,8);budget.record(ticket,{bytes:size,ms:size/rate*1000,rescues:0,...extra});}
}
test('重复有效吞吐样本后才试探减少并发，无收益连接收敛',()=>{
  const b=create();assert.equal(b.choose(url,size,32,8).workers,8);
  samples(b,2*1024*1024);assert.equal(b.choose(url,size,32,8).workers,4);
  samples(b,2*1024*1024);assert.equal(b.choose(url,size,32,8).workers,4);
  assert.equal(b.snapshot()[0].phase,'hold');
});
test('降低并发吞吐下降则恢复，持有后可重新试探扩容',()=>{
  const b=create();samples(b,2*1024*1024);samples(b,1024*1024);
  assert.equal(b.choose(url,size,32,8).workers,8);
  samples(b,2*1024*1024,6);assert.equal(b.snapshot()[0].phase,'probe-down');
});
test('保留收益相同的较低并发后，线路变化可重新增加',()=>{
  const b=create();samples(b,2*1024*1024);samples(b,2*1024*1024);
  samples(b,2*1024*1024,6);assert.equal(b.choose(url,size,32,8).workers,8);
  samples(b,4*1024*1024);assert.equal(b.choose(url,size,32,8).workers,8);
});
test('微小/快速响应、救援样本、旧票据不学习；用户上限不可突破',()=>{
  const b=create(), stale=b.choose(url,size,32,8);
  samples(b,2*1024*1024,5,{rescues:1});assert.equal(b.snapshot()[0].phase,'baseline');
  samples(b,2*1024*1024);b.record(stale,{bytes:size,ms:1000,rescues:0});
  assert.equal(b.choose(url,size,32,8).workers,4);
  assert.equal(b.choose(url,size,2,8).workers,2);
  assert.equal(b.choose(url,8*size,32,32).workers,32);
  assert(!JSON.stringify(b.snapshot()).includes('private'));
  b.reset();assert.equal(b.snapshot().length,0);
});
