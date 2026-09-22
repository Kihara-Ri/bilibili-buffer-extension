import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createBudgetService,budgetOwner} from '../src/request-budget.js';
const bridgeSource=await readFile(new URL('../src/playback-bridge.js',import.meta.url),'utf8');
const clientSource=await readFile(new URL('../src/request-budget-client.js',import.meta.url),'utf8');

test('生产 MAIN 客户端→真实桥脚本→持久预算服务，失败与多标签隔离',async()=>{
 let saved={};const service=createBudgetService({get:async()=>structuredClone(saved),set:async s=>{saved=structuredClone(s);}},async()=>2);
 function page(tabId){
  const listeners=[],out=[];
  const sandbox={console,crypto,AbortController,DOMException,ReadableStream,Response,Uint8Array,Promise,Date,URL,setTimeout,clearTimeout};
  const context=vm.createContext(sandbox);sandbox.window=sandbox;
  sandbox.document={documentElement:{dataset:{}}};
  sandbox.addEventListener=(name,cb)=>{if(name==='message')listeners.push(cb);};
  // 在同一个 realm 内提供 event.source === window，不能用 Node 对象伪装 window。
  sandbox.queueMicrotask=queueMicrotask;sandbox.dispatchMessage=e=>listeners.forEach(cb=>cb(e));
  vm.runInContext('window.postMessage = data => queueMicrotask(() => dispatchMessage({source:window,data}));',context);
  sandbox.chrome={runtime:{onMessage:{addListener(){}},sendMessage:async m=>{
   out.push(m);const owner=budgetOwner({id:'ext',url:'https://www.bilibili.com/video/BVx',tab:{id:tabId},documentId:'doc'},'ext');
   return {ok:true,...await service(m.request,owner)};
  }},storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:{addListener(){}}}};
  vm.runInContext(bridgeSource,context);vm.runInContext(clientSource,context);
  return {context,out};
 }
 const a=page(1),b=page(2);let active=0,peak=0;
 for(const p of [a,b])p.context.fakeFetch=async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,20));active--;return new Response(new Uint8Array(4));};
 await Promise.all([a,b].map(p=>vm.runInContext("BiliRequestBudget.createBudgetFetch(fakeFetch,BiliRequestBudget.createPageRpc())('https://example.test',{priority:'high'}).then(r=>r.arrayBuffer())",p.context)));
 await new Promise(r=>setTimeout(r,30));assert(peak<=2);assert.equal(saved.requestBudgetV1.leases.length,0);
 assert(a.out.some(m=>m.request.op==='acquire'));assert(b.out.some(m=>m.request.op==='release'));
});
