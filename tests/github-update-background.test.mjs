import test from 'node:test';import assert from 'node:assert/strict';
import {createUpdateCoordinator,UPDATE_STATE_KEY} from '../src/github-update-background.js';
function setup(){const local={},session={};const calls=[];let journal=null;const storage=data=>({async get(k){return {[k]:structuredClone(data[k])};},async set(v){Object.assign(data,structuredClone(v));}});const runtime={id:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',getURL:p=>'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'+p,getManifest:()=>({version:'2.15.0'}),reload(){calls.push('reload');}};const deps={runtime,storage:storage(local),session:storage(session),getJournal:async()=>journal,completeJournal:async()=>{journal={...journal,stage:'complete'};},freeze:async()=>{calls.push(local[UPDATE_STATE_KEY]?.stage);return ['one'];},thaw:async ids=>{calls.push(ids);return [];},ping:async()=>({version:'2.15.0'}),refresh:async()=>{},openPage:async()=>calls.push('page')};const coordinator=createUpdateCoordinator(deps);return {coordinator,local,calls,deps,setJournal(v){journal=v;}};}
const sender={url:'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/update.html',tab:{id:9}};
test('更新命令只接收自身更新页，先持久化锁再冻结下载',async()=>{const s=setup();await assert.rejects(s.coordinator.handle({type:'UPDATER_PREPARE',version:'2.16.0'},{url:'https://www.bilibili.com/'}));const state=await s.coordinator.handle({type:'UPDATER_PREPARE',version:'2.16.0'},sender);assert.equal(s.calls[0],'preparing');assert.equal(s.local[UPDATE_STATE_KEY].stage,'prepared');assert.equal(state.state.targetVersion,'2.16.0');await assert.rejects(s.coordinator.assertUnlocked());await assert.rejects(s.coordinator.handle({type:'UPDATER_PREPARE',version:'2.16.0'},sender));});
test('另一个更新页不能修改事务，写入日志未恢复不能解锁',async()=>{const s=setup();await s.coordinator.handle({type:'UPDATER_PREPARE',version:'2.16.0'},sender);await assert.rejects(s.coordinator.handle({type:'UPDATER_WRITING'},{...sender,tab:{id:10}}));await s.coordinator.handle({type:'UPDATER_WRITING'},sender);s.setJournal({stage:'writing'});await assert.rejects(s.coordinator.handle({type:'UPDATER_CANCEL'},sender));assert.equal(s.local[UPDATE_STATE_KEY].stage,'writing');s.setJournal(null);await s.coordinator.handle({type:'UPDATER_CANCEL'},sender);await s.coordinator.assertUnlocked();assert.deepEqual(s.calls.at(-1),['one']);});
test('没有目标版本和后台健康证据时不宣布完成',async()=>{const s=setup();await s.coordinator.handle({type:'UPDATER_PREPARE',version:'2.16.0'},sender);await s.coordinator.handle({type:'UPDATER_WRITING'},sender);s.setJournal({stage:'awaiting-reload',toVersion:'2.16.0'});await assert.rejects(s.coordinator.handle({type:'UPDATER_FINISH'},sender));assert.ok(s.local[UPDATE_STATE_KEY]);});
test('保存中的文件跨协调器实例阻止更新，保存结束才可冻结',async()=>{const s=setup();let done;const saving=s.coordinator.withSave(()=>new Promise(r=>done=r));while(!done)await new Promise(r=>setImmediate(r));const restarted=createUpdateCoordinator(s.deps);await assert.rejects(restarted.handle({type:'UPDATER_PREPARE',version:'2.16.0'},sender));done();await saving;await restarted.handle({type:'UPDATER_PREPARE',version:'2.16.0'},sender);assert.equal(s.local[UPDATE_STATE_KEY].stage,'prepared');});
test('确认新后台版本后才解锁，成功与恢复都保留暂停任务清单',async()=>{
 const s=setup();await s.coordinator.handle({type:'UPDATER_PREPARE',version:'2.16.0',refreshTabs:true},sender);
 await s.coordinator.handle({type:'UPDATER_WRITING'},sender);s.setJournal({stage:'awaiting-reload',toVersion:'2.16.0'});
 await s.coordinator.handle({type:'UPDATER_RELOAD'},sender);
 s.deps.runtime.getManifest=()=>({version:'2.16.0'});s.deps.ping=async()=>({version:'old'});
 await assert.rejects(s.coordinator.handle({type:'UPDATER_FINISH'},sender));assert.equal(s.local[UPDATE_STATE_KEY].stage,'reloading');
 s.deps.ping=async()=>({version:'2.16.0'});const result=await s.coordinator.handle({type:'UPDATER_FINISH'},sender);
 assert.equal(result.updated,true);assert.equal(s.local[UPDATE_STATE_KEY],null);assert.deepEqual(s.calls.at(-1),['one']);
});
test('准备暂停前持久化待恢复任务，冻结中断后新 SW 仍可恢复',async()=>{
 const s=setup();s.deps.freeze=async persist=>{await persist(['in-flight']);throw new Error('interrupted');};
 await assert.rejects(s.coordinator.handle({type:'UPDATER_PREPARE',version:'2.16.0'},sender));
 assert.deepEqual(s.calls.at(-1),['in-flight']);assert.equal(s.local[UPDATE_STATE_KEY],null);
});
test('写入日志尚未建立时，第二页也不能取消仍活跃的 owner',async()=>{
 const s=setup();s.deps.ownerAlive=async()=>true;
 await s.coordinator.handle({type:'UPDATER_PREPARE',version:'2.16.0'},sender);await s.coordinator.handle({type:'UPDATER_WRITING'},sender);
 await assert.rejects(s.coordinator.handle({type:'UPDATER_CANCEL'},{...sender,tab:{id:10}}));assert.equal(s.local[UPDATE_STATE_KEY].stage,'writing');
 s.deps.ownerAlive=async()=>false;await s.coordinator.handle({type:'UPDATER_CANCEL'},{...sender,tab:{id:10}});assert.equal(s.local[UPDATE_STATE_KEY],null);
});
