import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
test('当前文档不得声称灰色优先、按字节比例标黄或丢弃预热正文', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const technical = await readFile(new URL('../技术文档.md', import.meta.url), 'utf8');
  for (const [name, text] of [['README.md', readme], ['技术文档.md', technical]]) {
    for (const stale of ['重叠时原生缓冲优先', '插件范围仍按成功请求的字节比例估算', '高亮按字节比例映射到时间轴', '插件高亮表示的主要是这一层曾响应过预取字节', '正文读完后丢弃']) {
      assert(!text.includes(stale), `${name} 残留过时说明：${stale}`);
    }
    assert(text.includes('SIDX'), `${name} 缺少真实分段索引说明`);
    assert(text.includes('128 MiB'), `${name} 缺少容量边界`);
    assert(text.includes(manifest.version), `${name} 未同步版本`);
  }
  assert(technical.includes(`适用版本：v${manifest.version}`));
});
