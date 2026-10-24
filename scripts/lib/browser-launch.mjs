// 浏览器套件的启动参数。
//
// 默认使用 Playwright 自带的 Chrome for Testing；`npm run test:chrome` 会用
// PLAYWRIGHT_CHROMIUM_EXECUTABLE 指向与本机 Chrome 同版本的构建，让验收真正
// 跑在用户会遇到的浏览器版本上（见 scripts/test-chrome.mjs）。
/**
 * 界面语言默认钉在简体中文：扩展文案跟随 Chrome 语言（src/i18n.js），而既有浏览器断言都写的是中文，
 * 不钉住的话换一台英文系统的机器跑测试就会整片失败。需要英文时设 BROWSER_LANG=en。
 * @param {object} overrides 其余 Playwright 启动项（headless / args 等）
 * @returns {object} 互斥的 channel 或 executablePath 只会出现一个
 */
export function chromiumLaunchOptions(overrides = {}) {
  const lang = process.env.BROWSER_LANG || "zh-CN";
  const args = [`--lang=${lang}`, ...(overrides.args || [])];
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (executablePath) return { executablePath, ...overrides, args };
  return { channel: "chromium", ...overrides, args };
}
