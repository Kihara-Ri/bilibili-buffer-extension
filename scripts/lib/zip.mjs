// 发布包用的最小 ZIP 读写：只依赖 Node 自带的 zlib，不再调用系统 zip / unzip。
//
// 为什么自己写：Windows 下没有 zip / unzip 命令，`npm run build` 与发布包内容检查直接失败；
// 而 Chrome 商店只需要最基本的 ZIP（deflate、无加密、无 ZIP64），几十行就能覆盖。
//
// 可复现：条目按调用方给定的顺序写入，时间戳统一取固定值，不写 Unix 权限位，
// 同一份源码在任何机器上构建出的字节完全相同，SHA-256 才有意义。
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50;

/** ZIP 使用 DOS 本地时间格式（2 秒精度）；这里直接按 UTC 字段编码，保证跨时区一致。 */
function dosDateTime(date) {
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

/**
 * @param {{name: string, data: Buffer}[]} entries 已排序的条目；name 使用 / 分隔的相对路径
 * @param {{date?: Date}} [options]
 * @returns {Buffer}
 */
export function createZip(entries, { date = new Date(Date.UTC(2026, 0, 1)) } = {}) {
  const { time, day } = dosDateTime(date);
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    // 压缩反而变大时（如 PNG）原样存储，与 zip -X 的行为一致。
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0);
    header.writeUInt16LE(20, 4);            // 解压所需版本 2.0
    header.writeUInt16LE(0x0800, 6);        // 文件名为 UTF-8
    header.writeUInt16LE(stored ? 0 : 8, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    locals.push(header, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);           // 创建者版本 2.0 / MS-DOS：不携带权限位
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += header.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/**
 * 读出 ZIP 的全部条目并校验 CRC。只支持 createZip 产出的子集（stored / deflate，无 ZIP64、无注释）。
 * @param {Buffer} buffer @returns {Map<string, Buffer>}
 */
export function readZip(buffer) {
  const endAt = buffer.length - 22;
  if (endAt < 0 || buffer.readUInt32LE(endAt) !== END) throw new Error("不是受支持的 ZIP（找不到目录结尾）");
  const count = buffer.readUInt16LE(endAt + 10);
  let cursor = buffer.readUInt32LE(endAt + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL) throw new Error("ZIP 中央目录损坏");
    const method = buffer.readUInt16LE(cursor + 10), checksum = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20), nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const localAt = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const body = buffer.subarray(dataAt, dataAt + compressed);
    const data = method === 0 ? Buffer.from(body) : method === 8 ? inflateRawSync(body) : null;
    if (!data) throw new Error(`ZIP 条目 ${name} 使用了不支持的压缩方式 ${method}`);
    if (crc32(data) !== checksum) throw new Error(`ZIP 条目 ${name} 校验和不一致`);
    files.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
