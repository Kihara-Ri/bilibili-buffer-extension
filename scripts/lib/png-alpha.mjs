import { inflateSync } from "node:zlib";

/**
 * 只够用的 PNG 读取器：拿宽度、高度和每个像素的 alpha。
 *
 * 为什么自己写：图标留白与四角透明度是商店上架的硬性检查项，
 * 但整个项目只在“生成图标”和“校验发布包”两处用到它，
 * 为此拉一个图像库进 devDependencies 不划算，也容易因为依赖缺失让检查静默跳过。
 * 这里只支持扩展自己产出的非隔行真彩色 / 灰度 + alpha（colorType 6 / 4）。
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 判断文件头是否是 PNG，用于给出比“解码失败”更明确的错误信息。 */
export function isPng(buffer) {
  return buffer.length > 8 && buffer.subarray(0, 8).equals(SIGNATURE);
}

/** 只读 IHDR 里的宽高。商店对素材尺寸是硬性要求，写错尺寸会直接被驳回。 */
export function readPngSize(buffer) {
  if (!isPng(buffer)) throw new Error("不是 PNG 文件");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * 返回 { width, height, minX, minY, maxX, maxY, cornerAlpha }。
 * 判定“有图形”的 alpha 阈值取 16，忽略抗锯齿边缘那一圈几乎透明的像素，
 * 否则 128 像素图标会因为 1/255 的噪声算出满画布边界。
 */
export function readPngAlphaBounds(buffer) {
  if (!isPng(buffer)) throw new Error("不是 PNG 文件");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 6;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (!width || !height) throw new Error("PNG 缺少 IHDR");
  if (interlace !== 0) throw new Error("不支持隔行 PNG；图标应由 scripts/build-icons.mjs 生成");
  if (bitDepth !== 8) throw new Error(`只支持 8 位 PNG，实际为 ${bitDepth} 位`);
  if (colorType !== 6 && colorType !== 4) throw new Error(`图标必须带 alpha 通道，实际 colorType=${colorType}`);

  const channels = colorType === 6 ? 4 : 2;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rows = [];
  let previous = Buffer.alloc(stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = Buffer.from(raw.subarray(cursor, cursor + stride));
    cursor += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + left) & 0xff;
      else if (filter === 2) line[x] = (line[x] + up) & 0xff;
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const estimate = left + up - upperLeft;
        const da = Math.abs(estimate - left);
        const db = Math.abs(estimate - up);
        const dc = Math.abs(estimate - upperLeft);
        line[x] = (line[x] + (da <= db && da <= dc ? left : db <= dc ? up : upperLeft)) & 0xff;
      }
    }
    rows.push(line);
    previous = line;
  }

  const alphaAt = (x, y) => rows[y][x * channels + channels - 1];
  const cornerAlpha = Math.max(
    alphaAt(0, 0),
    alphaAt(width - 1, 0),
    alphaAt(0, height - 1),
    alphaAt(width - 1, height - 1)
  );
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alphaAt(x, y) > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { width, height, minX, minY, maxX, maxY, cornerAlpha, opaque: maxX >= 0 };
}

/**
 * 图标规范校验：四角必须完全透明，且图形不能贴边。
 * 128 的画布按 Chrome 图标规范留 16 像素（12.5%）；16/32 像素太小，
 * 按比例只剩 2 像素会把图形压得看不清，因此只要求至少 1 像素。
 */
export function checkIconPadding(buffer, expectedSize) {
  const bounds = readPngAlphaBounds(buffer);
  if (bounds.width !== expectedSize || bounds.height !== expectedSize) {
    throw new Error(`图标尺寸应为 ${expectedSize}×${expectedSize}，实际 ${bounds.width}×${bounds.height}`);
  }
  if (!bounds.opaque) throw new Error("图标完全透明");
  if (bounds.cornerAlpha !== 0) throw new Error("图标四角不透明：工具栏会出现方块底");
  const padding = Math.min(
    bounds.minX,
    bounds.minY,
    bounds.width - 1 - bounds.maxX,
    bounds.height - 1 - bounds.maxY
  );
  const required = expectedSize >= 48 ? Math.round(expectedSize / 8) : 1;
  if (padding < required) throw new Error(`图形离边缘只有 ${padding}px，少于要求的 ${required}px`);
  return { padding, artwork: [bounds.maxX - bounds.minX + 1, bounds.maxY - bounds.minY + 1] };
}
