import test from "node:test";
import assert from "node:assert/strict";
import { createZip, readZip } from "../scripts/lib/zip.mjs";

const entries = [
  { name: "manifest.json", data: Buffer.from('{"version":"1.0.0"}') },
  { name: "src/中文.js", data: Buffer.from("const x = 1;\n".repeat(200)) },
  // 随机字节压缩后更大，应原样存储。
  { name: "assets/noise.bin", data: Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 2654435761) >>> 24)) }
];

test("发布 ZIP 往返一致：UTF-8 文件名、deflate 与原样存储都能读回原字节", () => {
  const files = readZip(createZip(entries));
  assert.deepEqual([...files.keys()], entries.map((entry) => entry.name));
  for (const entry of entries) assert(files.get(entry.name).equals(entry.data), entry.name);
});

test("同样的输入与时间戳得到逐字节相同的 ZIP，时间戳变化才改变字节", () => {
  const date = new Date(Date.UTC(2026, 0, 1));
  assert(createZip(entries, { date }).equals(createZip(entries, { date })));
  assert(!createZip(entries, { date }).equals(createZip(entries, { date: new Date(Date.UTC(2026, 5, 1)) })));
});

test("损坏的 ZIP 被拒绝，而不是读出错误内容", () => {
  const zip = createZip(entries);
  assert.throws(() => readZip(zip.subarray(0, zip.length - 4)), /目录结尾/);
  const corrupted = Buffer.from(zip);
  corrupted[60] ^= 0xff; // 落在第一个条目的正文里
  assert.throws(() => readZip(corrupted));
});
