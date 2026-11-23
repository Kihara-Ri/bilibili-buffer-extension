try {
  const video = document.querySelector("#test-video");
  let buffered = [[0, 35], [60, 65]];
  Object.defineProperties(video, {
    duration: { configurable: true, writable: true, value: 100 },
    currentTime: { configurable: true, writable: true, value: 25 },
    paused: { configurable: true, value: false },
    ended: { configurable: true, value: false },
    buffered: { configurable: true, get: () => ({ length: buffered.length, start: i => buffered[i][0], end: i => buffered[i][1] }) }
  });
  const root = document.querySelector(".bpx-player-progress");
  const schedules = [...document.querySelectorAll(".bpx-player-progress-schedule")];
  const currents = schedules.map(el => el.querySelector(".bpx-player-progress-schedule-current"));
  currents.forEach((el, i) => el.style.transform = `scaleX(${[5 / 6, 0, 0, .25][i]})`);
  const tv = root.querySelector(".bpx-player-progress-thumb");
  let nativeEvents = 0;
  tv.addEventListener("click", () => nativeEvents++);
  tv.addEventListener("keydown", () => nativeEvents++);
  const elements = [...root.querySelectorAll("*"), root];
  const geometry = el => {
    const css = getComputedStyle(el), rect = el.getBoundingClientRect();
    const opacity = el.matches(".bpx-player-progress-schedule-buffer") ? null : css.opacity;
    return JSON.stringify([rect.x, rect.y, rect.width, rect.height, css.transform, css.visibility, opacity, css.zIndex, css.pointerEvents, css.borderRadius, css.backgroundSize]);
  };
  const original = elements.map(geometry);
  const tvAppearance = tv.getAttribute("style");
  const emptyColor = getComputedStyle(schedules[0]).backgroundColor;
  const bufferColor = getComputedStyle(schedules[0].querySelector(".bpx-player-progress-schedule-buffer")).backgroundColor;
  // 此夹具专测绘制和原生交互；缓存/索引/真实 MSE 播放在独立集成测试验证。
  let prefetched = [[10, 50], [62, 80]];
  window.__biliBufferCache = {
    index: url => ({ role: url.includes("audio") ? "audio" : "video" }),
    timeRanges: () => prefetched, install() {}, clear() {}, stats: {}
  };
  await import("../src/playback-network.js");
  await import("../src/playback-observer.js");
  const internals = window.__biliBufferPlaybackAssistInternals;
  const media = internals.trackFor("https://a.bilivideo.com/path/video.mp4");
  internals.trackFor("https://a.bilivideo.com/path/audio.m4s");
  media.size = 1000;
  internals.renderPreheatProgress();
  assert(!document.querySelector(".bili-buffer-timeline, .bili-buffer-timeline-marker, .bili-buffer-preheat-layer"), "不能增加替代时间轴、指示器或覆盖层");
  assert(elements.every((el, i) => geometry(el) === original[i]), "原生布局、变换和可见性必须保持不变");
  assert(root.querySelector(".bpx-player-progress-thumb") === tv && tv.getAttribute("style") === tvAppearance, "必须保留原生小电视节点和样式");
  assert(getComputedStyle(schedules[0]).backgroundColor === emptyColor, "未缓冲底色保持原生");
  assert(getComputedStyle(currents[0]).backgroundColor === "rgb(0, 161, 214)", "已播放默认蓝色");
  const shadow = schedules.at(-1);
  const shadowBuffer = shadow.querySelector(".bpx-player-progress-schedule-buffer");
  const fill = () => shadow.style.getPropertyValue("--bili-buffer-state-fill");
  const mask = () => shadow.style.getPropertyValue("--bili-buffer-preheat-mask");
  const preheatColor = internals.cfg.preheatColor;
  const nativeFill = internals.timelineGradient([[0, .35], [.60, .65]], bufferColor);
  const mixedFill = internals.timelineGradient([[0, .10], [.10, .35, preheatColor], [.60, .62], [.62, .65, preheatColor]], bufferColor);
  assert(fill() === mixedFill && mixedFill.includes(`${preheatColor} 10%, ${preheatColor} 35%`),
    "插件预取段进入播放器后保留纯色橙条，普通缓冲保留灰色");
  assert(fill().includes("transparent 35%, transparent 60%"), "尚未进入播放器的 35–50 秒不能填成灰条");
  assert(mask().includes("black 35%, black 50%") && mask().includes("black 65%, black 80%"), "已下载但未入播放器的部分单独标记");
  assert(getComputedStyle(shadow, "::before").backgroundImage.includes("repeating-linear-gradient"), "预取区通过斜线区分");
  assert(schedules[1].hasAttribute("data-bili-buffer-preheat"), "章节进度条也显示预取区");
  buffered = [[0, 50], [60, 80]];
  internals.cfg.preheatColor = "#00d08f";
  internals.renderPreheatProgress();
  const fullyAppended = internals.timelineGradient([[0, .10], [.10, .50, "#00d08f"], [.60, .62], [.62, .80, "#00d08f"]], bufferColor);
  assert(fill() === fullyAppended && !mask() && !shadow.hasAttribute("data-bili-buffer-preheat"),
    "音视频都进入播放器后斜线全部转为实色，并遵守自定义配色");
  buffered = [[0, 35], [60, 65]];
  internals.cfg.showPreheatHighlight = false;
  internals.renderPreheatProgress();
  assert(fill() === nativeFill && !mask(), "关掉预取提示时只绘制真实的播放器缓冲");
  internals.cfg.progressColor = "#20c997";
  internals.renderPreheatProgress();
  assert(getComputedStyle(currents[0]).backgroundColor === "rgb(32, 201, 151)", "允许修改已播放颜色");
  tv.click();
  tv.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert(nativeEvents === 2, "原生事件仍正常接收");
  assert(video.currentTime === 25, "插件不得自行修改播放位置");
  currents[0].style.transform = "scaleX(.9)";
  tv.style.left = "162px";
  internals.renderPreheatProgress();
  assert(currents[0].style.transform === "scaleX(0.9)" && tv.style.left === "162px", "原生动态指示器定位不被改写");
  video.duration = NaN;
  internals.renderPreheatProgress();
  const empty = "linear-gradient(to right, transparent 0%, transparent 100%)";
  assert(fill() === empty && !mask(), "原播放器换源、元数据未到时清除缓冲配色");
  video.remove();
  internals.renderPreheatProgress();
  assert(!shadow.hasAttribute("data-bili-buffer-paint") && getComputedStyle(shadowBuffer).opacity === "1", "找不到视频时恢复原生控件");
  document.body.prepend(video);
  video.duration = 100;
  internals.cfg.showPreheatHighlight = true;
  prefetched = [];
  internals.renderPreheatProgress();
  assert(shadow.hasAttribute("data-bili-buffer-paint") && getComputedStyle(shadowBuffer).opacity === "0",
    "插件范围回收后，不能恢复连成一片的站点灰条");
  assert(fill() === nativeFill,
    "实际缓冲的两个孤岛之间必须留空，原生连续灰块会让用户点到未缓冲的时间");
  buffered = [];
  internals.renderPreheatProgress();
  assert(fill() === empty,
    "浏览器清空 SourceBuffer 后不能继续显示旧灰条");
  show({ ok: true, nativeTvPreserved: true, nativeGeometryPreserved: true, nativeEventsPreserved: true,
    nativeBufferGapsPreserved: true, prefetchDisplayedSeparately: true, promotedPrefetchRetainsColor: true, evictedBufferCleared: true });
} catch (error) { show({ ok: false, error: error.stack || error.message }); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function show(value) { document.querySelector("#result").textContent = JSON.stringify(value, null, 2); }
