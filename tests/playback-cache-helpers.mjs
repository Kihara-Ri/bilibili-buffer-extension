import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/playback-cache.js', import.meta.url), 'utf8');
/** 在独立 MAIN world 模拟环境中装载缓存，允许注入失败的浏览器原语。 */
export function loadCache(extra = {}) {
  const window = extra.window || {};
  vm.runInNewContext(source, { window, URL, Headers, Response, Request, ReadableStream, Uint8Array, DataView, ArrayBuffer, Blob, DOMException, setTimeout, clearTimeout, ...extra });
  return window.__biliBufferCache;
}
