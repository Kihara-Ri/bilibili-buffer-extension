(() => {
  const CONFIG_KEY = "playbackAssistConfigV1";
  const QUALITY_WAIT_MS = 8000;
  const QUALITY_MENU = ".bpx-player-ctrl-quality";
  const QUALITY_OPTION = ".bpx-player-ctrl-quality-menu-item[data-value]";
  const QUALITY_LABEL = ".bpx-player-ctrl-quality-result";
  const QUALITY_TEXT = ".bpx-player-ctrl-quality-text";
  let bufferMode = null;
  let configRevision = 0;
  let session;
  let locationTimer;
  let qualityMenu;
  const qualityObserver = new MutationObserver(onPlayerQualityChanged);
  const markReady = () => {
    document.documentElement.dataset.biliBufferVersion = chrome.runtime.getManifest().version;
    document.documentElement.dataset.biliBufferContentReady = "2.5.0";
  };
  if (document.documentElement) markReady();
  else document.addEventListener("DOMContentLoaded", markReady, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) queueCacheLookup(session);
  });
  document.addEventListener("bili-buffer-site-quality", onPlayerQualityChanged);
  document.addEventListener("click", event => {
    const current = session;
    if (!current || !isCurrent(current)) return;
    const item = event.target?.closest?.(QUALITY_OPTION);
    const menu = item?.closest(QUALITY_MENU);
    const quality = Number(item?.dataset.value);
    if (!menu || menu !== playerQualityMenu(current) || !validPlayerQuality(quality, 0) || !isSelectableQuality(item)) return;
    if (selectedPlayerQuality(menu) === quality && !current.qualitySwitch && (!quality || siteQuality(current) === quality)) return;
    // 菜单由站点确认。点击到确认之间，旧下载即使恰好完成，也先不接管播放器。
    current.qualityChangedAt = current.popupQualitySelectedAt ?? performance.timeOrigin + performance.now();
    current.popupQualitySelectedAt = undefined;
    current.qualitySwitch = { quality, confirmed: false, expiresAt: Date.now() + QUALITY_WAIT_MS };
    current.nativeSizeWait = null;
    if (current.manualTask?.quality !== quality) current.manualTask = null;
    observeQualityMenu();
    queueCacheLookup(current);
  }, true);
  for (const type of ["resize", "loadeddata"]) document.addEventListener(type, event => {
    if (session?.nativeSizeWait && event.target === document.querySelector("video")) queueCacheLookup(session);
  }, true);
  document.addEventListener("loadedmetadata", event => {
    if (event.target !== document.querySelector("video")) return;
    syncPage();
    if (!session?.watchLaterId) return;
    session.watchLaterMetadata = event.target;
    onPlayerQualityChanged();
  }, true);
  window.addEventListener("online", () => queueCacheLookup(session));
  window.navigation?.addEventListener("currententrychange", syncPage);
  window.addEventListener("pagehide", () => {
    clearInterval(locationTimer);
    endSession();
  });
  // BFCache 恢复的是旧脚本实例，需要重新开始监听和查库。
  window.addEventListener("pageshow", event => { if (event.persisted) watchPage(); });
  watchPage();
  // 查库等配置到达后再开始。播放与缓存独立，读取配置期间仍可开播。
  const configDeadline = setTimeout(() => { if (bufferMode === null) applyBufferConfig(); }, 450);
  chrome.storage.local.get(CONFIG_KEY).then(values => {
    if (configRevision === 0) applyBufferConfig(values?.[CONFIG_KEY]);
  }, () => {
    if (bufferMode === null) applyBufferConfig();
  }).finally(() => clearTimeout(configDeadline));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CONFIG_KEY]) return;
    configRevision++;
    applyBufferConfig(changes[CONFIG_KEY].newValue);
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "CACHE_READY") {
      syncPage();
      queueCacheLookup(session);
      return false;
    }
    if (["BILI_BUFFER_GET_CACHE_PLAYER", "BILI_BUFFER_SET_PLAYER_QUALITY", "BILI_BUFFER_TRACK_MANUAL_CACHE"].includes(message?.type)) {
      syncPage();
      const current = session;
      if (sender.id !== chrome.runtime.id || !current ||
          typeof message.url !== "string" || pageKey(message.url) !== current.key) {
        sendResponse({});
        return false;
      }
      if (message.type === "BILI_BUFFER_GET_CACHE_PLAYER") {
        sendResponse(readPlayerQuality(current, message.includeSources));
      } else if (message.type === "BILI_BUFFER_SET_PLAYER_QUALITY") {
        changePlayerQuality(current, message.quality, message.selectedAt).then(sendResponse, () => sendResponse({}));
        return true;
      } else if (message.playbackAt >= (current.qualityChangedAt || 0) &&
          (!current.manualTask || message.playbackAt >= current.manualTask.playbackAt)) {
        // 晚返回的旧画质启动请求不能替换本页最后一次手动保存。
        current.manualTask = { id: message.videoId, createdAt: message.createdAt, quality: Number(message.quality),
          followPlayer: message.followPlayer === true, playbackAt: message.playbackAt };
        queueCacheLookup(current);
      }
      if (message.type === "BILI_BUFFER_TRACK_MANUAL_CACHE") sendResponse({});
      return false;
    }
    if (message?.type === "BILI_BUFFER_CONFIRM_CACHE_QUALITY") {
      // 后台查完 CID 后再次确认页面和画质，拒绝切换分 P 或清晰度前发出的请求。
      const confirmed = Boolean(session && isCurrent(session) && isFull(session) && !document.hidden &&
        pageKey(message.url) === session.key && siteQuality(session) === message.quality);
      sendResponse({ confirmed, sourcePaths: confirmed ? readPlayerSourcePaths() : undefined });
      return false;
    }
    if (message?.type === "BILI_BUFFER_FETCH_PLAYURL") {
      fetchPlayurlFromPage(message.request)
        .then((payload) => sendResponse({ ok: true, payload }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    return false;
  });

  function readPlayerSourcePaths() {
    document.dispatchEvent(new Event("bili-buffer-request-source-selection"));
    const data = document.documentElement?.dataset;
    return { video: data?.biliBufferSourceVideo, audio: data?.biliBufferSourceAudio };
  }

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

  function watchPage() {
    syncPage();
    locationTimer = setInterval(() => {
      syncPage();
      observeQualityMenu();
      onPlayerQualityChanged();
      // 相同缓存可由多个标签共用。以记录为准，而不是依赖 CACHE_READY 恰好发给此标签。
      if (session && isFull(session) && (session.autoTask || session.waitingForQuality || session.nativeSizeWait) &&
          !session.ready && !session.autoFailed) {
        queueCacheLookup(session);
      }
    }, 1000);
  }

  function pageKey(input = location.href) {
    const url = new URL(input);
    return [url.pathname.replace(/\/+$/, ""), url.searchParams.get("bvid") || watchLaterVideoId(url),
      url.searchParams.get("p") || "1"].join("\n");
  }

  function watchLaterVideoId(url) {
    if (!/\/list\/watchlater\/?$/.test(url.pathname)) return null;
    return url.searchParams.get("bvid") || (url.searchParams.has("oid") ? "av" + url.searchParams.get("oid") : null);
  }

  function syncPage() {
    const key = pageKey();
    if (session?.key === key) return;
    const previousWatchLaterPlayer = session?.watchLaterPlayer;
    endSession();
    session = { key, url: location.href, mode: bufferMode, controller: new AbortController(), failed: new Map(),
      watchLaterId: watchLaterVideoId(new URL(location.href)), previousWatchLaterPlayer };
    observeQualityMenu();
    if (isFull(session)) paintFull(session, "caching");
    if (bufferMode !== null) queueCacheLookup(session);
  }

  function endSession() {
    if (!session) return;
    session.controller.abort();
    clearFullNotice(session);
    releasePlayback(session);
    session = null;
    observeQualityMenu();
    const root = document.documentElement;
    if (root) {
      delete root.dataset.biliBufferPlayback;
      delete root.dataset.biliBufferFull;
    }
  }

  function applyBufferConfig(config) {
    let next = "adaptive";
    if (["off", "observe"].includes(config?.mode)) next = "off";
    else if (["full-speed", "complete", "complete-before-play"].includes(config?.bufferMode)) next = "full-speed";
    if (next === bufferMode) return;
    bufferMode = next;
    const current = session;
    if (!current) return;
    current.mode = bufferMode;
    observeQualityMenu();
    if (isFull(current)) {
      if (current.playback && ownsSource(current.playback)) { current.ready = true; paintFull(current, "ready"); }
      else paintFull(current, current.autoFailed ? "error" : "caching");
    } else {
      clearFullNotice(current);
      if (document.documentElement) delete document.documentElement.dataset.biliBufferFull;
    }
    queueCacheLookup(current);
  }

  function isFull(current) {
    return current.mode === "full-speed";
  }

  function observeQualityMenu() {
    const menu = session && (isFull(session) || session.qualitySwitch) ? document.querySelector(QUALITY_MENU) : null;
    if (menu === qualityMenu) return;
    qualityObserver.disconnect();
    qualityMenu = menu;
    if (menu) qualityObserver.observe(menu, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "data-value"]
    });
  }

  function onPlayerQualityChanged() {
    const current = session;
    if (!current || (!current.watchLaterId && !tracksSelectedQuality(current)) || !isCurrent(current)) return;
    if (isFull(current)) reflectLocalQuality(current);
    const quality = siteQuality(current);
    if (quality !== (current.observedQuality || 0)) {
      current.observedQuality = quality;
      if (tracksSelectedQuality(current)) queueCacheLookup(current);
    }
  }

  function reflectLocalQuality(current) {
    const attachment = current.playback;
    if (!current.ready || current.qualitySwitch || !attachment?.menuLabel ||
        attachment.video !== document.querySelector("video") || !ownsSource(attachment)) return;
    const menu = document.querySelector(QUALITY_MENU);
    if (!menu) return;
    const options = [...menu.querySelectorAll(QUALITY_OPTION)];
    const active = options.find(option => Number(option.dataset.value) === attachment.quality);
    if (!active) return;
    // 仅同步本地播放的显示。不要模拟点击，否则站点会把回写误当作新的换流请求。
    for (const option of options) {
      const selected = option === active;
      if (option.classList.contains("bpx-state-active") !== selected) option.classList.toggle("bpx-state-active", selected);
    }
    const label = qualityLabelNode(menu);
    if (label && !label.childElementCount && label.textContent !== attachment.menuLabel) label.textContent = attachment.menuLabel;
  }

  function qualityLabelNode(menu) {
    const label = menu?.querySelector(QUALITY_LABEL);
    return label?.querySelector(".bpx-player-ctrl-quality-result-name") || label;
  }

  function clearFullNotice(current) {
    current.fullUi?.panel.remove();
    current.fullUi = null;
  }

  function paintFull(current, phase) {
    if ((!isFull(current) && !current.manualTask) || !isCurrent(current) || !document.documentElement) return;
    const { dataset } = document.documentElement;
    if (dataset.biliBufferFull !== phase) dataset.biliBufferFull = phase;
    // 弹窗仍需要当前阶段，进度由工具栏徽标提供。页面只在异常或需要一次播放手势时显示提示。
    const needsPlay = phase === "ready" && current.localPlayBlocked;
    if (phase !== "error" && !needsPlay) {
      clearFullNotice(current);
      return;
    }
    if (!document.body) return;
    if (!current.fullUi) {
      const panel = document.createElement("aside");
      panel.className = "bili-buffer-full-status";
      const label = document.createElement("span");
      label.setAttribute("role", "status");
      const play = document.createElement("button");
      play.type = "button";
      play.textContent = chrome.i18n.getMessage("fullBufferPlayLocal");
      play.addEventListener("click", () => {
        if (!current.ready) return;
        void document.querySelector("video")?.play().then(() => {
          current.localPlayBlocked = false;
          paintFull(current, "ready");
        }, () => {});
      });
      panel.append(label, play);
      document.body.append(panel);
      current.fullUi = { panel, label, play };
    }
    const { label, play } = current.fullUi;
    const text = chrome.i18n.getMessage(needsPlay ? "fullBufferReady" : "fullBufferFailed");
    if (label.textContent !== text) label.textContent = text;
    play.toggleAttribute("hidden", !needsPlay);
  }

  function isCurrent(current) {
    return session === current && current.key === pageKey() && !current.controller.signal.aborted;
  }

  function cacheVersion(cache) {
    return cache.runStartedAt || cache.completedAt || cache.updatedAt || 0;
  }

  function queueCacheLookup(current) {
    if (!current || current.mode === null || !isCurrent(current)) return;
    if (current.lookup) { current.recheck = true; return; }
    current.lookup = checkForCachedVideo(current).finally(() => {
      current.lookup = null;
      if (!current.recheck || !isCurrent(current)) return;
      current.recheck = false;
      queueCacheLookup(current);
    });
  }

  function requestBackground(type, fields, signal, onLateReply) {
    // Chrome 消息无法主动撤销；页面取消或超时后，迟到的结果只能被丢弃。
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      let settled = false;
      const done = (finish, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        finish(value);
      };
      const abort = () => done(reject, signal.reason);
      const timer = setTimeout(() => done(reject, new Error("缓存后台没有及时响应")), 30_000);
      signal.addEventListener("abort", abort, { once: true });
      chrome.runtime.sendMessage({ target: "background", type, ...fields })
        .then(value => settled ? onLateReply?.(value) : done(resolve, value), error => done(reject, error));
    });
  }

  async function checkForCachedVideo(current) {
    const { signal } = current.controller;
    const full = isFull(current);
    const manual = full ? null : current.manualTask;
    const quality = tracksSelectedQuality(current) ? siteQuality(current) : 0;
    if (manual?.followPlayer && quality !== manual.quality && (quality || navigator.onLine)) return;
    if (!quality && (current.qualitySwitch?.confirmed === false || (full && navigator.onLine))) {
      current.waitingForQuality = true;
      paintFull(current, "waiting-quality");
      return;
    }
    current.waitingForQuality = false;
    if (full && quality && current.selectedQuality !== quality) {
      // 暂停或错误只属于原档位。旧任务继续由片库管理，页面跟踪新选择的任务与就绪状态。
      current.selectedQuality = quality;
      current.autoTask = null;
      current.autoFailed = false;
      current.localPlayBlocked = false;
      current.nativeSizeWait = null;
      current.ready = false;
    }
    if (current.nativeSizeWait && navigator.onLine &&
        !matchesVideoSize(document.querySelector("video"), current.nativeSizeWait)) return;
    current.nativeSizeWait = null;
    const attachment = current.playback;
    if (full && current.ready && attachment && (!quality || attachment.quality === quality) &&
        attachment.video === document.querySelector("video") && ownsSource(attachment)) return;
    let cache;
    let leaseId;
    try {
      const task = full ? current.autoTask : manual;
      if (task) {
        const response = await requestBackground("GET_VIDEO", { videoId: task.id }, signal);
        if (!isCurrent(current) || !qualityStillSelected(current, quality)) return;
        const video = response?.video;
        if (manual && video?.status === "paused") return;
        if (!response?.ok || !video || video.createdAt !== task.createdAt || ["paused", "error"].includes(video.status)) {
          failFull(current);
          return;
        }
        if (video.status !== "complete") {
          paintFull(current, "caching");
          return;
        }
        cache = video;
      } else {
        const response = await requestBackground("GET_CACHED_FOR_URL", { url: current.url, quality }, signal);
        if (!isCurrent(current) || !qualityStillSelected(current, quality)) return;
        if (response?.video?.status === "complete") cache = response.video;
        else if (isFull(current) && !current.autoFailed && !document.hidden && navigator.onLine && quality) cache = await startFull(current, quality);
        else if (isFull(current) && !navigator.onLine) failFull(current);
      }
      if (!cache || !isCurrent(current) || !cacheStillSelected(current, cache)) return;
      if (quality && Number(cache.quality) !== quality) { failFull(current); return; }
      const version = cacheVersion(cache);
      if (current.failed.get(cache.id) === version) return;
      const video = await waitForVideoElement(signal);
      if (!isCurrent(current) || !qualityStillSelected(current, quality)) return;
      if (!video) throw new Error("未找到当前播放页的播放器");
      if (current.playback?.videoId === cache.id && current.playback.version === version && ownsSource(current.playback)) {
        current.ready = true;
        paintFull(current, "ready");
        return;
      }
      paintFull(current, "preparing");
      const media = await requestBackground("GET_PLAYBACK_URL", { videoId: cache.id }, signal,
        late => releaseCacheUse(late?.leaseId));
      leaseId = media?.leaseId;
      if (!isCurrent(current) || !qualityStillSelected(current, quality)) return;
      if (!media?.ok) throw new Error(media?.error || "无法读取本地缓存");
      if (media.playbackUrl) await playFile(current, video, cache, media);
      else if (media.playback?.kind === "dash") await playDash(current, video, cache, media);
      else throw new Error("缓存缺少可播放的媒体");
    } catch (error) {
      if (!isCurrent(current) || !qualityStillSelected(current, quality)) return;
      if (cache) playbackFailed(current, cache, error);
      else if (isFull(current)) failFull(current);
    } finally {
      if (current.playback?.leaseId !== leaseId) releaseCacheUse(leaseId);
    }
  }

  function validPlayerQuality(quality, minimum = 1) {
    return Number.isSafeInteger(quality) && quality >= minimum && quality <= 127;
  }

  function selectedPlayerQuality(menu) {
    return Number(menu?.querySelector(`${QUALITY_OPTION}.bpx-state-active`)?.dataset.value);
  }

  function isSelectableQuality(option) {
    return !option.matches(".bpx-state-disabled, [disabled], [aria-disabled='true']") &&
      !option.querySelector(".bpx-player-ctrl-quality-badge-needlogin");
  }

  function autoPlayerQuality(menu) {
    // 未登录时清单也可能声明 480P，而播放器的「自动(360P 流畅)」才是当前使用的档位。
    const options = [...menu.querySelectorAll(QUALITY_OPTION)];
    const autoText = options.find(option => Number(option.dataset.value) === 0)?.querySelector(QUALITY_TEXT)?.textContent;
    const label = autoText?.match(/[(（]([^）)]+)[)）]/)?.[1].trim();
    if (!label) return 0;
    const active = options.find(option => option.querySelector(QUALITY_TEXT)?.textContent.trim() === label);
    const quality = Number(active?.dataset.value);
    return validPlayerQuality(quality) ? quality : 0;
  }

  function playerQualityOptions(current) {
    return [...(playerQualityMenu(current)?.querySelectorAll(QUALITY_OPTION) || [])];
  }

  function playerQualityMenu(current) {
    const menu = document.querySelector(QUALITY_MENU);
    if (!menu || pagePlayurlQuality(current)) return menu;
    if (!current.watchLaterId) return null;
    // 「稍后再看」可由播放器内部取得清单，document-start 拦截未必见到画质。
    // 等标题链接与标签 URL 一致且同一播放器有媒体元数据，换稿时还要排除上一条的媒体源。
    const titlePath = document.querySelector("h1.video-title a[href]")?.pathname;
    const titleId = titlePath?.match(/\/video\/([a-zA-Z0-9]+)\/?$/)?.[1];
    if (titleId !== current.watchLaterId) return null;
    const video = menu.closest(".bpx-player-container")?.querySelector("video");
    if (!video?.currentSrc || video.readyState < 1) return null;
    const previous = current.previousWatchLaterPlayer;
    if (previous?.video === video && previous.source === video.currentSrc && current.watchLaterMetadata !== video) return null;
    current.watchLaterPlayer = { video, source: video.currentSrc };
    return menu;
  }

  function readPlayerQuality(current, includeSources) {
    const playerQuality = siteQuality(current);
    const options = playerQualityOptions(current).filter(option => validPlayerQuality(Number(option.dataset.value)));
    const choices = options
      .filter(isSelectableQuality)
      .map(option => Number(option.dataset.value));
    return { playerQuality, playerChoices: options.length ? [...new Set(choices)].sort((a, b) => a - b) : null,
      sourcePaths: playerQuality && includeSources ? readPlayerSourcePaths() : undefined };
  }

  async function changePlayerQuality(current, quality, selectedAt) {
    const read = () => isCurrent(current) ? readPlayerQuality(current) : {};
    if (!validPlayerQuality(quality) || !Number.isFinite(selectedAt) || selectedAt < (current.qualityChangedAt || 0)) return read();
    const option = playerQualityOptions(current).find(item => Number(item.dataset.value) === quality && isSelectableQuality(item));
    if (!option || siteQuality(current) === quality) return read();
    // 复用 B 站自身的选档事件与换轨。仅菜单确认同档才返回成功，避免把点击当作切换完成。
    // 保留操作发生的顺序。较早请求如果在消息通道里晚到，不能覆盖较新的选择。
    current.popupQualitySelectedAt = selectedAt;
    try { option.click(); }
    finally { current.popupQualitySelectedAt = undefined; }
    const revision = current.qualityChangedAt;
    const deadline = Date.now() + QUALITY_WAIT_MS;
    while (isCurrent(current) && current.qualityChangedAt === revision && Date.now() < deadline) {
      const selected = siteQuality(current);
      if (selected) return read();
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return read();
  }

  function pagePlayurlQuality(current) {
    const data = document.documentElement?.dataset;
    const url = data?.biliBufferQualityUrl;
    const quality = Number(data?.biliBufferQuality);
    if (!url || !validPlayerQuality(quality)) return 0;
    try { return pageKey(url) === current.key ? quality : 0; }
    catch { return 0; }
  }

  function siteQuality(current) {
    // B 站可用同一份 DASH 清单切换表示。正数选中项是播放器已确认的手动档，优先于旧清单。
    const menu = playerQualityMenu(current);
    const selected = selectedPlayerQuality(menu);
    const switching = current.qualitySwitch;
    if (switching && !switching.confirmed) {
      if (selected === switching.quality) switching.confirmed = true;
      else if (Date.now() < switching.expiresAt) return 0;
      else current.qualitySwitch = null;
    }
    // 本地源仍由插件持有时，站点可能回写换源之前的菜单值。只有下一次确认的选档才能改变它。
    const attachment = current.playback;
    if (attachment?.quality && attachment.video === document.querySelector("video") && ownsSource(attachment) &&
        (!current.qualitySwitch || current.qualitySwitch.quality === attachment.quality)) return attachment.quality;
    const quality = pagePlayurlQuality(current);
    if (!quality && !menu && !current.watchLaterPlayer) return 0;
    // 控件收起或重建时保留本页已确认的选项。自动档优先使用菜单所显示的实际档位。
    if (validPlayerQuality(selected, 0)) current.menuQuality = selected || autoPlayerQuality(menu);
    return current.menuQuality || quality;
  }

  function tracksSelectedQuality(current) {
    return isFull(current) || current.qualitySwitch || current.manualTask?.followPlayer;
  }

  function qualityStillSelected(current, quality) {
    if (!tracksSelectedQuality(current)) return true;
    const selected = siteQuality(current);
    if (current.qualitySwitch?.confirmed === false) return false;
    if (selected === quality || (!selected && !navigator.onLine)) return true;
    current.recheck = true;
    return false;
  }

  function cacheStillSelected(current, cache) {
    if (!isFull(current) && current.manualTask && current.manualTask.id !== cache.id) return false;
    return qualityStillSelected(current, Number(cache.quality));
  }

  async function startFull(current, quality) {
    const { signal } = current.controller;
    const video = await waitForVideoElement(signal);
    if (!isCurrent(current) || !isFull(current) || document.hidden || !qualityStillSelected(current, quality)) return null;
    if (!video) { failFull(current); return null; }
    const mode = current.mode;
    paintFull(current, "caching");
    const result = await requestBackground("START_AUTO_CACHE", { url: location.href, quality }, signal);
    if (!isCurrent(current) || current.mode !== mode || !isFull(current) || !qualityStillSelected(current, quality)) return null;
    if (!result?.ok || (!result.skipped && !result.video) ||
        ["paused", "error"].includes(result.video?.status)) {
      failFull(current);
      return null;
    }
    if (result.skipped) {
      if (!document.hidden) failFull(current);
      return null;
    }
    current.autoTask = { id: result.video.id, createdAt: result.video.createdAt, quality };
    if (result.video.status === "complete") return result.video;
    return null;
  }

  function failFull(current) {
    if (!isFull(current) && !current.manualTask) return;
    current.autoFailed = true;
    current.ready = false;
    paintFull(current, "error");
  }

  function matchesVideoSize(video, { width, height }) {
    // 同一档不同编码的画面可能有几像素对齐差异。可解码后才算在线播放完成换流。
    return video?.readyState >= 2 && Math.abs(video.videoWidth - width) <= 4 && Math.abs(video.videoHeight - height) <= 4;
  }

  async function playFile(current, video, cache, media) {
    const { signal } = current.controller;
    const response = await fetch(media.playbackUrl, { signal });
    if (!response.ok) throw new Error("无法从扩展后台读取本地缓存");
    const blob = await response.blob();
    if (blob.size !== (media.video?.totalBytes ?? cache.totalBytes)) throw new Error("本地缓存字节数校验失败");
    if (!isCurrent(current)) return;
    const url = URL.createObjectURL(blob);
    try {
      // 先用独立元素读元数据；坏文件不能先把正常播放中的原生媒体源拆掉。
      const probe = document.createElement("video");
      probe.preload = "metadata";
      const ready = waitForEvent(probe, "loadedmetadata", signal, "缓存文件无法解码");
      probe.src = url;
      let size;
      try {
        await ready;
        size = { width: probe.videoWidth, height: probe.videoHeight };
      } finally {
        probe.removeAttribute("src");
        probe.load();
      }
      const quality = Number(cache.quality);
      if (!isCurrent(current) || !qualityStillSelected(current, quality)) return;
      // 菜单先改变，MSE 的音视频轨之后才完成切换。提前移除原生源会让 B 站回滚菜单和档位。
      if (navigator.onLine && current.qualitySwitch?.quality === quality &&
          video.dataset.biliCachePlayback !== "local" && size.width && size.height && !matchesVideoSize(video, size)) {
        current.nativeSizeWait = size;
        return;
      }
      await mountPlayback(current, video, cache, url, media.leaseId);
    } finally {
      if (current.playback?.url !== url) URL.revokeObjectURL(url);
    }
  }

  async function playDash(current, video, cache, media) {
    const { signal } = current.controller;
    const tracks = await Promise.all((media.playback.tracks || []).map(async track => {
      if (!track.url || !track.mimeCodec || !MediaSource.isTypeSupported(track.mimeCodec)) {
        throw new Error("浏览器无法打开缓存中的 DASH 轨道");
      }
      const response = await fetch(track.url, { signal });
      if (!response.ok) throw new Error("无法从扩展后台读取本地 DASH 轨道");
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== track.totalBytes) throw new Error("本地 DASH 轨道字节数校验失败");
      return { ...track, buffer };
    }));
    if (!tracks.some(track => track.name === "video")) throw new Error("本地 DASH 视频轨缺失");
    if (!isCurrent(current)) return;
    const mediaSource = new MediaSource();
    const url = URL.createObjectURL(mediaSource);
    try {
      await mountPlayback(current, video, cache, url, media.leaseId, async attachmentSignal => {
        await waitForEvent(mediaSource, "sourceopen", attachmentSignal, "本地媒体容器无法打开");
        if (Number(cache.duration) > 0) mediaSource.duration = Number(cache.duration);
        const buffers = tracks.map(track => mediaSource.addSourceBuffer(track.mimeCodec));
        await Promise.all(buffers.map((buffer, index) => {
          buffer.appendBuffer(new Uint8Array(tracks[index].buffer));
          return waitForEvent(buffer, "updateend", attachmentSignal, "缓存轨道无法加入播放器");
        }));
        if (mediaSource.readyState === "open") mediaSource.endOfStream();
      });
    } finally {
      if (current.playback?.url !== url) URL.revokeObjectURL(url);
    }
  }

  function waitForEvent(target, eventName, signal, message) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const finish = error => {
        clearTimeout(timer);
        target.removeEventListener(eventName, success);
        target.removeEventListener("error", failure);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const success = () => finish();
      const failure = () => finish(new Error(message));
      const abort = () => finish(signal.reason);
      const timer = setTimeout(failure, 15_000);
      target.addEventListener(eventName, success, { once: true });
      target.addEventListener("error", failure, { once: true });
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  function playerState(video) {
    return {
      time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      paused: video.paused,
      awaitingAutoplay: video.autoplay && !video.played.length && video.readyState < video.HAVE_FUTURE_DATA,
      muted: video.muted,
      volume: video.volume,
      rate: video.playbackRate
    };
  }

  function restorePlayerState(video, state, onPlayFailure = () => {}) {
    if (Number.isFinite(video.duration)) video.currentTime = Math.min(state.time, Math.max(0, video.duration - 0.1));
    video.muted = state.muted;
    video.volume = state.volume;
    video.playbackRate = state.rate;
    // 更换媒体源会重新启用 HTML autoplay。显式恢复暂停，避免用户停下后换源又自动开播。
    if (!state.paused) void video.play().catch(onPlayFailure);
    else if (!state.awaitingAutoplay) video.pause();
  }

  async function mountPlayback(current, video, cache, url, leaseId, setup) {
    const quality = Number(cache.quality);
    if (!isCurrent(current) || video !== document.querySelector("video") || !cacheStillSelected(current, cache)) return;
    const menu = document.querySelector(QUALITY_MENU);
    const menuLabel = selectedPlayerQuality(menu) === quality ? qualityLabelNode(menu)?.textContent : "";
    const nativeSource = current.playback?.video === video && ownsSource(current.playback)
      ? current.playback.nativeSource : { src: video.getAttribute("src"), srcObject: video.srcObject };
    const state = playerState(video);
    releasePlayback(current, "replace");
    const controller = new AbortController();
    const signal = AbortSignal.any([current.controller.signal, controller.signal]);
    const attachment = { videoId: cache.id, quality, menuLabel, version: cacheVersion(cache), controller, video, url, leaseId, nativeSource, state };
    current.playback = attachment;
    const metadata = waitForEvent(video, "loadedmetadata", signal, "网页播放器无法打开缓存");
    video.pause();
    if (video.srcObject) video.srcObject = null;
    video.src = url;
    video.dataset.biliCachePlayback = "local";
    document.documentElement.dataset.biliBufferPlayback = "loading";
    try {
      await Promise.all([metadata, setup?.(signal)]);
      if (!isCurrent(current)) return;
      if (!cacheStillSelected(current, cache)) {
        releasePlayback(current, "restore");
        return;
      }
      if (!ownsSource(attachment) || !video.isConnected) {
        releasePlayback(current);
        delete document.documentElement.dataset.biliBufferPlayback;
        return;
      }
      if ((isFull(current) || current.manualTask) && !wholeTimelineAvailable(video)) {
        if (video.readyState < 2) await waitForEvent(video, "loadeddata", signal, "本地视频无法出画");
        if (!isCurrent(current) || !ownsSource(attachment)) return;
        if (!cacheStillSelected(current, cache)) {
          releasePlayback(current, "restore");
          return;
        }
        if (!wholeTimelineAvailable(video)) throw new Error("本地视频无法读取完整时间轴");
      }
      current.ready = true;
      current.qualitySwitch = null;
      if (isFull(current)) reflectLocalQuality(current);
      restorePlayerState(video, state, error => {
        // 缓存完成是异步事件。Chrome 若要求一次页面手势，仍可直接启动准备好的本地媒体。
        if (error?.name !== "NotAllowedError" || !isCurrent(current) || !ownsSource(attachment)) return;
        current.localPlayBlocked = true;
        paintFull(current, "ready");
      });
      attachment.onError = () => {
        if (ownsSource(attachment) && qualityStillSelected(current, attachment.quality)) playbackFailed(current, cache, video.error);
      };
      video.addEventListener("error", attachment.onError, { once: true });
      document.documentElement.dataset.biliBufferPlayback = "local";
      paintFull(current, "ready");
      chrome.runtime.sendMessage({ target: "background", type: "PLAYBACK_ACTIVE" }).catch(() => {});
    } catch (error) {
      if (isCurrent(current)) releasePlayback(current, "restore");
      throw error;
    }
  }

  function wholeTimelineAvailable(video) {
    const duration = video.duration;
    const ranges = video.seekable;
    return Number.isFinite(duration) && duration > 0 && ranges.length === 1 &&
      ranges.start(0) <= 0.1 && ranges.end(0) >= duration - 0.1;
  }

  function playbackFailed(current, cache, error) {
    if (!isCurrent(current)) return;
    const version = cacheVersion(cache);
    current.failed.set(cache.id, version);
    if (current.playback?.videoId === cache.id && current.playback.version === version) releasePlayback(current, "restore");
    if (!current.playback) document.documentElement.dataset.biliBufferPlayback = "error";
    if (isFull(current)) failFull(current);
    console.warn("[海内存知] 本地缓存无法播放", error);
  }

  function waitForVideoElement(signal) {
    const existing = document.querySelector("video");
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const finish = video => {
        observer.disconnect();
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(video);
      };
      const abort = () => finish(null);
      const observer = new MutationObserver(() => {
        const found = document.querySelector("video");
        if (found) finish(found);
      });
      observer.observe(document, { childList: true, subtree: true });
      const timer = setTimeout(abort, 20_000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  function ownsSource({ video, url }) {
    return video.getAttribute("src") === url && !video.srcObject;
  }

  function releaseCacheUse(leaseId) {
    if (leaseId) chrome.runtime.sendMessage({ target: "background", type: "RELEASE_CACHE_PLAYBACK", leaseId }).catch(() => {});
  }

  function releasePlayback(current, mode) {
    const playback = current.playback;
    if (!playback) return;
    current.playback = null;
    playback.controller.abort();
    const { video, url, onError, nativeSource, state } = playback;
    if (onError) video.removeEventListener("error", onError);
    delete video.dataset.biliCachePlayback;
    if (mode !== "replace" && ownsSource(playback)) {
      if (mode === "restore") {
        if (nativeSource.src !== null) video.setAttribute("src", nativeSource.src);
        else video.removeAttribute("src");
        if (nativeSource.srcObject) video.srcObject = nativeSource.srcObject;
        video.addEventListener("loadedmetadata", () => {
          if (isCurrent(current) && !current.playback) restorePlayerState(video, state);
        }, { once: true, signal: current.controller.signal });
      } else {
        video.removeAttribute("src");
      }
      video.load();
    }
    URL.revokeObjectURL(url);
    releaseCacheUse(playback.leaseId);
  }
})();
