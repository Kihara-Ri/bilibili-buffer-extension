import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLiveBrowser } from "../scripts/lib/live-browser.mjs";

test("创建后的真实站点浏览器资料由后续运行复用，关闭保留数据", async t => {
  const directory = await mkdtemp(join(tmpdir(), "live-browser-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profileDirectory = join(directory, "chrome");
  const launches = [];
  const chromium = {
    async launchPersistentContext(path) {
      launches.push(path);
      return { async close() {} };
    }
  };
  const extension = "/test/extension";
  const first = await openLiveBrowser(chromium, { extension, mode: "create", profileDirectory });
  assert.equal(first.persistent, true);
  await writeFile(join(profileDirectory, "test-state"), "same browser");
  await first.close();
  const next = await openLiveBrowser(chromium, { extension, profileDirectory });
  assert.equal(next.persistent, true);
  await next.close();
  assert.deepEqual(launches, [profileDirectory, profileDirectory]);
  assert.equal(await readFile(join(profileDirectory, "test-state"), "utf8"), "same browser");
});

test("未初始化和显式匿名运行使用各自的临时资料，关闭后删除", async t => {
  const directory = await mkdtemp(join(tmpdir(), "live-browser-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const profileDirectory = join(directory, "chrome");
  const launches = [];
  const chromium = {
    async launchPersistentContext(path) {
      launches.push(path);
      return { async close() {} };
    }
  };
  const extension = "/test/extension";
  const first = await openLiveBrowser(chromium, { extension, profileDirectory });
  assert.equal(first.persistent, false);
  await first.close();
  await assert.rejects(access(launches[0]), { code: "ENOENT" });
  await mkdir(profileDirectory);
  const anonymous = await openLiveBrowser(chromium, { extension, mode: "anonymous", profileDirectory });
  assert.equal(anonymous.persistent, false);
  assert.notEqual(launches[1], launches[0]);
  assert.notEqual(launches[1], profileDirectory);
  await anonymous.close();
  await assert.rejects(access(launches[1]), { code: "ENOENT" });
  await access(profileDirectory);
});
