import test from 'node:test';
import assert from 'node:assert/strict';
import { ASSIST_DEFAULTS, sanitizeAssistConfig } from '../src/assist-config.js';
import '../src/playback-routes.js';
import '../src/playback-network.js';
const { createNetwork } = globalThis.BiliPlaybackNetwork;
const MiB = 1024 * 1024;
const url = 'https://upos-sz-mirrorcosov.bilivideo.com/policy.m4s';

async function measure(size, maxConcurrency = 32) {
  let active = 0, peak = 0, requests = 0;
  const network = createNetwork({ cdnMode: 'original', maxConcurrency, fetch: async (_url, { headers }) => {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    active++; requests++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return new Response(new Uint8Array(Number(b) - Number(a) + 1).fill(7), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${size}` } });
  }});
  network.tune({ ahead: 0, demand: true });
  const result = await network.download(url, 0, size, size, new AbortController().signal, { priority: 100 });
  assert(result.bytes.every(b => b === 7));
  assert.equal(result.bytes.length, size);
  assert.equal(network.snapshot().active, 0);
  return { peak, requests };
}

test('2 MiB 急需范围不因缺缓冲立即开满 32，仍保留 64 KiB 分块', async () => {
  assert.deepEqual(await measure(2 * MiB), { peak: 8, requests: 32 });
});
test('8 MiB 大范围仍可利用 32 路；用户低上限优先', async () => {
  assert.deepEqual(await measure(8 * MiB), { peak: 32, requests: 128 });
  assert.equal((await measure(2 * MiB, 4)).peak, 4);
  assert.equal((await measure(64 * 1024)).peak, 1);
});
test('新配置优先原清单 CDN，不覆盖已明确保存的大陆或自动模式', () => {
  assert.equal(ASSIST_DEFAULTS.cdnMode, 'original');
  assert.equal(sanitizeAssistConfig({}, { mode: 'always' }).cdnMode, 'original');
  for (const cdnMode of ['mainland', 'auto', 'original']) {
    const saved = { ...ASSIST_DEFAULTS, cdnMode, maxConcurrency: 16 };
    assert.equal(sanitizeAssistConfig({}, saved).cdnMode, cdnMode);
    assert.equal(sanitizeAssistConfig({}, saved).maxConcurrency, 16);
  }
});
test('独立下载器默认不合成大陆主机，显式大陆模式仍可用', async () => {
  const calls = [];
  const fetch = async address => { calls.push(address); return new Response(new Uint8Array(4), { status: 206, headers: { 'content-range': 'bytes 0-3/4' } }); };
  const network = createNetwork({ fetch });
  await network.download(url, 0, 4, 4, new AbortController().signal, { priority: 100 });
  assert.equal(calls[0], url);
  network.setMode('mainland');
  await network.download(url, 0, 4, 4, new AbortController().signal, { priority: 100 });
  assert.notEqual(calls[1], url);
});
