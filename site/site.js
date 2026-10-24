// 海内存知 官网的四处交互：顶栏随滚动变色、英文入口提示、瓶中水位随滚动上涨、演示弹窗按内容自适应高度。
// 不依赖任何库；脚本失败时页面仍完整可读（水位停在半瓶，演示保持默认高度）。

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// 顶栏：压在深海蓝首屏上时是深色，首屏底边滑到顶栏下方时混合成正文底色。
// 混合区间取首屏底部 120px：前半段底色 0 → 45%，过半时跳到 75% 并切 .is-light（深字），后半段 75% → 100%。
// 跳过的中灰段上白字与深字都不够读（原因见 site.css 的 .topbar 注释）。值不变就不写，避免每帧改样式。
const topbar = document.querySelector(".topbar");
const hero = document.querySelector(".hero");
if (topbar && hero) {
  const BLEND = 120;
  let frame = 0;
  let last = "";
  const update = () => {
    frame = 0;
    const overlap = hero.getBoundingClientRect().bottom - topbar.offsetHeight;
    const value = Math.min(1, Math.max(0, 1 - overlap / BLEND)).toFixed(2);
    if (value === last) return;
    last = value;
    const t = Number(value);
    const mix = t < 0.5 ? t * 2 * 45 : 75 + (t - 0.5) * 2 * 25;
    topbar.style.setProperty("--bar-mix", `${mix.toFixed(1)}%`);
    topbar.classList.toggle("is-light", t >= 0.5);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  update();
}

// 中文首页：浏览器偏好语言里没有中文的访客（多半从商店主页链接过来）看到一行英文入口。
// 只提示不跳转：自动跳转会让想看中文的人无法停留，也会干扰搜索引擎按 hreflang 收录。
const langHint = document.querySelector(".lang-hint");
if (langHint) {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language || ""];
  langHint.hidden = languages.some((tag) => /^zh\b/i.test(tag));
}

// 「存」一节：水位＝已缓存。区块从视口底部进入到离开视口顶部，水位从 15% 涨到 90%。
const bottle = document.querySelector(".keep-bottle");
if (bottle) {
  let frame = 0;
  const update = () => {
    frame = 0;
    if (reducedMotion.matches) {
      bottle.style.setProperty("--level", "0.5");
      return;
    }
    const rect = bottle.closest(".section").getBoundingClientRect();
    const progress = Math.min(1, Math.max(0, (innerHeight - rect.top) / (innerHeight + rect.height)));
    bottle.style.setProperty("--level", (0.15 + progress * 0.75).toFixed(3));
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  addEventListener("scroll", schedule, { passive: true });
  addEventListener("resize", schedule);
  reducedMotion.addEventListener("change", schedule);
  update();
}

// 演示弹窗与本页同源，可以读到它的文档：按弹窗内容高度调整 iframe，
// 切换页签或打开设置时不留空白、也不出现内部滚动条。上限 600 与 Chrome 弹窗一致。
// 弹窗固定 360px 宽（与 Chrome 里一致）。窄屏放不下时整体缩放而不是压窄，否则弹窗里会出现横向滚动。
const frame = document.querySelector(".demo-frame");
if (frame) {
  const scaleToFit = () => {
    const available = frame.closest(".demo").parentElement.clientWidth;
    frame.style.zoom = available < 360 ? (available / 360).toFixed(3) : "";
  };
  addEventListener("resize", scaleToFit);
  scaleToFit();
  const fit = () => {
    const shell = frame.contentDocument?.querySelector(".app-shell");
    if (!shell) return;
    const height = Math.min(600, Math.ceil(shell.getBoundingClientRect().height));
    if (height > 0 && Math.abs(frame.offsetHeight - height) > 1) frame.style.height = `${height}px`;
  };
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    // 场景夹具给 body 写死了 640px 高与浅色底，嵌在页面里时交给弹窗自己的配色。
    doc.body.style.height = "auto";
    doc.documentElement.style.background = "transparent";
    doc.body.style.background = "transparent";
    const observer = new ResizeObserver(fit);
    const watch = () => {
      const shell = doc.querySelector(".app-shell");
      if (shell) observer.observe(shell);
      else setTimeout(watch, 100);
    };
    watch();
  });
}
