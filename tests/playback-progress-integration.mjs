try {
  const video = document.querySelector("#test-video");
  Object.defineProperties(video, {
    duration: { configurable: true, writable: true, value: 100 },
    currentTime: { configurable: true, writable: true, value: 25 },
    paused: { configurable: true, value: false },
    ended: { configurable: true, value: false },
    buffered: { configurable: true, get: () => ({ length: 2, start: i => [0, 60][i], end: i => [35, 65][i] }) }
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
    return JSON.stringify([rect.x, rect.y, rect.width, rect.height, css.transform, css.visibility, css.opacity, css.zIndex, css.pointerEvents, css.borderRadius, css.backgroundSize]);
  };
  const original = elements.map(geometry);
  const tvAppearance = tv.getAttribute("style");
  const emptyColor = getComputedStyle(schedules[0]).backgroundColor;
  const bufferColor = getComputedStyle(schedules[0].querySelector(".bpx-player-progress-schedule-buffer")).backgroundColor;
  // 此夹具专测绘制和原生交互；缓存/索引/真实 MSE 播放在独立集成测试验证。
  window.__biliBufferCache = {
    index: url => ({ role: url.includes("audio") ? "audio" : "video" }),
    timeRanges: () => [[10, 50], [62, 80]], install() {}, clear() {}, stats: {}
  };
  await import("../src/playback-observer.js");
  const internals = window.__biliBufferPlaybackAssistInternals;
  const media = internals.trackFor("https://a.bilivideo.com/path/video.mp4");
  internals.trackFor("https://a.bilivideo.com/path/audio.m4s");
  media.size = 1000;
  internals.addRange(media.prefetchedRanges, 100, 800);
  internals.renderPreheatProgress();
  assert(!document.querySelector(".bili-buffer-timeline, .bili-buffer-timeline-marker, .bili-buffer-preheat-layer"), "不能增加替代时间轴、指示器或覆盖层");
  assert(elements.every((el, i) => geometry(el) === original[i]), "原生布局、变换和可见性必须保持不变");
  assert(root.querySelector(".bpx-player-progress-thumb") === tv && tv.getAttribute("style") === tvAppearance, "必须保留原生小电视节点和样式");
  assert(getComputedStyle(schedules[0]).backgroundColor === emptyColor, "未缓冲底色保持原生");
  assert(getComputedStyle(currents[0]).backgroundColor === "rgb(0, 161, 214)", "已播放默认蓝色");
  const paint = schedules[1].style.getPropertyValue("--bili-buffer-state-fill");
  assert(schedules[2].style.getPropertyValue("--bili-buffer-state-fill").includes(bufferColor) || paint.includes(bufferColor), "非插件缓冲沿用原生配色");
  assert(paint.includes("#ff8a1f"), "插件缓冲可区分");
  internals.cfg.showPreheatHighlight = false;
  internals.renderPreheatProgress();
  const merged = schedules[1].style.getPropertyValue("--bili-buffer-state-fill");
  assert(!merged.includes("#ff8a1f") && merged.includes(bufferColor), "关闭区分将插件范围染为原生灰色");
  assert(merged.split(bufferColor).length > paint.split(bufferColor).length, "插件缓冲保留并合并显示，不是隐藏");
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
  assert(!schedules[0].hasAttribute("data-bili-buffer-paint"), "媒体无效时撤销缓冲配色");
  assert(getComputedStyle(schedules[0].querySelector(".bpx-player-progress-schedule-buffer")).backgroundColor === bufferColor, "原生缓冲底色恢复");
  video.duration = 100;
  internals.cfg.showPreheatHighlight = true;
  internals.renderPreheatProgress();
  show({ ok: true, nativeTvPreserved: true, nativeGeometryPreserved: true, nativeEventsPreserved: true, nativeEmptyAndBufferColors: true, mergedPluginBuffer: true });
} catch (error) { show({ ok: false, error: error.stack || error.message }); }
function assert(condition, message) { if (!condition) throw new Error(message); }
function show(value) { document.querySelector("#result").textContent = JSON.stringify(value, null, 2); }
