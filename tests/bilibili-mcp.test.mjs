import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBilibiliDownloadJobs, parseBilibiliMediaRequest } from "../scripts/lib/bilibili-mcp.mjs";
import { planBilibiliBudget, readBilibiliSubtitles, resolveBilibiliMediaRequest, signedSubtitleQuery } from "../scripts/lib/bilibili-mcp-media.mjs";
import { createBilibiliOutput, subtitlesToSrt } from "../scripts/lib/bilibili-mcp-output.mjs";
import { createBilibiliJobStore } from "../scripts/lib/bilibili-mcp-store.mjs";

const video = "https://www.bilibili.com/video/BVfixture/";

test("MCP 工具保留分 P、识别 av／稍后再看并去掉分享追踪参数", () => {
  assert.deepEqual(parseBilibiliMediaRequest(`${video}?spm_id_from=333&p=2#share`), { url: `${video}?p=2`, page: 2 });
  assert.deepEqual(parseBilibiliMediaRequest("https://www.bilibili.com/zh-Hans/list/watchlater?bvid=BVfixture&p=1"), { url: video, page: 1 });
  assert.deepEqual(parseBilibiliMediaRequest("https://www.bilibili.com/video/av123?p=4"), { url: "https://www.bilibili.com/video/av123/?p=4", page: 4 });
});

test("MCP 工具拒绝非 B 站、凭据和无效分 P，且不会启动浏览器", async t => {
  const directory = await temporary(t);
  const jobs = createBilibiliDownloadJobs(() => assert.fail("无效请求不能启动 Chromium"), { jobDirectory: directory, outputDirectory: directory });
  for (const url of ["http://www.bilibili.com/video/BVfixture", "https://www.bilibili.com.test/video/BVfixture", "https://user@www.bilibili.com/video/BVfixture", `${video}?p=0`, `${video}?p=2x`, `${video}?p=99999999999999999`]) {
    await assert.rejects(jobs.start({ url }), { code: "INVALID_URL" });
  }
  await assert.rejects(jobs.start({ url: video, mode: "audio", quality: 120 }), { code: "INVALID_QUALITY" });
});

test("B 站短链保留用户指定的 P，也不会请求跳转到的其他域名", async () => {
  const calls = [];
  const fake = async (url, options) => {
    calls.push([url.hostname, options.redirect, options.credentials]);
    return Response.redirect(`${video}?p=2&spm_id_from=test`, 302);
  };
  assert.deepEqual(await resolveBilibiliMediaRequest("https://b23.tv/example?p=5", fake), { url: `${video}?p=5`, page: 5 });
  assert.deepEqual(calls, [["b23.tv", "manual", "omit"]]);
  await assert.rejects(resolveBilibiliMediaRequest("https://b23.tv/example", async () => Response.redirect("http://127.0.0.1/")), { code: "SHORT_LINK_UNAVAILABLE" });
});

test("两个 MCP 实例并发写入时任务不丢失，队列租约只有一个执行者", async t => {
  const directory = await temporary(t);
  const one = createBilibiliJobStore(directory), two = createBilibiliJobStore(directory);
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? one : two).update(rows => { rows.push({ id: i }); })));
  assert.deepEqual((await two.read()).map(row => row.id).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
  const release = await one.claimRunner();
  try {
    assert.equal(await two.runnerActive(), true);
    assert.equal(await two.claimRunner(), null);
  } finally { await release(); }
  const handoff = await two.claimRunner();
  await handoff();
});

test("预算先覆盖所有分 P，再选能容纳的最高档，缺少体积时返回明确原因", () => {
  const parts = [
    { options: [{ quality: 120, bytes: 92 }, { quality: 80, bytes: 40 }] },
    { options: [{ quality: 120, bytes: 75 }, { quality: 80, bytes: 43 }, { quality: 32, bytes: null }] }
  ];
  assert.deepEqual(planBilibiliBudget(parts, 120).map(item => item.quality), [80, 120]);
  assert.throws(() => planBilibiliBudget(parts, 82), { code: "BUDGET_TOO_SMALL" });
  assert.throws(() => planBilibiliBudget([{ options: [{ quality: 80, bytes: null }] }], 80), { code: "BUDGET_UNKNOWN" });
});

test("字幕保留时间戳和来源，锁定与外部字幕地址不能当成正常字幕", async () => {
  const keys = {
    img_url: `https://i0.hdslb.com/${"a".repeat(32)}.png`,
    sub_url: `https://i0.hdslb.com/${"b".repeat(32)}.png`
  };
  const calls = [];
  let track = { lan: "ai-zh", subtitle_url: "//i0.hdslb.com/cues?auth_key=example" };
  const browser = { async readJson(address, kind) {
    calls.push([new URL(address), kind]);
    if (kind === "nav") return { keys };
    if (kind === "tracks") return { code: 0, tracks: [track] };
    return { body: [{ from: 0.125, to: 2.5, content: "第 3 P" }] };
  } };
  const part = { bvid: "BVfixture", cid: 903 };
  const vector = new URLSearchParams(signedSubtitleQuery(part.bvid, part.cid, keys, 1700000000));
  assert.equal(vector.get("w_rid"), "af2e9a40765f9480ca03d633eb7e30c7"); // 独立内容服务 sign_wbi 的同输入结果。
  const ready = await readBilibiliSubtitles(browser, part);
  assert.match(calls[1][0].searchParams.get("w_rid"), /^[a-f\d]{32}$/);
  assert.equal(calls[1][0].searchParams.get("cid"), "903");
  assert.equal(ready.machineGenerated, true);
  assert.equal(ready.source, "bilibili");
  assert(!JSON.stringify(ready).includes("auth_key"));
  assert.match(subtitlesToSrt(ready.cues), /00:00:00,125 --> 00:00:02,500\n第 3 P/);
  assert.equal((await readBilibiliSubtitles(browser, part, "en-US")).status, "language_unavailable");
  track = { ...track, is_lock: true };
  assert.equal((await readBilibiliSubtitles(browser, part)).status, "subtitle_locked");
  track = { ...track, is_lock: false, subtitle_url: "https://example.com/cues" };
  await assert.rejects(readBilibiliSubtitles(browser, part), { code: "SUBTITLE_UNAVAILABLE" });
});

test("导出清单可恢复发布后的文件，实际产物超过预算时不发布目录", async t => {
  const directory = await temporary(t);
  const output = createBilibiliOutput(directory);
  const key = "11111111-1111-4111-8111-111111111111/P3";
  const stage = join(directory, "stage");
  await mkdir(stage);
  await writeFile(join(stage, "demo.m4a"), "audio");
  const artifact = { files: [{ name: "demo.m4a", bytes: 5 }], splitTracks: false };
  await assert.rejects(output.publish(key, stage, artifact, { maxBytes: 4 }), /实际产物/);
  assert.equal(await output.read(key), null);
  const published = await output.publish(key, stage, artifact, { maxBytes: 5 });
  assert.equal(await readFile(published.files[0].path, "utf8"), "audio");
  assert.deepEqual(await output.read(key), published);
  await rm(published.files[0].path);
  assert.equal(await output.read(key), null);
});

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "hainei-mcp-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
