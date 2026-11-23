import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { endianness } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { MCP_BRIDGE_PROTOCOL } from "../src/mcp-native-bridge.js";
import { MCP_BRIDGE_FILE } from "./lib/bilibili-mcp-connection.mjs";

const [, , directory, allowed, origin] = process.argv;
const originId = /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin || "")?.[1];
if (!directory || !originId || !allowed?.split(",").includes(originId)) throw new Error("Native connection requires an allowed extension");

const littleEndian = endianness() === "LE";
const maxIncoming = 8 * 1024 * 1024;
const timeout = 120_000;
const sessionTimeout = 300_000;
const token = randomBytes(32).toString("hex");
const pending = new Map();
const sessions = new Map();
const rendezvous = join(directory, MCP_BRIDGE_FILE);
let server, cleanup;
process.stdout.on("error", () => process.stdin.destroy());

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.allocUnsafe(4);
  if (littleEndian) header.writeUInt32LE(body.length); else header.writeUInt32BE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

async function* messages(readable) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of readable) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = littleEndian ? buffer.readUInt32LE() : buffer.readUInt32BE();
      if (size < 1 || size > maxIncoming) throw new Error("Invalid native message size");
      if (buffer.length < size + 4) break;
      yield JSON.parse(buffer.subarray(4, size + 4).toString("utf8"));
      buffer = buffer.subarray(size + 4);
    }
  }
}

function rpc(session, method, args) {
  const id = randomUUID();
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: "Chrome 扩展响应超时，请重试。" });
    }, timeout);
    pending.set(id, message => { clearTimeout(timer); resolve(message); });
    send({ type: "request", id, session, method, args });
  });
}

function authorized(value) {
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(value || "");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

async function serve(request, response) {
  const reply = (status, value) => response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(value));
  // 连接只供本机 MCP 进程使用。网页请求即使能到达 loopback 也没有账户目录里的临时凭据。
  if (request.method !== "POST" || request.url !== "/rpc" || request.headers.origin || !authorized(request.headers.authorization)) {
    request.resume();
    reply(403, { error: "Bridge authorization required" });
    return;
  }
  let bytes = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 65_536) { reply(413, { error: "Bridge request is too large" }); return; }
      chunks.push(chunk);
    }
    const { session, method, args } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!/^[a-f\d-]{36}$/i.test(session || "") || typeof method !== "string") throw new Error("Invalid bridge request");
    sessions.set(session, Date.now());
    const result = await rpc(session, method, args);
    if (method === "close") sessions.delete(session);
    reply(200, result.error ? { error: result.error } : { value: result.value });
  } catch { if (!response.headersSent) reply(400, { error: "Invalid bridge request" }); }
}

await mkdir(directory, { recursive: true, mode: 0o700 });
const release = await lockfile.lock(join(directory, "profile"), {
  realpath: false, stale: 15_000, update: 4_000, onCompromised: () => process.stdin.destroy()
}).catch(() => null);
if (release) {
  try {
    for await (const message of messages(process.stdin)) {
      if (!server) {
        if (message?.type !== "hello" || message.protocol !== MCP_BRIDGE_PROTOCOL) throw new Error("Unsupported bridge protocol");
        server = createServer((request, response) => { void serve(request, response); });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const temporary = join(directory, `.${randomUUID()}.json`);
        await writeFile(temporary, JSON.stringify({ protocol: MCP_BRIDGE_PROTOCOL, token, port: server.address().port }), { flag: "wx", mode: 0o600 });
        await rename(temporary, rendezvous);
        send({ type: "ready", protocol: MCP_BRIDGE_PROTOCOL });
        cleanup = setInterval(() => {
          for (const [session, last] of sessions) {
            if (Date.now() - last < sessionTimeout) continue;
            sessions.delete(session);
            void rpc(session, "close");
          }
        }, 30_000).unref();
      } else if (message?.type === "result") {
        const finish = pending.get(message.id);
        pending.delete(message.id);
        finish?.(message);
      }
    }
  } finally {
    clearInterval(cleanup);
    for (const finish of pending.values()) finish({ error: "Chrome 扩展已断开。" });
    pending.clear();
    server?.close();
    server?.closeAllConnections();
    const current = await readFile(rendezvous, "utf8").then(JSON.parse).catch(() => null);
    if (current?.token === token) await rm(rendezvous, { force: true });
    await release().catch(() => {});
  }
}
