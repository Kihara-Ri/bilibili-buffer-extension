import test from 'node:test';import assert from 'node:assert/strict';
import {applyUpdate,rollbackUpdate,bindInstallDirectory} from '../src/github-update-files.js';
const enc=new TextEncoder(),dec=new TextDecoder();
function memory(initial={}){const files=new Map(Object.entries(initial).map(([p,t])=>[p,enc.encode(t)]));let state=null,failPath='';const calls=[];return {files,calls,io:{async read(p){return files.has(p)?files.get(p).slice():null;},async write(p,b){calls.push(p);if(p===failPath){failPath='';throw Error('disk failure');}files.set(p,b.slice());},async remove(p){files.delete(p);}},journal:{async get(){return structuredClone(state);},async set(v){state=structuredClone(v);}},fail(p){failPath=p;}};}
const update=new Map([['manifest.json',enc.encode('{"version":"2"}')],['src/background.js',enc.encode('new')],['src/new.js',enc.encode('added')]]);
test('选择空目录时说明缺少 manifest.json，不写入验证文件',async()=>{
 let writes=0;
 const directory={async getDirectoryHandle(){throw new DOMException('missing','NotFoundError');},async getFileHandle(_path,options){if(options?.create)writes++;throw new DOMException('A requested file or directory could not be found','NotFoundError');}};
 await assert.rejects(bindInstallDirectory(directory,{manifest:{version:'1'},readResource:async()=>''}),/manifest\.json.*扩展安装目录/);
 assert.equal(writes,0);
});
test('损坏清单与不同版本目录给出可操作提示，不写探针',async()=>{
 for(const [text,pattern] of [['broken',/manifest\.json.*损坏/],['{"version":"2"}',/当前运行.*安装目录/]]) {
  let writes=0;
  const directory={async getDirectoryHandle(){throw new DOMException('missing','NotFoundError');},async getFileHandle(_path,options){if(options?.create)writes++;return {async getFile(){return new Blob([text]);}};}};
  await assert.rejects(bindInstallDirectory(directory,{manifest:{version:'1'},readResource:async()=>''}),pattern);
  assert.equal(writes,0);
 }
});
test('开发仓库包括 .git 文件的 worktree 都拒绝更新，并说明通过 Git 更新',async()=>{
 for(const isFile of [false,true]) {
  let reads=0;
  const directory={async getDirectoryHandle(){if(isFile)throw new DOMException('is file','TypeMismatchError');return {};},async getFileHandle(){reads++;}};
  await assert.rejects(bindInstallDirectory(directory,{manifest:{version:'1'},readResource:async()=>''}),/源码仓库.*Git/);
  assert.equal(reads,0);
 }
});
test('目录读取权限失败保留原错误，不能误报为空目录',async()=>{
 const denied=new DOMException('denied','NotAllowedError');
 const directory={async getDirectoryHandle(){throw new DOMException('missing','NotFoundError');},async getFileHandle(){throw denied;}};
 await assert.rejects(bindInstallDirectory(directory,{manifest:{version:'1'},readResource:async()=>''}),error=>error===denied);
});
test('所有备份持久化后才写文件，manifest 最后写且逐文件读回',async()=>{const m=memory({'manifest.json':'{"version":"1"}','src/background.js':'old'});await applyUpdate(update,m.io,m.journal,{fromVersion:'1',toVersion:'2'});assert.equal(dec.decode(m.files.get('src/background.js')),'new');assert.equal(m.calls.at(-1),'manifest.json');assert.equal((await m.journal.get()).stage,'awaiting-reload');});
test('写入中途失败恢复旧文件并移除本次新建文件',async()=>{const m=memory({'manifest.json':'{"version":"1"}','src/background.js':'old'});m.fail('manifest.json');await assert.rejects(applyUpdate(update,m.io,m.journal,{fromVersion:'1',toVersion:'2'}),/disk failure/);assert.equal(dec.decode(m.files.get('src/background.js')),'old');assert.equal(m.files.has('src/new.js'),false);assert.equal(await m.journal.get(),null);});
test('备份失败不修改文件，存在未完成更新时拒绝并发覆盖日志',async()=>{const m=memory({'manifest.json':'old'});m.journal.set=async()=>{throw Error('quota');};await assert.rejects(applyUpdate(update,m.io,m.journal,{fromVersion:'1',toVersion:'2'}),/quota/);assert.deepEqual(m.calls,[]);const n=memory();await n.journal.set({stage:'writing',backups:[]});await assert.rejects(applyUpdate(update,n.io,n.journal,{fromVersion:'1',toVersion:'2'}));assert.deepEqual(n.calls,[]);});
test('重新打开后可用持久日志恢复，恢复写入失败时保留日志',async()=>{const m=memory({'manifest.json':'old'});await applyUpdate(update,m.io,m.journal,{fromVersion:'1',toVersion:'2'});m.fail('manifest.json');await assert.rejects(rollbackUpdate(m.io,m.journal));assert.ok(await m.journal.get());await rollbackUpdate(m.io,m.journal);assert.equal(dec.decode(m.files.get('manifest.json')),'old');assert.equal(m.files.has('src/new.js'),false);});
test('相同 manifest 的另一份目录也须通过运行目录随机探针，且总会清理探针',async()=>{let removed=false;const directory={async getDirectoryHandle(){throw new DOMException('not found','NotFoundError');},async getFileHandle(path){return {async getFile(){return new Blob(['{"background":{"service_worker":"src/background.js"},"version":"1"}']);},async createWritable(){return {async write(){},async close(){}};}};},async removeEntry(){removed=true;}};await assert.rejects(bindInstallDirectory(directory,{manifest:{background:{service_worker:'src/background.js'},version:'1'},readResource:async()=> 'wrong'}));assert.equal(removed,true);});
