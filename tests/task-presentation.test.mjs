import test from 'node:test';
import assert from 'node:assert/strict';
import { committedBytes, taskProgress, compareLibraryTasks, newerTask, sampleSpeed, taskBadge } from '../src/task-presentation.js';
test('已缓存只用确认落盘量，不随接收中数据回滚', () => {
  const video = { status: 'downloading', downloadedBytes: 900, resumeBytes: 700, committedBytes: 600, totalBytes: 1000, progress: .9 };
  assert.equal(committedBytes(video), 600); assert.equal(taskProgress(video), .6);
  assert.equal(committedBytes({ ...video, downloadedBytes: 650, progress: .65 }), 600);
  assert.equal(taskProgress({ ...video, downloadedBytes: 650, progress: .65 }), .6);
  assert.equal(committedBytes({ ...video, status: 'complete', downloadedBytes: 580 }), 580);
});
test('成员顺序与进度更新时间无关，旧记录按ID稳定兜底', () => {
  const a = { id: 'a', createdAt: 10, updatedAt: 900 }, b = { id: 'b', createdAt: 20, updatedAt: 10 };
  assert.deepEqual([a,b].sort(compareLibraryTasks).map(x=>x.id), ['b','a']);
  a.updatedAt = 10000; assert.deepEqual([a,b].sort(compareLibraryTasks).map(x=>x.id), ['b','a']);
  assert.deepEqual([{id:'z',updatedAt:90},{id:'a',updatedAt:1}].sort(compareLibraryTasks).map(x=>x.id), ['a','z']);
});
test('迟到数据库快照不覆盖更新进度，旧世代不覆盖重新下载', () => {
  const live = { id: 'a', runStartedAt: 2, updatedAt: 20, downloadedBytes: 800 };
  assert.equal(newerTask(live, { ...live, updatedAt: 19, downloadedBytes: 700 }), live);
  assert.equal(newerTask(live, { ...live, runStartedAt: 1, updatedAt: 99 }), live);
  assert.equal(newerTask({ ...live, status: 'complete' }, { ...live, status: 'downloading' }).status, 'complete');
});
test('速度采用时间感知平滑，重复快照不反复加权，停用立即归零', () => {
  const first = sampleSpeed(null, { status:'downloading',speed:1000,updatedAt:100 }, 100);
  const next = sampleSpeed(first, {status:'downloading',speed:100000,updatedAt:600},600);
  assert(next.value > 1000 && next.value < 40000);
  assert.equal(sampleSpeed(next, {status:'downloading',speed:100000,updatedAt:600},700).value,next.value);
  assert.equal(sampleSpeed(next,{status:'complete',speed:100000,updatedAt:700},700).value,0);
  assert.equal(sampleSpeed(next,{status:'downloading',speed:100000,updatedAt:600},6000).value,0);
});
test('徽标按标签页任务集合决定，多任务不交替百分比', () => {
  const a = {id:'a',tabId:7,status:'downloading',progress:.2,downloadedBytes:20,resumeBytes:20,totalBytes:100};
  const b = {id:'b',tabId:7,status:'downloading',progress:.8,downloadedBytes:80,resumeBytes:80,totalBytes:100};
  assert.equal(taskBadge([a],7).text,'20'); assert.equal(taskBadge([a,b],7).text,'2↓');
  assert.equal(taskBadge([{...b,progress:.9},a],7).text,'2↓');
  assert.equal(taskBadge([a,{...b,status:'complete'}],7).text,'20');
  assert.equal(taskBadge([],7).text,''); assert.equal(taskBadge([{...a,status:'complete'}],7).text,'✓');
  assert.equal(taskBadge([a,{...b,tabId:8}],7).text,'20');
});
