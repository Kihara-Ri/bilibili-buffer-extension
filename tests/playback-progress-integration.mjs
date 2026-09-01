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
  const firstSegments = [...layers[0].querySelectorAll(".bili-buffer-preheat-segment")];
  const boundaries = [...document.querySelectorAll(".bili-buffer-playback-boundary")];
  assert(layers.length === 2, "主进度条和影子进度条都应有预热层");
  assert(firstSegments.length === 2, "音视频共同预热的两段交集应保留");
  assert(firstSegments[0].style.left === "20%", "第一个双轨预热段起点不正确");
  assert(firstSegments[0].style.width === "10%", "第一个双轨预热段宽度不正确");
  assert(getComputedStyle(layers[0]).pointerEvents === "none", "覆盖层不得拦截进度条拖动");
  assert(getComputedStyle(firstSegments[0]).backgroundColor === "rgb(255, 138, 31)", "默认预热段应使用纯橙色");
  assert(getComputedStyle(firstSegments[0]).boxShadow === "none", "预热色块顶部不应再有浅色内阴影");
  assert(boundaries.length === 2, "主进度条和影子进度条都应有播放分界线");
  assert(boundaries[0].classList.contains("is-visible"), "播放边缘接入预热片段时应显示白色分界");
  assert(boundaries[0].style.transform.includes("25%"), "白色分界没有跟随当前播放位置");
  assert(getComputedStyle(boundaries[0]).borderLeftColor !== "rgba(0, 0, 0, 0)", "播放分界线必须可见");
  assert(document.querySelector("#bili-buffer-preheat-progress-style").textContent.includes(":hover"), "进度条交互时应隐藏白色分界");

  show({
    ok: true,
    layers: layers.length,
    segmentsPerLayer: firstSegments.length,
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
