import {
  WATCHES_KEY,
  RESULTS_KEY,
  SETTINGS_KEY,
  parseDeploymentUrl,
  parseDeploymentUrls,
  permissionPattern,
  watchId,
  watchMatchesQuery,
  compareWatchesByHealth,
  clusterKey
} from "./lib/rancher.js";

const content = document.querySelector("#content");
const toolbar = document.querySelector("#toolbar");
const summary = document.querySelector("#summary");
const refreshButton = document.querySelector("#refresh");
const addButton = document.querySelector("#add");
const dialog = document.querySelector("#add-dialog");
const form = document.querySelector("#add-form");
const urlInput = document.querySelector("#deployment-url");
const environmentInput = document.querySelector("#environment-label");
const labelInput = document.querySelector("#watch-label");
const formError = document.querySelector("#form-error");
const intervalSelect = document.querySelector("#refresh-interval");
const searchInput = document.querySelector("#watch-search");
const urlHint = document.querySelector("#url-hint");

let watches = [];
let results = {};
let filter = "all";
let searchQuery = "";
const refreshingClusters = new Set();

const statusText = {
  healthy: "正常",
  degraded: "有风险",
  unavailable: "不可用",
  paused: "已暂停",
  unknown: "未知"
};

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
  const displayName = watch.label || watch.deployment;
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
          <span class="status ${escapeHtml(result.status)}">${statusText[result.status] || "未知"}</span>
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
        <span class="checked">${relativeTime(result.checkedAt)}</span>
        <div class="card-actions">
          <button class="link-button open-watch" data-id="${escapeHtml(watchId(watch))}">打开 Rancher</button>
          <button class="link-button danger remove-watch" data-id="${escapeHtml(watchId(watch))}">移除</button>
        </div>
      </footer>
    </article>
  `;
}

function render() {
  const uiState = captureContentState();
  const healthy = watches.filter((watch) => results[watchId(watch)]?.status === "healthy").length;
  const problems = watches.filter((watch) => isProblem(results[watchId(watch)])).length;
  summary.textContent = watches.length
    ? `${watches.length} 个监控项 · ${healthy} 正常${problems ? ` · ${problems} 异常` : ""}`
    : "跨 Cluster 状态面板";
  toolbar.classList.toggle("hidden", watches.length === 0);

  if (!watches.length) {
    content.innerHTML = `
      <div class="empty-state">
        <div>
          <div class="empty-icon">＋</div>
          <h2>还没有监控项</h2>
          <p>打开任意 Rancher Deployment 详情页，然后使用“添加监控”读取当前页面；也可以直接粘贴详情页地址。</p>
          <button class="button primary" id="empty-add">添加第一个 Deployment</button>
        </div>
      </div>`;
    document.querySelector("#empty-add").addEventListener("click", openAddDialog);
    return;
  }

  const visible = watches
    .filter((watch) => filter === "all" || isProblem(results[watchId(watch)]))
    .filter((watch) => watchMatchesQuery(watch, searchQuery))
    .sort((left, right) => compareWatchesByHealth(left, right, (watch) => results[watchId(watch)]));
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
    const environment = group[0]?.environment || clusterId;
    const problemCount = group.filter((watch) => isProblem(results[watchId(watch)])).length;
    return `
      <section class="cluster-group" data-group-key="${escapeHtml(key)}">
        <div class="cluster-title">
          <h2>${escapeHtml(environment)} <small>${escapeHtml(clusterId)}</small></h2>
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
  restoreContentState(uiState);
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
    : active.classList.contains("open-watch")
      ? "open-watch"
      : active.tagName === "SUMMARY" ? "pod-summary" : null;
  const focus = card && cardAction
    ? { watchId: card.dataset.id, action: cardAction }
    : active.classList.contains("cluster-refresh")
      ? { groupKey: active.dataset.groupKey, action: "cluster-refresh" }
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
    : [...document.querySelectorAll(".cluster-refresh")].filter(
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
      label: parsedWatches.length === 1 ? labelInput.value.trim() : existingById.get(watchId(parsed))?.label || "",
      createdAt: existingById.get(watchId(parsed))?.createdAt || new Date().toISOString()
    }));
    const newIds = new Set(newWatches.map(watchId));
    watches = [...watches.filter((item) => !newIds.has(watchId(item))), ...newWatches];
    saveButton.disabled = true;
    saveButton.textContent = `正在添加 ${newWatches.length} 项…`;
    await chrome.storage.local.set({ [WATCHES_KEY]: watches });
    dialog.close();
    render();
  } catch (error) {
    formError.textContent = error.message;
    formError.classList.remove("hidden");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "授权站点并添加";
  }
}

async function refreshAll(watchIds = null) {
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
  }
}

async function init() {
  const data = await chrome.storage.local.get([WATCHES_KEY, RESULTS_KEY, SETTINGS_KEY]);
  watches = data[WATCHES_KEY] || [];
  results = data[RESULTS_KEY] || {};
  intervalSelect.value = String(data[SETTINGS_KEY]?.refreshMinutes || 1);
  render();
  if (watches.length) refreshAll();
}

addButton.addEventListener("click", openAddDialog);
refreshButton.addEventListener("click", () => refreshAll());
document.querySelector("#use-current").addEventListener("click", () => useCurrentTab(true));
urlInput.addEventListener("input", updateUrlHint);
document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
document.querySelector("#cancel-dialog").addEventListener("click", () => dialog.close());
form.addEventListener("submit", saveWatch);
document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll(".filter").forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    render();
  });
});
intervalSelect.addEventListener("change", async () => {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { refreshMinutes: Number(intervalSelect.value) } });
  await chrome.runtime.sendMessage({ type: "reset-alarm" });
});
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[RESULTS_KEY]) {
    results = changes[RESULTS_KEY].newValue || {};
    render();
  }
});

init();
