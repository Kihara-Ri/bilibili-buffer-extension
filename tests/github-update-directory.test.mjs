import test from 'node:test';
import assert from 'node:assert/strict';
import {connectInstallDirectory} from '../src/github-update-directory.js';

const manifest={version:'2.15.0',background:{service_worker:'src/background.js'}};
function folder(name,children={},files={}) {
 const missing=()=>new DOMException('missing','NotFoundError');
 const directory={name,kind:'directory',children,files:new Map(Object.entries(files)),writes:0,
  async getDirectoryHandle(name){if(name in children)return children[name];if(this.files.has(name))throw new DOMException('file','TypeMismatchError');throw missing();},
  async getFileHandle(name,options={}){if(!this.files.has(name)&&!options.create)throw missing();return {
   getFile:async()=>new Blob([this.files.get(name)]),
   createWritable:async()=>({write:async text=>{this.writes++;this.files.set(name,text);},close:async()=>{},abort:async()=>{}})
  };},
  async removeEntry(name){this.files.delete(name);},
  async *values(){yield* Object.values(children);for(const name of this.files.keys())yield {name,kind:'file'};}
 };
 return directory;
}
const installed=name=>folder(name,{}, {'manifest.json':JSON.stringify(manifest)});
const options=running=>({manifest,readResource:async path=>running.files.get(path)??null});

test('直接选择安装目录，探针证明身份后返回原句柄并清理探针',async()=>{
 const running=installed('installed');
 assert.equal(await connectInstallDirectory(running,options(running)),running);
 assert.equal(running.writes,1);assert.deepEqual([...running.files.keys()],['manifest.json']);
});
test('选择上级自动找到嵌套安装目录，同版本副本不能冒充运行目录',async()=>{
 const copy=installed('copy'),running=installed('installed');
 const parent=folder('Downloads',{copy,release:folder('release',{installed:running})});
 assert.equal(await connectInstallDirectory(parent,options(running)),running);
 assert.equal(copy.writes,1);assert.deepEqual([...copy.files.keys()],['manifest.json']);
});
test('源码仓库拒绝绑定，扫描上级时跳过整个源码子树',async()=>{
 const running=installed('installed'),repo=folder('repository',{installed:running,'.git':folder('.git')});
 await assert.rejects(connectInstallDirectory(repo,options(running)),/源码仓库/);
 await assert.rejects(connectInstallDirectory(folder('parent',{repo}),options(running)),/没有找到.*安装文件夹/);
 assert.equal(running.writes,0);
});
test('无匹配目录、深度超限、条目超限分别指引重新选择更小范围',async()=>{
 const running=installed('elsewhere');
 await assert.rejects(connectInstallDirectory(folder('empty'),options(running)),/没有找到.*安装文件夹/);
 let deep=running;for(let i=0;i<4;i++)deep=folder('level'+i,{child:deep});
 await assert.rejects(connectInstallDirectory(deep,options(running)),/范围太大|层级太深/);
 const children=Object.fromEntries(Array.from({length:201},(_,i)=>['folder'+i,folder('folder'+i)]));
 await assert.rejects(connectInstallDirectory(folder('large',children),options(running)),/范围太大|层级太深/);
 assert.equal(running.writes,0);
});
test('不能读取的子目录不当作未找到，写入权限失败不当作其他副本跳过',async()=>{
 const denied=new DOMException('denied','NotAllowedError'),running=installed('installed');
 const child=folder('denied');child.getDirectoryHandle=async()=>{throw denied;};
 await assert.rejects(connectInstallDirectory(folder('parent',{child}),options(running)),error=>error===denied);
 running.getFileHandle=async(name,options)=>{if(options?.create)throw denied;return {getFile:async()=>new Blob([JSON.stringify(manifest)])};};
 await assert.rejects(connectInstallDirectory(running,options(running)),error=>error===denied);
});
