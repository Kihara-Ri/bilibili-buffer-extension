import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('生产 MAIN world 注册缓存在观察器之前，版本与检查命令一致', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const main = manifest.content_scripts.find(entry => entry.world === 'MAIN');
  assert.deepEqual(main.js, ['src/playback-cache.js', 'src/playback-routes.js', 'src/playback-network.js', 'src/request-budget-client.js', 'src/playback-observer.js']);
  assert.equal(main.run_at, 'document_start');
  assert.equal(manifest.version, pkg.version);
  // npm run check 已改为遍历仓库跑 node --check（见 scripts/check-syntax.mjs），
  // 不再逐文件列举；这里断言的是“确实由遍历式检查覆盖”，而不是某个写死的路径。
  const checker = await readFile(new URL('../scripts/check-syntax.mjs', import.meta.url), 'utf8');
  assert(pkg.scripts.check.includes('check-syntax.mjs'));
  assert(/await walk\(root\)/.test(checker));
  assert(/skipDirectories/.test(checker) && !/'src'/.test(checker));
  assert(pkg.scripts['test:playback'].includes('run-playback-cache-integration.mjs'));
  assert(!manifest.content_scripts.some(entry => entry.js.some(file => file.includes('dev-reload'))));
});
