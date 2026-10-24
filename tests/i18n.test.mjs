import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { isRecoverableDownloadError } from "../src/download-retry.js";
import { getLocale, MESSAGES, resolveLocale, setLocale, t } from "../src/i18n.js";

// 中英文案表的一致性测试。
// 两张表靠人工同步，最容易出的错是：新增一条中文忘了英文、占位符名写错、
// 以及英文错误文案不再命中按文字分类的重试判断（download-retry.js）——
// 最后一种会让英文用户的断网任务不再自动续传，界面上却看不出任何异常。

const root = new URL("../", import.meta.url);
const readText = (relative) => readFile(new URL(relative, root), "utf8");
const zh = MESSAGES["zh-CN"];
const en = MESSAGES.en;
const placeholders = (message) => new Set([...String(message).matchAll(/\{(\w+)\}/g)].map((match) => match[1]));

test("中英文案表的 key 完全一致", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});

test("占位符一致；英文复数写成函数时，用中文的占位符调用也能得到完整句子", () => {
  for (const key of Object.keys(zh)) {
    const params = Object.fromEntries([...placeholders(zh[key])].map((name) => [name, 2]));
    if (typeof zh[key] === "string" && typeof en[key] === "string") {
      assert.deepEqual(placeholders(en[key]), placeholders(zh[key]), `${key} 的占位符不一致`);
      assert.ok(en[key].trim(), `${key} 的英文为空`);
    } else {
      const text = typeof en[key] === "function" ? en[key](params) : en[key];
      assert.equal(typeof text, "string", key);
      assert.doesNotMatch(text, /undefined|NaN|\{\w+\}/, `${key} 的英文没有用到全部参数：${text}`);
    }
  }
});

test("语言识别：中文（含繁体）走中文，其余一律英文", () => {
  for (const tag of ["zh", "zh-CN", "zh_CN", "zh-TW", "zh-HK", "ZH-cn"]) assert.equal(resolveLocale(tag), "zh-CN", tag);
  for (const tag of ["en", "en-US", "ja", "ko-KR", "fr", "", undefined, null, "zhx"]) assert.equal(resolveLocale(tag), "en", String(tag));
});

test("Node 单测默认中文；t() 替换占位符，缺词退回 key", () => {
  assert.equal(getLocale(), "zh-CN");
  assert.equal(t("err.playurlHttp", { status: 412 }), "播放地址请求失败（HTTP 412）");
  assert.equal(t("no.such.key"), "no.such.key");
  setLocale("en-GB");
  try {
    assert.equal(t("ext.name"), "Kindred Afar");
    assert.match(t("err.playurlHttp", { status: 412 }), /HTTP 412/);
  } finally {
    setLocale("zh-CN");
  }
});

test("页面与源码引用的每个文案 key 都存在", async () => {
  const keys = new Set();
  const html = await readText("popup.html");
  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) keys.add(match[1]);
  for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(";")) keys.add(pair.split(":")[1].trim());
  }
  for (const name of await readdir(new URL("src/", root))) {
    if (!name.endsWith(".js")) continue;
    const source = await readText(`src/${name}`);
    // 只收字面量 key；模板拼出来的 key（如 `access.${x}`）由各自的测试覆盖。
    for (const match of source.matchAll(/\bt\("([\w.]+)"/g)) keys.add(match[1]);
  }
  assert.ok(keys.size > 100, `只找到 ${keys.size} 个 key，正则可能失效了`);
  const missing = [...keys].filter((key) => !(key in zh) || !(key in en));
  assert.deepEqual(missing, []);
});

test("错误文案在中英文下的重试分类完全一致", () => {
  const sample = { status: 503, code: -404, track: "视频", codec: "AV1", quality: "1080P", box: "moov", seconds: 30, received: 10, total: 20, message: "x", hint: "y", label: "z", list: "a" };
  const recoverable = (locale, key, params) => {
    setLocale(locale);
    return isRecoverableDownloadError(new Error(t(key, params)));
  };
  try {
    for (const key of Object.keys(zh).filter((name) => /^(err|mp4)\./.test(name))) {
      for (const status of [403, 404, 429, 503]) {
        const params = { ...sample, status };
        const expected = recoverable("zh-CN", key, params);
        assert.equal(recoverable("en", key, params), expected, `${key}（HTTP ${status}）中文 ${expected ? "可" : "不可"}续传：${t(key, params)}`);
      }
    }
  } finally {
    setLocale("zh-CN");
  }
});

test("_locales 的各语言条目一致，繁体与简体内容相同", async () => {
  const read = async (locale) => JSON.parse(await readText(`_locales/${locale}/messages.json`));
  const [enLocale, zhCN, zhTW] = await Promise.all(["en", "zh_CN", "zh_TW"].map(read));
  assert.deepEqual(Object.keys(enLocale).sort(), Object.keys(zhCN).sort());
  assert.deepEqual(zhTW, zhCN);
  assert.equal(enLocale.extName.message, en["ext.name"], "清单英文名与运行时文案一致");
  assert.equal(zhCN.extName.message, zh["ext.name"], "清单中文名与运行时文案一致");
});
