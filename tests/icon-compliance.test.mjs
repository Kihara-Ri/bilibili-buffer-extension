import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { checkIconPadding, readPngAlphaBounds } from "../scripts/lib/png-alpha.mjs";

// 图标是商店审核里少见的“硬性格式要求”：尺寸、格式、留白都有明确规定，
// 而且历史上出现过一次“整张不透明底”的回归，所以单独钉一组测试。
// 后半段用代码现场合成 PNG 喂给检查函数，确保规则真的会拒绝坏图标，
// 而不是只验证“当前这几个文件碰巧通过”。

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));

test("四个尺寸的图标都存在且声明一致", async () => {
  for (const size of [16, 32, 48, 128]) {
    const file = manifest.icons[String(size)];
    assert.ok(file, `icons 缺少 ${size} 尺寸`);
    assert.equal(manifest.action.default_icon[String(size)], file, `action.default_icon 的 ${size} 与 icons 不一致`);
    const buffer = await readFile(new URL(file, root));
    assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${file} 不是 PNG`);
    const bounds = readPngAlphaBounds(buffer);
    assert.deepEqual([bounds.width, bounds.height], [size, size], `${file} 尺寸不符`);
  }
});

test("图标四角完全透明，不会在深色工具栏上变成白方块", async () => {
  for (const size of [16, 32, 48, 128]) {
    const buffer = await readFile(new URL(manifest.icons[String(size)], root));
    assert.equal(readPngAlphaBounds(buffer).cornerAlpha, 0, `${size} 图标四角不透明`);
  }
});

test("图标留白符合 Chrome 图标规范：128 画布内图形约为 96×96，四周各留 16 像素", async () => {
  const buffer = await readFile(new URL(manifest.icons["128"], root));
  const { padding, artwork } = checkIconPadding(buffer, 128);
  assert.equal(padding, 16, "128 图标四周应各留 16 像素透明边距");
  assert.ok(artwork[0] >= 88 && artwork[0] <= 104, `图形宽度应接近 96，实际 ${artwork[0]}`);
  assert.ok(artwork[1] >= 80 && artwork[1] <= 104, `图形高度应接近 96，实际 ${artwork[1]}`);
});

test("48 图标按比例留白；16/32 至少留 1 像素不贴边", async () => {
  for (const size of [16, 32, 48]) {
    const buffer = await readFile(new URL(manifest.icons[String(size)], root));
    const { padding } = checkIconPadding(buffer, size);
    assert.ok(padding >= (size >= 48 ? 6 : 1), `${size} 图标留白仅 ${padding}px`);
  }
});

test("合成图标：尺寸不符、四角不透明、留白不足都会被拒绝", () => {
  assert.deepEqual(checkIconPadding(makePng({ size: 128, margin: 16 }), 128).artwork, [96, 96]);
  assert.throws(() => checkIconPadding(makePng({ size: 128, margin: 16 }), 96), /尺寸应为 96×96/);
  assert.throws(() => checkIconPadding(makePng({ size: 128, margin: 0 }), 128), /四角不透明/);
  assert.throws(() => checkIconPadding(makePng({ size: 128, margin: 2 }), 128), /离边缘只有 2px/);
  assert.throws(() => checkIconPadding(makePng({ size: 128, margin: 16, cornerAlpha: 255 }), 128), /四角不透明/);
  assert.throws(() => checkIconPadding(makePng({ size: 128, margin: 16, colorType: 2 }), 128), /alpha/);
  assert.throws(() => checkIconPadding(makePng({ size: 128, margin: 16, art: false }), 128), /完全透明/);
});

/**
 * 现场合成一张最小的 PNG：透明画布 + 居中不透明方块。
 * 只支持非隔行 8 位（colorType 6 / 2），够覆盖检查函数的每条分支。
 */
function makePng({ size, margin, cornerAlpha = 0, colorType = 6, art = true }) {
  const channels = colorType === 6 ? 4 : 3;
  const raw = Buffer.alloc((size * channels + 1) * size);
  let cursor = 0;
  for (let y = 0; y < size; y += 1) {
    raw[cursor] = 0; // filter: None
    cursor += 1;
    for (let x = 0; x < size; x += 1) {
      const inside = art && x >= margin && y >= margin && x < size - margin && y < size - margin;
      const edge = (x === 0 || y === 0 || x === size - 1 || y === size - 1) && cornerAlpha > 0;
      raw[cursor] = 19;
      raw[cursor + 1] = 169;
      raw[cursor + 2] = 223;
      if (channels === 4) raw[cursor + 3] = inside || edge ? (edge ? cornerAlpha : 255) : 0;
      cursor += channels;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
