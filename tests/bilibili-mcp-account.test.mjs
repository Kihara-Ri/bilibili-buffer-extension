import assert from "node:assert/strict";
import test from "node:test";
import { MCP_BILI_LOGIN_URL, readMcpAccountStatus, readMcpBrowserJson } from "../src/mcp-browser-requests.js";

test("登录判断使用当前浏览器 API 会话，只对明确登出提供登录地址", async () => {
  const result = data => readMcpAccountStatus(async (url, options) => {
    assert.equal(url, "https://api.bilibili.com/x/web-interface/nav");
    assert.equal(options.credentials, "include");
    assert.equal(options.redirect, "error");
    return Response.json(data);
  });
  assert.deepEqual(await result({ code: 0, data: { isLogin: true, uname: "synthetic account" } }), { status: "signed_in" });
  for (const response of [{ code: -101 }, { code: 0, data: { isLogin: false } }]) {
    assert.deepEqual(await result(response), { status: "signed_out", loginUrl: MCP_BILI_LOGIN_URL });
  }
  for (const response of [{ code: -412 }, { code: 0, data: {} }, { code: -403 }]) {
    assert.deepEqual(await result(response), { status: "unavailable" });
  }
  assert.deepEqual(await readMcpAccountStatus(async () => new Response(null, { status: 503 })), { status: "unavailable" });
  assert.deepEqual(await readMcpAccountStatus(async () => { throw new Error("offline"); }), { status: "unavailable" });
});

test("本机 Chrome 请求只读取固定 API，字幕 CDN 不带会话", async () => {
  assert.deepEqual(await readMcpBrowserJson("https://aisubtitle.hdslb.com/mock.json", "cues", async (url, options) => {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    return Response.json({ body: [] });
  }), { body: [] });
  await assert.rejects(readMcpBrowserJson("https://example.com/mock.json", "cues", () => assert.fail("请求不可发生")));
  await assert.rejects(readMcpBrowserJson("https://api.bilibili.com/x/player/wbi/v2", "account", () => assert.fail("请求不可发生")));
});
