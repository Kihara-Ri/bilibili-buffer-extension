import { watch } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";

const PORT = Number(process.env.BILI_BUFFER_DEV_PORT) || 17321;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let revision = Date.now();
let reloadTimer;

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    response.end(JSON.stringify({ ok: true, revision }));
    return;
  }
  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Not found");
});

const watcher = watch(ROOT, { recursive: true }, (_eventType, filename) => {
  const relative = String(filename || "").split(sep).join("/");
  if (!shouldReload(relative)) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    revision = Date.now();
    process.stdout.write(`已检测到 ${relative}，等待扩展自动重载。\n`);
  }, 180);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write(`端口 ${PORT} 已被占用；热更新服务可能已经启动。\n`);
    watcher.close();
    process.exitCode = 1;
    return;
  }
  throw error;
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`Bili 缓冲站热更新服务已启动：http://127.0.0.1:${PORT}\n`);
  process.stdout.write("修改扩展的 JS、JSON、HTML、CSS 或图标后，Chrome 会在约 1 秒内原位重载。\n");
});

function shouldReload(relative) {
  if (!relative || relative.startsWith(".git/") || relative.startsWith("node_modules/")) return false;
  if (relative.startsWith("tests/") || relative.startsWith("scripts/")) return false;
  return /\.(?:js|json|html|css|png|svg)$/i.test(relative);
}

function shutdown() {
  clearTimeout(reloadTimer);
  watcher.close();
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
