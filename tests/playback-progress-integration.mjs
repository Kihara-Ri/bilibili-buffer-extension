try {
  await import("../src/playback-observer.js");
  const internals = window.__biliBufferPlaybackAssistInternals;
  const video = internals.trackFor("https://a.bilivideo.com/path/video.m4s");
  video.size = 1000;
  internals.addRange(video.prefetchedRanges, 100, 300);
  internals.addRange(video.prefetchedRanges, 450, 700);

  const audio = internals.trackFor("https://a.bilivideo.com/path/audio.m4s");
  audio.size = 100;
  internals.addRange(audio.prefetchedRanges, 20, 35);
  internals.renderPreheatProgress();

  const layers = [...document.querySelectorAll(".bili-buffer-preheat-layer")];
  const firstSegments = [...layers[0].children];
  assert(layers.length === 2, "主进度条和影子进度条都应有预热层");
  assert(firstSegments.length === 2, "重叠的音视频预热区间应合并");
  assert(firstSegments[0].style.left === "10%", "第一个预热段起点不正确");
  assert(firstSegments[0].style.width === "25%", "第一个预热段宽度不正确");
  assert(getComputedStyle(layers[0]).pointerEvents === "none", "覆盖层不得拦截进度条拖动");
  assert(getComputedStyle(firstSegments[0]).backgroundColor !== "rgba(0, 0, 0, 0)", "预热段必须有可见颜色");

  show({
    ok: true,
    layers: layers.length,
    segmentsPerLayer: firstSegments.length,
    firstRange: { left: firstSegments[0].style.left, width: firstSegments[0].style.width },
    color: getComputedStyle(firstSegments[0]).backgroundColor,
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
