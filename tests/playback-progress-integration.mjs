try {
  const playback = document.querySelector("#test-video");
  Object.defineProperties(playback, {
    duration: { configurable: true, value: 100 },
    currentTime: { configurable: true, writable: true, value: 25 },
    paused: { configurable: true, value: false },
    ended: { configurable: true, value: false }
  });
  await import("../src/playback-observer.js");
  const internals = window.__biliBufferPlaybackAssistInternals;
  internals.cfg.preheatColor = "#ff8a1f";
  const video = internals.trackFor("https://a.bilivideo.com/path/video.m4s");
  video.size = 1000;
  internals.addRange(video.prefetchedRanges, 100, 300);
  internals.addRange(video.prefetchedRanges, 450, 700);

  const audio = internals.trackFor("https://a.bilivideo.com/path/audio.m4s");
  audio.size = 100;
  internals.addRange(audio.prefetchedRanges, 20, 35);
  internals.addRange(audio.prefetchedRanges, 50, 75);
  internals.renderPreheatProgress();
  internals.updatePlaybackBoundary();

  const layers = [...document.querySelectorAll(".bili-buffer-preheat-layer")];
  const mainSchedules = [...document.querySelectorAll(".bpx-player-progress.segmented .bpx-player-progress-schedule")];
  const mainLayers = mainSchedules.map((schedule) => schedule.querySelector(".bili-buffer-preheat-layer"));
  const firstSegments = [...mainLayers[0].querySelectorAll(".bili-buffer-preheat-segment")];
  const secondSegments = [...mainLayers[1].querySelectorAll(".bili-buffer-preheat-segment")];
  const boundaries = [...document.querySelectorAll(".bili-buffer-playback-boundary")];
  assert(layers.length === 3, "分段主进度条只应在两个相交子段绘制，影子进度条保留一层");
  assert(firstSegments.length === 1, "第一子段不应重复全片的两段预热范围");
  assert(secondSegments.length === 1, "第二子段不应重复全片的两段预热范围");
  assert(mainLayers[2] === null, "没有预热交集的第三子段不应出现色块或播放标记");
  assert(Math.abs(parseFloat(firstSegments[0].style.left) - (200 / 3)) < 0.001, "第一全片范围没有换算到第一子段坐标");
  assert(Math.abs(parseFloat(firstSegments[0].style.width) - (100 / 3)) < 0.001, "第一子段色块宽度不正确");
  assert(secondSegments[0].style.left === "50%", "第二全片范围没有换算到第二子段坐标");
  assert(secondSegments[0].style.width === "50%", "第二子段色块宽度不正确");
  assert(getComputedStyle(layers[0]).pointerEvents === "none", "覆盖层不得拦截进度条拖动");
  assert(getComputedStyle(firstSegments[0]).backgroundColor === "rgb(255, 138, 31)", "默认预热段应使用纯橙色");
  assert(getComputedStyle(firstSegments[0]).boxShadow === "none", "预热色块顶部不应再有浅色内阴影");
  assert(boundaries.length === 3, "只在有预热交集的主子段和影子进度条创建播放分界");
  assert(mainLayers[0].querySelector(".bili-buffer-playback-boundary").classList.contains("is-visible"), "当前子段应显示播放分界");
  assert(!mainLayers[1].querySelector(".bili-buffer-playback-boundary").classList.contains("is-visible"), "非当前子段不应重复显示播放分界");
  assert(Math.abs(parseFloat(mainLayers[0].querySelector(".bili-buffer-playback-boundary").style.transform.match(/\(([-\d.]+)%/)[1]) - (250 / 3)) < 0.001, "播放分界没有换算到第一子段坐标");
  assert(getComputedStyle(boundaries[0]).borderLeftColor !== "rgba(0, 0, 0, 0)", "播放分界线必须可见");
  assert(document.querySelector("#bili-buffer-preheat-progress-style").textContent.includes(":hover"), "进度条交互时应隐藏白色分界");

  show({
    ok: true,
    layers: layers.length,
    mainSegmentsPerLayer: mainLayers.map((layer) => layer?.querySelectorAll(".bili-buffer-preheat-segment").length || 0),
    firstRange: { left: firstSegments[0].style.left, width: firstSegments[0].style.width },
    color: getComputedStyle(firstSegments[0]).backgroundColor,
    boxShadow: getComputedStyle(firstSegments[0]).boxShadow,
    boundary: {
      count: boundaries.length,
      transform: boundaries[0].style.transform,
      color: getComputedStyle(boundaries[0]).borderLeftColor
    },
    pointerEvents: getComputedStyle(layers[0]).pointerEvents
  });
} catch (error) {
  show({ ok: false, error: error.stack || error.message });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function show(value) {
  document.querySelector("#result").textContent = JSON.stringify(value, null, 2);
}
