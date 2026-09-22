import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCache } from './playback-cache-helpers.mjs';
const url = 'https://a.bilivideo.com/video.m4s';
test('fetch 已返回响应但正文尚未消费时仍响应取消', async () => {
  const window = { fetch: () => { throw new Error('不应该下载'); } };
  const cache = loadCache({ window }); cache.put(url, 0, new Uint8Array([1, 2]), 2); cache.install();
  const controller = new AbortController();
  const response = await window.fetch(url, { headers: { Range: 'bytes=0-1' }, signal: controller.signal });
  controller.abort();
  await assert.rejects(response.arrayBuffer(), { name: 'AbortError' });
});
test('fetch 缓存内部响应构造失败时恢复原始网络请求', async () => {
  let requests = 0;
  const window = { fetch: async () => { requests++; return new Response(new Uint8Array([8, 9]), { status: 206 }); } };
  const cache = loadCache({ window, Response: class { constructor() { throw new Error('allocation failure'); } } });
  cache.put(url, 0, new Uint8Array([1, 2]), 2); cache.install();
  const response = await window.fetch(url, { headers: { Range: 'bytes=0-1' } });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [8, 9]);
  assert.equal(requests, 1); assert.equal(cache.stats.hits, 0);
});
test('fetch 排队命中遇到导航清理时不再交付旧缓存', async () => {
  let requests = 0;
  const window = { fetch: async () => { requests++; return new Response(new Uint8Array([8, 9]), { status: 206 }); } };
  const cache = loadCache({ window }); cache.put(url, 0, new Uint8Array([1, 2]), 2); cache.install();
  const pending = window.fetch(url, { headers: { Range: 'bytes=0-1' } }); cache.clear();
  assert.deepEqual([...new Uint8Array(await (await pending).arrayBuffer())], [8, 9]);
  assert.equal(requests, 1); assert.equal(cache.stats.hits, 0);
});
test('Fetch 在排队命中后取消时不下载、不记命中', async () => {
  const window = { fetch: () => { throw new Error('不应该下载'); } };
  const cache = loadCache({ window }); cache.put(url, 0, new Uint8Array([1, 2]), 2); cache.install();
  const controller = new AbortController();
  const pending = window.fetch(url, { headers: { Range: 'bytes=0-1' }, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(cache.stats.hits, 0);
});
test('fetch 缓存未命中时直接使用并发下载器，而不是原单路 CDN', async () => {
  let native=0,accelerated=0;
  const window={fetch:async()=>{native++;return new Response();}};
  const cache=loadCache({window});cache.install({loadRange:async()=>{accelerated++;return {body:new Uint8Array([3,4]),start:0,end:2,total:2,contentType:'video/mp4'};}});
  const r=await window.fetch(url,{headers:{Range:'bytes=0-1'}});
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[3,4]);assert.equal(accelerated,1);assert.equal(native,0);assert.equal(cache.stats.hits,0);
});
test('fetch 加速取消不回退原请求，也不交付旧视频数据',async()=>{
  let native=0;const window={fetch:async()=>{native++;return new Response();}};
  const cache=loadCache({window});cache.install({loadRange:async(_url,_range,signal)=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  const c=new AbortController();const pending=window.fetch(url,{headers:{Range:'bytes=0-1'},signal:c.signal});
  await Promise.resolve();c.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(native,0);
});
