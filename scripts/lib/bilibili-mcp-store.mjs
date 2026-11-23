import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

const lockOptions = { realpath: false, stale: 15_000, update: 4_000 };

/** @param {string} directory 本地资料目录。同一套 Chromium 资料只对应一个任务库。 */
export function createBilibiliJobStore(directory) {
  const file = join(directory, "downloads.json");
  const runner = join(directory, "runner");

  async function read() {
    try {
      const data = JSON.parse(await readFile(file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.jobs)) throw new Error("Unknown download journal format");
      return data.jobs;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async function update(edit) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(file, { ...lockOptions, retries: { retries: 30, minTimeout: 25, maxTimeout: 500 } });
    const temporary = join(directory, `.${randomUUID()}.json`);
    try {
      const jobs = await read();
      const result = await edit(jobs);
      // 两个会话可能同时读写。先写完新快照，再原位替换；读者始终读到一次完整事务。
      await writeFile(temporary, JSON.stringify({ version: 1, jobs }), { flag: "wx", mode: 0o600, flush: true });
      await rename(temporary, file);
      return result;
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      await release();
    }
  }

  return {
    read,
    update,
    runnerActive: () => lockfile.check(runner, lockOptions),
    async claimRunner(onCompromised) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        // 整个任务队列共用一个执行者，暂停 A 的缓存任务时不会误停另一会话的 B。
        return await lockfile.lock(runner, { ...lockOptions, ...(onCompromised ? { onCompromised } : {}) });
      } catch (error) {
        if (error.code === "ELOCKED") return null;
        throw error;
      }
    }
  };
}
