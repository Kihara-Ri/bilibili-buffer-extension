import test from 'node:test';
import assert from 'node:assert/strict';
import {transitionBudget,createBudgetService,budgetOwner,REQUEST_LEASE_MS} from '../src/request-budget.js';
import '../src/request-budget-client.js';
const acquire=(id,priority=1)=>({op:'acquire',id,priority});
test('多页与后台共享容量，后台限额、播放优先与重启保留有效租约',async()=>{
 let saved={};const storage={get:async()=>structuredClone(saved),set:async value=>{saved=structuredClone(value);}};
 let service=createBudgetService(storage,async()=>4);
 const grants=await Promise.all(Array.from({length:8},(_,i)=>service(acquire('a'+i,0),'offscreen')));
 assert.equal(grants.filter(r=>r.lease).length,1);
 const page=await service(acquire('p1'),'page:1');assert(page.lease);
 service=createBudgetService(storage,async()=>4);
 const second=await service(acquire('p2'),'page:2');assert(second.lease);
 assert(saved.requestBudgetV1.leases.length<=4);
 assert.equal((await service(acquire('bg',0),'offscreen')).lease,null);
});
test('容量降低不回收仍在途请求、不超发；重复申请与释放幂等，到期可回收',()=>{
 let state;for(let i=0;i<4;i++)state=transitionBudget(state,acquire('a'+i),'page',4,100).state;
 const duplicate=transitionBudget(state,acquire('a0'),'page',4,200);assert.equal(duplicate.state.leases.length,4);
 assert.equal(transitionBudget(state,acquire('b'),'other',1,200).reply.lease,null);
 const expired=transitionBudget(state,acquire('b'),'other',1,100+REQUEST_LEASE_MS);assert(expired.reply.lease);assert.equal(expired.state.leases.length,1);
 const release=transitionBudget(expired.state,{op:'release',id:'b'},'other',1,50000);assert.equal(release.state.leases.length,0);
});
test('持久化失败不授予；非法发送者不能冒用预算',async()=>{
 const service=createBudgetService({get:async()=>({}),set:async()=>{throw Error('storage failure');}},async()=>32);
 await assert.rejects(service(acquire('a'),'page'),/storage failure/);
 assert.equal(budgetOwner({id:'x',url:'https://evil.test',tab:{id:1}},'x'),null);
 assert.equal(budgetOwner({id:'x',url:'chrome-extension://x/offscreen.html'},'x'),'offscreen');
 assert.equal(budgetOwner({id:'x',url:'https://www.bilibili.com/video/BVx',tab:{id:1},documentId:'doc'},'x'),'page:1:doc');
});
test('客户端在正文消费完成前保持租约，取消/拒绝服务不旁路下载',async()=>{
 let requests=0,leases=0,releases=0;
 const rpc=async q=>{if(q.op==='release'){leases--;releases++;return {ok:true};}leases++;return {ok:true,lease:{expiresAt:Date.now()+45000}};};
 const wrapped=BiliRequestBudget.createBudgetFetch(async()=>{requests++;return new Response(new Uint8Array([1,2,3]));},rpc);
 const response=await wrapped('https://example.test');assert.equal(leases,1);
 assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3]);await new Promise(r=>setTimeout(r,0));assert.equal(leases,0);assert.equal(releases,1);
 const pending=await wrapped('https://example.test');await pending.body.cancel();await new Promise(r=>setTimeout(r,0));assert.equal(leases,0);
 const denied=BiliRequestBudget.createBudgetFetch(async()=>{requests++;},async()=>({ok:false}));
 await assert.rejects(denied('https://example.test'));assert.equal(requests,2);
});
test('两个独立上下文的实际 fetch 峰值受持久服务约束',async()=>{
 let saved={},active=0,peak=0;
 const service=createBudgetService({get:async()=>structuredClone(saved),set:async s=>{saved=structuredClone(s);}},async()=>2);
 const make=owner=>BiliRequestBudget.createBudgetFetch(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,30));active--;return new Response(new Uint8Array(4));},async q=>({ok:true,...await service(q,owner)}));
 const a=make('page:1'),b=make('page:2');
 await Promise.all([a,b,a,b].map(f=>f('https://example.test',{priority:'high'}).then(r=>r.arrayBuffer())));
 await new Promise(r=>setTimeout(r,0));assert(peak<=2);assert.equal(saved.requestBudgetV1.leases.length,0);
});
