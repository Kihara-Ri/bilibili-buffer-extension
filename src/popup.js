import { getAudioCacheSize, getCacheSize } from "./cache-size.js";
import {
  CODEC_LABELS,
  describeAudioContainer,
  describeAudioTrack,
  formatBytes,
  formatDuration,
  formatSpeed,
  getVideoPageId,
  isAudioOnlyCache,
  isVideoCodecSelectionMatch,
  makeBiliSpaceUrl,
  normalizeCacheMode,
  normalizeHttpUrl,
  shouldShowInLibrary
} from "./utils.js";
import { choosePopupQuality } from "./popup-snapshot.js";
import {
  DEFAULT_PREHEAT_COLOR,
  normalizePreheatColor,
  PREHEAT_COLOR_PRESETS
} from "./assist-config.js";

const elements = {
  panelTabs: document.querySelector("#panel-tabs"),
  panelViews: [...document.querySelectorAll("[data-panel-view]")],
  assistTab: document.querySelector("#assist-tab"),
  assistTabIndicator: document.querySelector("#assist-tab-indicator"),
  libraryCount: document.querySelector("#library-count"),
  currentHeading: document.querySelector("#current-heading"),
  currentDetail: document.querySelector("#current-detail"),
  currentOwner: document.querySelector("#current-owner"),
  currentDetailSeparator: document.querySelector("#current-detail-separator"),
  currentDetailText: document.querySelector("#current-detail-text"),
  pageMark: document.querySelector("#page-mark"),
  formatControls: document.querySelector("#format-controls"),
  cacheMode: document.querySelector("#cache-mode"),
  qualityRow: document.querySelector("#quality-row"),
  qualityTrigger: document.querySelector("#quality-trigger"),
  qualityTriggerLabel: document.querySelector("#quality-trigger-label"),
  qualityMenu: document.querySelector("#quality-menu"),
  cacheSize: document.querySelector("#cache-size"),
  authNote: document.querySelector("#auth-note"),
  cacheButton: document.querySelector("#cache-button"),
  buttonProgress: document.querySelector("#button-progress"),
  buttonLabel: document.querySelector("#button-label"),
  buttonSpeed: document.querySelector("#button-speed"),
  actionHint: document.querySelector("#action-hint"),
  assistPanel: document.querySelector("#assist-panel"),
  assistToggle: document.querySelector("#assist-toggle"),
  assistToggleLabel: document.querySelector("#assist-toggle-label"),
  assistStatus: document.querySelector("#assist-status"),
  progressColor: document.querySelector("#assist-progress-color"),
  showPreheatHighlight: document.querySelector("#assist-show-highlight"),
  assistColors: document.querySelector("#assist-colors"),
  assistColorPreview: document.querySelector("#assist-color-preview"),
  assistCustomColor: document.querySelector("#assist-custom-color"),
  assistCustomColorShell: document.querySelector("#assist-custom-color-shell"),
  videoList: document.querySelector("#video-list"),
  librarySummary: document.querySelector("#library-summary"),
  toast: document.querySelector("#toast")
};

const state = {
  activeView: "cache",
  cacheMode: "video",
  tab: null,
  pageInfo: null,
  qualityOptions: [],
  selectedQuality: 0,
  cacheSizeInfo: null,
  selectedCodec: "auto",
  qualitiesLoading: false,
  qualityError: "",
  auth: null,
  videos: [],
  qualityMenuSignature: "",
  focusQualityOptionOnOpen: false,
  assistConfig: null,
  assistStats: null,
  assistTimer: null,
  refreshTimer: null,
  toastTimer: null
};

elements.progressColor.addEventListener("change", () => persistProgressAppearance({ progressColor: elements.progressColor.value }));
elements.showPreheatHighlight.addEventListener("change", () => persistProgressAppearance({ showPreheatHighlight: elements.showPreheatHighlight.checked }));

async function persistProgressAppearance(patch) {
  const previous = state.assistConfig;
  state.assistConfig = { ...previous, ...patch };
  renderAssist();
  try {
    const result = await send("SET_ASSIST_CONFIG", { patch });
    state.assistConfig = result.config;
  } catch (error) {
    state.assistConfig = previous;
    showToast(error.message);
  }
  renderAssist();
}

elements.panelTabs.addEventListener("click", selectPanelViewFromEvent);
elements.panelTabs.addEventListener("keydown", navigatePanelViews);
elements.cacheButton.addEventListener("click", startCache);
elements.currentOwner.addEventListener("click", openCurrentOwner);
elements.cacheMode.addEventListener("click", selectCacheMode);
  elements.cacheMode.addEventListener("keydown", navigateCacheModes);
elements.qualityMenu.addEventListener("click", selectQualityFromMenu);
elements.qualityMenu.addEventListener("keydown", navigateQualityMenu);
elements.qualityMenu.addEventListener("toggle", handleQualityMenuToggle);
elements.qualityTrigger.addEventListener("keydown", openQualityMenuFromKeyboard);
elements.assistToggle.addEventListener("click", toggleAssist);
elements.assistColors.addEventListener("click", selectAssistColor);
elements.assistCustomColor.addEventListener("change", selectCustomAssistColor);
window.addEventListener("resize", () => {
  if (isQualityMenuOpen()) positionQualityMenu();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "popup") return;
  if (["CACHE_PROGRESS", "CACHE_RETRY", "CACHE_COMPLETE", "CACHE_ERROR", "CACHE_DELETED"].includes(message.type)) {
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

renderAssistColorPresets();
setPanelView("cache");
void initialize();

function selectPanelViewFromEvent(event) {
  const tab = event.target.closest("[data-panel-view]");
  if (!tab || tab.disabled) return;
  setPanelView(tab.dataset.panelView);
}

function navigatePanelViews(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = elements.panelViews.filter((tab) => !tab.disabled);
  if (!tabs.length) return;
  event.preventDefault();
  const current = Math.max(0, tabs.indexOf(document.activeElement.closest?.("[data-panel-view]")));
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : event.key === "ArrowRight"
        ? (current + 1) % tabs.length
        : (current - 1 + tabs.length) % tabs.length;
  setPanelView(tabs[next].dataset.panelView, { focus: true });
}

function setPanelView(view, { focus = false } = {}) {
  const tab = elements.panelViews.find((candidate) => candidate.dataset.panelView === view);
  if (!tab || tab.disabled) return;
  if (view !== "cache") closeQualityMenu();
  state.activeView = view;
  for (const candidate of elements.panelViews) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    const panel = document.querySelector(`#${candidate.getAttribute("aria-controls")}`);
    if (panel) panel.hidden = !selected;
  }
  if (focus) tab.focus();
}

function setAssistAvailability(available) {
  elements.assistTab.disabled = !available;
  elements.assistTab.setAttribute("aria-disabled", String(!available));
  elements.assistTabIndicator.hidden = !available;
  if (!available && state.activeView === "assist") setPanelView("cache");
}

async function initialize() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tabs[0] || null;
  await loadCacheModePreference();
  void refreshAssistState();
  const libraryPromise = refreshLibrary();
  const restored = await restorePopupSnapshot();
  if (!restored) {
    await refreshPopupData();
  } else if (restored.stale) {
    void refreshPopupData({ silent: true });
  }
  await libraryPromise;
  state.refreshTimer = setInterval(refreshLibrary, 700);
  state.assistTimer = setInterval(refreshAssistState, 1000);
  window.addEventListener("pagehide", () => {
    clearInterval(state.refreshTimer);
    clearInterval(state.assistTimer);
  }, { once: true });
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
    return { stale: Boolean(result.stale) || !result.snapshot.cacheSizeInfo };
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
  state.cacheSizeInfo = snapshot.cacheSizeInfo || null;
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
  state.selectedCodec = "auto";
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
  if (activeQuality) {
    state.selectedQuality = activeQuality;
    state.selectedCodec = "auto";
  }
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
  renderCacheModeControl();
  renderQualityControl(cached);
  renderAssist();
  if (!cached) {
    if (state.qualitiesLoading) {
      setButtonState("disabled", "正在读取可用画质", "", 0, true);
      setHint("正在读取账号可用画质…", false);
      return;
    }
    if (isAudioMode()) {
      const audioSize = getAudioCacheSize(state.cacheSizeInfo, null);
      if (!audioSize) {
        setButtonState("disabled", "暂时无法缓存音频", "", 0, true);
        setHint(state.qualityError || "B 站没有返回可缓存的音频轨（单文件 MP4 也需要包含音轨）。", true);
        return;
      }
      setButtonState("idle", "缓存", "", 0, false);
      setHint(
        audioSize.mode === "extract"
          ? "该视频只有单文件 MP4：仅音频会先下载整段 MP4，再无损提取音轨（不转码）"
          : "",
        false
      );
      return;
    }
    if (!state.selectedQuality) {
      setButtonState("disabled", "暂时无法缓存", "", 0, true);
      setHint(state.qualityError || "B 站没有返回可缓存画质。", true);
      return;
    }
    setButtonState("idle", "缓存", "", 0, false);
    setHint("", false);
    return;
  }

  if (cached.status === "downloading") {
    const progress = Math.max(0, Math.min(1, Number(cached.progress) || 0));
    const retrySeconds = Math.max(0, Math.ceil(((Number(cached.nextRetryAt) || 0) - Date.now()) / 1000));
    const recovering = Boolean(cached.error);
    const merging = cached.stage === "merging" || cached.mergeStage === "merging";
    const extracting = cached.stage === "extracting";
    const percent = Math.round(progress * 100);
    setButtonState(
      "downloading",
      retrySeconds > 0
        ? `等待续传 ${percent}%`
        : extracting
          ? `正在提取音频 ${percent}%`
          : merging
            ? `正在合并 ${percent}%`
            : recovering
              ? `正在恢复 ${percent}%`
              : `正在缓存 ${percent}%`,
      retrySeconds > 0 ? `${retrySeconds}s` : cached.speed ? formatSpeed(cached.speed) : "连接中",
      progress,
      true
    );
    setHint(
      extracting
        ? "单文件 MP4 已下载完成，正在无损提取音轨（不转码）"
        : merging
          ? "音视频轨已下载完成，正在合并为单个 MP4"
          : cached.error || `${formatBytes(cached.downloadedBytes)} / ${formatBytes(cached.totalBytes)}`,
      false
    );
    return;
  }

  if (cached.status === "complete") {
    setButtonState("complete", "已缓存完成", formatBytes(cached.downloadedBytes), 1, true);
    setHint(
      cached.mergeError ? `未能合并为单个 MP4，已保留两条独立轨道：${cached.mergeError}` : "",
      Boolean(cached.mergeError)
    );
    return;
  }

  setButtonState("error", "继续 / 重新缓存", "", cached.progress || 0, false);
  setHint(cached.error || "缓存未完成", true);
}

function isAudioMode() {
  return state.cacheMode === "audio";
}

async function loadCacheModePreference() {
  try {
    const result = await send("GET_CACHE_MODE");
    state.cacheMode = normalizeCacheMode(result.mode, state.cacheMode);
  } catch {
    // 读取失败时保持当前界面选择，不阻塞首屏。
  }
}

function renderCacheModeControl() {
  const audioMode = isAudioMode();
  for (const button of elements.cacheMode.querySelectorAll("[data-cache-mode]")) {
    const selected = (button.dataset.cacheMode === "audio") === audioMode;
    button.setAttribute("aria-checked", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
}

async function selectCacheMode(event) {
  const button = event.target.closest("[data-cache-mode]");
  if (!button || button.getAttribute("aria-checked") === "true") return;
  await persistCacheMode(button.dataset.cacheMode);
}

/** 左右方向键在“视频 + 音频 / 仅音频”之间切换，与画质选择保持一致的可访问性。 */
async function navigateCacheModes(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const buttons = [...elements.cacheMode.querySelectorAll("[data-cache-mode]")];
  if (!buttons.length) return;
  event.preventDefault();
  const current = Math.max(0, buttons.indexOf(document.activeElement));
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? buttons.length - 1
      : event.key === "ArrowRight"
        ? (current + 1) % buttons.length
        : (current - 1 + buttons.length) % buttons.length;
  buttons[next].focus();
  await persistCacheMode(buttons[next].dataset.cacheMode);
}

async function persistCacheMode(value) {
  const previous = state.cacheMode;
  state.cacheMode = normalizeCacheMode(value, previous);
  renderCurrent();
  try {
    const result = await send("SET_CACHE_MODE", { mode: state.cacheMode });
    state.cacheMode = normalizeCacheMode(result.mode, state.cacheMode);
  } catch (error) {
    state.cacheMode = previous;
    showToast(error.message);
  }
  renderCurrent();
}

function renderUnsupported(title, detail) {
  elements.currentHeading.textContent = title;
  elements.currentOwner.hidden = true;
  elements.currentOwner.removeAttribute("href");
  delete elements.currentOwner.dataset.url;
  elements.currentDetailSeparator.hidden = true;
  elements.currentDetailText.textContent = detail;
  elements.pageMark.hidden = true;
  elements.formatControls.hidden = true;
  elements.qualityRow.hidden = true;
  elements.assistPanel.hidden = true;
  setAssistAvailability(false);
  elements.authNote.hidden = true;
  closeQualityMenu();
  setButtonState("disabled", "当前页面无法缓存", "", 0, true);
  setHint("请打开 B 站视频页", false);
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
  const audioMode = isAudioMode();
  const videos = getCurrentPageVideos().filter((video) => isAudioOnlyCache(video) === audioMode);
  if (!videos.length) return null;
  if (audioMode) {
    return videos.find((video) => video.status === "downloading")
      || videos.find((video) => video.status === "complete")
      || videos[0];
  }
  if (state.selectedQuality) {
    const selected = videos.find((video) => (
      Number(video.requestedQuality || video.quality) === state.selectedQuality &&
      isVideoCodecSelectionMatch(video, state.selectedCodec)
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
  elements.formatControls.hidden = false;
  const audioMode = isAudioMode();
  elements.qualityRow.hidden = audioMode;
  elements.authNote.hidden = false;

  let ladder = null;
  if (audioMode) {
    closeQualityMenu();
  } else if (state.qualitiesLoading) {
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
    ladder = describeQualityLadder(options);
    setQualityTrigger(
      selected ? formatQualityOptionLabel(selected, selectedIndex) : "没有可缓存画质",
      !options.length || cached?.status === "downloading",
      ladder.title
    );
    updateQualitySelection();
  }

  const size = audioMode
    ? getAudioCacheSize(state.cacheSizeInfo, cached)
    : getCacheSize(state.cacheSizeInfo, state.selectedQuality, cached);
  const sizeLabel = audioMode && size?.label ? ` · ${size.label}` : "";
  elements.cacheSize.textContent = state.qualitiesLoading && !audioMode ? "正在估算…"
    : size ? `${size.estimated ? "约 " : ""}${formatBytes(size.bytes)}${sizeLabel}` : "暂时无法估算";
  elements.cacheSize.title = audioMode
    ? size?.mode === "extract"
      ? "该视频只有单文件 MP4：会先下载整段 MP4，再无损提取音轨；保存时保留原始音频格式"
      : "仅缓存音频：优先 Hi-Res 无损，其次杜比全景声，最后 AAC；保存时保留 B 站原始格式"
    : size?.estimated
      ? "按当前画质的音视频码率和时长估算，实际大小以下载后为准"
      : "当前画质的音视频总大小";

  if (state.qualityError) {
    elements.authNote.textContent = state.qualityError;
    elements.authNote.dataset.tone = "warning";
    elements.authNote.title = state.qualityError;
  } else if (state.auth?.viaPageSession && state.auth?.vipActive) {
    elements.authNote.textContent = "大会员登录态";
    elements.authNote.dataset.tone = "member";
    elements.authNote.title = "已通过当前 B 站页面使用登录态，并检测到有效大会员";
  } else if (state.auth?.viaPageSession) {
    elements.authNote.textContent = "已使用登录态";
    elements.authNote.dataset.tone = "normal";
    elements.authNote.title = "画质列表以当前账号实际权限为准";
  } else if (state.auth?.hasSessionCookie) {
    elements.authNote.textContent = "登录态受限";
    elements.authNote.dataset.tone = "warning";
    elements.authNote.title = "检测到登录 Cookie，但页面登录态请求未成功；会员画质可能不完整";
  } else {
    elements.authNote.textContent = "未登录";
    elements.authNote.dataset.tone = "warning";
    elements.authNote.title = "登录或大会员画质可能不可用";
  }

  // 把“B 站声明了但当前账号拿不到”的档位数显式说出来，方便判断是否已取到最高规格。
  if (ladder?.missing.length && !state.qualityError) {
    elements.authNote.textContent = `${elements.authNote.textContent} · ${ladder.missing.length} 档未返回`;
    elements.authNote.title = `${elements.authNote.title}；B 站声明但当前账号未返回：${ladder.missingText}`;
  }
}

async function refreshAssistState() {
  if (!state.tab?.id) return;
  try {
    const result = await send("GET_ASSIST_STATE", { tabId: state.tab.id });
    state.assistConfig = result.config || state.assistConfig;
    state.assistStats = result.stats || null;
  } catch {
    state.assistStats = null;
  }
  renderAssist();
}

function renderAssist() {
  if (!state.pageInfo?.supported) {
    elements.assistPanel.hidden = true;
    setAssistAvailability(false);
    return;
  }
  setAssistAvailability(true);
  elements.assistPanel.hidden = false;
  const config = state.assistConfig || { mode: "always", preheatColor: DEFAULT_PREHEAT_COLOR };
  const stats = state.assistStats;
  const enabled = config.mode !== "off";
  elements.assistToggle.setAttribute("aria-checked", String(enabled));
  elements.assistToggleLabel.textContent = enabled ? "开启" : "关闭";
  elements.progressColor.value = config.progressColor || "#00a1d6";
  elements.showPreheatHighlight.checked = config.showPreheatHighlight !== false;
  renderAssistColorSelection(config.preheatColor);

  let status = "已关闭";
  let statusState = "off";
  if (enabled && !stats?.activeTracks) {
    status = "等待视频加载";
    statusState = "waiting";
  } else if (enabled && stats.prefetching > 0) {
    status = "正在提前加载后续内容";
    statusState = "active";
  } else if (enabled && stats.prefetchMB > 0) {
    status = `已提前加载 ${Number(stats.prefetchMB).toFixed(1)} MB`;
    statusState = "active";
  } else if (enabled && stats.prefetchErrors > 0) {
    status = "连接不稳定，自动重试";
    statusState = "warning";
  } else if (enabled) {
    status = "已开启";
    statusState = "active";
  }
  elements.assistStatus.textContent = status;
  elements.assistStatus.dataset.state = statusState;
  elements.assistTab.title = status;
  elements.assistTabIndicator.dataset.tone = enabled ? "active" : "off";
}

async function toggleAssist() {
  if (!state.tab?.id) return;
  const previous = state.assistConfig || { mode: "always", preheatColor: DEFAULT_PREHEAT_COLOR };
  const mode = previous.mode === "off" ? "always" : "off";
  state.assistConfig = { ...previous, mode };
  renderAssist();
  try {
    const result = await send("SET_ASSIST_CONFIG", { patch: { mode } });
    state.assistConfig = result.config;
    renderAssist();
  } catch (error) {
    state.assistConfig = previous;
    renderAssist();
    showToast(error.message);
  }
}

function renderAssistColorPresets() {
  const fragment = document.createDocumentFragment();
  for (const preset of PREHEAT_COLOR_PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "radio";
    button.dataset.assistColor = preset.value;
    button.title = preset.label;
    button.setAttribute("aria-label", `${preset.label}高亮`);
    button.setAttribute("aria-checked", "false");
    button.style.setProperty("--swatch-color", preset.value);
    fragment.append(button);
  }
  elements.assistColors.replaceChildren(fragment);
}

function renderAssistColorSelection(input) {
  const color = normalizePreheatColor(input);
  const presetValues = new Set(PREHEAT_COLOR_PRESETS.map((preset) => preset.value));
  for (const button of elements.assistColors.querySelectorAll("[data-assist-color]")) {
    button.setAttribute("aria-checked", String(button.dataset.assistColor === color));
  }
  elements.assistCustomColor.value = color;
  elements.assistCustomColorShell.dataset.selected = String(!presetValues.has(color));
  elements.assistColorPreview.style.setProperty("--preview-color", color);
}

async function selectAssistColor(event) {
  const button = event.target.closest("[data-assist-color]");
  if (!button) return;
  await persistAssistColor(button.dataset.assistColor);
}

async function selectCustomAssistColor() {
  await persistAssistColor(elements.assistCustomColor.value);
}

async function persistAssistColor(input) {
  const preheatColor = normalizePreheatColor(input);
  const previous = state.assistConfig || { mode: "always", preheatColor: DEFAULT_PREHEAT_COLOR };
  state.assistConfig = { ...previous, preheatColor };
  renderAssistColorSelection(preheatColor);
  try {
    const result = await send("SET_ASSIST_CONFIG", { patch: { preheatColor } });
    state.assistConfig = result.config;
    renderAssist();
  } catch (error) {
    state.assistConfig = previous;
    renderAssist();
    showToast(error.message);
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

function setQualityTrigger(label, disabled, extraTitle = "") {
  elements.qualityTriggerLabel.textContent = label;
  elements.qualityTrigger.disabled = disabled;
  elements.qualityTrigger.title = extraTitle ? `${label}\n${extraTitle}` : label;
  if (disabled) closeQualityMenu();
}

/**
 * 对比 B 站声明的档位与当前账号实际返回的轨道：让“是不是最高规格”在界面上有答案。
 * 只声明、未返回的档位基本都是大会员 / 登录限制，或该视频根本没有对应轨道。
 */
function describeQualityLadder(options) {
  const declared = Array.isArray(state.cacheSizeInfo?.declared) ? state.cacheSizeInfo.declared : [];
  const describe = (quality) => {
    const suffix = quality.requiresVip ? "（大会员）" : quality.requiresLogin ? "（需登录）" : "";
    return `${quality.label}${suffix}`;
  };
  const missing = declared.filter((item) => !options.some((option) => option.quality === item.quality));
  if (!declared.length) return { missing: [], missingText: "", title: "" };
  return {
    missing,
    missingText: missing.map(describe).join(" / "),
    title: [
      `B 站声明可用：${declared.map(describe).join(" / ")}`,
      `当前账号返回：${options.map((option) => option.label).join(" / ") || "无"}`,
      missing.length ? `未返回：${missing.map(describe).join(" / ")}` : ""
    ].filter(Boolean).join("\n")
  };
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
  state.selectedCodec = "auto";
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
    quality: state.selectedQuality,
    codec: state.selectedCodec
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
  elements.actionHint.hidden = !message;
}

async function startCache() {
  if (!state.pageInfo?.supported || !state.tab) return;
  if (!isAudioMode() && !state.selectedQuality) return;
  setButtonState("downloading", "正在连接缓存节点", "", 0, true);
  setHint("正在获取当前视频的可缓存版本…", false);
  try {
    await send("START_CACHE", {
      url: state.tab.url,
      tabId: state.tab.id,
      quality: state.selectedQuality,
      codec: state.selectedCodec,
      mode: state.cacheMode
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
  elements.libraryCount.textContent = videos.length > 99 ? "99+" : String(videos.length);
  elements.libraryCount.title = `${videos.length} 个本地视频`;
  elements.librarySummary.textContent = formatBytes(total);
  elements.videoList.replaceChildren();

  if (!videos.length) {
    renderEmptyLibrary("还没有缓存", "在“缓存”页保存当前视频");
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
    ? isAudioOnlyCache(video)
      ? ["仅音频", video.audioLabel || describeAudioTrack(video)].filter(Boolean).join(" · ")
      : [video.qualityLabel || "MP4", video.codecLabel || CODEC_LABELS[video.codec]].filter(Boolean).join(" · ")
    : video.status === "downloading"
      ? Number(video.nextRetryAt) > Date.now() ? "等待自动续传" : video.error ? "正在恢复" : "缓存中"
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
    saveButton.title = isAudioOnlyCache(video)
      ? `保存音频文件（${describeAudioContainer(video)}，未转码）`
      : video.merged
        ? "保存已合并音视频的单个 MP4"
        : video.mediaKind === "dash" && video.tracks?.audio
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
