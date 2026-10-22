import { committedBytes, taskProgress, compareLibraryTasks, newerTask, sampleSpeed } from "./task-presentation.js";
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

const DEFAULT_PROGRESS_COLOR = "#00a1d6";
// 删除先从列表隐藏，提示里可撤销；超时（或弹窗关闭）才真正删除数据。
const DELETE_UNDO_MS = 6000;
const TASK_EVENTS = ["CACHE_PROGRESS", "CACHE_RETRY", "CACHE_COMPLETE", "CACHE_ERROR", "CACHE_PAUSED", "CACHE_DELETED"];

const $ = (selector) => document.querySelector(selector);
const elements = {
  panelTabs: $("#panel-tabs"),
  tabs: [...document.querySelectorAll("[data-panel-view]")],
  libraryCount: $("#library-count"),
  settingsButton: $("#settings-button"),
  settingsAlert: $("#settings-alert"),
  settingsView: $("#settings-view"),
  settingsBack: $("#settings-back"),
  healthBanner: $("#health-banner"),
  healthBannerOpen: $("#health-banner-open"),
  currentHeading: $("#current-heading"),
  currentOwner: $("#current-owner"),
  currentDetailText: $("#current-detail-text"),
  pageMark: $("#page-mark"),
  formatControls: $("#format-controls"),
  cacheMode: $("#cache-mode"),
  qualityRow: $("#quality-row"),
  qualityTrigger: $("#quality-trigger"),
  qualityTriggerLabel: $("#quality-trigger-label"),
  qualityMenu: $("#quality-menu"),
  cacheSize: $("#cache-size"),
  audioRow: $("#audio-row"),
  audioSummary: $("#audio-summary"),
  authNote: $("#auth-note"),
  cacheButton: $("#cache-button"),
  buttonLabel: $("#button-label"),
  buttonSpeed: $("#button-speed"),
  actionHint: $("#action-hint"),
  pauseButton: $("#pause-button"),
  assistPanel: $("#assist-panel"),
  assistToggle: $("#assist-toggle"),
  assistStatus: $("#assist-status"),
  assistMetrics: Object.fromEntries(["speed", "hit", "buffer", "ready", "connections", "rescues", "node", "accelerated", "fallbacks"].map(key => [key, $(`#assist-${key}`)])),
  appearance: $("#assist-appearance"),
  appearanceReset: $("#assist-appearance-reset"),
  preheatControls: $("#assist-preheat-controls"),
  progressColor: $("#assist-progress-color"),
  showPreheatHighlight: $("#assist-show-highlight"),
  assistColors: $("#assist-colors"),
  assistCustomColor: $("#assist-custom-color"),
  assistCustomColorShell: $("#assist-custom-color-shell"),
  browserHealthStatus: $("#browser-health-status"),
  browserHealthList: $("#browser-health-list"),
  browserHealthRefresh: $("#browser-health-refresh"),
  aboutVersion: $("#about-version"),
  videoList: $("#video-list"),
  librarySummary: $("#library-summary"),
  appFooter: $(".app-footer"),
  toast: $("#toast"),
  toastText: $("#toast-text"),
  toastAction: $("#toast-action")
};

const state = {
  activeView: "current",
  settingsOpen: false,
  libraryRevision: 0,
  libraryLoading: false,
  deletedAt: new Map(),
  // 待删除：videoId → { timer, resume }。期间行被隐藏，撤销即恢复。
  pendingDeletes: new Map(),
  speedSamples: new Map(),
  confirmedAssistConfig: null,
  appearancePending: 0,
  appearanceRevision: 0,
  appearanceQueue: Promise.resolve(),
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
  assistReadSequence: 0,
  healthReport: null,
  healthError: "",
  healthSignature: "",
  pausePending: false,
  refreshTimer: null,
  assistTimer: null,
  toastTimer: null
};

// ---- 事件绑定 ----------------------------------------------------------------

elements.panelTabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-panel-view]");
  if (tab && !tab.disabled) setPanelView(tab.dataset.panelView);
});
elements.panelTabs.addEventListener("keydown", navigatePanelViews);
// 鼠标点击时 detail ≥ 1，键盘触发时为 0：只在键盘打开设置时把焦点移进去，鼠标操作不出现多余的焦点框。
elements.settingsButton.addEventListener("click", (event) => setSettingsOpen(!state.settingsOpen, { moveFocus: event.detail === 0 }));
elements.settingsBack.addEventListener("click", (event) => setSettingsOpen(false, { restoreFocus: event.detail === 0 }));
elements.healthBannerOpen.addEventListener("click", () => setSettingsOpen(true, { focus: elements.browserHealthRefresh }));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.settingsOpen && !isQualityMenuOpen()) setSettingsOpen(false);
});
elements.cacheButton.addEventListener("click", startCache);
elements.pauseButton.addEventListener("click", pauseCurrentTask);
elements.currentOwner.addEventListener("click", (event) => {
  const url = elements.currentOwner.dataset.url;
  if (!url) return;
  event.preventDefault();
  chrome.tabs.create({ url });
});
elements.cacheMode.addEventListener("click", (event) => {
  const button = event.target.closest("[data-cache-mode]");
  if (button && button.getAttribute("aria-checked") !== "true") void persistCacheMode(button.dataset.cacheMode);
});
elements.cacheMode.addEventListener("keydown", navigateCacheModes);
elements.qualityMenu.addEventListener("click", selectQualityFromMenu);
elements.qualityMenu.addEventListener("keydown", navigateQualityMenu);
elements.qualityMenu.addEventListener("toggle", handleQualityMenuToggle);
elements.qualityTrigger.addEventListener("keydown", openQualityMenuFromKeyboard);
elements.assistToggle.addEventListener("click", () => {
  if (state.tab?.id) void persistProgressAppearance({ mode: state.assistConfig?.mode === "off" ? "always" : "off" });
});
elements.browserHealthRefresh.addEventListener("click", () => refreshHealth({ refresh: true }));
elements.progressColor.addEventListener("change", () => persistProgressAppearance({ progressColor: elements.progressColor.value }));
elements.showPreheatHighlight.addEventListener("change", () => persistProgressAppearance({ showPreheatHighlight: elements.showPreheatHighlight.checked }));
elements.assistColors.addEventListener("click", (event) => {
  const button = event.target.closest("[data-assist-color]");
  if (button) void persistProgressAppearance({ preheatColor: normalizePreheatColor(button.dataset.assistColor) });
});
elements.assistColors.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || elements.preheatControls.disabled) return;
  const buttons = [...elements.assistColors.querySelectorAll("button")], index = buttons.indexOf(document.activeElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[next].focus();
  void persistProgressAppearance({ preheatColor: normalizePreheatColor(buttons[next].dataset.assistColor) });
});
elements.assistCustomColor.addEventListener("change", () => persistProgressAppearance({ preheatColor: normalizePreheatColor(elements.assistCustomColor.value) }));
elements.appearanceReset.addEventListener("click", () => persistProgressAppearance({ progressColor: DEFAULT_PROGRESS_COLOR, preheatColor: DEFAULT_PREHEAT_COLOR, showPreheatHighlight: true }));
elements.toastAction.addEventListener("click", () => {
  const action = elements.toastAction.onAction;
  hideToast();
  action?.();
});
window.addEventListener("resize", () => { if (isQualityMenuOpen()) positionQualityMenu(); });

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "popup" || !TASK_EVENTS.includes(message.type)) return;
  if (message.video) {
    state.libraryRevision++;
    const deletedAt = state.deletedAt.get(message.video.id) || 0;
    if (deletedAt && (message.video.updatedAt || 0) <= deletedAt) return;
    state.deletedAt.delete(message.video.id);
    const index = state.videos.findIndex((video) => video.id === message.video.id);
    if (index >= 0) state.videos.splice(index, 1, newerTask(state.videos[index], message.video));
    else state.videos.push(message.video);
  } else if (message.type === "CACHE_DELETED") {
    state.libraryRevision++;
    state.deletedAt.set(message.videoId, Date.now());
    state.videos = state.videos.filter((video) => video.id !== message.videoId);
  } else {
    void refreshLibrary();
    return;
  }
  renderLibrary();
  if (state.pageInfo) renderCurrent();
});

renderAssistColorPresets();
renderAbout();
setPanelView("current");
void initialize();

// ---- 导航 --------------------------------------------------------------------

function navigatePanelViews(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = elements.tabs.filter((tab) => !tab.disabled);
  if (!tabs.length) return;
  event.preventDefault();
  const current = Math.max(0, tabs.indexOf(document.activeElement.closest?.("[data-panel-view]")));
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : event.key === "ArrowRight" ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
  setPanelView(tabs[next].dataset.panelView, { focus: true });
}

function setPanelView(view, { focus = false } = {}) {
  const tab = elements.tabs.find((candidate) => candidate.dataset.panelView === view);
  if (!tab) return;
  if (view !== "current") closeQualityMenu();
  if (state.settingsOpen) setSettingsOpen(false, { restoreFocus: false });
  state.activeView = view;
  for (const candidate of elements.tabs) {
    const selected = candidate === tab;
    candidate.setAttribute("aria-selected", String(selected));
    candidate.tabIndex = selected ? 0 : -1;
    $(`#${candidate.getAttribute("aria-controls")}`).hidden = !selected;
  }
  if (focus) tab.focus();
}

/** 设置是覆盖在页签之上的二级视图：打开时隐藏页签与当前面板，返回时回到原页签。 */
function setSettingsOpen(open, { focus = null, restoreFocus = true, moveFocus = true } = {}) {
  state.settingsOpen = open;
  closeQualityMenu();
  elements.settingsView.hidden = !open;
  elements.panelTabs.hidden = open;
  // 设置的「关于」里已有隐私说明链接；隐藏重复的页脚，让设置页落在 Chrome 弹窗 600px 的高度上限内。
  elements.appFooter.hidden = open;
  elements.settingsButton.setAttribute("aria-expanded", String(open));
  for (const tab of elements.tabs) $(`#${tab.getAttribute("aria-controls")}`).hidden = open || tab.dataset.panelView !== state.activeView;
  renderHealth();
  if (open) {
    if (focus) { focus.focus(); focus.scrollIntoView({ block: "nearest" }); }
    else if (moveFocus) elements.settingsBack.focus();
  } else if (restoreFocus) {
    elements.settingsButton.focus();
  }
}

// ---- 初始化与数据刷新 ---------------------------------------------------------

async function initialize() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tabs[0] || null;
  await loadCacheModePreference();
  void refreshAssistState();
  // 自检只在打开弹窗时读一次（后台缓存 6 小时），不参与轮询。
  void refreshHealth();
  const libraryPromise = refreshLibrary();
  const restored = await restorePopupSnapshot();
  if (!restored) await refreshPopupData();
  else if (restored.stale) void refreshPopupData({ silent: true });
  await libraryPromise;
  state.refreshTimer = setInterval(refreshLibrary, 700);
  state.assistTimer = setInterval(refreshAssistState, 1000);
  window.addEventListener("pagehide", () => {
    clearInterval(state.refreshTimer);
    clearInterval(state.assistTimer);
    // 弹窗关闭时把还在撤销窗口里的删除立即提交，不能让「已删除」的条目下次又出现。
    for (const videoId of state.pendingDeletes.keys()) void send("DELETE_VIDEO", { videoId }).catch(() => {});
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
      state.qualityError = silent ? `后台刷新失败，暂时使用上次画质：${error.message}` : error.message;
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
  state.selectedQuality = choosePopupQuality(state.qualityOptions, activeQuality, snapshot.selectedQuality, snapshot.defaultQuality);
  state.selectedCodec = "auto";
  renderCurrent();
}

async function refreshLibrary() {
  if (state.libraryLoading) return;
  state.libraryLoading = true;
  const revision = state.libraryRevision;
  try {
    const result = await send("LIST_VIDEOS");
    const previous = new Map(state.videos.map((video) => [video.id, video]));
    const incoming = new Map((result.videos || [])
      .filter((video) => !state.deletedAt.has(video.id) || video.updatedAt > state.deletedAt.get(video.id))
      .map((video) => [video.id, newerTask(previous.get(video.id), video)]));
    // 查询期间收到推送时，旧查询不能删除刚加入的任务，也不能压回进度。
    if (revision !== state.libraryRevision) {
      for (const video of state.videos) if (!incoming.has(video.id) && !state.deletedAt.has(video.id)) incoming.set(video.id, video);
    }
    state.videos = [...incoming.values()].sort(compareLibraryTasks);
    const active = getCurrentPageVideos().find((video) => video.status === "downloading");
    const activeQuality = Number(active?.requestedQuality || active?.quality) || 0;
    if (activeQuality) { state.selectedQuality = activeQuality; state.selectedCodec = "auto"; }
    renderLibrary();
    if (state.pageInfo) renderCurrent();
  } catch (error) {
    if (!state.videos.length) renderEmptyLibrary("本地片库读取失败", error.message);
  } finally {
    state.libraryLoading = false;
  }
}

// ---- 当前视频 ----------------------------------------------------------------

function isAudioMode() {
  return state.cacheMode === "audio";
}

async function loadCacheModePreference() {
  try {
    state.cacheMode = normalizeCacheMode((await send("GET_CACHE_MODE")).mode, state.cacheMode);
  } catch {
    // 读取失败时保持当前选择，不阻塞首屏。
  }
}

async function navigateCacheModes(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const buttons = [...elements.cacheMode.querySelectorAll("[data-cache-mode]")];
  event.preventDefault();
  const current = Math.max(0, buttons.indexOf(document.activeElement));
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : event.key === "ArrowRight" ? (current + 1) % buttons.length : (current - 1 + buttons.length) % buttons.length;
  buttons[next].focus();
  await persistCacheMode(buttons[next].dataset.cacheMode);
}

async function persistCacheMode(value) {
  const previous = state.cacheMode;
  state.cacheMode = normalizeCacheMode(value, previous);
  renderCurrent();
  try {
    state.cacheMode = normalizeCacheMode((await send("SET_CACHE_MODE", { mode: state.cacheMode })).mode, state.cacheMode);
  } catch (error) {
    state.cacheMode = previous;
    showToast(error.message);
  }
  renderCurrent();
}

function renderUnsupported(title, detail) {
  setText(elements.currentHeading, title);
  elements.currentOwner.hidden = true;
  setText(elements.currentDetailText, detail);
  elements.pageMark.hidden = true;
  elements.formatControls.hidden = true;
  elements.assistPanel.hidden = true;
  elements.pauseButton.hidden = true;
  closeQualityMenu();
  setButtonState("disabled", "当前页面无法缓存", "", 0, true);
  setHint("打开一个 B 站视频页即可缓存；已缓存的视频在「片库」里", false);
}

function renderCurrent() {
  const info = state.pageInfo;
  if (!info?.supported) {
    renderUnsupported(info?.message || "请打开 B 站视频页", "支持标准 BV / av 投稿视频");
    return;
  }

  setText(elements.currentHeading, info.partTitle || info.title);
  const ownerUrl = normalizeHttpUrl(info.ownerUrl) || makeBiliSpaceUrl(info.ownerId);
  elements.currentOwner.hidden = !info.owner;
  setText(elements.currentOwner, info.owner || "");
  elements.currentOwner.title = ownerUrl ? `打开 ${info.owner} 的主页` : "";
  if (ownerUrl) { elements.currentOwner.href = ownerUrl; elements.currentOwner.dataset.url = ownerUrl; }
  else { elements.currentOwner.removeAttribute("href"); delete elements.currentOwner.dataset.url; }
  setText(elements.currentDetailText, formatDuration(info.duration));
  elements.pageMark.hidden = info.pageCount <= 1;
  setText(elements.pageMark, `P${info.page} / ${info.pageCount}`);

  const cached = findCurrentVideo();
  for (const button of elements.cacheMode.querySelectorAll("[data-cache-mode]")) {
    const selected = (button.dataset.cacheMode === "audio") === isAudioMode();
    button.setAttribute("aria-checked", String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  renderFormatControls(cached);
  renderAssist();
  renderCacheAction(cached);
}

/** 主按钮与下方状态行：空闲 → 缓存；下载中 → 进度 + 速度 + 「暂停」；暂停 / 出错 → 继续；完成 → 结果。 */
function renderCacheAction(cached) {
  elements.pauseButton.hidden = !(cached?.status === "downloading");
  elements.pauseButton.disabled = state.pausePending;
  if (!cached) {
    if (state.qualitiesLoading) {
      setButtonState("disabled", "正在读取可用画质", "", 0, true);
      setHint("", false);
      return;
    }
    if (isAudioMode() && !getAudioCacheSize(state.cacheSizeInfo, null)) {
      setButtonState("disabled", "暂时无法缓存音频", "", 0, true);
      setHint(state.qualityError || "B 站没有返回可缓存的音频轨（单文件 MP4 也需要包含音轨）。", true);
      return;
    }
    if (!isAudioMode() && !state.selectedQuality) {
      setButtonState("disabled", "暂时无法缓存", "", 0, true);
      setHint(state.qualityError || "B 站没有返回可缓存画质。", true);
      return;
    }
    setButtonState("idle", "缓存", "", 0, false);
    setHint(isAudioMode() && getAudioCacheSize(state.cacheSizeInfo, null)?.mode === "extract"
      ? "该视频只有单文件 MP4：会先下载整段，再无损提取音轨（不转码）" : "", false);
    return;
  }

  const progress = taskProgress(cached);
  const percent = Math.round(progress * 100);
  if (cached.status === "downloading") {
    const speedSample = sampleSpeed(state.speedSamples.get(cached.id), cached);
    state.speedSamples.set(cached.id, speedSample);
    const retrySeconds = Math.max(0, Math.ceil(((Number(cached.nextRetryAt) || 0) - Date.now()) / 1000));
    const merging = cached.stage === "merging" || cached.mergeStage === "merging";
    const extracting = cached.stage === "extracting";
    const label = retrySeconds > 0 ? `等待续传 ${percent}%` : extracting ? `正在提取音频 ${percent}%`
      : merging ? `正在合并 ${percent}%` : cached.error ? `正在恢复 ${percent}%` : `正在缓存 ${percent}%`;
    const speed = retrySeconds > 0 ? `${retrySeconds}s` : merging || extracting ? "处理中"
      : speedSample.value > 0 ? formatSpeed(speedSample.value) : "连接中";
    setButtonState("downloading", label, speed, progress, true);
    setHint(extracting ? "正在无损提取音轨（不转码）" : merging ? "音视频已下载完，正在合并为单个 MP4"
      : cached.error || `已缓存 ${formatBytes(committedBytes(cached))} / ${formatBytes(cached.totalBytes)} · 可以关闭这个页面`, false);
    return;
  }
  if (cached.status === "complete") {
    setButtonState("complete", "已缓存", formatBytes(cached.downloadedBytes), 1, true);
    setHint(cached.mergeError ? `未能合并为单个 MP4，已保留两条独立轨道：${cached.mergeError}` : "再次打开这个视频时会自动使用本地缓存播放", Boolean(cached.mergeError));
    return;
  }
  if (cached.status === "paused") {
    setButtonState("paused", `继续缓存 ${percent}%`, "", progress, false);
    setHint(`已暂停 · 已缓存 ${formatBytes(committedBytes(cached))}`, false);
    return;
  }
  setButtonState("error", `继续缓存 ${percent}%`, "", progress, false);
  setHint(cached.error || "缓存未完成", true);
}

function findCurrentVideo() {
  const audioMode = isAudioMode();
  const videos = getCurrentPageVideos().filter((video) => isAudioOnlyCache(video) === audioMode);
  if (!videos.length) return null;
  if (audioMode) return videos.find((video) => video.status === "downloading") || videos.find((video) => video.status === "complete") || videos[0];
  if (state.selectedQuality) {
    return videos.find((video) => Number(video.requestedQuality || video.quality) === state.selectedQuality && isVideoCodecSelectionMatch(video, state.selectedCodec)) || null;
  }
  return videos.find((video) => video.status === "downloading") || videos[0];
}

function getCurrentPageVideos() {
  if (!state.pageInfo?.id) return [];
  return state.videos.filter((video) => getVideoPageId(video) === state.pageInfo.id && !state.pendingDeletes.has(video.id));
}

function renderFormatControls(cached) {
  elements.formatControls.hidden = false;
  const audioMode = isAudioMode();
  elements.qualityRow.hidden = audioMode;
  elements.audioRow.hidden = !audioMode;

  let ladder = null;
  if (audioMode) {
    closeQualityMenu();
    const size = getAudioCacheSize(state.cacheSizeInfo, cached);
    setText(elements.audioSummary, size ? [size.label, `${size.estimated ? "约 " : ""}${formatBytes(size.bytes)}`].filter(Boolean).join(" · ") : "暂时无法估算");
    elements.audioSummary.title = size?.mode === "extract"
      ? "该视频只有单文件 MP4：会先下载整段 MP4，再无损提取音轨；保存时保留原始音频格式"
      : "优先 Hi-Res 无损，其次杜比全景声，最后 AAC；保存时保留 B 站原始格式";
  } else if (state.qualitiesLoading) {
    setQualityTrigger("正在读取可用画质…", "", true);
  } else {
    const options = getQualityDisplayOptions(cached);
    if (!options.some((option) => option.quality === state.selectedQuality)) state.selectedQuality = options[0]?.quality || 0;
    renderQualityMenu(options, cached);
    const selected = options.find((option) => option.quality === state.selectedQuality);
    ladder = describeQualityLadder(options);
    setQualityTrigger(selected ? qualityLabel(selected, options.indexOf(selected)) : "没有可缓存画质", sizeText(selected?.quality, cached), !options.length || cached?.status === "downloading", ladder.title);
    updateQualitySelection();
  }
  renderAuthNote(ladder);
}

function sizeText(quality, cached) {
  if (!quality) return "";
  const size = getCacheSize(state.cacheSizeInfo, quality, cached);
  return size ? `${size.estimated ? "约 " : ""}${formatBytes(size.bytes)}` : "";
}

/**
 * 用一句人话说明账号权限。B 站声明了、但这次没返回的档位要分两种说：
 * 大会员账号拿不到，说明是这个视频本身没有；普通账号拿不到大会员档，才是权限问题。
 */
function renderAuthNote(ladder) {
  const note = elements.authNote;
  const missing = ladder?.missing || [];
  const list = (items) => items.slice(0, 2).map((item) => item.label).join("、") + (items.length > 2 ? " 等" : "");
  const vipOnly = missing.filter((item) => item.requiresVip);
  const others = missing.filter((item) => !item.requiresVip);
  let text = "", tone = "normal", title = "";
  if (state.qualityError) {
    text = state.qualityError; tone = "warning"; title = state.qualityError;
  } else if (state.auth?.viaPageSession && state.auth?.vipActive) {
    text = missing.length ? `已登录大会员 · 本视频没有 ${list(missing)}` : "已登录大会员";
    tone = "member"; title = "通过当前 B 站页面使用登录态，并检测到有效大会员";
  } else if (state.auth?.viaPageSession) {
    text = vipOnly.length ? `已登录 · ${list(vipOnly)} 需要大会员` : others.length ? `已登录 · 本视频没有 ${list(others)}` : "已登录";
    title = "画质列表以当前账号实际权限为准";
  } else if (state.auth?.hasSessionCookie) {
    text = "登录状态受限，会员画质可能不全"; tone = "warning"; title = "检测到登录 Cookie，但通过页面读取登录态没有成功";
  } else if (state.auth) {
    text = "未登录：只能缓存公开画质"; tone = "warning"; title = "在当前 Chrome 登录 B 站后可缓存更高画质";
  }
  note.hidden = !text || isAudioMode() && tone !== "warning";
  setText(note, text);
  note.dataset.tone = tone;
  note.title = [title, ladder?.title].filter(Boolean).join("\n");
}

function getQualityDisplayOptions(cached) {
  const options = [...state.qualityOptions];
  const cachedQuality = Number(cached?.requestedQuality || cached?.quality) || 0;
  if (cachedQuality && !options.some((option) => option.quality === cachedQuality)) {
    options.push({ quality: cachedQuality, label: cached.qualityLabel || `画质 ${cachedQuality}` });
  }
  return options;
}

function qualityLabel(quality, index) {
  return `${quality.label}${index === 0 && state.qualityOptions.length > 1 ? "（最高）" : ""}`;
}

function qualityAccess(quality) {
  return quality.requiresVip ? "大会员" : quality.requiresLogin ? "登录可用" : "";
}

function renderQualityMenu(options, cached) {
  const rows = options.map((quality, index) => [quality.quality, qualityLabel(quality, index), sizeText(quality.quality, cached), qualityAccess(quality)]);
  const signature = JSON.stringify(rows);
  if (signature === state.qualityMenuSignature) return;
  state.qualityMenuSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const [value, label, size, access] of rows) {
    const option = document.createElement("button");
    option.className = "quality-option";
    option.type = "button";
    option.setAttribute("role", "option");
    option.dataset.quality = String(value);
    const name = document.createElement("span"); name.className = "quality-option-label"; name.textContent = label;
    const bytes = document.createElement("span"); bytes.className = "quality-option-size"; bytes.textContent = size;
    option.append(name, bytes);
    if (access) { const note = document.createElement("span"); note.className = "quality-option-note"; note.textContent = access; option.append(note); }
    fragment.append(option);
  }
  elements.qualityMenu.replaceChildren(fragment);
}

function setQualityTrigger(label, size, disabled, extraTitle = "") {
  setText(elements.qualityTriggerLabel, label);
  setText(elements.cacheSize, size);
  elements.qualityTrigger.disabled = disabled;
  elements.qualityTrigger.title = [label, size, extraTitle].filter(Boolean).join("\n");
  if (disabled) closeQualityMenu();
}

/** 对比 B 站声明的档位与当前账号实际返回的轨道，让「是不是最高规格」有答案。 */
function describeQualityLadder(options) {
  const declared = Array.isArray(state.cacheSizeInfo?.declared) ? state.cacheSizeInfo.declared : [];
  const describe = (quality) => `${quality.label}${quality.requiresVip ? "（大会员）" : quality.requiresLogin ? "（需登录）" : ""}`;
  const missing = declared.filter((item) => !options.some((option) => option.quality === item.quality));
  if (!declared.length) return { missing: [], missingText: "", title: "" };
  return {
    missing,
    missingText: missing.map(describe).join("、"),
    title: [`B 站声明可用：${declared.map(describe).join(" / ")}`, `当前账号返回：${options.map((option) => option.label).join(" / ") || "无"}`].join("\n")
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
  if (state.tab?.url && state.selectedQuality) {
    void send("SET_POPUP_SELECTION", { tabId: state.tab.id, url: state.tab.url, quality: state.selectedQuality, codec: state.selectedCodec }).catch(() => {});
  }
  closeQualityMenu();
  renderCurrent();
  elements.qualityTrigger.focus();
}

function openQualityMenuFromKeyboard(event) {
  if (!["ArrowDown", "ArrowUp"].includes(event.key) || elements.qualityTrigger.disabled) return;
  event.preventDefault();
  state.focusQualityOptionOnOpen = true;
  if (isQualityMenuOpen()) focusSelectedQualityOption();
  else elements.qualityMenu.showPopover();
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
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = Math.max(0, options.indexOf(document.activeElement));
  const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
    : event.key === "ArrowDown" ? (current + 1) % options.length : (current - 1 + options.length) % options.length;
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
  const padding = 12;
  menu.style.minWidth = `${Math.round(rect.width)}px`;
  menu.style.maxWidth = `${Math.max(180, window.innerWidth - padding * 2)}px`;
  const menuRect = menu.getBoundingClientRect();
  const left = Math.max(padding, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - padding));
  let top = rect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - padding) top = Math.max(padding, rect.top - menuRect.height - 4);
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
  elements.cacheButton.style.setProperty("--progress-ratio", String(Math.max(0, Math.min(1, progress))));
  setText(elements.buttonLabel, label);
  setText(elements.buttonSpeed, speed);
  setAttr(elements.cacheButton, "aria-label", speed ? `${label}，${speed}` : label);
}

function setHint(message, isError) {
  setText(elements.actionHint, message);
  elements.actionHint.dataset.tone = isError ? "error" : "normal";
  elements.actionHint.hidden = !message;
}

async function startCache() {
  if (!state.pageInfo?.supported || !state.tab) return;
  if (!isAudioMode() && !state.selectedQuality) return;
  setButtonState("downloading", "正在连接缓存节点", "", 0, true);
  setHint("正在获取当前视频的可缓存版本…", false);
  try {
    await send("START_CACHE", { url: state.tab.url, tabId: state.tab.id, quality: state.selectedQuality, codec: state.selectedCodec, mode: state.cacheMode });
    await refreshLibrary();
  } catch (error) {
    setButtonState("error", "重试缓存", "", 0, false);
    setHint(error.message, true);
  }
}

async function pauseCurrentTask() {
  const cached = findCurrentVideo();
  if (!cached || state.pausePending) return;
  state.pausePending = true;
  elements.pauseButton.disabled = true;
  try {
    await pauseTask(cached.id);
  } finally {
    state.pausePending = false;
    if (state.pageInfo) renderCurrent();
  }
}

// ---- 提前加载 ----------------------------------------------------------------

async function persistProgressAppearance(patch) {
  const previous = state.assistConfig;
  const revision = ++state.appearanceRevision;
  state.appearancePending++;
  state.assistConfig = { ...previous, ...patch };
  renderAssist();
  // 连续改色/切换时按操作顺序落盘；轮询与较早响应不得覆盖尚未完成的选择。
  const request = state.appearanceQueue.then(() => send("SET_ASSIST_CONFIG", { patch }));
  state.appearanceQueue = request.catch(() => {});
  try {
    const result = await request;
    state.confirmedAssistConfig = result.config;
    if (revision === state.appearanceRevision) state.assistConfig = result.config;
  } catch (error) {
    // 连续失败时 previous 可能也是尚未保存的乐观值，必须回到最后一次确认配置。
    if (revision === state.appearanceRevision) state.assistConfig = state.confirmedAssistConfig || previous;
    showToast(error.message);
  } finally {
    state.appearancePending--;
    renderAssist();
  }
}

async function refreshAssistState() {
  if (!state.tab?.id) return;
  const revision = state.appearanceRevision;
  const readSequence = ++state.assistReadSequence;
  try {
    const result = await send("GET_ASSIST_STATE", { tabId: state.tab.id });
    if (readSequence !== state.assistReadSequence) return;
    if (!state.appearancePending && revision === state.appearanceRevision) {
      state.assistConfig = result.config || state.assistConfig;
      state.confirmedAssistConfig = state.assistConfig;
    }
    state.assistStats = result.stats || null;
  } catch {
    if (readSequence !== state.assistReadSequence) return;
    state.assistStats = null;
  }
  renderAssist();
}

function renderAssist() {
  const config = state.assistConfig || { mode: "always", preheatColor: DEFAULT_PREHEAT_COLOR };
  renderAppearance(config);
  elements.assistPanel.hidden = !state.pageInfo?.supported;
  if (elements.assistPanel.hidden) return;
  const stats = state.assistStats;
  const enabled = config.mode !== "off";
  const live = enabled && stats && Date.now() - stats.at < 5000;
  const finite = (value) => Math.max(0, Number(value) || 0);
  const metrics = {
    speed: live ? formatSpeed(finite(stats.networkSpeed)) : "—",
    hit: live ? formatBytes(finite(stats.cacheHitMB) * 1024 * 1024) : "—",
    ready: live ? `${finite(stats.prefetchAheadSec).toFixed(0)} 秒` : "—",
    buffer: live ? `${finite(stats.bufferAheadSec).toFixed(1)} 秒` : "—",
    connections: live ? `${finite(stats.networkActive)} / ${finite(stats.networkLimit)}` : "—",
    rescues: live ? `${finite(stats.networkRescues)} 次` : "—",
    accelerated: live ? `${finite(stats.acceleratedRequests)} 次` : "—",
    fallbacks: live ? `${finite(stats.nativeFallbacks)} 次` : "—",
    node: live ? (stats.networkHost || "等待连接") : (enabled ? "等待数据" : "已关闭")
  };
  for (const [key, value] of Object.entries(metrics)) setText(elements.assistMetrics[key], value);
  setAttr(elements.assistMetrics.node, "title", metrics.node);
  elements.assistToggle.setAttribute("aria-checked", String(enabled));

  // 状态只看新鲜的统计：页面没在播放或统计过期时，不能沿用旧的「正在加载」。
  let status = "已关闭", tone = "off";
  if (enabled && (!live || !stats.activeTracks)) { status = "等待视频播放"; tone = "waiting"; }
  else if (enabled && stats.prefetchErrors > 0 && !stats.prefetching && !(stats.prefetchAheadSec > 0)) { status = "连接不稳定，自动重试中"; tone = "warning"; }
  else if (enabled && stats.prefetching > 0) { status = "正在提前加载"; tone = "active"; }
  else if (enabled && stats.prefetchAheadSec > 0) { status = "前方已就绪"; tone = "active"; }
  else if (enabled) { status = "已开启"; tone = "active"; }
  setText(elements.assistStatus, status);
  elements.assistStatus.dataset.state = tone;
}

function renderAppearance(config) {
  if (document.activeElement !== elements.progressColor) elements.progressColor.value = config.progressColor || DEFAULT_PROGRESS_COLOR;
  const highlight = config.showPreheatHighlight !== false;
  elements.showPreheatHighlight.checked = highlight;
  elements.preheatControls.disabled = !highlight;
  elements.appearance.dataset.highlight = String(highlight);
  elements.appearance.style.setProperty("--played-color", config.progressColor || DEFAULT_PROGRESS_COLOR);
  const color = normalizePreheatColor(config.preheatColor);
  elements.appearance.style.setProperty("--preheat-color", color);
  const presets = new Set(PREHEAT_COLOR_PRESETS.map((preset) => preset.value));
  for (const button of elements.assistColors.querySelectorAll("[data-assist-color]")) {
    button.setAttribute("aria-checked", String(button.dataset.assistColor === color));
    button.tabIndex = button.dataset.assistColor === color || !presets.has(color) && button === elements.assistColors.firstElementChild ? 0 : -1;
  }
  if (document.activeElement !== elements.assistCustomColor) elements.assistCustomColor.value = color;
  elements.assistCustomColorShell.dataset.selected = String(!presets.has(color));
}

function renderAssistColorPresets() {
  const fragment = document.createDocumentFragment();
  for (const preset of PREHEAT_COLOR_PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "radio");
    button.dataset.assistColor = preset.value;
    button.title = preset.label;
    button.setAttribute("aria-label", preset.label);
    button.setAttribute("aria-checked", "false");
    button.style.setProperty("--swatch-color", preset.value);
    fragment.append(button);
  }
  elements.assistColors.replaceChildren(fragment);
}

// ---- 浏览器自检与关于 ---------------------------------------------------------

/** 读取浏览器侧自检结论（见 src/health-check.js）。主视图只在失败时提示，详情在设置里。 */
async function refreshHealth({ refresh = false } = {}) {
  elements.browserHealthRefresh.disabled = true;
  try {
    state.healthReport = (await send("GET_HEALTH", { refresh })).report || null;
    state.healthError = "";
  } catch (error) {
    state.healthReport = null;
    state.healthError = error?.message || "无法读取自检结果";
  } finally {
    elements.browserHealthRefresh.disabled = false;
  }
  renderHealth();
}

function renderHealth() {
  const report = state.healthReport;
  const failed = (report?.checks || []).filter((check) => !check.ok);
  const problem = Boolean(state.healthError) || failed.length > 0;
  elements.healthBanner.hidden = !problem || state.settingsOpen;
  elements.settingsAlert.hidden = !problem;
  if (!report && !state.healthError) return;
  // 自检结论是低频数据；只有内容变化才重建列表，保持节点身份与键盘焦点。
  const signature = state.healthError || `${report.browserVersion}|${failed.map((check) => `${check.id}:${check.detail}`).join("|")}`;
  if (signature === state.healthSignature) return;
  state.healthSignature = signature;
  // 不写「N 项」这类数字加量词：中文可断行，窄宽度下会把数字与量词拆到两行。
  setText(elements.browserHealthStatus, state.healthError ? `自检未完成：${state.healthError}`
    : failed.length ? `浏览器自检未通过（Chrome ${report.browserVersion || "版本未知"}），下面列出的能力当前不可用`
      : `全部正常（Chrome ${report.browserVersion || "版本未知"}）`);
  elements.browserHealthStatus.dataset.state = problem ? "failed" : "ok";
  elements.browserHealthList.replaceChildren(...failed.map((check) => {
    const item = document.createElement("li");
    item.dataset.healthCheck = check.id;
    const label = document.createElement("strong");
    label.textContent = check.label;
    const detail = document.createElement("span");
    detail.textContent = check.detail;
    item.append(label, detail);
    return item;
  }));
}

function renderAbout() {
  try { setText(elements.aboutVersion, chrome.runtime.getManifest?.().version || "—"); } catch { /* 测试夹具里没有 manifest。 */ }
}

// ---- 片库 --------------------------------------------------------------------

const ACTION_ICONS = {
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M15 6v12"/></svg>',
  resume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5-10-6.5Z"/></svg>',
  save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="download-arrow" d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/></svg>',
  delete: '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="trash-lid" d="M5 7h14M9 7V4h6v3"/><path d="m7 7 1 13h8l1-13M10 10v7m4-7v7"/></svg>'
};

function libraryVideos() {
  return state.videos.filter((video) => shouldShowInLibrary(video) && !state.pendingDeletes.has(video.id)).sort(compareLibraryTasks);
}

function renderLibrary() {
  const videos = libraryVideos();
  setText(elements.libraryCount, videos.length > 99 ? "99+" : String(videos.length));
  elements.libraryCount.title = `${videos.length} 个本地视频`;
  const bytes = videos.reduce((sum, video) => sum + committedBytes(video), 0);
  setText(elements.librarySummary, videos.length ? `${videos.length} 个视频 · ${formatBytes(bytes)}` : "");
  elements.librarySummary.hidden = !videos.length;
  const ids = new Set(videos.map((video) => video.id));
  for (const row of elements.videoList.querySelectorAll(".video-item")) {
    if (!ids.has(row.dataset.videoId)) { state.speedSamples.delete(row.dataset.videoId); row.remove(); }
  }
  if (!videos.length) { renderEmptyLibrary("还没有缓存", "在「当前视频」里缓存正在看的视频"); return; }
  elements.videoList.querySelector(".empty-state")?.remove();
  const rows = new Map([...elements.videoList.querySelectorAll(".video-item")].map((row) => [row.dataset.videoId, row]));
  let cursor = elements.videoList.firstElementChild;
  for (const video of videos) {
    const row = rows.get(video.id) || createVideoItem(video);
    updateVideoItem(row, video);
    // 只有成员/创建顺序变化才移动节点；普通进度更新不触发 hover/focus/动画重启。
    if (row === cursor) cursor = cursor.nextElementSibling;
    else elements.videoList.insertBefore(row, cursor);
  }
}

function renderEmptyLibrary(title, detail) {
  let empty = elements.videoList.querySelector(".empty-state");
  if (!empty) {
    empty = document.createElement("div");
    empty.className = "empty-state";
    empty.append(document.createElement("strong"), document.createElement("p"));
    elements.videoList.append(empty);
  }
  setText(empty.querySelector("strong"), title);
  setText(empty.querySelector("p"), detail);
}

function createVideoItem(video) {
  const item = document.createElement("article");
  item.className = "video-item";
  item.dataset.videoId = video.id;
  item.video = video;
  // 静态骨架只创建一次；外部标题、URL 和状态始终通过安全的属性/textContent 写入。
  item.innerHTML = `<div class="cover-wrap"><img alt="" loading="lazy" referrerpolicy="no-referrer"><span class="cover-status"></span></div>
    <div class="video-copy"><a class="video-link"></a><p class="video-meta"><span class="video-state"></span><span class="owner-separator"> · </span><a class="video-owner"></a></p><div class="item-progress" hidden><span></span></div></div>
    <div class="video-actions"><button class="item-action toggle-button" type="button"></button><button class="item-action save-button" type="button">${ACTION_ICONS.save}</button><button class="item-action delete-button" type="button">${ACTION_ICONS.delete}</button></div>`;
  const image = item.querySelector("img");
  image.addEventListener("error", () => { image.hidden = true; });
  item.querySelector(".video-link").addEventListener("click", (event) => {
    event.preventDefault();
    const url = normalizeHttpUrl(item.video.url);
    if (url) chrome.tabs.create({ url });
  });
  item.querySelector(".video-owner").addEventListener("click", (event) => {
    event.preventDefault();
    const url = normalizeHttpUrl(item.video.ownerUrl) || makeBiliSpaceUrl(item.video.ownerId);
    if (url) chrome.tabs.create({ url });
  });
  const toggle = item.querySelector(".toggle-button"), save = item.querySelector(".save-button"), remove = item.querySelector(".delete-button");
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      if (item.video.status === "downloading") await pauseTask(item.video.id);
      else await resumeTask(item.video.id);
    } finally {
      toggle.disabled = false;
    }
  });
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const result = await send("SAVE_VIDEO", { videoId: item.video.id });
      showToast(result.splitTracks ? "高画质为双轨，已分别保存视频轨和音频轨" : "已交给 Chrome 保存");
    } catch (error) {
      showToast(error.message);
    } finally {
      save.disabled = false;
    }
  });
  remove.addEventListener("click", () => void deleteWithUndo(item.video));
  return item;
}

function updateVideoItem(item, video) {
  item.video = video;
  item.dataset.status = video.status;
  const title = video.partTitle || video.title || "视频";
  const image = item.querySelector("img");
  // 片库记录里的封面是 http 地址；扩展页里统一换成 https，避免混合内容拦截。
  const cover = normalizeHttpUrl(video.cover)?.replace(/^http:/, "https:") || null;
  if (image.getAttribute("src") !== cover) {
    if (cover) image.src = cover; else image.removeAttribute("src");
    image.hidden = !cover;
  }
  const progress = taskProgress(video);
  setText(item.querySelector(".cover-status"), video.status === "complete" ? formatDuration(video.duration) : `${Math.floor(progress * 100)}%`);
  const link = item.querySelector(".video-link");
  setText(link, title);
  setAttr(link, "title", video.status === "complete" ? `打开原视频（自动使用本地缓存播放）：${title}` : `打开原视频：${title}`);
  setAttr(link, "href", normalizeHttpUrl(video.url) || "#");
  const owner = item.querySelector(".video-owner");
  setText(owner, video.owner || "");
  owner.hidden = !video.owner;
  item.querySelector(".owner-separator").hidden = !video.owner;
  const ownerUrl = normalizeHttpUrl(video.ownerUrl) || makeBiliSpaceUrl(video.ownerId);
  if (ownerUrl) owner.href = ownerUrl; else owner.removeAttribute("href");

  const speedSample = video.status === "downloading" ? sampleSpeed(state.speedSamples.get(video.id), video) : null;
  if (speedSample) state.speedSamples.set(video.id, speedSample);
  const status = video.status === "complete"
    ? (isAudioOnlyCache(video) ? ["仅音频", video.audioLabel || describeAudioTrack(video)] : [video.qualityLabel || "MP4", video.codecLabel || CODEC_LABELS[video.codec]]).filter(Boolean).join(" · ")
    : video.status === "downloading"
      ? video.stage === "merging" ? "合并中" : video.stage === "extracting" ? "提取音频中" : Number(video.nextRetryAt) > Date.now() ? "等待自动续传"
        : video.error ? "正在恢复" : speedSample?.value > 0 ? formatSpeed(speedSample.value) : "缓存中"
      : video.status === "paused" ? "已暂停" : "未完成";
  const state_ = item.querySelector(".video-state");
  setText(state_, `${status} · ${formatBytes(committedBytes(video))}`);
  setAttr(state_, "title", video.status === "error" ? video.error || "" : "");
  const bar = item.querySelector(".item-progress");
  bar.hidden = video.status === "complete";
  bar.firstElementChild.style.setProperty("--progress-ratio", String(progress));

  // 第一个按钮按状态切换：下载中 → 暂停；暂停/出错 → 继续；完成 → 保存（位置不变，列对齐）。
  const toggle = item.querySelector(".toggle-button"), save = item.querySelector(".save-button");
  const complete = video.status === "complete";
  toggle.hidden = complete;
  save.hidden = !complete;
  if (!complete) {
    const mode = video.status === "downloading" ? "pause" : "resume";
    if (toggle.dataset.mode !== mode) { toggle.dataset.mode = mode; toggle.innerHTML = ACTION_ICONS[mode]; }
    setAttr(toggle, "aria-label", `${mode === "pause" ? "暂停" : "继续"}缓存《${title}》`);
    setAttr(toggle, "title", mode === "pause" ? "暂停缓存" : "继续缓存（不需要打开原视频）");
  }
  setAttr(save, "aria-label", `保存《${title}》到电脑`);
  setAttr(save, "title", isAudioOnlyCache(video) ? `保存音频文件（${describeAudioContainer(video)}，未转码）`
    : video.merged ? "保存已合并音视频的单个 MP4" : video.mediaKind === "dash" && video.tracks?.audio ? "保存视频轨和音频轨" : "保存视频");
  const remove = item.querySelector(".delete-button");
  setAttr(remove, "aria-label", `删除《${title}》的缓存`);
  setAttr(remove, "title", "删除缓存");
}

async function pauseTask(videoId) {
  try {
    const result = await send("PAUSE_CACHE", { videoId });
    if (result.video) mergeTask(result.video);
    if (!result.paused && result.video?.status === "complete") showToast("已经缓存完成");
  } catch (error) {
    showToast(error.message);
  }
}

async function resumeTask(videoId) {
  try {
    const result = await send("RESUME_CACHE", { videoId });
    if (result.video) mergeTask(result.video);
  } catch (error) {
    showToast(error.message);
  }
}

function mergeTask(video) {
  state.libraryRevision++;
  const index = state.videos.findIndex((item) => item.id === video.id);
  if (index >= 0) state.videos.splice(index, 1, newerTask(state.videos[index], video));
  else state.videos.push(video);
  renderLibrary();
  if (state.pageInfo) renderCurrent();
}

/**
 * 删除：立即从列表隐藏并给出可撤销提示（不用确认弹窗），超时后才真正删除数据。
 * 下载中的任务先暂停，撤销时再继续；弹窗关闭时未撤销的删除立即提交（见 initialize）。
 */
function deleteWithUndo(video) {
  if (state.pendingDeletes.has(video.id)) return;
  const title = video.partTitle || video.title || "视频";
  const pending = { resume: video.status === "downloading", timer: null };
  state.pendingDeletes.set(video.id, pending);
  renderLibrary();
  if (state.pageInfo) renderCurrent();
  if (pending.resume) void send("PAUSE_CACHE", { videoId: video.id }).catch(() => {});
  pending.timer = setTimeout(() => void commitDelete(video.id), DELETE_UNDO_MS);
  showToast(`已删除《${title}》`, {
    action: "撤销",
    duration: DELETE_UNDO_MS,
    onAction: () => {
      clearTimeout(pending.timer);
      state.pendingDeletes.delete(video.id);
      renderLibrary();
      if (state.pageInfo) renderCurrent();
      if (pending.resume) void resumeTask(video.id);
    }
  });
}

async function commitDelete(videoId) {
  if (!state.pendingDeletes.has(videoId)) return;
  try {
    await send("DELETE_VIDEO", { videoId });
    state.libraryRevision++;
    state.deletedAt.set(videoId, Date.now());
    state.videos = state.videos.filter((video) => video.id !== videoId);
  } catch (error) {
    showToast(`删除失败：${error.message}`);
  } finally {
    state.pendingDeletes.delete(videoId);
    renderLibrary();
    if (state.pageInfo) renderCurrent();
  }
}

// ---- 通用 --------------------------------------------------------------------

function setAttr(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

function showToast(message, { action = "", onAction = null, duration = 1800 } = {}) {
  setText(elements.toastText, message);
  elements.toastAction.hidden = !action;
  setText(elements.toastAction, action);
  elements.toastAction.onAction = onAction;
  elements.toast.dataset.visible = "true";
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(state.toastTimer);
  elements.toast.dataset.visible = "false";
  elements.toastAction.onAction = null;
}

async function send(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: "background", type, ...data });
  if (!response?.ok) throw new Error(response?.error || "扩展后台没有响应");
  return response;
}
