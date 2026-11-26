import {
  WATCHES_KEY,
  RESULTS_KEY,
  SETTINGS_KEY,
  HISTORY_KEY,
  parseDeploymentUrl,
  parseDeploymentUrls,
  permissionPattern,
  watchId,
  watchMatchesQuery,
  compareWatchesByLastReady,
  sortTimelineEvents,
  timelineEnvironmentOptions,
  timelineEventsWithTimes,
  clusterKey,
  clusterDisplayName,
  settingsWithClusterName,
  refreshSecondsFromSettings,
  deploymentDisplayName,
  watchesWithDeploymentName,
  isMonitoringPaused,
  settingsWithMonitoringPaused,
  buildConfigExport,
  parseConfigImport,
  applyConfigImport,
  configExportFilename,
  isSystemNamespace,
  discoveryRowMatches,
  discoveredDeploymentToWatch,
  mergeMonitors,
  clusterFromUrl,
  mergeClusterSources,
  DISCOVERY_MAX_NAMESPACES,
  DISCOVERY_PAGE_SIZE,
  DISCOVERY_MAX_PAGES
} from "./lib/rancher.js";

const content = document.querySelector("#content");
const toolbar = document.querySelector("#toolbar");
const summary = document.querySelector("#summary");
const refreshButton = document.querySelector("#refresh");
const pauseButton = document.querySelector("#pause-toggle");
const rememberLoginButton = document.querySelector("#remember-login");
const pauseBanner = document.querySelector("#pause-banner");
const resumeFromBannerButton = document.querySelector("#resume-from-banner");
const addButton = document.querySelector("#add");
const dialog = document.querySelector("#add-dialog");
const form = document.querySelector("#add-form");
const urlInput = document.querySelector("#deployment-url");
const environmentInput = document.querySelector("#environment-label");
const labelInput = document.querySelector("#watch-label");
const formError = document.querySelector("#form-error");
const intervalSelect = document.querySelector("#refresh-interval");
const searchInput = document.querySelector("#watch-search");
const timelineFilters = document.querySelector("#timeline-filters");
const timelineEnvSelect = document.querySelector("#timeline-environment");
const timelineSortSelect = document.querySelector("#timeline-sort");
const urlHint = document.querySelector("#url-hint");
const nameDialog = document.querySelector("#name-dialog");
const nameForm = document.querySelector("#name-form");
const nameInput = document.querySelector("#name-input");
const nameDialogTitle = document.querySelector("#name-dialog-title");
const nameDialogContext = document.querySelector("#name-dialog-context");
const nameDialogHint = document.querySelector("#name-dialog-hint");
const nameDialogError = document.querySelector("#name-dialog-error");
const saveDisplayNameButton = document.querySelector("#save-display-name");
const resetDisplayNameButton = document.querySelector("#reset-display-name");
const configButton = document.querySelector("#config-menu");
const configDialog = document.querySelector("#config-dialog");
const configForm = document.querySelector("#config-form");
const exportCount = document.querySelector("#export-count");
const exportButton = document.querySelector("#export-config");
const pickFileButton = document.querySelector("#pick-config-file");
const importFile = document.querySelector("#import-file");
const importSummary = document.querySelector("#import-summary");
const importMode = document.querySelector("#import-mode");
const confirmImportButton = document.querySelector("#confirm-import");
const configError = document.querySelector("#config-error");
const configMessage = document.querySelector("#config-message");
const browseButton = document.querySelector("#browse-deployments");
const discoverDialog = document.querySelector("#discover-dialog");
const discoverForm = document.querySelector("#discover-form");
const discoverSiteSelect = document.querySelector("#discover-site");
const discoverClusterSelect = document.querySelector("#discover-cluster");
const discoverUseTabButton = document.querySelector("#discover-use-tab");
const discoverSearchInput = document.querySelector("#discover-search");
const discoverSystemInput = document.querySelector("#discover-system");
const discoverGrantButton = document.querySelector("#discover-grant");
const discoverStatus = document.querySelector("#discover-status");
const discoverList = document.querySelector("#discover-list");
const discoverError = document.querySelector("#discover-error");
const discoverBuild = document.querySelector("#discover-build");
const discoverSelectedCount = document.querySelector("#discover-selected-count");
const discoverSelectShownButton = document.querySelector("#discover-select-shown");
const discoverClearButton = document.querySelector("#discover-clear-selection");
const discoverAddButton = document.querySelector("#discover-add");

let watches = [];
let results = {};
let settings = {};
let history = [];
let filter = "all";
let searchQuery = "";
let timelineEnvironment = "";
let timelineEnvironmentSignature = "";
let timelineSort = "normal";
let editingNameTarget = null;
let pendingImport = null;
let discoverSites = [];
let discoverClusters = [];
let discoverRows = [];
let discoverTruncated = false;
let discoverSource = "";
let discoverSkipped = 0;
let discoverNamespacesRead = 0;
let discoverClusterNotice = "";
let discoverTabCluster = null;
let discoverFailed = false;
let discoverQuery = "";
let discoverShowSystem = false;
const discoverSelection = new Map();
const discoverWatchIndex = new Map();
let liveRefreshTimer = null;
let refreshInProgress = false;
let pendingFullRefresh = false;
const pendingWatchIds = new Set();
let pendingRefreshWaiters = [];
const refreshingClusters = new Set();

const statusText = {
  healthy: "正常",
  degraded: "有风险",
  unavailable: "不可用",
  paused: "已暂停",
  unknown: "未知"
};

function paused() {
  return isMonitoringPaused(settings);
}

function updatePauseButton() {
  const isPaused = paused();
  pauseButton.classList.toggle("paused", isPaused);
  pauseButton.setAttribute("aria-pressed", String(isPaused));
  pauseButton.querySelector(".pause-label").textContent = isPaused ? "继续监控" : "暂停监控";
  pauseButton.title = isPaused
    ? "恢复后台与弹窗的定时刷新"
    : "暂停后不再发起任何 Rancher 请求，适合不在内网或无网络时使用";
  pauseBanner.classList.toggle("hidden", !isPaused || !watches.length);
  refreshButton.disabled = isPaused;
  if (isPaused) {
    refreshButton.title = "监控已暂停，先继续监控再刷新";
  } else {
    refreshButton.title = "立即刷新";
  }
}

function updateRememberLoginButton() {
  const enabled = settings.rememberLogin === true;
  rememberLoginButton.classList.toggle("active", enabled);
  rememberLoginButton.setAttribute("aria-pressed", String(enabled));
  rememberLoginButton.querySelector(".remember-login-label").textContent = enabled ? "已保持登录" : "保持登录";
  rememberLoginButton.title = enabled
    ? "已将 Rancher 会话 Cookie 设为约 30 天有效；服务端过期或主动退出仍会结束登录"
    : "让当前 Rancher 登录在关闭并重新打开浏览器后继续有效（约 30 天）";
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function relativeTime(iso) {
  if (!iso) return "尚未检查";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 10) return "刚刚检查";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function readyTimeLabel(iso) {
  if (!iso) return "尚未就绪";
  const text = relativeTime(iso).replace("检查", "").trim();
  return `就绪 ${text || "刚刚"}`;
}

function timelineTime(iso) {
  const time = Date.parse(iso || "");
  if (Number.isNaN(time)) return "未知时间";
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function timelineNote(event) {
  if (event.status === "unknown") return event.error || "请求失败";
  if (event.ready !== null && event.desired !== null) return `${event.ready}/${event.desired} 就绪`;
  return "";
}

function isProblem(result) {
  return !result?.ok || ["degraded", "unavailable", "unknown"].includes(result?.status);
}

function podRows(pods = []) {
  if (!pods.length) return '<div class="pod"><span class="pod-name">暂无 Pod 数据</span></div>';
  return pods.map((pod) => `
    <div class="pod">
      <div class="pod-main">
        <span class="pod-name" title="${escapeHtml(pod.name)}">${escapeHtml(pod.name)}</span>
        <span class="pod-state ${pod.ready ? "ready" : "not-ready"}">${escapeHtml(pod.ready ? "Ready" : pod.reason)}</span>
        <span>重启 ${escapeHtml(pod.restarts)}</span>
        <span>${escapeHtml(relativeTime(pod.age).replace("检查", ""))}</span>
      </div>
      <div class="pod-meta" title="${escapeHtml(pod.images?.join(" · ") || "")}">
        <span>IP ${escapeHtml(pod.ip)}</span><span>节点 ${escapeHtml(pod.node)}</span><code>${escapeHtml(pod.images?.[0] || "暂无镜像")}</code>
      </div>
    </div>
  `).join("");
}

function cardHtml(watch) {
  const result = results[watchId(watch)] || {
    ok: false,
    status: "unknown",
    error: "等待首次刷新…"
  };
  const displayName = deploymentDisplayName(watch);
  const image = result.images?.[0] || "暂无镜像信息";
  const conditionText = result.conditions?.length
    ? result.conditions.map((condition) => `${condition.type} ${condition.status === "True" ? "✓" : condition.reason || condition.status}`).join(" · ")
    : "暂无 Condition";
  const metrics = result.ok ? `
    <div class="metrics">
      <div class="metric"><strong>${escapeHtml(result.ready)}/${escapeHtml(result.desired)}</strong><span>就绪副本</span></div>
      <div class="metric"><strong>${escapeHtml(result.updated)}</strong><span>已更新</span></div>
      <div class="metric"><strong>${escapeHtml(result.available)}</strong><span>可用副本</span></div>
      <div class="metric"><strong>${escapeHtml(result.restarts)}</strong><span>Pod 重启</span></div>
    </div>
    <div class="image-line"><span>镜像</span><code title="${escapeHtml(image)}">${escapeHtml(image)}</code></div>
    <div class="condition-line" title="${escapeHtml(conditionText)}">条件 ${escapeHtml(conditionText)}</div>
  ` : `<div class="error">${escapeHtml(result.error)}</div>`;

  return `
    <article class="deployment-card" data-id="${escapeHtml(watchId(watch))}">
      <div class="card-main">
        <div class="card-top">
          <div class="card-heading">
            <h3 title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</h3>
            <p>${escapeHtml(watch.namespace)} / ${escapeHtml(watch.deployment)}</p>
          </div>
          <div class="card-top-right">
            <label class="card-notify" title="该 Deployment 出现异常时弹出浏览器通知">
              <input type="checkbox" class="notify-toggle-input" data-id="${escapeHtml(watchId(watch))}" ${settings.notifiedWatchIds?.[watchId(watch)] ? "checked" : ""} />
              <span class="card-notify-icon" aria-hidden="true">🔔</span>
            </label>
            <span class="status ${escapeHtml(result.status)}">${statusText[result.status] || "未知"}</span>
          </div>
        </div>
        ${metrics}
      </div>
      ${result.ok ? `
        <details>
          <summary>Pod 明细（${escapeHtml(result.pods?.length || 0)}）</summary>
          <div class="pod-list">${podRows(result.pods)}</div>
        </details>
      ` : ""}
     <footer class="card-footer">
       <span class="card-times">
         <span class="checked">${relativeTime(result.checkedAt)}</span>
         <span class="ready-at" title="最近一次全部就绪的时间">${escapeHtml(readyTimeLabel(result.lastReadyAt))}</span>
       </span>
       <div class="card-actions">
         <button class="link-button open-watch" data-id="${escapeHtml(watchId(watch))}" aria-label="在 Rancher 中打开 ${escapeHtml(displayName)}">打开 Rancher</button>
          <button class="link-button rename-watch" data-id="${escapeHtml(watchId(watch))}" aria-label="修改 ${escapeHtml(displayName)} 的显示名称">改名</button>
          <button class="link-button danger remove-watch" data-id="${escapeHtml(watchId(watch))}" aria-label="移除 ${escapeHtml(displayName)} 监控">移除</button>
        </div>
      </footer>
    </article>
  `;
}

function timelineNormalTimes() {
  const normalTimes = new Map();
  for (const watch of watches) {
    const id = watchId(watch);
    const lastReadyAt = results[id]?.lastReadyAt;
    if (lastReadyAt) normalTimes.set(id, lastReadyAt);
  }
  return normalTimes;
}

const TIMELINE_SORT_MODES = new Set(["normal", "abnormal", "separate", "merged"]);

function syncTimelineFilters(environments, visible) {
  timelineFilters.classList.toggle("hidden", !visible);
  if (!visible) return;
  if (timelineEnvironment && !environments.some((environment) => environment.key === timelineEnvironment)) {
    timelineEnvironment = "";
  }
  const signature = environments.map((environment) => `${environment.key}\u0000${environment.name}`).join("\u0001");
  if (signature !== timelineEnvironmentSignature) {
    timelineEnvironmentSignature = signature;
    timelineEnvSelect.innerHTML = [
      '<option value="">全部环境</option>',
      ...environments.map((environment) => `
        <option value="${escapeHtml(environment.key)}">${escapeHtml(environment.name)}</option>
      `)
    ].join("");
  }
  timelineEnvSelect.value = timelineEnvironment;
  timelineSortSelect.value = timelineSort;
}

function timelineItemHtml(event, watch) {
  const note = timelineNote(event);
  const normalTime = event.normalAt
    ? `<time class="timeline-time-value" datetime="${escapeHtml(event.normalAt)}">${escapeHtml(timelineTime(event.normalAt))}</time>`
    : '<span class="timeline-time-value empty" title="暂无更早的正常记录">—</span>';
  const abnormalTime = event.abnormalAt
    ? `<time class="timeline-time-value" datetime="${escapeHtml(event.abnormalAt)}">${escapeHtml(timelineTime(event.abnormalAt))}</time>`
    : '<span class="timeline-time-value empty" title="这条记录不是异常状态">—</span>';
  return `
    <li class="timeline-item status-${escapeHtml(event.status)}" data-id="${escapeHtml(event.id)}">
      <span class="timeline-dot" aria-hidden="true"></span>
      <div class="timeline-card">
        <div class="timeline-times">
          <div class="timeline-time-block normal">
            <span class="timeline-time-label">正常时间</span>
            ${normalTime}
          </div>
          <div class="timeline-time-block abnormal">
            <span class="timeline-time-label">异常时间</span>
            ${abnormalTime}
          </div>
        </div>
        <div class="timeline-line">
          <div class="timeline-title">
            <strong>${escapeHtml(deploymentDisplayName(watch))}</strong>
            <span class="timeline-place">${escapeHtml(clusterDisplayName(watch, settings))} · ${escapeHtml(watch.namespace)}/${escapeHtml(watch.deployment)}</span>
            ${note ? `<span class="timeline-note" title="${escapeHtml(note)}">${escapeHtml(note)}</span>` : ""}
          </div>
          <span class="status ${escapeHtml(event.status)}">${statusText[event.status] || "未知"}</span>
          <button class="link-button timeline-open" data-id="${escapeHtml(event.id)}">打开 Rancher</button>
        </div>
      </div>
    </li>`;
}

function renderTimeline(environments = []) {
  const active = new Map(watches.map((watch) => [watchId(watch), watch]));
  const allowed = new Set(
    watches
      .filter((watch) => watchMatchesQuery(watch, searchQuery, settings))
      .map(watchId)
  );
  let events = timelineEventsWithTimes(history, timelineNormalTimes())
    .filter((event) => active.has(event.id) && allowed.has(event.id));
  if (timelineEnvironment) {
    events = events.filter((event) => clusterKey(active.get(event.id)) === timelineEnvironment);
  }
  if (filter === "problem") {
    events = events.filter((event) => ["degraded", "unavailable", "unknown"].includes(event.status));
  }
  if (!events.length) {
    const selectedEnvironment = environments.find((environment) => environment.key === timelineEnvironment);
    const empty = filter === "problem"
      ? { icon: "✓", title: "时间线里没有异常记录", text: "已记录的就绪事件都处于正常状态，切回“全部”可以查看完整历史。" }
      : timelineEnvironment
        ? {
            icon: "⏱",
            title: `${selectedEnvironment?.name || "该环境"}还没有时间线记录`,
            text: "当前环境内还没有状态切换记录。切回“全部环境”可以查看其他环境。"
          }
        : searchQuery.trim()
          ? { icon: "⌕", title: "没有匹配的时间线记录", text: "试试环境名称、Cluster ID、命名空间或 Deployment 名称。" }
          : { icon: "⏱", title: "还没有就绪记录", text: "保持监控运行，Deployment 每次就绪或状态切换都会记录到这条时间线上，最近就绪的排在最上面。" };
    content.innerHTML = `
      <div class="empty-state">
        <div>
          <div class="empty-icon">${empty.icon}</div>
          <h2>${empty.title}</h2>
          <p>${empty.text}</p>
        </div>
      </div>`;
    return;
  }

  const sortMode = TIMELINE_SORT_MODES.has(timelineSort) ? timelineSort : "normal";
  const sections = sortMode === "separate"
    ? [
        {
          key: "normal",
          title: "正常记录",
          hint: "按正常时间",
          events: sortTimelineEvents(events.filter((event) => !event.abnormalAt), "normal").slice(0, 200)
        },
        {
          key: "abnormal",
          title: "异常记录",
          hint: "按异常时间",
          events: sortTimelineEvents(events.filter((event) => event.abnormalAt), "abnormal").slice(0, 200)
        }
      ].filter((section) => section.events.length)
    : [{
        key: "",
        title: "",
        hint: "",
        events: sortTimelineEvents(events, sortMode).slice(0, 200)
      }];
  const total = sections.reduce((sum, section) => sum + section.events.length, 0);
  const sortText = sortMode === "separate"
    ? "正常 / 异常分开排序"
    : sortMode === "merged"
      ? "正常 / 异常合并排序"
      : sortMode === "abnormal" ? "按异常时间排序" : "按正常时间排序";
  const sectionsHtml = sections.map((section) => `
    ${section.title ? `
      <h3 class="timeline-group-title ${section.key}">
        <span>${section.title}</span>
        <small>${section.hint} · ${section.events.length} 条</small>
      </h3>` : ""}
    <ol class="timeline-list">${section.events.map((event) => timelineItemHtml(event, active.get(event.id))).join("")}</ol>
  `).join("");
  content.innerHTML = `
    <section class="timeline">
      <div class="timeline-header">
        <h2>历史时间线</h2>
        <span>${total} 条 · ${sortText} · 左正常 / 右异常</span>
      </div>
      ${sectionsHtml}
    </section>`;
  content.querySelectorAll(".timeline-open").forEach((button) => {
    button.addEventListener("click", () => {
      const watch = watches.find((item) => watchId(item) === button.dataset.id);
      if (watch) chrome.tabs.create({ url: watch.sourceUrl });
    });
  });
}

function render() {
  const uiState = captureContentState();
  const viewMode = settings.viewMode === "compact"
    ? "compact"
    : settings.viewMode === "timeline" ? "timeline" : "standard";
  const environments = timelineEnvironmentOptions(watches, settings);
  syncTimelineFilters(environments, viewMode === "timeline");
  content.classList.toggle("compact-mode", viewMode === "compact");
  content.classList.toggle("timeline-mode", viewMode === "timeline");
  document.querySelectorAll(".view-mode").forEach((button) => {
    const active = button.dataset.view === viewMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const healthy = watches.filter((watch) => results[watchId(watch)]?.status === "healthy").length;
  const problems = watches.filter((watch) => isProblem(results[watchId(watch)])).length;
  summary.textContent = !watches.length
    ? "跨 Cluster 状态面板"
    : paused()
      ? `监控已暂停 · ${watches.length} 个监控项 · 保留上次状态`
      : `${watches.length} 个监控项 · ${healthy} 正常${problems ? ` · ${problems} 异常` : ""}`;
  toolbar.classList.toggle("hidden", watches.length === 0);
  updatePauseButton();
  updateRememberLoginButton();

  if (!watches.length) {
    content.innerHTML = `
      <div class="empty-state">
        <div>
          <div class="empty-icon">＋</div>
          <h2>还没有监控项</h2>
          <p>在“添加监控”里点“浏览 Cluster 与 Deployment…”，直接勾选要监控的服务；也可以粘贴 Deployment 详情页地址。</p>
          <button class="button primary" id="empty-add">添加第一个 Deployment</button>
          <p>换电脑或换浏览器时，点击右上角 ⚙ 导入之前导出的配置文件。</p>
        </div>
      </div>`;
    document.querySelector("#empty-add").addEventListener("click", openAddDialog);
    return;
  }

  if (viewMode === "timeline") {
    renderTimeline(environments);
    restoreContentState(uiState);
    return;
  }

  const visible = watches
    .filter((watch) => filter === "all" || isProblem(results[watchId(watch)]))
    .filter((watch) => watchMatchesQuery(watch, searchQuery, settings))
    .sort((left, right) => compareWatchesByLastReady(left, right, (watch) => results[watchId(watch)]));
  if (!visible.length) {
    const isSearching = searchQuery.trim();
    content.innerHTML = isSearching
      ? '<div class="empty-state"><div><div class="empty-icon">⌕</div><h2>没有匹配的监控项</h2><p>试试 Cluster ID、命名空间、Deployment 名称或环境名称。</p></div></div>'
      : '<div class="empty-state"><div><div class="empty-icon">✓</div><h2>当前没有异常</h2><p>所有已检查的 Deployment 状态正常。</p></div></div>';
    return;
  }

  const groups = Map.groupBy
    ? Map.groupBy(visible, clusterKey)
    : visible.reduce((map, watch) => {
        const key = clusterKey(watch);
        map.set(key, [...(map.get(key) || []), watch]);
        return map;
      }, new Map());
  content.innerHTML = [...groups.entries()].map(([key, group]) => {
    const { baseUrl, clusterId } = group[0];
    const displayName = clusterDisplayName(group[0], settings);
    const problemCount = group.filter((watch) => isProblem(results[watchId(watch)])).length;
    return `
      <section class="cluster-group" data-group-key="${escapeHtml(key)}">
        <div class="cluster-title">
          <div class="cluster-heading">
            <h2><span class="cluster-display-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span><small>${escapeHtml(clusterId)}</small></h2>
            <button class="link-button edit-cluster-name" data-group-key="${escapeHtml(key)}" aria-label="修改 ${escapeHtml(displayName)} 的显示名称">修改名称</button>
          </div>
          <div class="cluster-actions">
            <span>${escapeHtml(new URL(baseUrl).host)} · ${group.length} 项${problemCount ? ` · ${problemCount} 异常` : ""}</span>
          <button class="link-button cluster-refresh" data-group-key="${escapeHtml(key)}" ${refreshingClusters.has(key) ? 'aria-busy="true" aria-disabled="true"' : ""}>${refreshingClusters.has(key) ? "刷新中…" : "刷新此 Cluster"}</button>
          </div>
        </div>
        <div class="cards">${group.map(cardHtml).join("")}</div>
      </section>`;
  }).join("");

  document.querySelectorAll(".open-watch").forEach((button) => {
    button.addEventListener("click", () => {
      const watch = watches.find((item) => watchId(item) === button.dataset.id);
      if (watch) chrome.tabs.create({ url: watch.sourceUrl });
    });
  });
  document.querySelectorAll(".remove-watch").forEach((button) => {
    button.addEventListener("click", async () => {
      const watch = watches.find((item) => watchId(item) === button.dataset.id);
      if (!watch || !confirm(`移除 ${watch.label || watch.deployment}？`)) return;
      watches = watches.filter((item) => watchId(item) !== button.dataset.id);
      await chrome.storage.local.set({ [WATCHES_KEY]: watches });
      render();
    });
  });
  document.querySelectorAll(".rename-watch").forEach((button) => {
    button.addEventListener("click", () => openDeploymentNameDialog(button.dataset.id));
  });
  document.querySelectorAll(".notify-toggle-input").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const id = checkbox.dataset.id;
      const notifiedWatchIds = { ...(settings.notifiedWatchIds || {}) };
      if (checkbox.checked) notifiedWatchIds[id] = true;
      else delete notifiedWatchIds[id];
      const nextSettings = { ...settings, notifiedWatchIds };
      try {
        await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
        settings = nextSettings;
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        summary.textContent = `通知设置保存失败：${error?.message || "无法写入本地存储"}`;
      }
    });
  });
  document.querySelectorAll(".cluster-refresh").forEach((button) => {
    button.addEventListener("click", async () => {
      if (refreshingClusters.has(button.dataset.groupKey)) return;
      const ids = watches
        .filter((watch) => clusterKey(watch) === button.dataset.groupKey)
        .map(watchId);
      refreshingClusters.add(button.dataset.groupKey);
      render();
      try {
        await refreshAll(ids);
      } finally {
        refreshingClusters.delete(button.dataset.groupKey);
        render();
      }
    });
  });
  document.querySelectorAll(".edit-cluster-name").forEach((button) => {
    button.addEventListener("click", () => openClusterNameDialog(button.dataset.groupKey));
  });
  restoreContentState(uiState);
}

function openClusterNameDialog(key) {
  const watch = watches.find((item) => clusterKey(item) === key);
  if (!watch) return;
  const customName = settings.clusterNames?.[key] || "";
  openNameDialog({ type: "cluster", watch }, {
    title: "修改 Cluster 显示名称",
    context: `${new URL(watch.baseUrl).host} · ${watch.clusterId}`,
    hint: "只修改扩展中的显示名称，不影响 Rancher Cluster ID。",
    value: customName || clusterDisplayName(watch, settings),
    hasCustomName: Boolean(customName)
  });
}

function openDeploymentNameDialog(id) {
  const watch = watches.find((item) => watchId(item) === id);
  if (!watch) return;
  openNameDialog({ type: "deployment", watch }, {
    title: "修改 Deployment 显示名称",
    context: `${clusterDisplayName(watch, settings)} · ${watch.namespace}/${watch.deployment}`,
    hint: "只修改扩展中的显示名称，不影响 Rancher Deployment。",
    value: deploymentDisplayName(watch),
    hasCustomName: Boolean(String(watch.label || "").trim())
  });
}

function openNameDialog(target, options) {
  editingNameTarget = target;
  nameDialogTitle.textContent = options.title;
  nameDialogContext.textContent = options.context;
  nameDialogHint.textContent = options.hint;
  nameInput.value = options.value;
  nameDialogError.classList.add("hidden");
  resetDisplayNameButton.classList.toggle("hidden", !options.hasCustomName);
  nameDialog.showModal();
  nameInput.select();
}

async function saveDisplayName(event) {
  event.preventDefault();
  await persistDisplayName(nameInput.value);
}

async function persistDisplayName(name) {
  if (!editingNameTarget) return nameDialog.close();
  const { type, watch } = editingNameTarget;
  const nextSettings = type === "cluster" ? settingsWithClusterName(settings, watch, name) : settings;
  const nextWatches = type === "deployment" ? watchesWithDeploymentName(watches, watch, name) : watches;
  nameDialogError.classList.add("hidden");
  saveDisplayNameButton.disabled = true;
  resetDisplayNameButton.disabled = true;
  try {
    await chrome.storage.local.set(
      type === "cluster" ? { [SETTINGS_KEY]: nextSettings } : { [WATCHES_KEY]: nextWatches }
    );
    settings = nextSettings;
    watches = nextWatches;
    editingNameTarget = null;
    nameDialog.close();
    render();
  } catch (error) {
    nameDialogError.textContent = `保存失败：${error?.message || "无法写入扩展本地存储"}`;
    nameDialogError.classList.remove("hidden");
  } finally {
    saveDisplayNameButton.disabled = false;
    resetDisplayNameButton.disabled = false;
  }
}

async function resetDisplayName() {
  await persistDisplayName("");
}

function showConfigError(message) {
  configError.textContent = message;
  configError.classList.toggle("hidden", !message);
}

function updateImportSelection() {
  const ready = Boolean(pendingImport);
  confirmImportButton.disabled = !ready;
  importMode.classList.toggle("hidden", !ready);
  if (ready) {
    const clusters = new Set(pendingImport.watches.map(clusterKey)).size;
    const sites = new Set(pendingImport.watches.map((watch) => watch.baseUrl)).size;
    const notified = Object.keys(pendingImport.settings.notifiedWatchIds || {}).length;
    const renamed = Object.keys(pendingImport.settings.clusterNames || {}).length;
    importSummary.textContent =
      `${pendingImport.fileName} · ${pendingImport.watches.length} 个监控项 · ${clusters} 个 Cluster / ${sites} 个站点` +
      `${notified ? ` · ${notified} 项开启通知` : ""}${renamed ? ` · ${renamed} 个 Cluster 改名` : ""}`;
  } else {
    importSummary.textContent = "选择之前导出的 JSON 文件，导入后会立即按配置刷新。";
  }
}

function updateExportSummary() {
  const clusters = new Set(watches.map(clusterKey)).size;
  exportCount.textContent = watches.length
    ? `当前 ${watches.length} 个监控项 · ${clusters} 个 Cluster · 刷新间隔 ${refreshSecondsFromSettings(settings)} 秒`
    : "暂无监控项";
  exportButton.disabled = !watches.length;
}

function openConfigDialog() {
  pendingImport = null;
  importFile.value = "";
  showConfigError("");
  configMessage.textContent = "";
  updateExportSummary();
  updateImportSelection();
  configDialog.showModal();
}

function exportConfig() {
  if (!watches.length) {
    showConfigError("没有可导出的监控项");
    return;
  }
  const payload = buildConfigExport(watches, settings);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = configExportFilename();
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  configMessage.textContent = `已导出 ${payload.watches.length} 个监控项到 ${link.download}`;
}

async function readConfigFile(file) {
  pendingImport = null;
  showConfigError("");
  if (!file) {
    updateImportSelection();
    return;
  }
  try {
    pendingImport = { fileName: file.name, ...parseConfigImport(await file.text()) };
  } catch (error) {
    showConfigError(`${file.name}：${error.message}`);
  }
  updateImportSelection();
}

async function confirmConfigImport() {
  if (!pendingImport) return;
  const mode = importMode.querySelector("input:checked")?.value || "merge";
  confirmImportButton.disabled = true;
  try {
    const origins = [...new Set(pendingImport.watches.map((watch) => permissionPattern(watch.baseUrl)))];
    if (origins.length && !(await chrome.permissions.request({ origins }))) {
      throw new Error("需要 Rancher 站点访问权限才能导入监控项");
    }
    const applied = applyConfigImport({ watches, settings }, pendingImport, mode);
    await chrome.storage.local.set({
      [WATCHES_KEY]: applied.watches,
      [SETTINGS_KEY]: applied.settings
    });
    watches = applied.watches;
    settings = applied.settings;
    pendingImport = null;
    importFile.value = "";
    configDialog.close();
    intervalSelect.value = String(refreshSecondsFromSettings(settings));
    resetLiveRefreshTimer();
    render();
    summary.textContent = `已${mode === "replace" ? "替换为" : "导入"} ${applied.watches.length} 个监控项` +
      `${origins.length ? `，并授权 ${origins.length} 个 Rancher 站点` : ""}，正在刷新状态`;
  } catch (error) {
    showConfigError(`导入失败：${error?.message || "无法写入扩展本地存储"}`);
  } finally {
    updateImportSelection();
  }
}

function captureContentState() {
  const openDetails = [...content.querySelectorAll(".deployment-card details[open]")]
    .map((details) => details.closest(".deployment-card")?.dataset.id)
    .filter(Boolean);
  const active = document.activeElement;
  if (!active || !content.contains(active)) return { openDetails, focus: null };
  const card = active.closest(".deployment-card");
  const cardAction = active.classList.contains("remove-watch")
    ? "remove-watch"
    : active.classList.contains("rename-watch")
      ? "rename-watch"
    : active.classList.contains("open-watch")
      ? "open-watch"
      : active.tagName === "SUMMARY" ? "pod-summary" : null;
  const clusterAction = active.classList.contains("cluster-refresh")
    ? "cluster-refresh"
    : active.classList.contains("edit-cluster-name") ? "edit-cluster-name" : null;
  const focus = card && cardAction
    ? { watchId: card.dataset.id, action: cardAction }
    : clusterAction
      ? { groupKey: active.dataset.groupKey, action: clusterAction }
      : null;
  return { openDetails, focus };
}

function restoreContentState(state) {
  const openIds = new Set(state.openDetails);
  document.querySelectorAll(".deployment-card").forEach((card) => {
    if (openIds.has(card.dataset.id)) card.querySelector("details")?.setAttribute("open", "");
  });
  if (!state.focus) return;
  const candidates = state.focus.watchId
    ? [...document.querySelectorAll(state.focus.action === "pod-summary" ? "summary" : `.${state.focus.action}`)].filter(
        (element) => element.closest(".deployment-card")?.dataset.id === state.focus.watchId
      )
    : [...document.querySelectorAll(`.${state.focus.action}`)].filter(
        (button) => button.dataset.groupKey === state.focus.groupKey
      );
  candidates[0]?.focus();
}

async function currentTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
}

async function useCurrentTab(showError = true) {
  try {
    const current = await currentTabUrl();
    parseDeploymentUrl(current);
    urlInput.value = current;
    updateUrlHint();
    formError.classList.add("hidden");
    return true;
  } catch (error) {
    if (showError) {
      formError.textContent = "当前标签页不是 Rancher Deployment 详情页，请手动粘贴地址。";
      formError.classList.remove("hidden");
    }
    return false;
  }
}

async function openAddDialog() {
  form.reset();
  formError.classList.add("hidden");
  updateUrlHint();
  await useCurrentTab(false);
  updateUrlHint();
  dialog.showModal();
}

function updateUrlHint() {
  const lines = urlInput.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    urlHint.textContent = "支持批量添加，也可从当前 Rancher 页面自动读取";
    labelInput.disabled = false;
    return;
  }
  try {
    const parsed = parseDeploymentUrls(urlInput.value);
    urlHint.textContent = `已识别 ${parsed.length} 个 Deployment，涉及 ${new Set(parsed.map(clusterKey)).size} 个 Cluster`;
    labelInput.disabled = parsed.length > 1;
    if (parsed.length > 1) labelInput.value = "";
  } catch (error) {
    urlHint.textContent = error.message;
    labelInput.disabled = false;
  }
}

async function saveWatch(event) {
  event.preventDefault();
  const saveButton = document.querySelector("#save-watch");
  try {
    const parsedWatches = parseDeploymentUrls(urlInput.value);
    const origins = [...new Set(parsedWatches.map((watch) => permissionPattern(watch.baseUrl)))];
    const granted = await chrome.permissions.request({ origins });
    if (!granted) throw new Error("需要站点访问权限才能读取 Rancher 状态");

    const existingById = new Map(watches.map((watch) => [watchId(watch), watch]));
    const newWatches = parsedWatches.map((parsed) => ({
      ...parsed,
      environment: environmentInput.value.trim() || existingById.get(watchId(parsed))?.environment || parsed.clusterId,
      label: parsedWatches.length === 1
        ? labelInput.value.trim() || existingById.get(watchId(parsed))?.label || ""
        : existingById.get(watchId(parsed))?.label || "",
      createdAt: existingById.get(watchId(parsed))?.createdAt || new Date().toISOString()
    }));
    const merged = mergeMonitors(watches, newWatches);
    saveButton.disabled = true;
    saveButton.textContent = `正在添加 ${newWatches.length} 项…`;
    await chrome.storage.local.set({ [WATCHES_KEY]: merged.watches });
    watches = merged.watches;
    dialog.close();
    render();
    summary.textContent = `已添加 ${merged.addedIds.length} 个监控项` +
      `${merged.skippedIds.length ? `，${merged.skippedIds.length} 个已存在并已更新` : ""}，共 ${watches.length} 个`;
  } catch (error) {
    formError.textContent = error.message;
    formError.classList.remove("hidden");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "授权站点并添加";
  }
}

function showDiscoverError(message) {
  discoverError.textContent = message;
  discoverError.classList.toggle("hidden", !message);
}

async function sendDiscoverRequest(payload) {
  const response = await chrome.runtime.sendMessage(payload);
  if (response?.__rancherWatchError) throw new Error(response.__rancherWatchError);
  return response || {};
}

function discoverClusterRef() {
  const clusterId = discoverClusterSelect.value;
  const baseUrl = discoverSiteSelect.value;
  if (!clusterId || !baseUrl) return null;
  const cluster = discoverClusters.find((item) => item.id === clusterId);
  return { baseUrl, id: clusterId, name: cluster?.name || "" };
}

const DISCOVER_CLUSTER_ORIGIN_LABELS = { local: "本机已监控", tab: "当前标签页" };

function discoverClusterLabel(cluster) {
  const base = cluster.name && cluster.name !== cluster.id ? `${cluster.name}（${cluster.id}）` : cluster.id;
  const marks = (cluster.origins || [])
    .map((origin) => DISCOVER_CLUSTER_ORIGIN_LABELS[origin])
    .filter(Boolean);
  return marks.length ? `${base} · ${marks.join(" · ")}` : base;
}

function localClustersForSite(baseUrl) {
  const clusters = new Map();
  for (const watch of watches) {
    if (watch.baseUrl !== baseUrl || !watch.clusterId || clusters.has(watch.clusterId)) continue;
    clusters.set(watch.clusterId, { id: watch.clusterId, name: clusterDisplayName(watch, settings) });
  }
  return [...clusters.values()];
}

// Cluster 列表接口常常比命名空间与 Deployment 权限更严，本机配置和当前页面仍是有效来源。
function clusterCandidatesFor(baseUrl, apiClusters = []) {
  const fromTab = discoverTabCluster?.baseUrl === baseUrl ? [{ id: discoverTabCluster.clusterId }] : [];
  return mergeClusterSources(
    { clusters: apiClusters, origin: "api" },
    { clusters: localClustersForSite(baseUrl), origin: "local" },
    { clusters: fromTab, origin: "tab" }
  );
}

function visibleDiscoverRows() {
  return discoverRows.filter((row) =>
    (discoverShowSystem || !isSystemNamespace(row.namespace)) &&
    discoveryRowMatches(row, discoverQuery)
  );
}

function updateDiscoverStatus() {
  if (!discoverSiteSelect.value) {
    discoverStatus.textContent = "暂无可浏览的站点，请在 Rancher 页面点“用当前标签页”。";
    return;
  }
  if (!discoverClusterRef()) {
    discoverStatus.textContent = discoverClusters.length
      ? "选择一个 Cluster 后列出其中的 Deployment。"
      : "没有可浏览的 Cluster，可在 Rancher 页面点“用当前标签页”，或改用粘贴地址添加。";
    return;
  }
  if (discoverFailed) {
    discoverStatus.textContent = "读取失败，未获得 Deployment 列表。";
    return;
  }
  const hidden = discoverRows.filter((row) => isSystemNamespace(row.namespace)).length;
  const parts = [`共 ${discoverRows.length} 个 Deployment`];
  if (discoverClusterNotice) parts.push("Cluster 列表接口不可用，改用本机/标签页 Cluster");
  if (discoverSource === "collection") parts.push("改用 Rancher 集合列表读取");
  if (discoverSource === "namespace") {
    parts.push(`改用按命名空间读取 ${discoverNamespacesRead} 个${discoverSkipped ? `，跳过 ${discoverSkipped} 个` : ""}`);
    if (discoverTruncated) parts.push(`命名空间较多，只读取前 ${DISCOVERY_MAX_NAMESPACES} 个`);
  } else if (discoverTruncated) {
    parts.push(`列表较大，仅读取前 ${DISCOVERY_PAGE_SIZE * DISCOVERY_MAX_PAGES} 项`);
  }
  if (!discoverShowSystem && hidden) parts.push(`已隐藏 ${hidden} 个系统命名空间条目`);
  if (discoverQuery) parts.push(`匹配 ${visibleDiscoverRows().length} 项`);
  discoverStatus.textContent = parts.join(" · ");
}

function updateDiscoverSelectionCount() {
  discoverSelectedCount.textContent = `已选 ${discoverSelection.size} 项`;
  discoverAddButton.disabled = discoverSelection.size === 0;
  discoverAddButton.textContent = discoverSelection.size
    ? `添加到监控（${discoverSelection.size}）`
    : "添加到监控";
}

function renderSiteSelect() {
  discoverSiteSelect.innerHTML = discoverSites.length
    ? discoverSites.map((site) => `<option value="${escapeHtml(site.baseUrl)}">${escapeHtml(site.baseUrl.replace(/^https?:\/\//, ""))}</option>`).join("")
    : '<option value="">暂无已授权的 Rancher 站点</option>';
}

function renderClusterSelect() {
  const previous = discoverClusterSelect.value;
  discoverClusterSelect.innerHTML = discoverClusters.length
    ? discoverClusters.map((cluster) => `<option value="${escapeHtml(cluster.id)}">${escapeHtml(discoverClusterLabel(cluster))}</option>`).join("")
    : '<option value="">未读取到 Cluster</option>';
  if (discoverClusters.some((cluster) => cluster.id === previous)) {
    discoverClusterSelect.value = previous;
  }
}

function renderDiscoverList() {
  const cluster = discoverClusterRef();
  if (!cluster) {
    discoverList.innerHTML = '<div class="discover-empty">选择站点与 Cluster 后显示可添加的 Deployment。</div>';
  } else if (discoverFailed) {
    discoverList.innerHTML = '<div class="discover-empty">读取失败。可点“授权并重试”，或改用粘贴地址添加。</div>';
  } else if (!discoverRows.length) {
    discoverList.innerHTML = '<div class="discover-empty">该 Cluster 没有读取到 Deployment。</div>';
  } else if (!visibleDiscoverRows().length) {
    discoverList.innerHTML = '<div class="discover-empty">没有匹配的 Deployment，可勾选“系统命名空间”再试。</div>';
  } else {
    const watchedIds = new Set(watches.map(watchId));
    discoverList.innerHTML = visibleDiscoverRows().map((row) => {
      const watch = discoveredDeploymentToWatch(cluster, row);
      const id = watchId(watch);
      discoverWatchIndex.set(id, watch);
      const watched = watchedIds.has(id);
      return `<label class="discover-row${watched ? " is-watched" : ""}" data-id="${escapeHtml(id)}">
        <input type="checkbox" aria-label="选择 ${escapeHtml(`${row.namespace}/${row.name}`)}"${watched ? " disabled" : ""}${discoverSelection.has(id) ? " checked" : ""} />
        <span class="discover-ns">${escapeHtml(row.namespace)}</span>
        <span class="discover-name">${escapeHtml(row.name)}</span>
        <span class="discover-replicas">${row.ready}/${row.desired}</span>
        <span class="discover-watched">${watched ? "已监控" : ""}</span>
      </label>`;
    }).join("");
  }
  updateDiscoverSelectionCount();
}

async function listDiscoverSites() {
  const granted = await chrome.permissions.getAll();
  const sites = new Map();
  for (const pattern of granted?.origins || []) {
    const baseUrl = pattern.replace(/\/\*$/, "");
    if (/^https?:\/\/[^/]+$/.test(baseUrl)) sites.set(baseUrl, { baseUrl });
  }
  for (const watch of watches) {
    if (!sites.has(watch.baseUrl)) sites.set(watch.baseUrl, { baseUrl: watch.baseUrl });
  }
  return [...sites.values()].sort((left, right) => left.baseUrl.localeCompare(right.baseUrl));
}

async function openDiscoverDialog() {
  discoverBuild.textContent = `v${chrome.runtime.getManifest().version}`;
  discoverSelection.clear();
  discoverWatchIndex.clear();
  discoverClusters = [];
  discoverClusterNotice = "";
  discoverTabCluster = null;
  discoverRows = [];
  discoverTruncated = false;
  discoverSource = "";
  discoverFailed = false;
  discoverQuery = "";
  discoverShowSystem = false;
  discoverSearchInput.value = "";
  discoverSystemInput.checked = false;
  showDiscoverError("");
  discoverSites = await listDiscoverSites();
  renderSiteSelect();
  renderClusterSelect();
  renderDiscoverList();
  updateDiscoverStatus();
  discoverDialog.showModal();
  if (discoverSites.length) await loadDiscoverClusters();
}

async function loadDiscoverClusters() {
  const baseUrl = discoverSiteSelect.value;
  if (!baseUrl) return;
  discoverTabCluster = clusterFromUrl(await currentTabUrl());
  discoverClusterNotice = "";
  discoverClusters = clusterCandidatesFor(baseUrl);
  discoverRows = [];
  discoverSource = "";
  discoverFailed = false;
  renderClusterSelect();
  renderDiscoverList();
  showDiscoverError("");
  discoverStatus.textContent = "正在读取 Cluster 列表…";
  try {
    const response = await sendDiscoverRequest({ type: "discover-clusters", baseUrl });
    discoverClusters = clusterCandidatesFor(baseUrl, response.clusters || []);
    if (!discoverClusters.some((cluster) => cluster.origins?.includes("api"))) {
      discoverClusterNotice = "该站点没有返回 Cluster 列表，可能是当前账号无权限；已改用本机与当前标签页的 Cluster。";
    }
  } catch (error) {
    discoverClusters = clusterCandidatesFor(baseUrl);
    if (discoverClusters.length) {
      discoverClusterNotice = `${error.message}（本机与当前标签页的 Cluster 仍可选）`;
    } else {
      discoverClusterNotice = error.message;
    }
  }
  renderClusterSelect();
  if (discoverClusters.length) await loadDiscoverDeployments();
  else updateDiscoverStatus();
}

function knownNamespaceNames(cluster) {
  return [...new Set(
    watches
      .filter((watch) => watch.baseUrl === cluster.baseUrl && watch.clusterId === cluster.id)
      .map((watch) => watch.namespace)
  )];
}

async function loadDiscoverDeployments() {
  const cluster = discoverClusterRef();
  if (!cluster) return;
  discoverRows = [];
  discoverTruncated = false;
  discoverSource = "";
  discoverSkipped = 0;
  discoverNamespacesRead = 0;
  discoverFailed = false;
  renderDiscoverList();
  showDiscoverError(discoverClusterNotice);
  discoverStatus.textContent = `正在读取 ${cluster.name || cluster.id} 的 Deployment 列表…`;
  try {
    const response = await sendDiscoverRequest({
      type: "discover-deployments",
      baseUrl: cluster.baseUrl,
      clusterId: cluster.id,
      namespaces: knownNamespaceNames(cluster)
    });
    discoverRows = response.deployments || [];
    discoverTruncated = response.truncated === true;
    discoverSource = response.source || "cluster";
    discoverSkipped = Number(response.skipped) || 0;
    discoverNamespacesRead = Number(response.namespacesRead) || 0;
  } catch (error) {
    discoverFailed = true;
    showDiscoverError(error.message);
  } finally {
    renderDiscoverList();
    updateDiscoverStatus();
  }
}

async function useCurrentTabForDiscovery() {
  const found = clusterFromUrl(await currentTabUrl());
  if (!found) {
    showDiscoverError("当前标签页不是 Rancher Cluster 页面，请手动选择站点。");
    return;
  }
  discoverTabCluster = found;
  discoverTabCluster = found;
  if (!discoverSites.some((site) => site.baseUrl === found.baseUrl)) {
    discoverSites = [...discoverSites, { baseUrl: found.baseUrl }]
      .sort((left, right) => left.baseUrl.localeCompare(right.baseUrl));
    renderSiteSelect();
  }
  discoverSiteSelect.value = found.baseUrl;
  await loadDiscoverClusters();
  if (discoverClusters.some((cluster) => cluster.id === found.clusterId)) {
    discoverClusterSelect.value = found.clusterId;
    await loadDiscoverDeployments();
  }
}

async function grantDiscoverSite() {
  const baseUrl = discoverSiteSelect.value;
  if (!baseUrl) {
    showDiscoverError("请先选择要授权的 Rancher 站点。");
    return;
  }
  discoverGrantButton.disabled = true;
  try {
    const granted = await chrome.permissions.request({ origins: [permissionPattern(baseUrl)] });
    if (!granted) {
      showDiscoverError("未获得该站点的访问权限，无法读取列表。");
      discoverStatus.textContent = "未获得该站点的访问权限。";
      return;
    }
    await loadDiscoverClusters();
  } finally {
    discoverGrantButton.disabled = false;
  }
}

function toggleDiscoverRow(event) {
  const row = event.target.closest(".discover-row");
  if (!row || event.target.tagName !== "INPUT") return;
  const id = row.dataset.id;
  if (event.target.checked) {
    const watch = discoverWatchIndex.get(id);
    if (watch) discoverSelection.set(id, watch);
  } else {
    discoverSelection.delete(id);
  }
  updateDiscoverSelectionCount();
}

function selectShownDiscoverRows() {
  const cluster = discoverClusterRef();
  if (!cluster) return;
  const watchedIds = new Set(watches.map(watchId));
  for (const row of visibleDiscoverRows()) {
    const watch = discoveredDeploymentToWatch(cluster, row);
    const id = watchId(watch);
    if (watchedIds.has(id)) continue;
    discoverWatchIndex.set(id, watch);
    discoverSelection.set(id, watch);
  }
  renderDiscoverList();
}

function clearDiscoverSelection() {
  discoverSelection.clear();
  renderDiscoverList();
}

async function addDiscoveredWatches() {
  const pending = [...discoverSelection.values()];
  if (!pending.length) return;
  discoverAddButton.disabled = true;
  discoverAddButton.textContent = "正在添加…";
  try {
    const origins = [...new Set(pending.map((watch) => permissionPattern(watch.baseUrl)))];
    const granted = await chrome.permissions.request({ origins });
    if (!granted) throw new Error("需要 Rancher 站点访问权限才能读取状态");
    const merged = mergeMonitors(watches, pending);
    await chrome.storage.local.set({ [WATCHES_KEY]: merged.watches });
    watches = merged.watches;
    discoverSelection.clear();
    discoverDialog.close();
    dialog.close();
    render();
    summary.textContent = `已添加 ${merged.addedIds.length} 个监控项` +
      `${merged.skippedIds.length ? `，${merged.skippedIds.length} 个已存在并已更新` : ""}，正在刷新状态`;
  } catch (error) {
    showDiscoverError(`添加失败：${error?.message || "无法写入扩展本地存储"}`);
  } finally {
    updateDiscoverSelectionCount();
  }
}

async function refreshAll(watchIds = null) {
  if (paused()) {
    summary.textContent = "监控已暂停，不会发起 Rancher 请求";
    return results;
  }
  if (refreshInProgress) {
    if (Array.isArray(watchIds)) watchIds.forEach((id) => pendingWatchIds.add(id));
    else pendingFullRefresh = true;
    return new Promise((resolve) => pendingRefreshWaiters.push(resolve));
  }
  refreshInProgress = true;
  refreshButton.classList.add("refreshing");
  refreshButton.disabled = true;
  content.setAttribute("aria-busy", "true");
  try {
    const response = await chrome.runtime.sendMessage({ type: "refresh", watchIds });
    if (response?.__rancherWatchError) throw new Error(response.__rancherWatchError);
    results = response || results;
    render();
  } catch (error) {
    summary.textContent = `刷新失败：${error.message}`;
  } finally {
    refreshButton.classList.remove("refreshing");
    refreshButton.disabled = false;
    content.removeAttribute("aria-busy");
    refreshInProgress = false;
    if (pendingFullRefresh || pendingWatchIds.size) {
      const nextWatchIds = pendingFullRefresh ? null : [...pendingWatchIds];
      const waiters = pendingRefreshWaiters;
      pendingFullRefresh = false;
      pendingWatchIds.clear();
      pendingRefreshWaiters = [];
      refreshAll(nextWatchIds).then((value) => waiters.forEach((resolve) => resolve(value)));
    } else {
      const waiters = pendingRefreshWaiters;
      pendingRefreshWaiters = [];
      waiters.forEach((resolve) => resolve(results));
    }
  }
  return results;
}

function resetLiveRefreshTimer() {
  if (liveRefreshTimer) clearInterval(liveRefreshTimer);
  if (paused()) return;
  liveRefreshTimer = setInterval(() => {
    if (watches.length) refreshAll();
  }, refreshSecondsFromSettings(settings) * 1000);
}

async function init() {
  const data = await chrome.storage.local.get([WATCHES_KEY, RESULTS_KEY, SETTINGS_KEY, HISTORY_KEY]);
  watches = data[WATCHES_KEY] || [];
  results = data[RESULTS_KEY] || {};
  settings = data[SETTINGS_KEY] || {};
  history = Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [];
  intervalSelect.value = String(refreshSecondsFromSettings(settings));
  resetLiveRefreshTimer();
  render();
  if (watches.length) refreshAll();
}

addButton.addEventListener("click", openAddDialog);
refreshButton.addEventListener("click", () => refreshAll());
async function toggleRememberLogin() {
  const enabling = settings.rememberLogin !== true;
  try {
    if (enabling) {
      const granted = await chrome.permissions.request({ permissions: ["cookies"] });
      if (!granted) throw new Error("需要 Cookie 权限才能在浏览器重启后保持 Rancher 登录");
    }
    const nextSettings = { ...settings, rememberLogin: enabling };
    await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
    settings = nextSettings;
    updateRememberLoginButton();
    if (enabling) {
      const response = await chrome.runtime.sendMessage({ type: "remember-login-now" });
      if (response?.__rancherWatchError || response?.ok === false) {
        throw new Error(response?.__rancherWatchError || "无法读取当前 Rancher 会话");
      }
      summary.textContent = response?.persisted
        ? `已保持 ${response.persisted} 个 Rancher 站点的当前登录（约 30 天）`
        : "已开启保持登录；下次登录 Rancher 时会自动记住最新会话";
    } else {
      await chrome.permissions.remove({ permissions: ["cookies"] });
      summary.textContent = "已关闭保持登录；可在 Rancher 中退出已有会话";
    }
  } catch (error) {
    summary.textContent = `保持登录设置失败：${error?.message || "未知错误"}`;
  }
}
rememberLoginButton.addEventListener("click", toggleRememberLogin);
async function togglePause() {
  const nextSettings = settingsWithMonitoringPaused(settings, !paused());
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
    settings = nextSettings;
    updatePauseButton();
    resetLiveRefreshTimer();
    if (paused()) {
      summary.textContent = "监控已暂停 · 保留上次状态";
      render();
    } else {
      summary.textContent = "已恢复监控";
      render();
      if (watches.length) refreshAll();
    }
  } catch (error) {
    summary.textContent = `暂停设置保存失败：${error?.message || "无法写入本地存储"}`;
  }
}
pauseButton.addEventListener("click", togglePause);
resumeFromBannerButton.addEventListener("click", togglePause);
document.querySelector("#use-current").addEventListener("click", () => useCurrentTab(true));
urlInput.addEventListener("input", updateUrlHint);
document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => dialog.close());
form.addEventListener("submit", saveWatch);
nameForm.addEventListener("submit", saveDisplayName);
resetDisplayNameButton.addEventListener("click", resetDisplayName);
document.querySelector("#close-name-dialog").addEventListener("click", () => nameDialog.close());
document.querySelector("#cancel-name-dialog").addEventListener("click", () => nameDialog.close());
configButton.addEventListener("click", openConfigDialog);
document.querySelector("#close-config-dialog").addEventListener("click", () => configDialog.close());
document.querySelector("#cancel-config-dialog").addEventListener("click", () => configDialog.close());
exportButton.addEventListener("click", exportConfig);
pickFileButton.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", () => readConfigFile(importFile.files[0]));
importMode.addEventListener("change", () => showConfigError(""));
configForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pendingImport) confirmConfigImport();
});
confirmImportButton.addEventListener("click", confirmConfigImport);
browseButton.addEventListener("click", openDiscoverDialog);
document.querySelector("#close-discover-dialog").addEventListener("click", () => discoverDialog.close());
document.querySelector("#cancel-discover-dialog").addEventListener("click", () => discoverDialog.close());
discoverForm.addEventListener("submit", (event) => event.preventDefault());
discoverSiteSelect.addEventListener("change", () => loadDiscoverClusters());
discoverClusterSelect.addEventListener("change", () => loadDiscoverDeployments());
discoverUseTabButton.addEventListener("click", useCurrentTabForDiscovery);
discoverGrantButton.addEventListener("click", grantDiscoverSite);
discoverSearchInput.addEventListener("input", () => {
  discoverQuery = discoverSearchInput.value;
  renderDiscoverList();
  updateDiscoverStatus();
});
discoverSystemInput.addEventListener("change", () => {
  discoverShowSystem = discoverSystemInput.checked;
  renderDiscoverList();
  updateDiscoverStatus();
});
discoverList.addEventListener("change", toggleDiscoverRow);
discoverSelectShownButton.addEventListener("click", selectShownDiscoverRows);
discoverClearButton.addEventListener("click", clearDiscoverSelection);
discoverAddButton.addEventListener("click", addDiscoveredWatches);
document.querySelectorAll(".filter[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll(".filter[data-filter]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    render();
  });
});
document.querySelectorAll(".view-mode").forEach((button) => {
  button.addEventListener("click", async () => {
    const nextSettings = { ...settings, viewMode: button.dataset.view };
    try {
      await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
      settings = nextSettings;
      render();
    } catch (error) {
      summary.textContent = `视图设置保存失败：${error?.message || "无法写入本地存储"}`;
    }
  });
});
intervalSelect.addEventListener("change", async () => {
  const { refreshMinutes: _legacyRefreshMinutes, ...currentSettings } = settings;
  const previousSeconds = refreshSecondsFromSettings(settings);
  const nextSettings = { ...currentSettings, refreshSeconds: Number(intervalSelect.value) };
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: nextSettings });
    settings = nextSettings;
    resetLiveRefreshTimer();
  } catch (error) {
    intervalSelect.value = String(previousSeconds);
    summary.textContent = `刷新间隔保存失败：${error?.message || "无法写入本地存储"}`;
  }
});
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  render();
});
timelineEnvSelect.addEventListener("change", () => {
  timelineEnvironment = timelineEnvSelect.value;
  render();
});
timelineSortSelect.addEventListener("change", () => {
  timelineSort = TIMELINE_SORT_MODES.has(timelineSortSelect.value) ? timelineSortSelect.value : "normal";
  render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[RESULTS_KEY]) {
    results = changes[RESULTS_KEY].newValue || {};
    render();
  }
  if (changes[SETTINGS_KEY]) {
    settings = changes[SETTINGS_KEY].newValue || {};
    intervalSelect.value = String(refreshSecondsFromSettings(settings));
    resetLiveRefreshTimer();
    render();
  }
  if (changes[WATCHES_KEY]) {
    watches = changes[WATCHES_KEY].newValue || [];
    render();
  }
  if (changes[HISTORY_KEY]) {
    const nextHistory = changes[HISTORY_KEY].newValue;
    history = Array.isArray(nextHistory) ? nextHistory : [];
    render();
  }
});

init();
