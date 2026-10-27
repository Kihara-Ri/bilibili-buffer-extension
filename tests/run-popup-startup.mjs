// 回归：丢掉启动状态、过早结束 pending、接受迟到请求或轮询改选画质，均应使此测试失败。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromiumLaunchOptions } from '../scripts/lib/browser-launch.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const output = path.join(root, '.tmp/cache-button-flash/fixed');
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://test').pathname);
    if (!file.startsWith(root + path.sep)) throw new Error('outside root');
    const data = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/javascript');
    res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
const results = [], errors = [];
await mkdir(output, { recursive: true });
async function fresh(run) {
  const page = await browser.newPage({ viewport: { width: 360, height: 680 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/popup-startup-integration.html`);
    await page.waitForFunction(() => document.querySelector('#cache-button')?.dataset.state === 'idle');
    await page.evaluate(() => {
      const button = document.querySelector('#cache-button');
      window.__buttonNode = button;
      window.__states = [];
      new MutationObserver(() => window.__states.push(button.dataset.state)).observe(button, { attributes: true, attributeFilter: ['data-state'] });
    });
    await run(page);
  } finally { await page.close(); }
}
async function pending(page, label) {
  const actual = await page.evaluate(() => {
    const b = document.querySelector('#cache-button');
    return { state: b.dataset.state, disabled: b.disabled, label: document.querySelector('#button-label').textContent, sameNode: b === window.__buttonNode };
  });
  assert.equal(actual.state, 'downloading', label + ': 启动中不得退回粉色');
  assert.equal(actual.disabled, true, label + ': 不得重复启动');
  assert.equal(actual.sameNode, true);
  assert.match(actual.label, /连接/);
}
try {
  await fresh(async page => {
    await page.locator('#cache-button').click();
    await page.locator('#quality-slider').focus();
    await page.waitForTimeout(1600); // 跨越两次真实 700ms 轮询。
    await pending(page, '慢响应');
    assert(await page.locator('#quality-slider').evaluate(el => document.activeElement === el), '刷新不能丢失键盘焦点');
    await page.evaluate(() => { document.querySelector('#cache-button').dispatchEvent(new MouseEvent('click')); });
    assert.equal(await page.evaluate(() => window.__startupTest.starts.length), 1, '处理函数也应挡住重复事件');
    await page.locator('.cache-control').screenshot({ path: path.join(output, 'connecting.png') });
    await page.evaluate(() => window.__startupTest.reply(0));
    await page.waitForTimeout(850);
    await pending(page, '响应后尚未登记');
    await page.evaluate(() => window.__startupTest.publish());
    await page.waitForFunction(() => document.querySelector('#button-label').textContent.includes('25%'));
    assert(!(await page.evaluate(() => window.__states.includes('idle'))));
    await page.locator('.cache-control').screenshot({ path: path.join(output, 'downloading.png') });
    results.push('慢响应、响应后延迟登记、重复点击、节点与焦点、进度交接');
  });
  await fresh(async page => {
    await page.locator('#cache-button').click();
    await page.evaluate(() => window.__startupTest.reply(0, { ok: false, error: '播放地址获取失败' }));
    await page.waitForTimeout(850);
    assert.equal(await page.locator('#cache-button').getAttribute('data-state'), 'error');
    assert(await page.locator('#cache-button').isEnabled());
    assert.equal(await page.locator('#action-hint').textContent(), '播放地址获取失败');
    await page.locator('#cache-button').click();
    await pending(page, '失败后重试');
    await page.evaluate(() => { window.__startupTest.publish(); window.__startupTest.reply(1); });
    await page.waitForFunction(() => document.querySelector('#button-label').textContent.includes('25%'));
    results.push('失败提示跨轮询保留、重试');
  });
  await fresh(async page => {
    await page.locator('#cache-button').click();
    await page.evaluate(() => {
      const slider = document.querySelector('#quality-slider'); slider.value = '0';
      slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.equal(await page.locator('#quality-name').textContent(), '720P');
    assert.equal(await page.locator('#cache-button').getAttribute('data-state'), 'idle');
    await page.locator('#cache-button').click();
    await page.evaluate(() => window.__startupTest.reply(0, { ok: false, error: '旧画质请求失败' }));
    await page.waitForTimeout(800);
    await pending(page, '旧画质失败不能覆盖新请求');
    await page.evaluate(() => window.__startupTest.publish({ quality: 80 }));
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#quality-name').textContent(), '720P', '旧任务到达不能切回旧画质');
    await pending(page, '旧画质进度不能结束新请求');
    await page.evaluate(() => { window.__startupTest.publish({ quality: 64 }); window.__startupTest.reply(1); });
    await page.waitForFunction(() => document.querySelector('#button-label').textContent.includes('25%'));
    assert.equal(await page.locator('#quality-name').textContent(), '720P');
    results.push('切换画质、旧请求失败与旧任务进度隔离');
  });
  await fresh(async page => {
    await page.locator('#cache-button').click();
    await page.locator('[data-cache-mode="audio"]').click();
    assert.equal(await page.locator('#cache-button').getAttribute('data-state'), 'idle');
    await page.locator('#cache-button').click();
    await page.evaluate(() => { window.__startupTest.publish(); window.__startupTest.reply(0); window.__startupTest.reply(1); });
    await page.waitForTimeout(800);
    await pending(page, '视频记录不能结束音频启动');
    await page.evaluate(() => window.__startupTest.publish({ cacheMode: 'audio', mediaKind: 'audio' }));
    await page.waitForFunction(() => document.querySelector('#button-label').textContent.includes('25%'));
    results.push('视频与仅音频启动隔离');
  });
  await fresh(async page => {
    await page.evaluate(() => window.__startupTest.publish({ status: 'paused', runStartedAt: 1, updatedAt: 1 }));
    await page.locator('#cache-button').click();
    await page.evaluate(() => window.__startupTest.reply(0, { ok: true, started: true, video: window.__startupTest.videos[0] }));
    await page.waitForTimeout(800);
    await pending(page, '旧暂停记录不能结束续传启动');
    assert.equal(await page.locator('#cache-button').evaluate(el => el.style.getPropertyValue('--progress-ratio')), '0.25');
    assert(await page.locator('#pause-button').isHidden(), '启动中不提供尚不可用的暂停或继续');
    await page.evaluate(() => window.__startupTest.publish({ status: 'error', error: '媒体初始化失败' }));
    await page.waitForFunction(() => document.querySelector('#cache-button').dataset.state === 'error');
    assert.equal(await page.locator('#action-hint').textContent(), '媒体初始化失败');
    results.push('续传保留水位、旧暂停快照、新任务初始化失败');
  });
  await fresh(async page => {
    await page.locator('#cache-button').click();
    await page.evaluate(() => window.__startupTest.publish());
    await page.evaluate(() => window.__startupTest.reply(0, { ok: false, error: '迟到的消息通道错误' }));
    await page.waitForTimeout(800);
    assert.match(await page.locator('#button-label').textContent(), /25%/);
    assert.equal(await page.locator('#action-hint').textContent(), '');
    results.push('进度先到、消息通道失败后到');
  });
  await fresh(async page => {
    await page.clock.install();
    await page.locator('#cache-button').click();
    await page.clock.fastForward(30_001);
    await page.waitForFunction(() => document.querySelector('#cache-button').dataset.state === 'error');
    assert(await page.locator('#cache-button').isEnabled());
    assert.match(await page.locator('#action-hint').textContent(), /确认|超时/);
    await page.locator('#cache-button').click();
    await page.evaluate(() => window.__startupTest.reply(0, { ok: false, error: '上一轮迟到错误' }));
    await pending(page, '同一选择重试后旧响应失效');
    await page.evaluate(() => { window.__startupTest.publish(); window.__startupTest.reply(1); });
    await page.waitForFunction(() => document.querySelector('#button-label').textContent.includes('25%'));
    results.push('启动无响应超时、同一选择重试世代隔离');
  });
  await fresh(async page => {
    await page.clock.install();
    await page.locator('#cache-button').click();
    await page.evaluate(() => { window.__startupTest.holdLists = true; window.__startupTest.reply(0); });
    await page.clock.fastForward(36_000);
    await page.waitForFunction(() => document.querySelector('#cache-button').dataset.state === 'error');
    await page.evaluate(() => window.__startupTest.publish());
    await page.waitForFunction(() => document.querySelector('#button-label').textContent.includes('25%'));
    results.push('状态查询无响应仍有界退出、迟到真实任务恢复');
  });
  await fresh(async page => {
    await page.locator('#cache-button').click();
    await page.evaluate(() => window.__startupTest.reply(0));
    await page.waitForTimeout(800);
    await pending(page, '未推送任务时仍等待');
    await page.evaluate(() => window.__startupTest.publish({}, false));
    await page.waitForFunction(() => document.querySelector('#button-label').textContent.includes('25%'));
    results.push('没有推送时由片库轮询接管进度');
  });
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'result.json'), JSON.stringify({ ok: true, results }, null, 2));
  console.log(JSON.stringify({ ok: true, results }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
