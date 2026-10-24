import en from "./locales/en.js";
import zhCN from "./locales/zh-CN.js";

/**
 * 界面文案的多语言入口：中文浏览器显示中文，其余一律英文。
 *
 * 为什么不直接用 chrome.i18n.getMessage：
 * - Offscreen Document 只能用 chrome.runtime，拿不到 chrome.i18n，而缓存出错的提示正是在 Offscreen 里产生的；
 * - getMessage 不支持复数与带条件的句式，英文的「1 video / 2 videos」只能写成函数。
 * 所以运行时文案放在 src/locales/*.js，由各上下文直接 import；_locales/ 只保留清单要用的扩展名与描述。
 *
 * 语言在每个上下文启动时确定一次，之后不再变化（Chrome 改界面语言需要重启浏览器）：
 * - 有 chrome.i18n 的上下文（Service Worker、弹窗）按 Chrome 界面语言；
 * - Offscreen 与普通网页按 navigator.language，扩展页面里它与 Chrome 界面语言一致；
 * - Node 单测环境默认中文，保持既有断言稳定，需要英文时调用 setLocale("en")。
 * zh-TW / zh-HK 也归到中文：简体总比英文更接近繁体用户的习惯。
 *
 * 只翻译用户可能看到的文字（弹窗、徽标提示、任务错误、自检）。页面主世界脚本里的取消原因、
 * console 日志等只用于排查，仍用中文。
 */

/** @typedef {string | ((params: Record<string, unknown>) => string)} Message */

/** @type {Record<string, Record<string, Message>>} */
export const MESSAGES = Object.freeze({ "zh-CN": zhCN, en });

/**
 * @param {string | undefined | null} tag BCP 47 语言标签，如 zh-CN、zh_TW、en-US
 * @returns {"zh-CN" | "en"}
 */
export function resolveLocale(tag) {
  return /^zh(?:[-_]|$)/i.test(String(tag || "")) ? "zh-CN" : "en";
}

function detectLocale() {
  const chromeLanguage = globalThis.chrome?.i18n?.getUILanguage?.();
  if (chromeLanguage) return resolveLocale(chromeLanguage);
  if (typeof globalThis.process?.versions?.node === "string" && typeof globalThis.document === "undefined") return "zh-CN";
  return resolveLocale(globalThis.navigator?.language);
}

let current = detectLocale();

/** @returns {"zh-CN" | "en"} */
export function getLocale() {
  return current;
}

/**
 * 仅供测试与演示场景切换语言；扩展运行时语言在启动时已经确定。
 * @param {string} tag
 */
export function setLocale(tag) {
  current = resolveLocale(tag);
}

/**
 * 取一条文案。缺词时退回中文原文，再退回 key 本身，界面不会出现空白。
 * @param {string} key
 * @param {Record<string, unknown>} [params] 替换 {name} 占位符，或传给函数式文案
 * @returns {string}
 */
export function t(key, params = {}) {
  const message = MESSAGES[current][key] ?? MESSAGES["zh-CN"][key];
  if (message === undefined) return key;
  if (typeof message === "function") return message(params);
  return message.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

/**
 * 按 data-i18n 系列属性填充静态页面文案：
 * - data-i18n="key"：替换 textContent（元素内不要再放其他子节点）；
 * - data-i18n-attr="aria-label:key;title:key"：替换属性。
 * 同时把 <html lang> 改成当前语言，读屏软件才会用对发音。
 * @param {ParentNode & { documentElement?: HTMLElement }} [root]
 */
export function localizeDocument(root = document) {
  for (const element of root.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of root.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of element.dataset.i18nAttr.split(";")) {
      const [attribute, key] = pair.split(":").map((part) => part.trim());
      if (attribute && key) element.setAttribute(attribute, t(key));
    }
  }
  const html = root.documentElement || globalThis.document?.documentElement;
  if (html) html.lang = current === "zh-CN" ? "zh-CN" : "en";
}
