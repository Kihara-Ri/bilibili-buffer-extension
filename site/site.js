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

// 顶栏小瓶：水位＝本页读了多少。滚动时摇一下，但一次摇摆播完之前不重新开始，
// 否则连续滚动会让动画每帧重启、看起来在抽搐。减少动态偏好下只涨水位、不摇。
const barBottle = document.querySelector(".bar-bottle");
if (barBottle) {
  let frame = 0;
  let last = "";
  const update = () => {
    frame = 0;
    const scrollable = document.documentElement.scrollHeight - innerHeight;
    const value = (scrollable > 0 ? Math.min(1, Math.max(0, scrollY / scrollable)) : 1).toFixed(2);
    if (value !== last) barBottle.style.setProperty("--read", (last = value));
  };
  addEventListener("scroll", () => {
    if (!frame) frame = requestAnimationFrame(update);
    if (!reducedMotion.matches && !barBottle.classList.contains("is-rocking")) barBottle.classList.add("is-rocking");
  }, { passive: true });
  barBottle.addEventListener("animationend", () => barBottle.classList.remove("is-rocking"));
  addEventListener("resize", () => { if (!frame) frame = requestAnimationFrame(update); });
  update();
}

// 「天涯」一节的时差钟：访问者本地时间 vs 北京时间（B 站服务器所在，1991 年起不实行夏令时，固定 UTC+8）。
// 只用本机时区计算，不请求任何服务。每分钟整点刷新，文字不变就不写，避免无谓的重排。
const clock = document.querySelector(".clock");
if (clock) {
  const english = document.documentElement.lang === "en";
  const BEIJING_OFFSET = 480;
  const timeFormat = (timeZone) => new Intl.DateTimeFormat(english ? "en-GB" : "zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone });
  const dayFormat = (timeZone) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
  const fields = { local: clock.querySelector('[data-clock="local"]'), bilibili: clock.querySelector('[data-clock="bilibili"]'), note: clock.querySelector("[data-clock-note]") };
  const write = (element, text) => { if (element.textContent !== text) element.textContent = text; };
  const hoursText = (minutes) => {
    const hours = Math.abs(minutes) / 60;
    const number = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace(/\.0$/, "");
    return english ? `${number} hour${hours === 1 ? "" : "s"}` : `${number} 小时`;
  };
  const note = (now) => {
    const diff = BEIJING_OFFSET + now.getTimezoneOffset();
    const localDay = dayFormat(undefined).format(now);
    const beijingDay = dayFormat("Asia/Shanghai").format(now);
    let text;
    if (diff === 0) text = english ? "You're in the same time zone as Bilibili" : "你和 B 站在同一个时区";
    else if (english) text = `Bilibili is ${hoursText(diff)} ${diff > 0 ? "ahead of" : "behind"} you`;
    else text = `B 站那里比你${diff > 0 ? "快" : "慢"} ${hoursText(diff)}`;
    if (beijingDay > localDay) text += english ? ", already tomorrow there" : "，那边已经是明天了";
    if (beijingDay < localDay) text += english ? ", still yesterday there" : "，那边还是昨天";
    text += english ? "." : "。";
    // 深夜（本地 0–4 点）多一句：海外党看 B 站，经常就是这个钟点。
    if (now.getHours() < 5) text += english ? " Up late? The danmaku has night owls too." : "夜深了，弹幕里也有和你一样没睡的人。";
    return text;
  };
  const tick = () => {
    const now = new Date();
    write(fields.local, timeFormat(undefined).format(now));
    write(fields.bilibili, timeFormat("Asia/Shanghai").format(now));
    write(fields.note, note(now));
    setTimeout(tick, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
  };
  tick();
  clock.hidden = false;
}

// 「知己」一节：发一条自己的弹幕。只在本页飘过一次，不发请求、不写存储；文字一律走 textContent。
// 放进人最少的那条轨道；同时最多 6 条，再多就先移除最早的一条。
const danmakuForm = document.querySelector(".danmaku-send");
const danmakuBoard = document.querySelector(".danmaku");
if (danmakuForm && danmakuBoard) {
  const english = document.documentElement.lang === "en";
  const input = danmakuForm.querySelector("input");
  const status = danmakuForm.querySelector("[data-danmaku-status]");
  const lanes = [...danmakuBoard.querySelectorAll(".danmaku-lane")];
  danmakuForm.hidden = false;
  danmakuForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim().slice(0, 24);
    if (!text) return;
    const mine = [...danmakuBoard.querySelectorAll(".danmaku-mine")];
    if (mine.length >= 6) mine[0].remove();
    const counts = lanes.map((lane) => mine.filter((item) => item.dataset.lane === String(lanes.indexOf(lane))).length);
    const laneIndex = counts.indexOf(Math.min(...counts));
    const item = document.createElement("span");
    item.className = "danmaku-mine";
    item.dataset.lane = String(laneIndex);
    item.textContent = text;
    item.style.top = `${lanes[laneIndex].offsetTop}px`;
    danmakuBoard.append(item);
    if (reducedMotion.matches) {
      item.classList.add("is-static");
      setTimeout(() => item.remove(), 4000);
    } else {
      item.style.setProperty("--distance", `${danmakuBoard.clientWidth + item.offsetWidth}px`);
      item.addEventListener("animationend", () => item.remove());
    }
    input.value = "";
    status.textContent = english ? `Sent: ${text}. It only shows on your screen.` : `已发送：${text}。只在你的屏幕上飘过。`;
  });
}

// 「扔一只漂流瓶」：官网唯一会联网的地方，只连 data-api 指向的作者自己的服务器（server/bottles/）。
// - 滚到「知己」一节附近才去取计数，只看首屏的访客不产生任何请求；取不到就整节保持隐藏；
// - 请求不带 Cookie（credentials: omit），只发一个可选的预设标签；同 IP 每天一只由服务端判重；
// - 本机扔过就记在 localStorage（只存日期，读写都包 try/catch，隐私模式下失效也不影响页面），刷新后不再出按钮。
const bottles = document.querySelector(".bottles");
if (bottles?.dataset.api) {
  const english = document.documentElement.lang === "en";
  const STORAGE_KEY = "haineicunzhi.bottle";
  const total = bottles.querySelector("[data-bottles-total]");
  const unit = bottles.querySelector("[data-bottles-unit]");
  const tags = [...bottles.querySelectorAll(".bottles-tag")];
  const form = bottles.querySelector(".bottles-form");
  const throwButton = bottles.querySelector(".bottles-throw");
  const status = bottles.querySelector("[data-bottles-status]");
  const review = bottles.querySelector(".bottles-review");
  const fly = bottles.querySelector(".bottles-fly");
  const text = english ? {
    unit: (count) => (count === 1 ? "bottle has washed up here" : "bottles have washed up here"),
    empty: "No bottles yet. Be the first to throw one.",
    thrown: "Thrown",
    thanks: "Your bottle is out at sea. Thank you!",
    again: "You've already thrown one today. Thank you!",
    remembered: "You've thrown a bottle from this device. Thank you!",
    failed: "The bottle didn't make it out. Please try again later."
  } : {
    unit: () => "只瓶子已经漂到这里",
    empty: "还没有人扔过瓶子，做第一个吧。",
    thrown: "已经扔出去了",
    thanks: "瓶子已经漂出去了，谢谢你！",
    again: "今天已经扔过一只了，谢谢你！",
    remembered: "你在这台设备上扔过一只了，谢谢你！",
    failed: "瓶子没扔出去，稍后再试试。"
  };
  const readThrown = () => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } };
  const saveThrown = () => { try { localStorage.setItem(STORAGE_KEY, new Date().toISOString().slice(0, 10)); } catch { /* 存不下就只在本次页面里生效 */ } };
  const request = (init = {}) => fetch(bottles.dataset.api, { ...init, credentials: "omit", signal: AbortSignal.timeout(8000) })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((data) => (Number.isInteger(data?.total) && data.tags && typeof data.tags === "object" ? data : Promise.reject(new Error("bad payload"))));
  const format = (count) => count.toLocaleString(english ? "en-US" : "zh-CN");
  // 只改文字：按钮节点一直复用，焦点与按下状态不受计数刷新影响。
  const render = (data) => {
    total.textContent = format(data.total);
    unit.textContent = text.unit(data.total);
    if (data.total === 0 && !status.textContent) status.textContent = text.empty;
    for (const tag of tags) {
      const count = Number(data.tags[tag.dataset.tag]) || 0;
      tag.querySelector("[data-tag-count]").textContent = count ? format(count) : "";
    }
  };
  const finish = (message) => {
    throwButton.disabled = true;
    throwButton.textContent = text.thrown;
    for (const tag of tags) tag.disabled = true;
    status.textContent = message;
    review.hidden = false;
  };
  for (const tag of tags) {
    // 单选、可取消：再点一次已选的标签就是不带标签。
    tag.addEventListener("click", () => {
      const pressed = tag.getAttribute("aria-pressed") !== "true";
      for (const other of tags) other.setAttribute("aria-pressed", String(other === tag && pressed));
    });
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (throwButton.disabled) return;
    const tag = tags.find((item) => item.getAttribute("aria-pressed") === "true")?.dataset.tag;
    throwButton.disabled = true;
    throwButton.classList.add("is-pending");
    try {
      const data = await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tag ? { tag } : {}) });
      saveThrown();
      render(data);
      if (data.accepted && !reducedMotion.matches) {
        fly.classList.remove("is-flying");
        void fly.offsetWidth; // 重新触发一次性动画
        fly.classList.add("is-flying");
      }
      finish(data.accepted ? text.thanks : text.again);
    } catch {
      throwButton.disabled = false;
      status.textContent = text.failed;
    } finally {
      throwButton.classList.remove("is-pending");
    }
  });
  const load = () => request().then((data) => {
    render(data);
    bottles.hidden = false;
    if (readThrown()) finish(text.remembered);
  }).catch(() => { /* 接口不可用：整节保持隐藏，页面其他部分不受影响 */ });
  const friend = document.querySelector("#friend");
  if (friend && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: "0px 0px 400px 0px" });
    observer.observe(friend);
  } else {
    load();
  }
}

// 页尾靠岸：页尾还没进入视口时先把瓶子放回海里（.is-waiting），滚到页尾再推上岸，只播一次。
// 页尾一开始就在视口里（页面很矮）、不支持 IntersectionObserver 或减少动态时，瓶子直接在岸上。
const shore = document.querySelector(".shore");
if (shore && "IntersectionObserver" in window && !reducedMotion.matches) {
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    shore.classList.remove("is-waiting");
    observer.disconnect();
  }, { threshold: 0.6 });
  if (shore.getBoundingClientRect().top > innerHeight) shore.classList.add("is-waiting");
  observer.observe(shore);
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
