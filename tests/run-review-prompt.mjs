import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const playwrightModule = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const chromium = playwrightModule.chromium || playwrightModule.default.chromium;
import { chromiumLaunchOptions } from '../scripts/lib/browser-launch.mjs';

// 评价邀请的浏览器测试：真实 popup.html + popup.js，夹具提供假的 chrome.* 与片库。
// 覆盖：显示条件（下载中不插话）、轮询刷新下节点身份与动画稳定、推迟 / 永久关闭 / 去评价的持久化、
// 关闭后键盘焦点不丢、收起时 inert、设置里的常驻入口，以及首次安装不出现。
const root = fileURLToPath(new URL('../', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://test').pathname);
    if (!file.startsWith(root)) throw new Error('outside root');
    const data = await readFile(file);
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'text/javascript'); res.end(data);
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
const STORE_URL = 'https://chromewebstore.google.com/detail/bjegpandnhmeinmennpfpkholhmbllam/reviews';

async function openPopup(seed) {
  const page = await browser.newPage({ viewport: { width: 360, height: 900 }, locale: 'zh-CN' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/tests/popup-instant-integration.html${seed ? '?reviewSeed=eligible' : ''}`);
  await page.waitForFunction(() => document.querySelector('#result').textContent !== 'running');
  assert.equal(JSON.parse(await page.locator('#result').textContent()).ok, true);
  await page.addStyleTag({ content: 'body > #result, body > #step { display: none !important; }' });
  await page.locator('#library-tab').click();
  return { page, errors };
}
// 不真的开新标签（无头浏览器里不稳定，也不该访问外网）：捕获阶段拦下默认跳转并记下目标，popup.js 自己的点击处理照常运行。
const captureLinks = page => page.evaluate(() => document.addEventListener('click', event => { const link = event.target.closest?.('a[target="_blank"]'); if (link) { window.openedHref = link.href; event.preventDefault(); } }, true));
const cardState = page => page.evaluate(() => { const card = document.querySelector('#review-card'); return { open: card.dataset.open, inert: card.inert, height: card.getBoundingClientRect().height }; });
const stored = page => page.evaluate(() => structuredClone(window.__popupTest.reviewStore.reviewPromptV1));
const settle = page => page.waitForTimeout(450);
// 夹具片库里有一个「下载中」任务：把它改成暂停，才算没有任务在下载。
const pauseDownloads = page => page.evaluate(() => { for (const video of window.__popupTest.videos) if (video.status === 'downloading') video.status = 'paused'; });

try {
  // 1. 刚安装：首次打开只记时间，不出现。
  {
    const { page, errors } = await openPopup(false);
    await pauseDownloads(page); await page.waitForTimeout(1000);
    assert.deepEqual((await cardState(page)).open, 'false');
    assert.ok((await stored(page)).firstSeenAt > 0, '首次打开应记下 firstSeenAt');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // 2. 已用满 3 天但还有任务在下载：不插话；暂停后才展开。
  const { page, errors } = await openPopup(true);
  await page.waitForTimeout(1000);
  assert.equal((await cardState(page)).open, 'false', '下载中不显示评价邀请');
  await pauseDownloads(page);
  await page.waitForFunction(() => document.querySelector('#review-card').dataset.open === 'true');
  await settle(page);
  let state = await cardState(page);
  assert.equal(state.inert, false); assert.ok(state.height > 40, `展开后应有高度：${state.height}`);
  assert.equal(await page.locator('#review-go').getAttribute('href'), STORE_URL);
  assert.equal(await page.locator('#about-review').getAttribute('href'), STORE_URL);

  // 3. 持续轮询（片库每 700ms 刷新）：卡片节点、按钮节点与展开状态不被重建，hover 不丢。
  const sameBefore = await page.evaluate(() => { window.cardNode = document.querySelector('#review-card'); window.goNode = document.querySelector('#review-go'); window.mutations = 0; new MutationObserver(list => { window.mutations += list.length; }).observe(window.cardNode, { subtree: true, childList: true, attributes: true, characterData: true }); return true; });
  await page.locator('#review-go').hover();
  await page.waitForTimeout(2200);
  const stable = await page.evaluate(() => ({ sameCard: window.cardNode === document.querySelector('#review-card'), sameGo: window.goNode === document.querySelector('#review-go'), hover: window.goNode.matches(':hover'), mutations: window.mutations }));
  assert.ok(sameBefore && stable.sameCard && stable.sameGo && stable.hover, '轮询期间评价卡片节点与 hover 必须保持');
  assert.equal(stable.mutations, 0, `轮询期间卡片不应有任何 DOM 变更，实际 ${stable.mutations}`);

  // 4. 以后再说：卡片收起、焦点落到「片库」页签、状态持久化（推迟 1 次、14 天后）。
  await page.locator('#review-later').focus();
  await page.locator('#review-later').click();
  await page.waitForFunction(() => document.querySelector('#review-card').dataset.open === 'false');
  await settle(page);
  state = await cardState(page);
  assert.equal(state.inert, true); assert.ok(state.height < 1, `收起后高度应为 0：${state.height}`);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'library-tab', '关闭后键盘焦点不能丢到 body');
  const snoozed = await stored(page);
  assert.equal(snoozed.snoozeCount, 1); assert.ok(snoozed.snoozedUntil > Date.now() + 13 * 86400000); assert.equal(snoozed.closed, '');
  await page.waitForTimeout(1500);
  assert.equal((await cardState(page)).open, 'false', '推迟期内轮询不能让卡片重新出现');

  // 5. 设置里的常驻入口：链接可见、点击后记为已评价。点击会开新标签，这里拦截以免真的访问网络。
  await captureLinks(page);
  await page.locator('#settings-button').click();
  assert.equal(await page.locator('#about-review').isVisible(), true);
  await page.locator('#about-review').click();
  assert.equal(await page.evaluate(() => window.openedHref), STORE_URL);
  assert.equal((await stored(page)).closed, 'reviewed');
  assert.deepEqual(errors, []);
  await page.close();

  // 6. 不再提示：永久关闭。
  {
    const { page, errors } = await openPopup(true);
    await pauseDownloads(page);
    await page.waitForFunction(() => document.querySelector('#review-card').dataset.open === 'true');
    await page.locator('#review-never').click();
    await page.waitForFunction(() => document.querySelector('#review-card').dataset.open === 'false');
    assert.equal((await stored(page)).closed, 'never');
    await page.waitForTimeout(1500);
    assert.equal((await cardState(page)).open, 'false');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // 7. 去评价：链接在新标签打开，并记为已评价。
  {
    const { page, errors } = await openPopup(true);
    await captureLinks(page);
    await pauseDownloads(page);
    await page.waitForFunction(() => document.querySelector('#review-card').dataset.open === 'true');
    await page.locator('#review-go').click();
    assert.equal(await page.evaluate(() => window.openedHref), STORE_URL);
    assert.equal((await stored(page)).closed, 'reviewed');
    await page.waitForFunction(() => document.querySelector('#review-card').dataset.open === 'false');
    assert.deepEqual(errors, []);
    await page.close();
  }

  // 8. 减少动态偏好：展开 / 收起不做过渡（时长约 0）。
  {
    const { page } = await openPopup(true);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const duration = await page.evaluate(() => getComputedStyle(document.querySelector('#review-card')).transitionDuration);
    assert.match(duration, /^0\.0*1?(ms|s)|^0s|^1e-05s/, `减少动态时过渡应接近 0：${duration}`);
    await page.close();
  }
  console.log('评价邀请浏览器测试通过');
} catch (error) { console.error('FAIL', error.message); process.exitCode = 1; } finally {
  await browser.close();
  server.close();
}
