import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkGate} from '../src/update-work-gate.js';
test('关闭更新闸门后拒绝新操作，等待先前操作实际结束',async()=>{
 const gate=createWorkGate();let finish;const first=gate.run(()=>new Promise(r=>finish=r));
 let drained=false;const closing=gate.close().then(()=>drained=true);
 await assert.rejects(gate.run(async()=>42));assert.equal(drained,false);
 finish();await first;await closing;assert.equal(drained,true);
 gate.open();assert.equal(await gate.run(async()=>42),42);
});
