// 官网「扔一只漂流瓶」计数服务（server/bottles/bottles.py）的接口契约：
// 计数与标签、同 IP 每天一只、只接受官网来源、拒绝自由文本与超大请求、跨域头只给允许的来源。
// 服务只用 Python 标准库；机器上没有 python3 时整组跳过（发布包与扩展本身都不依赖它）。
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = ["python3", "python"].find((command) => spawnSync(command, ["--version"]).status === 0);
const SITE = "https://haineicunzhi.kihara.cn";
const API = "/haineicunzhi/api/bottles";

async function startServer(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "bottles-"));
  const child = spawn(python, [path.join(root, "server", "bottles", "bottles.py")], {
    env: { ...process.env, BOTTLES_PORT: "0", BOTTLES_DB: path.join(dir, "bottles.sqlite3") },
    stdio: ["ignore", "pipe", "inherit"]
  });
  t.after(() => { child.kill(); rmSync(dir, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    child.on("exit", (code) => reject(new Error(`计数服务提前退出：${code}`)));
    child.stdout.on("data", (chunk) => {
      const match = String(chunk).match(/listening (\d+)/);
      if (match) resolve(Number(match[1]));
    });
  });
  const base = `http://127.0.0.1:${port}${API}`;
  const throwBottle = (body, { ip = "203.0.113.7", origin = SITE, type = "application/json" } = {}) => fetch(base, {
    method: "POST",
    headers: { "Content-Type": type, "X-Real-IP": ip, ...(origin ? { Origin: origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  return { base, throwBottle };
}

test("计数服务：初始为零，GET 带短缓存，只给允许的来源跨域头", { skip: !python && "没有 python3" }, async (t) => {
  const { base } = await startServer(t);
  const fromSite = await fetch(base, { headers: { Origin: SITE } });
  assert.equal(fromSite.status, 200);
  assert.deepEqual(await fromSite.json(), { total: 0, tags: { smooth: 0, offline: 0, quality: 0 } });
  assert.equal(fromSite.headers.get("access-control-allow-origin"), SITE);
  assert.match(fromSite.headers.get("cache-control"), /max-age=15/);
  const fromElsewhere = await fetch(base, { headers: { Origin: "https://evil.example" } });
  assert.equal(fromElsewhere.headers.get("access-control-allow-origin"), null);
  // 本地预览（npm run site:preview）任意端口都能读写。
  const local = await fetch(base, { headers: { Origin: "http://localhost:4173" } });
  assert.equal(local.headers.get("access-control-allow-origin"), "http://localhost:4173");
  assert.equal((await fetch(base.replace("bottles", "other"))).status, 404);
});

test("计数服务：扔瓶子计数、带标签，同一 IP 当天第二只不计数", { skip: !python && "没有 python3" }, async (t) => {
  const { throwBottle } = await startServer(t);
  const first = await (await throwBottle({ tag: "offline" })).json();
  assert.deepEqual(first, { accepted: true, total: 1, tags: { smooth: 0, offline: 1, quality: 0 } });
  const again = await (await throwBottle({ tag: "smooth" })).json();
  assert.deepEqual(again, { accepted: false, total: 1, tags: { smooth: 0, offline: 1, quality: 0 } });
  const other = await (await throwBottle({}, { ip: "198.51.100.2" })).json();
  assert.equal(other.accepted, true);
  assert.equal(other.total, 2);
  assert.equal(other.tags.offline, 1);
});

test("计数服务：拒绝其他来源、自由文本标签、非 JSON 与超大请求", { skip: !python && "没有 python3" }, async (t) => {
  const { base, throwBottle } = await startServer(t);
  assert.equal((await throwBottle({}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await throwBottle({}, { origin: "" })).status, 403);
  assert.equal((await throwBottle({ tag: "随便写点什么" })).status, 400);
  assert.equal((await throwBottle("tag=offline", { type: "application/x-www-form-urlencoded" })).status, 400);
  assert.equal((await throwBottle("{", {})).status, 400);
  assert.equal((await throwBottle({ tag: "offline", pad: "x".repeat(400) })).status, 400);
  assert.equal((await (await fetch(base)).json()).total, 0, "被拒绝的请求不能计数");
});
