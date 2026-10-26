import { DISTRIBUTION, GITHUB_RELEASES } from "./distribution.js";
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
import { connectPendingDeletes } from "./pending-deletes.js";
import {
  DEFAULT_PREHEAT_COLOR,
  normalizePreheatColor,
  PREHEAT_COLOR_PRESETS
} from "./assist-config.js";
import { localizeDocument, t } from "./i18n.js";
import {
  completeReviewPrompt,
  defaultReviewState,
  dismissReviewPrompt,
  markFirstSeen,
  normalizeReviewState,
  REVIEW_PROMPT_KEY,
  REVIEW_URL,
  shouldShowReviewPrompt,
  snoozeReviewPrompt
} from "./review-prompt.js";

const updateLink = document.querySelector('#update-link');
if (updateLink) {
  const github = DISTRIBUTION !== 'store';
  updateLink.href = github && chrome.runtime.getURL ? chrome.runtime.getURL('update.html') : GITHUB_RELEASES;
  updateLink.dataset.i18n = github ? 'update.open' : 'update.download';
}

const DEFAULT_PROGRESS_COLOR = "#00a1d6";
// 删除先从列表隐藏，提示里可撤销；超时（或弹窗关闭）才真正删除数据。
const DELETE_UNDO_MS = 6000;
// 未登录时「去登录」打开的 B 站登录页；只是新开一个标签，不需要额外权限，也不读取任何账号数据。
const BILIBILI_LOGIN_URL = "https://passport.bilibili.com/login";
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
  qualityName: $("#quality-name"),
  qualitySize: $("#quality-size"),
  qualityTrack: $("#quality-track"),
  qualityLocked: $("#quality-locked"),
  qualityStops: $("#quality-stops"),
  qualitySlider: $("#quality-slider"),
  qualityKnob: $("#quality-track .quality-knob"),
  qualityLow: $("#quality-low"),
  qualityHigh: $("#quality-high"),
  audioRow: $("#audio-row"),
  audioSummary: $("#audio-summary"),
  authNote: $("#auth-note"),
  authNoteText: $("#auth-note-text"),
  authAction: $("#auth-action"),
  accountChip: $("#account-chip"),
  cacheButton: $("#cache-button"),
  buttonLabel: $("#button-label"),
  buttonSpeed: $("#button-speed"),
  buttonSub: $("#button-sub"),
  actionHint: $("#action-hint"),
  pauseButton: $("#pause-button"),
  assistPanel: $("#assist-panel"),
  assistToggle: $("#assist-toggle"),
  assistDetailsToggle: $("#assist-details-toggle"),
  assistMetricsPanel: $("#assist-metrics-panel"),
  assistStatus: $("#assist-status"),
  assistMetrics: Object.fromEntries(["speed", "hit", "buffer", "ready", "stalls", "residency", "trouble", "node", "accelerated"].map(key => [key, $(`#assist-${key}`)])),
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
  aboutReview: $("#about-review"),
  reviewCard: $("#review-card"),
  reviewGo: $("#review-go"),
  reviewLater: $("#review-later"),
  reviewNever: $("#review-never"),
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
  // 与后台的待删登记通道；弹窗关闭时由后台提交仍在撤销期内的删除。
  pendingDeleteChannel: null,
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
  qualityStopsSignature: "",
  // 滑杆的档位（从低到高）：open 可选，locked 是当前账号拿不到、画成杆尾斜纹的更高档位。
  qualityStops: { open: [], locked: [] },
  // 滑杆几何：可选段最右档的位置（0–1）与当前所选档位的位置，供拖动换算与松手落定。
  qualityReach: 1,
  qualityRatio: 1,
  // 只有用户拖动 / 按键换档时为 true：轮询刷新或首次渲染进入顶档不播「登顶」动画。
  qualityInteractive: false,
  qualityDragPointer: null,
  // 指针操作的落定阶段：拇指正滑向所选档位，名称/体积等拇指停稳后才切换（见 endQualityDrag）。
  qualitySettling: false,
  qualitySettleCancel: null,
  qualityPress: null,
  qualityDragRatio: 0,
  qualitySurgeTimer: 0,
  assistConfig: null,
  assistStats: null,
  assistReadSequence: 0,
  healthReport: null,
  // 评价邀请的持久状态；读出之前为 null，此时卡片一律不显示。
  review: null,
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
  if (event.key === "Escape" && state.settingsOpen) setSettingsOpen(false);
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
// 拖动 / 方向键时 input 连续触发，只更新界面；松手或按键结束（change）才把选择存回后台。
elements.qualitySlider.addEventListener("input", selectQualityFromSlider);
elements.qualitySlider.addEventListener("change", () => { if (!state.qualitySettling) persistQualitySelection(); });
// 跟手：按住期间看得见的拇指按指针连续移动，松手后弹回所选档位（原生 range 照常按整档改 value）。
elements.qualitySlider.addEventListener("pointerdown", startQualityDrag);
elements.qualitySlider.addEventListener("pointermove", followQualityDrag);
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) elements.qualitySlider.addEventListener(type, endQualityDrag);
elements.authAction.addEventListener("click", () => chrome.tabs.create({ url: BILIBILI_LOGIN_URL }));
elements.assistDetailsToggle.addEventListener("click", () => {
  const open = elements.assistDetailsToggle.getAttribute("aria-expanded") !== "true";
  elements.assistDetailsToggle.setAttribute("aria-expanded", String(open));
  elements.assistMetricsPanel.hidden = !open;
});
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

localizeDocument();
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
  // 撤销期内的删除登记到后台：弹窗怎么关闭都由后台提交（见 pending-deletes.js）。
  state.pendingDeleteChannel = connectPendingDeletes({
    connect: (info) => chrome.runtime.connect(info),
    getPending: () => state.pendingDeletes.keys()
  });
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tabs[0] || null;
  await loadCacheModePreference();
  await loadReviewState();
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
    // 撤销期内的删除不在这里补发：关闭中的弹窗发出的消息会被丢弃，由后台在 port 断开时提交。
  }, { once: true });
}

async function restorePopupSnapshot() {
  if (!state.tab?.url) {
    renderUnsupported(t("page.unreadable"), t("page.reopen"));
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
      state.qualityError = silent ? t("quality.refreshFailed", { error: error.message }) : error.message;
      renderCurrent();
    } else {
      renderUnsupported(t("page.unrecognized"), error.message);
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
    if (!state.videos.length) renderEmptyLibrary(t("library.readFailed"), error.message);
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
  setButtonState("disabled", t("button.unsupportedPage"), "", 0, true);
  setHint(t("hint.unsupportedPage"), false);
}

function renderCurrent() {
  const info = state.pageInfo;
  if (!info?.supported) {
    renderUnsupported(info?.message || t("page.openVideo"), t("page.supported"));
    return;
  }

  setText(elements.currentHeading, info.partTitle || info.title);
  const ownerUrl = normalizeHttpUrl(info.ownerUrl) || makeBiliSpaceUrl(info.ownerId);
  elements.currentOwner.hidden = !info.owner;
  setText(elements.currentOwner, info.owner || "");
  elements.currentOwner.title = ownerUrl ? t("owner.open", { owner: info.owner }) : "";
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

const TOGGLE_ICONS = {
  pause: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5.5v9M12.5 5.5v9"/></svg>',
  resume: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 5.2v9.6L15 10 7.5 5.2Z"/></svg>'
};

/**
 * 主按钮内右侧的圆钮：下载中是「暂停」，暂停 / 出错时是「继续」。
 * 只在模式变化时换图标，避免进度刷新打断 hover 动效与焦点。
 */
function renderTaskToggle(status) {
  const toggle = elements.pauseButton;
  const mode = status === "downloading" ? "pause" : status === "paused" || status === "error" ? "resume" : "";
  toggle.hidden = !mode;
  toggle.disabled = state.pausePending;
  if (!mode || toggle.dataset.mode === mode) return;
  toggle.dataset.mode = mode;
  toggle.innerHTML = TOGGLE_ICONS[mode];
  const label = t(mode === "pause" ? "task.pause" : "task.resume");
  setAttr(toggle, "aria-label", label);
  setAttr(toggle, "title", label);
}

/** 主按钮与下方状态行：空闲 → 缓存；下载中 → 进度 + 速度 + 「暂停」；暂停 / 出错 → 同样的进度样式 + 「继续」；完成 → 结果。 */
function renderCacheAction(cached) {
  renderTaskToggle(cached?.status);
  if (!cached) {
    if (state.qualitiesLoading) {
      setButtonState("disabled", t("button.loadingQualities"), "", 0, true);
      setHint("", false);
      return;
    }
    if (isAudioMode() && !getAudioCacheSize(state.cacheSizeInfo, null)) {
      setButtonState("disabled", t("button.noAudio"), "", 0, true);
      setHint(state.qualityError || t("hint.noAudio"), true);
      return;
    }
    if (!isAudioMode() && !state.selectedQuality) {
      setButtonState("disabled", t("button.noQuality"), "", 0, true);
      setHint(state.qualityError || t("hint.noQuality"), true);
      return;
    }
    setButtonState("idle", t("button.cache"), "", 0, false);
    setHint(isAudioMode() && getAudioCacheSize(state.cacheSizeInfo, null)?.mode === "extract"
      ? t("hint.extract") : "", false);
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
    const label = t(retrySeconds > 0 ? "button.waitRetry" : extracting ? "button.extracting"
      : merging ? "button.merging" : cached.error ? "button.recovering" : "button.caching", { percent });
    const speed = retrySeconds > 0 ? `${retrySeconds}s` : merging || extracting ? t("speed.processing")
      : speedSample.value > 0 ? formatSpeed(speedSample.value) : t("speed.connecting");
    // 已缓存字节数放进按钮第二行；只有需要解释的状态（提取 / 合并 / 出错）才占独立提示行，省出一行高度。
    const special = extracting ? t("hint.extracting") : merging ? t("hint.merging") : cached.error || "";
    setButtonState("downloading", label, speed, progress, true, special ? "" : `${formatBytes(committedBytes(cached))} / ${formatBytes(cached.totalBytes)}`);
    setHint(special, false);
    elements.cacheButton.title = special ? "" : t("button.backgroundTip");
    return;
  }
  if (cached.status === "complete") {
    setButtonState("complete", t("button.cached"), formatBytes(cached.downloadedBytes), 1, true);
    setHint(cached.mergeError ? t("hint.mergeFailed", { error: cached.mergeError }) : t("hint.cachedPlayback"), Boolean(cached.mergeError));
    return;
  }
  // 暂停与出错沿用下载中的进度样式（不再变回粉色的「缓存」主按钮）：已缓存字节写在第二行，点主按钮或圆钮都能继续。
  const bytes = `${formatBytes(committedBytes(cached))} / ${formatBytes(cached.totalBytes)}`;
  if (cached.status === "paused") {
    setButtonState("paused", t("button.paused", { percent }), "", progress, false, bytes);
    setHint("", false);
    elements.cacheButton.title = t("item.resumeTip");
    return;
  }
  setButtonState("error", t("button.resume", { percent }), "", progress, false, bytes);
  setHint(cached.error || t("hint.incomplete"), true);
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
    const size = getAudioCacheSize(state.cacheSizeInfo, cached);
    setText(elements.audioSummary, size ? [size.label, approxBytes(size)].filter(Boolean).join(" · ") : t("audio.unknownSize"));
    elements.audioSummary.title = size?.mode === "extract"
      ? t("audio.extractTip")
      : t("audio.tip");
  } else if (state.qualitiesLoading) {
    renderQualitySlider([], cached, t("quality.loading"));
  } else {
    const options = getQualityDisplayOptions(cached);
    if (!options.some((option) => option.quality === state.selectedQuality)) state.selectedQuality = options[0]?.quality || 0;
    ladder = describeQualityLadder(options);
    renderQualitySlider(options, cached, t("quality.none"));
    elements.qualityTrack.title = ladder.title;
  }
  renderAuthNote(ladder);
}

function sizeText(quality, cached) {
  if (!quality) return "";
  const size = getCacheSize(state.cacheSizeInfo, quality, cached);
  return size ? approxBytes(size) : "";
}

function approxBytes(size) {
  return size.estimated ? t("size.approx", { size: formatBytes(size.bytes) }) : formatBytes(size.bytes);
}

/**
 * 账号说明只在「影响这次能选什么」时出现，并且放在画质滑杆下面：
 * - 大会员：不再写一句「已登录大会员」，只在分段控件右侧挂一枚「大会员」小标记；
 * - 未登录：说明登录后能多选哪些档，并给出「去登录」入口（在新标签打开 B 站登录页，不需要新权限）；
 * - 已登录但不是大会员：只在杆尾有大会员档被锁时说一句「4K 需要大会员」；
 * - 读取出错 / 登录态受限：警示色说明，仅音频模式下也保留。
 * B 站声明了、但大会员账号也没拿到的档位，是这个视频本身没有，杆上不画、这里也不提，完整对照在悬停提示里。
 */
function renderAuthNote(ladder) {
  const locked = isAudioMode() ? [] : state.qualityStops.locked;
  const list = (items) => items.slice(0, 2).map((item) => item.label).join(t("sep.list")) + (items.length > 2 ? t("list.more") : "");
  const signedIn = Boolean(state.auth?.viaPageSession);
  const vip = signedIn && Boolean(state.auth?.vipActive);
  let text = "", tone = "normal", title = "", action = false;
  if (state.qualityError) {
    text = state.qualityError; tone = "warning"; title = state.qualityError;
  } else if (!signedIn && state.auth?.hasSessionCookie) {
    text = t("auth.limited"); tone = "warning"; title = t("auth.limitedTip");
  } else if (!signedIn && state.auth) {
    const loginOnly = locked.filter((item) => !item.requiresVip);
    text = loginOnly.length ? t("auth.unlockLogin", { list: list(loginOnly) }) : t("auth.signedOut");
    title = t("auth.signedOutTip"); action = true;
  } else if (signedIn && !vip && locked.length) {
    text = t("auth.unlockVip", { list: list(locked) }); title = t("auth.signedInTip");
  }
  const note = elements.authNote;
  note.hidden = !text || isAudioMode() && tone !== "warning";
  setText(elements.authNoteText, text);
  note.dataset.tone = tone;
  note.title = [title, ladder?.title].filter(Boolean).join("\n");
  elements.authAction.hidden = !action;
  elements.accountChip.hidden = !vip;
  elements.accountChip.title = [t("auth.vipTip"), ladder?.title].filter(Boolean).join("\n");
}

function getQualityDisplayOptions(cached) {
  const options = [...state.qualityOptions];
  const cachedQuality = Number(cached?.requestedQuality || cached?.quality) || 0;
  if (cachedQuality && !options.some((option) => option.quality === cachedQuality)) {
    options.push({ quality: cachedQuality, label: cached.qualityLabel || t("quality.fallback", { quality: cachedQuality }) });
  }
  return options;
}

/** 杆两端的短名：「4K 超高清」→「4K」。短名重名时（如两个 1080P 档）才退回完整名。 */
function qualityShortLabels(options) {
  const short = options.map((quality) => String(quality.label || "").trim().split(/\s+/)[0] || String(quality.quality));
  return options.map((quality, index) => short.indexOf(short[index]) === short.lastIndexOf(short[index]) ? short[index] : quality.label);
}

/**
 * 滑杆的档位，从低到高（B 站画质编号越大越高）。
 * 锁定段只收「比当前可选最高档还高、且需要登录或大会员」的声明档位：
 * 它们一定排在杆尾，原生 range 只覆盖可选段，拖不进锁定段。大会员账号缺的档位是视频本身没有，不画。
 */
function buildQualityStops(options) {
  const open = [...options].sort((left, right) => left.quality - right.quality);
  const top = open.length ? open[open.length - 1].quality : 0;
  const declared = Array.isArray(state.cacheSizeInfo?.declared) ? state.cacheSizeInfo.declared : [];
  const locked = !open.length || state.auth?.viaPageSession && state.auth?.vipActive ? [] : declared
    .filter((item) => item.quality > top && (item.requiresVip || item.requiresLogin))
    .sort((left, right) => left.quality - right.quality);
  return { open, locked };
}

/**
 * 画质滑杆。几何约定（与 popup.css 的 .quality-track 一致）：N 个档位等距排在
 * [拇指半径, 宽度 - 拇指半径] 之间，第 i 档在 i / (N - 1)。原生 range 只铺在可选段上，
 * 宽度 = 拇指 + (总宽 - 拇指) × reach，于是它的拇指位置与装饰档位点严格重合。
 * 档位点与两端名称只在档位集合变化时重建；选中态、体积、是否顶档每次刷新只改属性与文字，
 * 进度心跳不会重建节点，也不会让顶档的浪与气泡动画重启（AGENTS 8.1）。
 */
function renderQualitySlider(options, cached, placeholder) {
  const stops = buildQualityStops(options);
  state.qualityStops = stops;
  const all = [...stops.open, ...stops.locked];
  const count = all.length;
  const at = (index) => count > 1 ? index / (count - 1) : 1;
  const row = elements.qualityRow;
  row.dataset.empty = String(!stops.open.length);
  const signature = JSON.stringify([all.map((item) => [item.quality, item.label]), stops.open.length, placeholder]);
  if (signature !== state.qualityStopsSignature) {
    state.qualityStopsSignature = signature;
    elements.qualityStops.replaceChildren(...all.map((item, index) => {
      const dot = document.createElement("span");
      dot.className = "quality-stop";
      dot.style.setProperty("--at", String(at(index)));
      return dot;
    }));
    const short = qualityShortLabels(all);
    setText(elements.qualityLow, count > 1 ? short[0] : "");
    setText(elements.qualityHigh, count ? short[count - 1] : "");
    elements.qualityHigh.dataset.locked = String(stops.locked.length > 0);
    const reach = stops.open.length > 1 ? at(stops.open.length - 1) : 0;
    state.qualityReach = reach;
    const track = elements.qualityTrack.style;
    track.setProperty("--q-reach", String(reach));
    // 只有一个档位时拇指停在最右（它就是最高），range 本身只有拇指宽。
    track.setProperty("--q-offset", stops.open.length === 1 ? String(at(count - 1)) : "0");
    // 锁定段从「最后一个可选档与第一个锁定档的中点」开始，斜纹不会压住可选档的点。
    elements.qualityLocked.hidden = !stops.locked.length;
    track.setProperty("--q-lock", String(stops.locked.length ? (at(stops.open.length - 1) + at(stops.open.length)) / 2 : 1));
    const slider = elements.qualitySlider;
    slider.max = String(Math.max(0, stops.open.length - 1));
  }
  if (!stops.open.length) {
    setText(elements.qualityName, placeholder);
    setText(elements.qualitySize, "");
    row.dataset.top = "false";
    elements.qualitySlider.disabled = true;
    return;
  }
  const index = Math.max(0, stops.open.findIndex((item) => item.quality === state.selectedQuality));
  const selected = stops.open[index];
  const size = sizeText(selected.quality, cached);
  setText(elements.qualityName, selected.label);
  setText(elements.qualitySize, size);
  const slider = elements.qualitySlider;
  if (slider.value !== String(index)) slider.value = String(index);
  slider.disabled = cached?.status === "downloading";
  setAttr(slider, "aria-valuetext", [selected.label, size].filter(Boolean).join(t("sep.comma")));
  state.qualityRatio = stops.open.length === 1 ? at(count - 1) : at(index);
  // 拖动中拇指跟着指针走，不能被这里写回档位；松手时 endQualityDrag 再落定。
  if (state.qualityDragPointer === null && !state.qualitySettling) elements.qualityTrack.style.setProperty("--q-pos", String(state.qualityRatio));
  // 顶档：选中的是整根杆的最右一档（上面没有被锁的档位）时，杆身变成有浪和气泡的海、拇指里是漂流瓶。
  // 未登录或非大会员时可选最高档上面还有锁定段，不算顶档：这层效果留给真正的最高画质。
  const top = String(index === stops.open.length - 1 && !stops.locked.length);
  if (row.dataset.top !== top) {
    row.dataset.top = top;
    if (top === "true" && state.qualityInteractive) surgeQualityRow();
  }
}

/** 登顶反馈：重新挂上 .is-surging 让一次性动画从头播放（popup.css「登顶」一节），播完摘掉。 */
function surgeQualityRow() {
  const row = elements.qualityRow;
  row.classList.remove("is-surging");
  void row.offsetWidth; // 强制样式重算，同一帧内摘了又挂上也能重新开始动画
  row.classList.add("is-surging");
  clearTimeout(state.qualitySurgeTimer);
  state.qualitySurgeTimer = setTimeout(() => row.classList.remove("is-surging"), 900);
}

/** 过档反馈：拇指轻轻一跳。 */
function tickQualityKnob() {
  const knob = elements.qualityKnob;
  knob.classList.remove("is-tick");
  void knob.offsetWidth;
  knob.classList.add("is-tick");
}

/** 指针横坐标 → 拇指位置（0–1），夹在可选段之内：锁定段拖不进去，拇指也不越过去。 */
function qualityRatioAt(clientX) {
  const box = elements.qualityTrack.getBoundingClientRect();
  const thumb = parseFloat(getComputedStyle(elements.qualityTrack).getPropertyValue("--thumb")) || 22;
  const span = box.width - thumb;
  if (span <= 0) return state.qualityRatio;
  return Math.min(state.qualityReach, Math.max(0, (clientX - box.left - thumb / 2) / span));
}

/** 第 index 个可选档的拇指位置（0–1）。与 renderQualitySlider 的 at() 同一套坐标。 */
function qualityStopRatio(index) {
  const open = state.qualityStops.open.length;
  return open > 1 ? state.qualityReach * index / (open - 1) : state.qualityReach;
}

/** 拇指位置 → 最近的可选档序号。 */
function nearestQualityIndex(ratio) {
  const open = state.qualityStops.open.length;
  if (open < 2 || state.qualityReach <= 0) return 0;
  return Math.min(open - 1, Math.max(0, Math.round(ratio / state.qualityReach * (open - 1))));
}

function setQualityPos(ratio) {
  state.qualityDragRatio = ratio;
  elements.qualityTrack.style.setProperty("--q-pos", ratio.toFixed(4));
}

function enterQualityDragging() {
  if (state.qualityPress) state.qualityPress.dragging = true;
  elements.qualityTrack.dataset.dragging = "true";
}

function startQualityDrag(event) {
  if (elements.qualitySlider.disabled || state.qualityStops.open.length < 2) return;
  cancelQualitySettle();
  state.qualityDragPointer = event.pointerId;
  // 捕获指针：拖出杆外（尤其拖向锁定段或弹窗边缘）时仍能收到移动与松开。
  elements.qualitySlider.setPointerCapture?.(event.pointerId);
  const box = elements.qualityTrack.getBoundingClientRect();
  const thumb = parseFloat(getComputedStyle(elements.qualityTrack).getPropertyValue("--thumb")) || 22;
  // 取正在过渡中的实际位置（而非目标值）：滑行途中再次按下，命中判断要对着眼前看到的拇指。
  const current = parseFloat(getComputedStyle(elements.qualityTrack).getPropertyValue("--q-pos"));
  const center = box.left + thumb / 2 + (box.width - thumb) * (Number.isFinite(current) ? current : state.qualityRatio);
  state.qualityDragRatio = Number.isFinite(current) ? current : state.qualityRatio;
  state.qualityPress = { x: event.clientX, dragging: false };
  if (Math.abs(event.clientX - center) <= thumb / 2 + 2) {
    // 按在拇指上：立刻跟手。
    enterQualityDragging();
    followQualityDrag(event);
  } else {
    // 按在轨道别处：不让拇指瞬移到指针下（三档时档距很长，会先冲到半路再退回来），
    // 而是带着过渡平滑滑向最近的档位；之后若指针明显移动，再转为拖动。
    setQualityPos(qualityStopRatio(nearestQualityIndex(qualityRatioAt(event.clientX))));
  }
}

function followQualityDrag(event) {
  if (event.pointerId !== state.qualityDragPointer) return;
  const press = state.qualityPress;
  if (press && !press.dragging) {
    if (Math.abs(event.clientX - press.x) < 6) return;
    enterQualityDragging();
  }
  setQualityPos(qualityRatioAt(event.clientX));
}

function endQualityDrag(event) {
  if (event.pointerId !== state.qualityDragPointer) return;
  state.qualityDragPointer = null;
  state.qualityPress = null;
  delete elements.qualityTrack.dataset.dragging;
  // 松手落到最近的档位。名称、体积、顶档效果都要等拇指停稳再换，而不是拖过中点就变。
  const index = nearestQualityIndex(state.qualityDragRatio);
  state.qualitySettling = true;
  setQualityPos(qualityStopRatio(index));
  settleQualityThen(() => {
    state.qualitySettling = false;
    elements.qualitySlider.value = String(index);
    commitQualityIndex(index);
    persistQualitySelection();
  });
}

/**
 * 等拇指的滑行过渡结束后执行 done。没有过渡在跑（已在档位上、或「减少动态效果」）就立刻执行；
 * 过渡被打断时 transitionend 不会来，所以配一个兜底定时器。
 */
function settleQualityThen(done) {
  const track = elements.qualityTrack;
  if (!track.getAnimations().some((animation) => animation.playState === "running" || animation.playState === "pending")) {
    done();
    return;
  }
  let timer = 0;
  const onEnd = (event) => {
    if (event.target === track && event.propertyName === "--q-pos") finish();
  };
  const cleanup = () => {
    clearTimeout(timer);
    track.removeEventListener("transitionend", onEnd);
    track.removeEventListener("transitioncancel", finish);
    state.qualitySettleCancel = null;
  };
  const finish = () => {
    cleanup();
    done();
  };
  track.addEventListener("transitionend", onEnd);
  track.addEventListener("transitioncancel", finish);
  timer = setTimeout(finish, 360);
  state.qualitySettleCancel = () => {
    cleanup();
    state.qualitySettling = false;
  };
}

/** 新一轮按下时放弃尚未提交的落定：由这一轮操作决定最终档位。 */
function cancelQualitySettle() {
  state.qualitySettleCancel?.();
}

/** 对比 B 站声明的档位与当前账号实际返回的轨道，作为滑杆与账号说明的悬停提示，让「是不是最高规格」有答案。 */
function describeQualityLadder(options) {
  const declared = Array.isArray(state.cacheSizeInfo?.declared) ? state.cacheSizeInfo.declared : [];
  const describe = (quality) => `${quality.label}${quality.requiresVip ? t("ladder.vip") : quality.requiresLogin ? t("ladder.login") : ""}`;
  if (!declared.length) return { title: "" };
  return {
    title: [t("ladder.declared", { list: declared.map(describe).join(" / ") }), t("ladder.returned", { list: options.map((option) => option.label).join(" / ") || t("ladder.none") })].join("\n")
  };
}

/** 键盘等非指针途径（原生 input 事件）：立即提交。指针操作的 input 由 endQualityDrag 落定后统一提交。 */
function selectQualityFromSlider() {
  if (state.qualityDragPointer !== null || state.qualitySettling) return;
  commitQualityIndex(Number(elements.qualitySlider.value));
}

function commitQualityIndex(index) {
  const quality = state.qualityStops.open[index]?.quality || 0;
  if (!quality || quality === state.selectedQuality) return;
  state.selectedQuality = quality;
  state.selectedCodec = "auto";
  state.qualityInteractive = true;
  try {
    renderCurrent();
  } finally {
    state.qualityInteractive = false;
  }
  if (!elements.qualityRow.classList.contains("is-surging") || elements.qualityRow.dataset.top !== "true") tickQualityKnob();
}

function persistQualitySelection() {
  if (!state.tab?.url || !state.selectedQuality) return;
  void send("SET_POPUP_SELECTION", { tabId: state.tab.id, url: state.tab.url, quality: state.selectedQuality, codec: state.selectedCodec }).catch(() => {});
}

function setButtonState(mode, label, speed, progress, disabled, sub = "") {
  elements.cacheButton.dataset.state = mode;
  elements.cacheButton.disabled = disabled;
  elements.cacheButton.style.setProperty("--progress-ratio", String(Math.max(0, Math.min(1, progress))));
  setText(elements.buttonLabel, label);
  setText(elements.buttonSpeed, speed);
  setText(elements.buttonSub, sub);
  elements.cacheButton.title = "";
  setAttr(elements.cacheButton, "aria-label", [label, sub, speed].filter(Boolean).join(t("sep.comma")));
}

function setHint(message, isError) {
  setText(elements.actionHint, message);
  elements.actionHint.dataset.tone = isError ? "error" : "normal";
  elements.actionHint.hidden = !message;
}

async function startCache() {
  if (!state.pageInfo?.supported || !state.tab) return;
  if (!isAudioMode() && !state.selectedQuality) return;
  cancelPendingDeleteForSelection();
  setButtonState("downloading", t("button.connecting"), "", 0, true);
  setHint(t("hint.starting"), false);
  try {
    await send("START_CACHE", { url: state.tab.url, tabId: state.tab.id, quality: state.selectedQuality, codec: state.selectedCodec, mode: state.cacheMode });
    await refreshLibrary();
  } catch (error) {
    setButtonState("error", t("button.retry"), "", 0, false);
    setHint(error.message, true);
  }
}

async function pauseCurrentTask() {
  if (elements.pauseButton.dataset.mode === "resume") return startCache();
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
    ready: live ? t("assist.seconds", { value: finite(stats.prefetchAheadSec).toFixed(0) }) : "—",
    buffer: live ? t("assist.seconds", { value: finite(stats.bufferAheadSec).toFixed(1) }) : "—",
    // 卡顿是「插件有没有让你少卡」的结果指标；累计时长不足 0.1 秒不显示，免得「0 次 · 0.0 秒」。
    stalls: live ? t("assist.stallsValue", { count: finite(stats.stalls), seconds: finite(stats.stallMs) >= 100 ? (finite(stats.stallMs) / 1000).toFixed(1) : "" }) : "—",
    // 驻留上限是 playback-cache 的 128 MiB；超过后按播放位置回收，用户需要知道离上限有多远。
    residency: live ? `${finite(stats.cacheResidentMB).toFixed(0)} / 128 MB` : "—",
    accelerated: live ? t("assist.acceleratedValue", { count: finite(stats.acceleratedRequests), rescues: finite(stats.networkRescues) }) : "—",
    trouble: live ? [finite(stats.nativeFallbacks) > 0 ? t("assist.trouble.fallbacks", { count: finite(stats.nativeFallbacks) }) : "", finite(stats.prefetchErrors) > 0 ? t("assist.trouble.prefetch", { count: finite(stats.prefetchErrors) }) : "", finite(stats.blockedNodes) > 0 ? t("assist.trouble.blocked", { count: finite(stats.blockedNodes) }) : ""].filter(Boolean).join(" · ") : "",
    node: live ? (stats.networkHost || t("assist.node.connecting")) : t(enabled ? "assist.node.waitingData" : "assist.status.off")
  };
  for (const [key, value] of Object.entries(metrics)) setText(elements.assistMetrics[key], value);
  // 「异常」合并交还原生 / 预热失败 / 隔离节点：全是失败信号，为 0 时只是噪音，整行不出现；出现才显示并用警示色。
  const troubleRow = elements.assistMetrics.trouble.parentElement;
  troubleRow.hidden = !metrics.trouble;
  troubleRow.classList.toggle("is-warning", Boolean(metrics.trouble));
  setAttr(elements.assistMetrics.node, "title", metrics.node);
  elements.assistToggle.setAttribute("aria-checked", String(enabled));

  // 状态只看新鲜的统计：页面没在播放或统计过期时，不能沿用旧的「正在加载」。
  let status = "off", tone = "off";
  if (enabled && (!live || !stats.activeTracks)) { status = "waiting"; tone = "waiting"; }
  else if (enabled && stats.prefetchErrors > 0 && !stats.prefetching && !(stats.prefetchAheadSec > 0)) { status = "unstable"; tone = "warning"; }
  else if (enabled && stats.prefetching > 0) { status = "prefetching"; tone = "active"; }
  else if (enabled && stats.prefetchAheadSec > 0) { status = "ready"; tone = "active"; }
  else if (enabled) { status = "on"; tone = "active"; }
  setText(elements.assistStatus, t(`assist.status.${status}`));
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
    const label = t(`color.${preset.name}`);
    button.title = label;
    button.setAttribute("aria-label", label);
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
    state.healthError = error?.message || t("health.readFailed");
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
  setText(elements.browserHealthStatus, state.healthError ? t("health.incomplete", { error: state.healthError })
    : t(failed.length ? "health.failed" : "health.ok", { version: report.browserVersion || t("health.unknownVersion") }));
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

// ---- 评价邀请 ----------------------------------------------------------------

elements.reviewGo.href = elements.aboutReview.href = REVIEW_URL;
// 两个入口都是普通链接（新标签页打开）：点击时只记「不再追问」，不拦截跳转。
// 弹窗会在新标签获得焦点时关闭，所以状态必须在点击当下同步发起写入。
elements.reviewGo.addEventListener("click", () => updateReviewState(completeReviewPrompt));
elements.aboutReview.addEventListener("click", () => updateReviewState(completeReviewPrompt));
elements.reviewLater.addEventListener("click", () => closeReviewCard((review) => snoozeReviewPrompt(review, Date.now())));
elements.reviewNever.addEventListener("click", () => closeReviewCard(dismissReviewPrompt));

/** 读取持久状态并补记首次打开时间；读取失败按默认处理（最坏情况只是晚一点出现）。 */
async function loadReviewState() {
  let review = defaultReviewState();
  try {
    const stored = await chrome.storage.local.get(REVIEW_PROMPT_KEY);
    review = normalizeReviewState(stored?.[REVIEW_PROMPT_KEY]);
  } catch { /* 测试夹具或存储不可用：当作首次。 */ }
  state.review = review;
  updateReviewState((current) => markFirstSeen(current, Date.now()));
}

/** 状态变更统一入口：值没变就不写存储、不重绘。 */
function updateReviewState(change) {
  if (!state.review) return;
  const next = change(state.review);
  if (next === state.review) return;
  state.review = next;
  try { void chrome.storage.local.set({ [REVIEW_PROMPT_KEY]: next }).catch(() => {}); } catch { /* 存储不可用：本次弹窗内仍按内存状态生效。 */ }
  renderReviewCard();
}

/** 关闭卡片：焦点还在卡片里时先挪到「片库」页签，否则卡片 inert 后键盘焦点会丢到 body。 */
function closeReviewCard(change) {
  if (elements.reviewCard.contains(document.activeElement)) elements.tabs.find((tab) => tab.dataset.panelView === "library")?.focus();
  updateReviewState(change);
}

/**
 * 卡片只切 data-open / inert，不重建节点：片库每 700ms 刷新一次，
 * 这里必须幂等，否则 hover 与展开动画会随轮询重启（见 AGENTS.md 8.1）。
 */
function renderReviewCard() {
  const completedCount = libraryVideos().filter((video) => video.status === "complete").length;
  const busy = state.videos.some((video) => video.status === "downloading");
  const open = Boolean(state.review) && shouldShowReviewPrompt(state.review, { completedCount, busy, now: Date.now() });
  setAttr(elements.reviewCard, "data-open", String(open));
  elements.reviewCard.inert = !open;
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
  elements.libraryCount.title = t("library.countTitle", { count: videos.length });
  const bytes = videos.reduce((sum, video) => sum + committedBytes(video), 0);
  setText(elements.librarySummary, videos.length ? t("library.summary", { count: videos.length, bytes: formatBytes(bytes) }) : "");
  elements.librarySummary.hidden = !videos.length;
  renderReviewCard();
  const ids = new Set(videos.map((video) => video.id));
  for (const row of elements.videoList.querySelectorAll(".video-item")) {
    if (!ids.has(row.dataset.videoId)) { state.speedSamples.delete(row.dataset.videoId); row.remove(); }
  }
  if (!videos.length) { renderEmptyLibrary(t("library.empty"), t("library.emptyHint")); return; }
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
      showToast(t(result.splitTracks ? "toast.savedSplit" : "toast.saved"));
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
  const title = video.partTitle || video.title || t("video.untitled");
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
  setAttr(link, "title", t(video.status === "complete" ? "item.openCached" : "item.open", { title }));
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
    ? (isAudioOnlyCache(video) ? [t("mode.audio"), video.audioLabel || describeAudioTrack(video)] : [video.qualityLabel || "MP4", video.codecLabel || CODEC_LABELS[video.codec]]).filter(Boolean).join(" · ")
    : video.status === "downloading"
      ? video.stage === "merging" ? t("item.merging") : video.stage === "extracting" ? t("item.extracting") : Number(video.nextRetryAt) > Date.now() ? t("item.waitRetry")
        : video.error ? t("item.recovering") : speedSample?.value > 0 ? formatSpeed(speedSample.value) : t("item.caching")
      : t(video.status === "paused" ? "item.paused" : "item.incomplete");
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
    setAttr(toggle, "aria-label", t(mode === "pause" ? "item.pauseLabel" : "item.resumeLabel", { title }));
    setAttr(toggle, "title", t(mode === "pause" ? "task.pause" : "item.resumeTip"));
  }
  setAttr(save, "aria-label", t("item.saveLabel", { title }));
  setAttr(save, "title", isAudioOnlyCache(video) ? t("item.saveAudio", { container: describeAudioContainer(video) })
    : t(video.merged ? "item.saveMerged" : video.mediaKind === "dash" && video.tracks?.audio ? "item.saveTracks" : "item.saveVideo"));
  const remove = item.querySelector(".delete-button");
  setAttr(remove, "aria-label", t("item.deleteLabel", { title }));
  setAttr(remove, "title", t("item.deleteTip"));
}

async function pauseTask(videoId) {
  try {
    const result = await send("PAUSE_CACHE", { videoId });
    if (result.video) mergeTask(result.video);
    if (!result.paused && result.video?.status === "complete") showToast(t("toast.alreadyComplete"));
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
 * 下载中的任务先暂停，撤销时再继续；弹窗关闭时未撤销的删除由后台提交（见 pending-deletes.js）。
 */
function deleteWithUndo(video) {
  if (state.pendingDeletes.has(video.id)) return;
  const title = video.partTitle || video.title || t("video.untitled");
  const pending = { resume: video.status === "downloading", timer: null };
  state.pendingDeletes.set(video.id, pending);
  state.pendingDeleteChannel?.schedule(video.id);
  renderLibrary();
  if (state.pageInfo) renderCurrent();
  if (pending.resume) void send("PAUSE_CACHE", { videoId: video.id }).catch(() => {});
  pending.timer = setTimeout(() => void commitDelete(video.id), DELETE_UNDO_MS);
  showToast(t("toast.deleted", { title }), {
    action: t("toast.undo"),
    duration: DELETE_UNDO_MS,
    onAction: () => {
      clearTimeout(pending.timer);
      state.pendingDeletes.delete(video.id);
      state.pendingDeleteChannel?.release(video.id);
      renderLibrary();
      if (state.pageInfo) renderCurrent();
      if (pending.resume) void resumeTask(video.id);
    }
  });
}

/**
 * 撤销期内对同一缓存内容（同画质、同编码，或仅音频）点「缓存」，等同于点「撤销」。
 * 否则 START_CACHE 会续传那条被暂停的记录，界面却仍把它当待删除隐藏（按钮转一圈又变回「缓存」），
 * 到点后删除照常提交，把刚恢复的任务删掉。选了别的画质时是另一个任务，删除照常进行。
 */
function cancelPendingDeleteForSelection() {
  const audioMode = isAudioMode();
  for (const [videoId, pending] of state.pendingDeletes) {
    const video = state.videos.find((item) => item.id === videoId);
    if (!video || getVideoPageId(video) !== state.pageInfo?.id || isAudioOnlyCache(video) !== audioMode) continue;
    if (!audioMode && (Number(video.requestedQuality || video.quality) !== state.selectedQuality || !isVideoCodecSelectionMatch(video, state.selectedCodec))) continue;
    clearTimeout(pending.timer);
    state.pendingDeletes.delete(videoId);
    state.pendingDeleteChannel?.release(videoId);
    hideToast();
  }
  renderLibrary();
}

async function commitDelete(videoId) {
  if (!state.pendingDeletes.has(videoId)) return;
  try {
    await send("DELETE_VIDEO", { videoId });
    state.libraryRevision++;
    state.deletedAt.set(videoId, Date.now());
    state.videos = state.videos.filter((video) => video.id !== videoId);
  } catch (error) {
    showToast(t("toast.deleteFailed", { error: error.message }));
  } finally {
    // 请求结束后才撤销后台登记：请求途中弹窗被关，后台补删一次也无害；反过来先撤销就可能两头都没删。
    state.pendingDeletes.delete(videoId);
    state.pendingDeleteChannel?.release(videoId);
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
  if (!response?.ok) throw new Error(response?.error || t("err.noResponse"));
  return response;
}
