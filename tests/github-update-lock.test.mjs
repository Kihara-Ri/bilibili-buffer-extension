import test from 'node:test';import assert from 'node:assert/strict';
import {withUpdateFileLock} from '../src/github-update-lock.js';
test('另一个页面占用文件事务时拒绝更新和恢复，操作异常后释放所有权',async()=>{
 let held=false;const locks={async request(name,options,callback){assert.equal(name,'haineicunzhi-update-files-v1');if(held)return callback(null);held=true;try{return await callback({name});}finally{held=false;}}};
 let done;const first=withUpdateFileLock(()=>new Promise(resolve=>done=resolve),{locks});
 await assert.rejects(withUpdateFileLock(()=>assert.fail('不能进入并发恢复'),{locks}));
 done();await first;await assert.rejects(withUpdateFileLock(()=>{throw new Error('write failed');},{locks}));
 assert.equal(await withUpdateFileLock(()=>42,{locks}),42);
});
