/**
 * 关闭闸门必须同步拒绝新命令，再等待所有已进入的异步命令结束，避免检查锁后的 await 漏入写操作。
 * @returns {{run:Function,close:Function,open:Function}}
 */
export function createWorkGate() {
  let locked = false;
  const pending = new Set();
  return {
    async run(operation) {
      if (locked) throw new Error('Update in progress');
      const task = Promise.resolve().then(operation);
      pending.add(task);
      try { return await task; } finally { pending.delete(task); }
    },
    async close() { locked = true; await Promise.allSettled([...pending]); },
    open() { locked = false; }
  };
}
