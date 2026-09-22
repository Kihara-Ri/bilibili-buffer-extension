// 离线下载得到的「原始 CDN 范围字节」镜像：只服务同一媒体文件（路径 + 总长一致）的播放请求。
// 与离线片库（videos/chunks）完全分离：这里只接收逐字节校验过的源范围，
// 合并文件或抽取音频永不进入，因此不会把合成字节当成源范围复用。
export const SOURCE_LIMIT = 64 * 1024 * 1024;
export const SOURCE_RANGE_LIMIT = 2 * 1024 * 1024;
export const SOURCE_ROWS = 256;
// 页面侧一次复用请求的上限：单条消息不能把整段播放请求塞进内存或消息通道。
export const SOURCE_READ_LIMIT = 4 * 1024 * 1024;

const MEDIA_HOST = /(^|\.)(bilivideo\.com|bilivideo\.cn|hdslb\.com|akamaized\.net)$/;
const b64 = (bytes) => { let text = ""; for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192)); return btoa(text); };
const unb64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const safe = (value) => Number.isSafeInteger(value) && value >= 0;

/** 解析并校验一个源范围请求；任何字段可疑都返回 null（调用方按未命中处理）。
 * 身份只看 pathname + total：签名、主机与查询串不参与匹配，与 CDN 备用主机互换的既有假设一致。
 * @param {object} request @param {number} now @returns {{pathname:string, source:string, total:number, start:number, end:number, expires:number}|null}
 */
export function sourceFacts(request, now = Date.now()) {
  try {
    const url = new URL(String(request?.url || ""));
    if (url.protocol !== "https:" || !MEDIA_HOST.test(url.hostname) || url.username || url.password || url.hash) return null;
    if (!url.pathname || url.pathname.length > 512) return null;
    const { start, end, total } = request;
    if (![start, end, total].every(safe) || total <= 0 || end <= start || end > total) return null;
    if (end - start > SOURCE_RANGE_LIMIT) return null;
    // 签名有效期：deadline/expires 是秒级 Unix 时间；缺失或已过期就不允许持久化或复用。
    const deadline = Number(url.searchParams.get("deadline") || url.searchParams.get("expires")) * 1000;
    if (!Number.isFinite(deadline) || deadline <= now) return null;
    return { pathname: url.pathname, source: `${url.pathname}\n${total}`, total, start, end, expires: Math.min(deadline, now + 3600_000) };
  } catch { return null; }
}

/** 判定一次源范围请求的可见范围：写入只允许扩展自己的下载文档，读取只允许 B 站视频页。
 * 页面身份用 sender.url（帧自身地址）优先，其次才是标签页地址，避免标签页导航后的误判。
 * @param {{id?:string, url?:string, tab?:{url?:string}}} sender
 * @param {{runtimeId?:string, offscreenUrl?:string}} identity
 * @returns {'writer'|'reader'|null}
 */
export function sourceRangeScope(sender, { runtimeId, offscreenUrl } = {}) {
  if (!sender || !runtimeId || sender.id !== runtimeId) return null;
  const frameUrl = String(sender.url || "").split("#")[0];
  if (offscreenUrl && !sender.tab && frameUrl === offscreenUrl) return "writer";
  const pageUrl = sender.tab?.url || frameUrl;
  return /^https:\/\/www\.bilibili\.com\/(video|list)\//.test(String(pageUrl || "")) ? "reader" : null;
}

/** 有界源范围库；写入在事务成功后才算完成，异常一律向上抛给服务层吞掉。
 * @param {IDBFactory} factory @param {string} name @returns {object}
 */
export function createSourceRepository(factory = globalThis.indexedDB, name = "bili-buffer-source-ranges-v1") {
  // 能力缺失（无 IndexedDB 或无 open）时返回一个恒为空的服务仓库：调用方无需分支，也永远不会抛错。
  if (!factory || typeof factory.open !== "function") {
    return { disabled: true, list: async () => [], put: async () => false, clear: async () => {} };
  }
  let opening = null;
  const open = () => opening ||= new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("ranges", { keyPath: "id" }).createIndex("source", "source");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error); };
  });
  return {
    async list(source) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("ranges"), request = tx.objectStore("ranges").index("source").getAll(source);
        tx.oncomplete = () => resolve(request.result || []);
        tx.onabort = () => reject(tx.error);
      });
    },
    async put(row) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("ranges", "readwrite"), store = tx.objectStore("ranges"), all = store.getAll();
        all.onsuccess = () => {
          // 先淘汰过期行，再按「最旧优先」回收，直到行数与字节都在上限内。
          let bytes = row.data.size;
          const kept = [];
          for (const old of all.result || []) {
            if (old.expires <= Date.now() || old.id === row.id) store.delete(old.id);
            else { kept.push(old); bytes += old.data.size; }
          }
          kept.sort((left, right) => left.created - right.created || String(left.id).localeCompare(String(right.id)));
          while (kept.length && (bytes > SOURCE_LIMIT || kept.length >= SOURCE_ROWS)) {
            const old = kept.shift();
            bytes -= old.data.size;
            store.delete(old.id);
          }
          store.put(row);
        };
        tx.oncomplete = () => resolve(true);
        tx.onabort = () => reject(tx.error);
      });
    },
    async clear() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("ranges", "readwrite");
        tx.objectStore("ranges").clear();
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    }
  };
}

/** 后台侧的镜像服务：唯一入口，负责账户隔离与有界校验。
 * @param {{repository:object, account:Function, now?:Function}} options
 * @returns {{handle:Function, clear:Function}}
 */
export function createSourceService({ repository, account, now = Date.now }) {
  let queue = Promise.resolve();
  const disabled = !repository;
  // 账户分区由调用方给出的不透明指纹决定；本模块永不接触 cookie、token 或账号 ID。
  const partitionOf = async () => { try { return String(await account() || "anonymous").slice(0, 64); } catch { return "anonymous"; } };
  const read = async (request, partition) => {
    const facts = sourceFacts(request, now());
    if (!facts || request.end - request.start > SOURCE_READ_LIMIT) return null;
    const rows = (await repository.list(facts.source))
      .filter((row) => row && row.partition === partition && row.total === facts.total && row.expires > now())
      .sort((left, right) => left.start - right.start || right.end - left.end);
    if (!rows.length) return null;
    // 只按连续覆盖取字节：中间有洞就整体判未命中，绝不返回不完整范围。
    const parts = [];
    let cursor = facts.start;
    for (const row of rows) {
      if (row.end <= cursor || row.start > cursor) { if (row.start > cursor) break; continue; }
      const end = Math.min(facts.end, row.end);
      parts.push(row.data.slice(cursor - row.start, end - row.start));
      cursor = end;
      if (cursor === facts.end) break;
    }
    if (cursor !== facts.end || !parts.length) return null;
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    if (bytes.length !== facts.end - facts.start) return null;
    // 读取期间账户可能已切换或签名失效，旧字节不能交付给新会话。
    if (partition !== await partitionOf() || !sourceFacts(request, now())) return null;
    return { start: facts.start, end: facts.end, total: facts.total, body: bytes, contentType: rows[0].contentType };
  };
  const write = async (request, partition) => {
    const facts = sourceFacts(request, now());
    if (!facts || facts.start !== request.start || facts.end !== request.end) return false;
    if (typeof request.body !== "string" || request.body.length > Math.ceil(SOURCE_RANGE_LIMIT / 3) * 4) return false;
    const bytes = unb64(request.body);
    if (bytes.length !== facts.end - facts.start) return false;
    const contentType = /^(video|audio)\/[-\w.+]+$/.test(request.contentType || "") ? request.contentType : "application/octet-stream";
    // 事务成功且真实写入才算成功；停用/被拒的仓库返回 false，调用方据此判未命中。
    const stored = await repository.put({
      id: `${facts.source}\u0000${partition}\u0000${facts.start}`,
      source: facts.source, partition, start: facts.start, end: facts.end, total: facts.total,
      expires: facts.expires, created: now(), contentType, data: new Blob([bytes])
    });
    return stored !== false;
  };
  return {
    /** 串行处理，避免并发写入时同一 source 的回收互相覆盖。
     * @param {object} request @param {'writer'|'reader'} scope @returns {Promise<object>}
     */
    async handle(request, scope) {
      if (disabled || !request || typeof request !== "object") return {};
      const run = queue.then(async () => {
        const partition = await partitionOf();
        if (request.op === "read") {
          const hit = await read(request, partition);
          return hit ? { hit: true, ...hit, body: b64(hit.body) } : {};
        }
        // 只有扩展自己的下载上下文可以写入；页面只能读。
        if (request.op !== "write" || scope !== "writer") return {};
        return (await write(request, partition)) ? { stored: true } : {};
      });
      queue = run.catch(() => {});
      try { return await run; } catch { return {}; }
    },
    clear: () => (disabled ? Promise.resolve() : repository.clear())
  };
}
