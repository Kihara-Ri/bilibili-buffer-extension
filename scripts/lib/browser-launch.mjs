// 浏览器套件的启动参数。
//
// 默认使用 Playwright 自带的 Chrome for Testing；`npm run test:chrome` 会用
// PLAYWRIGHT_CHROMIUM_EXECUTABLE 指向与本机 Chrome 同版本的构建，让验收真正
// 跑在用户会遇到的浏览器版本上（见 scripts/test-chrome.mjs）。
/**
 * @param {object} overrides 其余 Playwright 启动项（headless / args 等）
 * @returns {object} 互斥的 channel 或 executablePath 只会出现一个
 */
export function chromiumLaunchOptions(overrides = {}) {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (executablePath) return { executablePath, ...overrides };
  return { channel: "chromium", ...overrides };
}
