(() => {
  document.documentElement.dataset.biliBufferVersion = chrome.runtime.getManifest().version;
  let lastUrl = location.href;
  let activePlayback = null;

  void checkForCachedVideo();
  const locationTimer = setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    cleanupPlayback();
    void checkForCachedVideo();
  }, 1000);

  window.addEventListener("pagehide", () => {
    clearInterval(locationTimer);
    cleanupPlayback();
  }, { once: true });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "CACHE_READY") {
      void checkForCachedVideo();
      return false;
    }
    if (message?.type === "BILI_BUFFER_FETCH_PLAYURL") {
      fetchPlayurlFromPage(message.request)
        .then((payload) => sendResponse({ ok: true, payload: { ...payload, __fromBiliPage: true } }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    return false;
  });

  async function fetchPlayurlFromPage(request) {
    const bvid = String(request?.bvid || "");
    const cid = Number(request?.cid);
    const quality = Number(request?.quality);
    const fnval = String(request?.fnval || "4048");
    if (!/^BV[0-9A-Za-z]+$/.test(bvid) || !Number.isSafeInteger(cid) || cid <= 0) {
      throw new Error("播放地址参数无效");
    }
    if (!Number.isSafeInteger(quality) || quality <= 0 || quality > 127) {
      throw new Error("画质参数无效");
    }
    if (!["1", "4048"].includes(fnval)) throw new Error("播放格式参数无效");

    const endpoint = new URL("https://api.bilibili.com/x/player/playurl");
    endpoint.search = new URLSearchParams({
      bvid,
      cid: String(cid),
      qn: String(quality),
      fnver: "0",
      fnval,
      fourk: "1"
    });
    const response = await fetch(endpoint, {
      cache: "no-store",
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`播放地址请求失败（HTTP ${response.status}）`);
    return response.json();
  }

  async function checkForCachedVideo() {
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "GET_CACHED_FOR_URL",
        url: location.href
      });
      if (!response?.ok || response.video?.status !== "complete") return;
      if (activePlayback?.videoId === response.video.id) return;
      await startCachedPlayback(response.video);
    } catch (error) {
      console.warn("[Bili 缓冲站] 查询本地缓存失败", error);
    }
  }

  async function startCachedPlayback(cache) {
    const requestedUrl = location.href;
    const video = await waitForVideoElement();
    if (!video || location.href !== requestedUrl) return;

    document.documentElement.dataset.biliBufferPlayback = "loading";
    try {
      const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "GET_PLAYBACK_URL",
        videoId: cache.id
      });
      if (!response?.ok || (!response.playbackUrl && response.playback?.kind !== "dash")) {
        throw new Error(response?.error || "无法读取本地缓存");
      }
      if (location.href !== requestedUrl) return;
      if (response.playback?.kind === "dash") {
        await startDashPlayback(video, cache, response.playback);
        return;
      }
      const blobResponse = await fetch(response.playbackUrl);
      if (!blobResponse.ok) throw new Error("无法从扩展后台读取本地缓存");
      const blob = await blobResponse.blob();
      if (blob.size !== cache.totalBytes) throw new Error("本地缓存字节数校验失败");
      if (location.href !== requestedUrl) return;
      applyPlaybackUrl(video, cache, URL.createObjectURL(blob));
    } catch (error) {
      document.documentElement.dataset.biliBufferPlayback = "error";
      console.warn("[Bili 缓冲站] 本地缓存无法播放：", error);
    }
  }

  async function startDashPlayback(video, cache, playback) {
    const tracks = await Promise.all((playback.tracks || []).map(async (track) => {
      if (!track.url || !track.mimeCodec) throw new Error("本地 DASH 轨道信息不完整");
      if (!MediaSource.isTypeSupported(track.mimeCodec)) {
        throw new Error(`浏览器不支持缓存轨道：${track.mimeCodec}`);
      }
      const response = await fetch(track.url);
      if (!response.ok) throw new Error("无法从扩展后台读取本地 DASH 轨道");
      const blob = await response.blob();
      if (blob.size !== track.totalBytes) throw new Error("本地 DASH 轨道字节数校验失败");
      return { ...track, buffer: await blob.arrayBuffer() };
    }));
    if (!tracks.some((track) => track.name === "video")) throw new Error("本地 DASH 视频轨缺失");

    const mediaSource = new MediaSource();
    const playbackUrl = URL.createObjectURL(mediaSource);
    const sourceOpen = waitForEvent(mediaSource, "sourceopen", "本地媒体容器无法打开");
    applyPlaybackUrl(video, cache, playbackUrl);
    await sourceOpen;
    if (Number(cache.duration) > 0) mediaSource.duration = Number(cache.duration);
    await Promise.all(tracks.map((track) => appendTrack(mediaSource, track)));
    if (mediaSource.readyState === "open") mediaSource.endOfStream();
  }

  function waitForEvent(target, eventName, errorMessage) {
    return new Promise((resolve, reject) => {
      const onSuccess = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(errorMessage));
      };
      const cleanup = () => {
        target.removeEventListener(eventName, onSuccess);
        target.removeEventListener("error", onError);
      };
      target.addEventListener(eventName, onSuccess, { once: true });
      target.addEventListener("error", onError, { once: true });
    });
  }

  function appendTrack(mediaSource, track) {
    return new Promise((resolve, reject) => {
      let sourceBuffer;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(track.mimeCodec);
      } catch (error) {
        reject(error);
        return;
      }
      const onUpdateEnd = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`${track.name === "video" ? "视频" : "音频"}轨无法加入本地播放器`));
      };
      const cleanup = () => {
        sourceBuffer.removeEventListener("updateend", onUpdateEnd);
        sourceBuffer.removeEventListener("error", onError);
      };
      sourceBuffer.addEventListener("updateend", onUpdateEnd, { once: true });
      sourceBuffer.addEventListener("error", onError, { once: true });
      sourceBuffer.appendBuffer(new Uint8Array(track.buffer));
    });
  }

  function applyPlaybackUrl(video, cache, playbackUrl) {
    const previous = {
      time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      paused: video.paused,
      muted: video.muted,
      volume: video.volume,
      rate: video.playbackRate
    };

    video.pause();
    video.src = playbackUrl;
    video.dataset.biliCachePlayback = "local";
    video.load();
    video.addEventListener("loadedmetadata", () => {
      document.documentElement.dataset.biliBufferPlayback = "local";
      video.currentTime = Math.min(previous.time, Math.max(0, video.duration - 0.1));
      video.muted = previous.muted;
      video.volume = previous.volume;
      video.playbackRate = previous.rate;
      if (!previous.paused) video.play().catch(() => {});
      chrome.runtime.sendMessage({ target: "background", type: "PLAYBACK_ACTIVE" }).catch(() => {});
      console.info(`[Bili 缓冲站] 已切换为本地缓存播放：${cache.title}`);
    }, { once: true });

    video.addEventListener("error", () => {
      document.documentElement.dataset.biliBufferPlayback = "error";
      delete video.dataset.biliCachePlayback;
      console.warn("[Bili 缓冲站] 本地缓存播放失败，页面刷新后将恢复网络播放");
    }, { once: true });

    activePlayback = { videoId: cache.id, objectUrl: playbackUrl, video };
  }

  function waitForVideoElement(timeout = 20000) {
    const existing = document.querySelector("video");
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        const found = document.querySelector("video");
        if (!found) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(found);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  function cleanupPlayback() {
    if (activePlayback?.objectUrl) URL.revokeObjectURL(activePlayback.objectUrl);
    activePlayback = null;
  }
})();
