import {
  formatBytes,
  formatDuration,
  formatSpeed,
  getVideoPageId,
  makeBiliSpaceUrl,
  normalizeHttpUrl,
  shouldShowInLibrary
} from "./utils.js";
import { choosePopupQuality } from "./popup-snapshot.js";

const elements = {
  currentHeading: document.querySelector("#current-heading"),
  currentDetail: document.querySelector("#current-detail"),
  currentOwner: document.querySelector("#current-owner"),
  currentDetailSeparator: document.querySelector("#current-detail-separator"),
  currentDetailText: document.querySelector("#current-detail-text"),
  pageMark: document.querySelector("#page-mark"),
  qualityRow: document.querySelector("#quality-row"),
  qualityTrigger: document.querySelector("#quality-trigger"),
  qualityTriggerLabel: document.querySelector("#quality-trigger-label"),
  qualityMenu: document.querySelector("#quality-menu"),
  authNote: document.querySelector("#auth-note"),
  cacheButton: document.querySelector("#cache-button"),
  buttonProgress: document.querySelector("#button-progress"),
  buttonLabel: document.querySelector("#button-label"),
  buttonSpeed: document.querySelector("#button-speed"),
  actionHint: document.querySelector("#action-hint"),
  videoList: document.querySelector("#video-list"),
  librarySummary: document.querySelector("#library-summary"),
  toast: document.querySelector("#toast")
};

const state = {
  tab: null,
  pageInfo: null,
  qualityOptions: [],
  selectedQuality: 0,
  qualitiesLoading: false,
  qualityError: "",
  auth: null,
  videos: [],
  qualityMenuSignature: "",
  focusQualityOptionOnOpen: false,
  refreshTimer: null,
  toastTimer: null
};

elements.cacheButton.addEventListener("click", startCache);
elements.currentOwner.addEventListener("click", openCurrentOwner);
elements.qualityMenu.addEventListener("click", selectQualityFromMenu);
elements.qualityMenu.addEventListener("keydown", navigateQualityMenu);
elements.qualityMenu.addEventListener("toggle", handleQualityMenuToggle);
elements.qualityTrigger.addEventListener("keydown", openQualityMenuFromKeyboard);
window.addEventListener("resize", () => {
  if (isQualityMenuOpen()) positionQualityMenu();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "popup") return;
  if (["CACHE_PROGRESS", "CACHE_COMPLETE", "CACHE_ERROR", "CACHE_DELETED"].includes(message.type)) {
    if (message.video) {
      const index = state.videos.findIndex((video) => video.id === message.video.id);
      if (index >= 0) state.videos.splice(index, 1, message.video);
      else state.videos.unshift(message.video);
      renderLibrary();
      if (state.pageInfo) renderCurrent();
    } else {
      void refreshLibrary();
    }
  }
});

void initialize();

async function initialize() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tabs[0] || null;
  const libraryPromise = refreshLibrary();
  const restored = await restorePopupSnapshot();
  if (!restored) {
    await refreshPopupData();
  } else if (restored.stale) {
    void refreshPopupData({ silent: true });
  }
  await libraryPromise;
  state.refreshTimer = setInterval(refreshLibrary, 700);
  window.addEventListener("pagehide", () => clearInterval(state.refreshTimer), { once: true });
}

async function restorePopupSnapshot() {
  if (!state.tab?.url) {
    renderUnsupported("无法读取当前页面", "请重新打开插件");
    return null;
  }
  try {
    const result = await send("GET_POPUP_SNAPSHOT", { url: state.tab.url, tabId: state.tab.id });
    if (!result.snapshot) return null;
    applyPopupSnapshot(result.snapshot);
    return { stale: Boolean(result.stale) };
  } catch {
    return null;
  }
}

async function refreshPopupData({ silent = false } = {}) {
  if (!state.tab?.url) return;
  const expectedTabId = state.tab.id;
  if (!silent && state.pageInfo?.supported) {
    state.qualitiesLoading = true;
    renderCurrent();
  }
  try {
    const result = await send("REFRESH_POPUP_DATA", { url: state.tab.url, tabId: expectedTabId });
    if (state.tab?.id !== expectedTabId || !result.snapshot) return;
    applyPopupSnapshot(result.snapshot);
  } catch (error) {
    if (state.pageInfo) {
      state.qualityError = silent
        ? `后台刷新失败，暂时使用上次画质：${error.message}`
        : error.message;
      renderCurrent();
    } else {
      renderUnsupported("暂时无法识别", error.message);
    }
  } finally {
    state.qualitiesLoading = false;
    if (state.pageInfo) renderCurrent();
  }
}

function applyPopupSnapshot(snapshot) {
  state.pageInfo = snapshot.pageInfo || null;
  state.qualityOptions = Array.isArray(snapshot.qualities) ? snapshot.qualities : [];
  state.auth = snapshot.auth || null;
  state.qualityError = "";
  state.qualitiesLoading = false;
  const active = getCurrentPageVideos().find((video) => video.status === "downloading");
  const activeQuality = Number(active?.requestedQuality || active?.quality) || 0;
  state.selectedQuality = choosePopupQuality(
    state.qualityOptions,
    activeQuality,
    snapshot.selectedQuality,
    snapshot.defaultQuality
  );
  renderCurrent();
}

async function refreshLibrary() {
  try {
    const result = await send("LIST_VIDEOS");
    state.videos = result.videos || [];
    syncSelectedQualityWithActiveDownload();
    renderLibrary();
    if (state.pageInfo) renderCurrent();
  } catch (error) {
    if (!state.videos.length) renderEmptyLibrary("本地片库读取失败", error.message);
  }
}

function syncSelectedQualityWithActiveDownload() {
  const active = getCurrentPageVideos().find((video) => video.status === "downloading");
  const activeQuality = Number(active?.requestedQuality || active?.quality) || 0;
  if (activeQuality) state.selectedQuality = activeQuality;
}

function renderCurrent() {
  const info = state.pageInfo;
  if (!info?.supported) {
    renderUnsupported(info?.message || "请打开 B 站视频页", "支持标准 BV / av 投稿视频");
    return;
  }

  elements.currentHeading.textContent = info.partTitle || info.title;
  renderCurrentDetail(info);
  elements.pageMark.hidden = info.pageCount <= 1;
  elements.pageMark.textContent = `P${info.page} / ${info.pageCount}`;

  const cached = findCurrentVideo();
  renderQualityControl(cached);
  if (!cached) {
    if (state.qualitiesLoading) {
      setButtonState("disabled", "正在读取可用画质", "", 0, true);
      setHint("会优先使用当前 Chrome 的 B 站登录状态。", false);
      return;
    }
    if (!state.selectedQuality) {
      setButtonState("disabled", "暂时无法缓存", "", 0, true);
      setHint(state.qualityError || "B 站没有返回可缓存画质。", true);
      return;
    }
    setButtonState("idle", "缓存", "", 0, false);
    setHint(`默认选择 ${getSelectedQualityLabel()}，可在上方切换。`, false);
    return;
  }

  if (cached.status === "downloading") {
    const progress = Math.max(0, Math.min(1, Number(cached.progress) || 0));
    setButtonState(
      "downloading",
      `正在缓存 ${Math.round(progress * 100)}%`,
      cached.speed ? formatSpeed(cached.speed) : "连接中",
      progress,
      true
    );
    setHint(`${formatBytes(cached.downloadedBytes)} / ${formatBytes(cached.totalBytes)}`, false);
    return;
  }

  if (cached.status === "complete") {
    setButtonState("complete", "已缓存完成", formatBytes(cached.downloadedBytes), 1, true);
    setHint("重新打开这个视频时，会优先使用本地缓存。", false);
    return;
  }

  setButtonState("error", "继续 / 重新缓存", "", cached.progress || 0, false);
  setHint(cached.error || "缓存未完成", true);
}

function renderUnsupported(title, detail) {
  elements.currentHeading.textContent = title;
  elements.currentOwner.hidden = true;
  elements.currentOwner.removeAttribute("href");
  delete elements.currentOwner.dataset.url;
  elements.currentDetailSeparator.hidden = true;
  elements.currentDetailText.textContent = detail;
  elements.pageMark.hidden = true;
  elements.qualityRow.hidden = true;
  elements.authNote.hidden = true;
  closeQualityMenu();
  setButtonState("disabled", "当前页面无法缓存", "", 0, true);
  setHint("打开一个 bilibili.com/video/… 页面后再试。", false);
}

function renderCurrentDetail(info) {
  const ownerUrl = normalizeHttpUrl(info.ownerUrl) || makeBiliSpaceUrl(info.ownerId);
  const hasOwner = Boolean(info.owner);
  elements.currentOwner.hidden = !hasOwner;
  elements.currentOwner.textContent = info.owner || "";
  elements.currentOwner.title = ownerUrl ? `打开 ${info.owner} 的主页` : "";
  if (ownerUrl) {
    elements.currentOwner.href = ownerUrl;
    elements.currentOwner.dataset.url = ownerUrl;
  } else {
    elements.currentOwner.removeAttribute("href");
    delete elements.currentOwner.dataset.url;
  }
  const duration = formatDuration(info.duration);
  elements.currentDetailSeparator.hidden = !hasOwner || !duration;
  elements.currentDetailText.textContent = duration;
}

function openCurrentOwner(event) {
  const url = elements.currentOwner.dataset.url;
  if (!url) return;
  event.preventDefault();
  chrome.tabs.create({ url });
}

function findCurrentVideo() {
  const videos = getCurrentPageVideos();
  if (!videos.length) return null;
  if (state.selectedQuality) {
    const selected = videos.find((video) => (
      Number(video.requestedQuality || video.quality) === state.selectedQuality
    ));
    return selected || null;
  }
  return videos.find((video) => video.status === "downloading") || videos[0];
}

function getCurrentPageVideos() {
  if (!state.pageInfo?.id) return [];
  return state.videos.filter((video) => getVideoPageId(video) === state.pageInfo.id);
}

function renderQualityControl(cached) {
  elements.qualityRow.hidden = false;
  elements.authNote.hidden = false;

  if (state.qualitiesLoading) {
    setQualityTrigger("正在读取可用画质…", true);
    closeQualityMenu();
  } else {
    const options = getQualityDisplayOptions(cached);
    if (!options.some((option) => option.quality === state.selectedQuality)) {
      state.selectedQuality = options[0]?.quality || 0;
    }
    renderQualityMenu(options);
    const selectedIndex = Math.max(0, options.findIndex((option) => option.quality === state.selectedQuality));
    const selected = options[selectedIndex];
    setQualityTrigger(
      selected ? formatQualityOptionLabel(selected, selectedIndex) : "没有可缓存画质",
      !options.length || cached?.status === "downloading"
    );
    updateQualitySelection();
  }

  if (state.qualityError) {
    elements.authNote.textContent = state.qualityError;
    elements.authNote.dataset.tone = "warning";
  } else if (state.auth?.viaPageSession && state.auth?.vipActive) {
    elements.authNote.textContent = "已通过当前 B 站页面使用登录态，并检测到有效大会员。";
    elements.authNote.dataset.tone = "member";
  } else if (state.auth?.viaPageSession) {
    elements.authNote.textContent = "已通过当前 B 站页面使用登录态；画质列表以账号实际权限为准。";
    elements.authNote.dataset.tone = "normal";
  } else if (state.auth?.hasSessionCookie) {
    elements.authNote.textContent = "检测到登录 Cookie，但页面登录态请求未成功；会员画质可能不完整。";
    elements.authNote.dataset.tone = "warning";
  } else {
    elements.authNote.textContent = "未检测到 B 站登录 Cookie；登录或大会员画质可能不可用。";
    elements.authNote.dataset.tone = "warning";
  }
}

function getQualityDisplayOptions(cached) {
  const options = [...state.qualityOptions];
  const cachedQuality = Number(cached?.requestedQuality || cached?.quality) || 0;
  if (cachedQuality && !options.some((option) => option.quality === cachedQuality)) {
    options.push({ quality: cachedQuality, label: cached.qualityLabel || `画质 ${cachedQuality}` });
  }
  return options;
}

function formatQualityOptionLabel(quality, index) {
  const accessLabel = quality.requiresVip
    ? " · 大会员"
    : quality.requiresLogin
      ? " · 登录可用"
      : "";
  const highestLabel = index === 0 && state.qualityOptions.length ? "（最高）" : "";
  return `${quality.label}${highestLabel}${accessLabel}`;
}

function renderQualityMenu(options) {
  const signature = JSON.stringify(options.map((quality, index) => [
    quality.quality,
    formatQualityOptionLabel(quality, index)
  ]));
  if (signature === state.qualityMenuSignature) return;

  state.qualityMenuSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const [index, quality] of options.entries()) {
    const option = document.createElement("button");
    option.className = "quality-option";
    option.type = "button";
    option.setAttribute("role", "option");
    option.dataset.quality = String(quality.quality);
    option.textContent = formatQualityOptionLabel(quality, index);
    fragment.append(option);
  }
  elements.qualityMenu.replaceChildren(fragment);
}

function setQualityTrigger(label, disabled) {
  elements.qualityTriggerLabel.textContent = label;
  elements.qualityTrigger.disabled = disabled;
  elements.qualityTrigger.title = label;
  if (disabled) closeQualityMenu();
}

function updateQualitySelection() {
  for (const option of elements.qualityMenu.querySelectorAll(".quality-option")) {
    const selected = Number(option.dataset.quality) === state.selectedQuality;
    option.setAttribute("aria-selected", String(selected));
    option.tabIndex = selected ? 0 : -1;
  }
}

function selectQualityFromMenu(event) {
  const option = event.target.closest(".quality-option");
  if (!option) return;
  state.selectedQuality = Number(option.dataset.quality) || 0;
  persistPopupSelection();
  closeQualityMenu();
  renderCurrent();
  elements.qualityTrigger.focus();
}

function persistPopupSelection() {
  if (!state.tab?.url || !state.selectedQuality) return;
  void send("SET_POPUP_SELECTION", {
    tabId: state.tab.id,
    url: state.tab.url,
    quality: state.selectedQuality
  }).catch(() => {});
}

function openQualityMenuFromKeyboard(event) {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || elements.qualityTrigger.disabled) return;
  event.preventDefault();
  state.focusQualityOptionOnOpen = true;
  if (isQualityMenuOpen()) {
    focusSelectedQualityOption();
  } else {
    elements.qualityMenu.showPopover();
  }
}

function navigateQualityMenu(event) {
  const options = [...elements.qualityMenu.querySelectorAll(".quality-option")];
  if (!options.length) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeQualityMenu();
    elements.qualityTrigger.focus();
    return;
  }
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();
  const current = Math.max(0, options.indexOf(document.activeElement));
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? options.length - 1
      : event.key === "ArrowDown"
        ? (current + 1) % options.length
        : (current - 1 + options.length) % options.length;
  options[next].focus();
}

function handleQualityMenuToggle(event) {
  const open = event.newState === "open";
  elements.qualityTrigger.setAttribute("aria-expanded", String(open));
  elements.qualityTrigger.classList.toggle("is-open", open);
  if (!open) return;
  requestAnimationFrame(() => {
    positionQualityMenu();
    if (state.focusQualityOptionOnOpen) focusSelectedQualityOption();
    state.focusQualityOptionOnOpen = false;
  });
}

function focusSelectedQualityOption() {
  elements.qualityMenu.querySelector('[aria-selected="true"]')?.focus();
}

function positionQualityMenu() {
  if (!isQualityMenuOpen()) return;
  const rect = elements.qualityTrigger.getBoundingClientRect();
  const menu = elements.qualityMenu;
  const viewportPadding = 12;
  menu.style.minWidth = `${Math.round(rect.width)}px`;
  menu.style.maxWidth = `${Math.max(180, window.innerWidth - viewportPadding * 2)}px`;
  const menuRect = menu.getBoundingClientRect();
  const preferredLeft = rect.right - menuRect.width;
  const left = Math.max(
    viewportPadding,
    Math.min(preferredLeft, window.innerWidth - menuRect.width - viewportPadding)
  );
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - viewportPadding) {
    top = Math.max(viewportPadding, rect.top - menuRect.height - 6);
  }
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function closeQualityMenu() {
  if (isQualityMenuOpen()) elements.qualityMenu.hidePopover();
}

function isQualityMenuOpen() {
  return elements.qualityMenu.matches(":popover-open");
}

function getSelectedQualityLabel() {
  return state.qualityOptions.find((option) => option.quality === state.selectedQuality)?.label || "所选画质";
}

function setButtonState(mode, label, speed, progress, disabled) {
  elements.cacheButton.dataset.state = mode;
  elements.cacheButton.disabled = disabled;
  elements.cacheButton.style.setProperty("--progress", `${Math.round(progress * 100)}%`);
  elements.buttonLabel.textContent = label;
  elements.buttonSpeed.textContent = speed;
  elements.cacheButton.setAttribute("aria-label", speed ? `${label}，${speed}` : label);
}

function setHint(message, isError) {
  elements.actionHint.textContent = message;
  elements.actionHint.dataset.tone = isError ? "error" : "normal";
}

async function startCache() {
  if (!state.pageInfo?.supported || !state.tab || !state.selectedQuality) return;
  setButtonState("downloading", "正在连接缓存节点", "", 0, true);
  setHint("正在获取当前视频的可缓存版本…", false);
  try {
    await send("START_CACHE", {
      url: state.tab.url,
      tabId: state.tab.id,
      quality: state.selectedQuality
    });
    await refreshLibrary();
  } catch (error) {
    setButtonState("error", "重试缓存", "", 0, false);
    setHint(error.message, true);
  }
}

function renderLibrary() {
  const videos = state.videos.filter(shouldShowInLibrary);
  const total = videos.reduce((sum, video) => sum + (Number(video.downloadedBytes) || 0), 0);
  elements.librarySummary.textContent = `${videos.length} 个 · ${formatBytes(total)}`;
  elements.videoList.replaceChildren();

  if (!videos.length) {
    renderEmptyLibrary("这里还很空", "打开一个 B 站视频，点击上方按钮，它就会出现在这里。");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const video of videos) fragment.append(createVideoItem(video));
  elements.videoList.append(fragment);
}

function renderEmptyLibrary(title, detail) {
  elements.videoList.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  const track = document.createElement("div");
  track.className = "empty-track";
  track.setAttribute("aria-hidden", "true");
  track.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  const strong = document.createElement("strong");
  strong.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = detail;
  empty.append(track, strong, paragraph);
  elements.videoList.append(empty);
}

function createVideoItem(video) {
  const item = document.createElement("article");
  item.className = "video-item";

  const coverWrap = document.createElement("div");
  coverWrap.className = "cover-wrap";
  const coverUrl = normalizeHttpUrl(video.cover);
  if (coverUrl) {
    const image = document.createElement("img");
    image.src = coverUrl;
    image.alt = "";
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => image.remove(), { once: true });
    coverWrap.append(image);
  }
  const status = document.createElement("span");
  status.className = "cover-status";
  status.textContent = video.status === "complete"
    ? formatDuration(video.duration)
    : `${Math.round((video.progress || 0) * 100)}%`;
  coverWrap.append(status);

  const copy = document.createElement("div");
  copy.className = "video-copy";
  const link = document.createElement("a");
  link.className = "video-link";
  link.href = video.url;
  link.textContent = video.partTitle || video.title;
  link.title = video.partTitle || video.title;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: video.url });
  });
  const meta = document.createElement("p");
  meta.className = "video-meta";
  const statusText = video.status === "complete"
    ? video.qualityLabel || "MP4"
    : video.status === "downloading"
      ? "缓存中"
      : "可继续";
  if (video.owner) {
    const ownerUrl = normalizeHttpUrl(video.ownerUrl) || makeBiliSpaceUrl(video.ownerId);
    const owner = ownerUrl ? document.createElement("a") : document.createElement("span");
    owner.className = "video-owner";
    owner.textContent = video.owner;
    if (ownerUrl) {
      owner.href = ownerUrl;
      owner.title = `打开 ${video.owner} 的主页`;
      owner.addEventListener("click", (event) => {
        event.preventDefault();
        chrome.tabs.create({ url: ownerUrl });
      });
    }
    meta.append(owner, document.createTextNode(" · "));
  }
  meta.append(document.createTextNode(`${statusText} · ${formatBytes(video.downloadedBytes || video.totalBytes)}`));
  copy.append(link, meta);

  const actions = document.createElement("div");
  actions.className = "video-actions";

  if (video.status === "complete") {
    const saveButton = document.createElement("button");
    saveButton.className = "item-action save-button";
    saveButton.type = "button";
    saveButton.setAttribute("aria-label", `保存《${video.partTitle || video.title}》到电脑`);
    saveButton.title = video.mediaKind === "dash" && video.tracks?.audio
      ? "保存视频轨和音频轨"
      : "保存视频";
    saveButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span>保存</span>`;
    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      try {
        const result = await send("SAVE_VIDEO", { videoId: video.id });
        showToast(result.splitTracks
          ? "高画质为双轨，已分别保存视频轨和音频轨"
          : "已交给 Chrome 保存");
      } catch (error) {
        showToast(error.message);
      } finally {
        saveButton.disabled = false;
      }
    });
    actions.append(saveButton);
  }

  const deleteButton = document.createElement("button");
  deleteButton.className = "item-action delete-button";
  deleteButton.type = "button";
  deleteButton.setAttribute("aria-label", `删除《${video.partTitle || video.title}》的缓存`);
  deleteButton.title = "删除缓存";
  deleteButton.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 10v7m4-7v7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  deleteButton.addEventListener("click", async () => {
    deleteButton.disabled = true;
    try {
      await send("DELETE_VIDEO", { videoId: video.id });
      showToast("缓存已删除");
      await refreshLibrary();
    } catch (error) {
      deleteButton.disabled = false;
      showToast(error.message);
    }
  });
  actions.append(deleteButton);

  item.append(coverWrap, copy, actions);
  return item;
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.visible = "true";
  state.toastTimer = setTimeout(() => {
    elements.toast.dataset.visible = "false";
  }, 1800);
}

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: "background", type, ...data });
  if (!response?.ok) throw new Error(response?.error || "扩展后台没有响应");
  return response;
}
