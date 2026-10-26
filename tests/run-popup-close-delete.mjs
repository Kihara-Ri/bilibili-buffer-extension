import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const playwrightModule = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = playwrightModule.chromium || playwrightModule.default.chromium;
import { chromiumLaunchOptions } from '../scripts/lib/browser-launch.mjs';

// 回归：片库里点删除后在 6 秒撤销期内关掉弹窗，删除必须照样生效。
//
// 为什么必须用真正的工具栏弹窗：弹窗失焦关闭时 pagehide 会触发，但其中 runtime.sendMessage 发出的消息
// 到不了后台（实测 0/3）；把 popup.html 当普通标签页打开再关闭却能送达。用标签页测会得出「没问题」的假结论。
// Playwright 不把 action 弹窗暴露为 Page，这里经 --remote-debugging-port 直接连弹窗的 CDP 目标来点按钮，
// 再由弹窗自己关闭，复现用户「点删除 → 点网页别处」时同样的消息丢失。
const extension = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(`${tmpdir()}/haineicunzhi-popup-close-`);
const context = await chromium.launchPersistentContext(profile, {
  ...chromiumLaunchOptions({ headless: true }),
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--remote-debugging-port=0']
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const KEEP = 'BV1closedelete:1:q80:cavc';
const DROP = 'BV1closedelete:2:q80:cavc';

try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto('about:blank');
  // MV3 SW 禁止动态 import；从扩展页面写同源 IndexedDB。暂停状态的任务不需要联网即可走完整删除链路。
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${extensionId}/popup.html`);
  await probe.evaluate(async ids => {
    const { putVideo } = await import(chrome.runtime.getURL('src/db.js'));
    for (const [index, id] of ids.entries()) {
      const now = Date.now() + index;
      await putVideo({ id, bvid: 'BV1closedelete', cid: index + 1, page: 1, title: `关闭弹窗删除 ${index + 1}`, status: 'paused', progress: 0.02, quality: 80, requestedQuality: 80, mediaKind: 'dash', downloadedBytes: 1e7, totalBytes: 4.5e8, tracks: {}, createdAt: now, updatedAt: now });
    }
  }, [KEEP, DROP]);
  const listIds = () => probe.evaluate(async () => (await chrome.runtime.sendMessage({ target: 'background', type: 'LIST_VIDEOS' })).videos.map(video => video.id));

  const port = (await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0];
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  // 探针标签页也是 popup.html：打开弹窗前记下已有目标，之后按目标 id 认准工具栏弹窗。
  const probeTargets = new Set((await targets()).map(item => item.id));
  let target;
  const popupTarget = async () => (await targets())
    .find(item => item.url === `chrome-extension://${extensionId}/popup.html` && (target ? item.id === target.id : !probeTargets.has(item.id)));
  await page.bringToFront();
  assert.equal(await worker.evaluate(() => chrome.action.openPopup().then(() => 'ok', error => String(error))), 'ok');
  for (let attempt = 0; attempt < 40 && !target; attempt++) { target = await popupTarget(); if (!target) await delay(100); }
  assert(target, '工具栏弹窗没有打开');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data); pending.get(message.id)?.(message); pending.delete(message.id); };
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, message => message.result?.exceptionDetails ? reject(new Error(message.result.exceptionDetails.exception?.description || 'evaluate failed')) : resolve(message.result?.result?.value));
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });

  const steps = await evaluate(`(async () => {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const row = async id => { for (let i = 0; i < 100; i++) { const node = document.querySelector('.video-item[data-video-id="' + id + '"]'); if (node) return node; await delay(50); } throw new Error('片库没有出现 ' + id); };
    document.querySelector('#library-tab').click();
    // 先删除再撤销：关闭弹窗后它必须保留。
    (await row(${JSON.stringify(KEEP)})).querySelector('.delete-button').click();
    await delay(50);
    document.querySelector('#toast-action').click();
    await delay(50);
    const restored = Boolean(document.querySelector('.video-item[data-video-id="${KEEP}"]'));
    // 再删除另一条且不撤销：撤销期内就关闭弹窗。
    (await row(${JSON.stringify(DROP)})).querySelector('.delete-button').click();
    await delay(50);
    return { restored, hidden: !document.querySelector('.video-item[data-video-id="${DROP}"]') };
  })()`);
  assert.deepEqual(steps, { restored: true, hidden: true }, `弹窗内删除 / 撤销表现不对：${JSON.stringify(steps)}`);

  // 远早于 6 秒撤销期结束就关闭弹窗。无头模式下弹窗不会因失焦关闭；弹窗内 window.close() 与失焦关闭
  // 一样会丢掉 pagehide 里的消息（实测），而 CDP 的 /json/close 不丢，不能用它代替。
  void evaluate('setTimeout(() => window.close(), 0)').catch(() => {});
  for (let attempt = 0; attempt < 40 && await popupTarget(); attempt++) await delay(100);
  assert.equal(await popupTarget(), undefined, '弹窗没有关闭');
  socket.close();

  let ids = await listIds();
  for (let attempt = 0; attempt < 30 && ids.includes(DROP); attempt++) { await delay(100); ids = await listIds(); }
  assert(!ids.includes(DROP), '撤销期内关闭弹窗后，未撤销的删除没有提交，任务会在下次打开时重新出现');
  assert(ids.includes(KEEP), '已撤销的删除不能在弹窗关闭时被提交');
  console.log(JSON.stringify({ ok: true, committedOnClose: true, undoneKept: true }));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
