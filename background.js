import {
  WATCHES_KEY,
  RESULTS_KEY,
  SETTINGS_KEY,
  HISTORY_KEY,
  HISTORY_LIMIT,
  buildApiUrls,
  selectorFromDeployment,
  summarizeDeployment,
  podsForDeployment,
  readableError,
  watchId,
  isMonitoringPaused,
  refreshSecondsFromSettings,
  nextLastReadyAt,
  historyEventFor,
  mergeHistory,
  clusterDiscoveryUrls,
  normalizeClusterList,
  clusterListFailureMessage,
  deploymentDiscoveryUrl,
  normalizeDeploymentList,
  sortDiscoveryRows,
  namespaceDiscoveryUrls,
  normalizeNamespaceList,
  namespacedDeploymentDiscoveryUrl,
  deploymentCollectionDiscoveryUrl,
  prioritizeNamespaces,
  isCollectionPayload,
  nextCollectionPageUrl,
  isCollectionTruncated,
  discoveryProblemLabel,
  discoveryFailureMessage,
  DISCOVERY_MAX_PAGES,
  DISCOVERY_NAMESPACE_CONCURRENCY
} from "./lib/rancher.js";

const ALARM_NAME = "refresh-deployments";
const RANCHER_SESSION_COOKIE = "R_SESS";
const REMEMBER_LOGIN_SECONDS = 30 * 24 * 60 * 60;
const refreshVersions = new Map();
let resultWriteQueue = Promise.resolve();
let cookieListenerRegistered = false;

async function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function cookieUrl(baseUrl, cookie) {
  const url = new URL(baseUrl);
  url.pathname = cookie.path || "/";
  url.search = "";
  url.hash = "";
  return url.href;
}

function cookieMatchesBaseUrl(cookie, baseUrl) {
  const hostname = new URL(baseUrl).hostname.toLocaleLowerCase();
  const domain = String(cookie.domain || "").replace(/^\./, "").toLocaleLowerCase();
  return cookie.hostOnly ? hostname === domain : hostname === domain || hostname.endsWith(`.${domain}`);
}

async function persistSessionCookie(baseUrl, cookie) {
  if (!cookie || cookie.name !== RANCHER_SESSION_COOKIE || cookie.expirationDate) return false;
  const details = {
    url: cookieUrl(baseUrl, cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path || "/",
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    expirationDate: Date.now() / 1000 + REMEMBER_LOGIN_SECONDS
  };
  if (!cookie.hostOnly && cookie.domain) details.domain = cookie.domain;
  if (cookie.sameSite) details.sameSite = cookie.sameSite;
  if (cookie.storeId) details.storeId = cookie.storeId;
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  await chrome.cookies.set(details);
  return true;
}

async function persistCurrentSessions() {
  if (!chrome.cookies?.get || !chrome.cookies?.set) return { ok: false, persisted: 0 };
  const data = await storageGet([WATCHES_KEY, SETTINGS_KEY]);
  if (data[SETTINGS_KEY]?.rememberLogin !== true) return { ok: true, persisted: 0 };
  const baseUrls = [...new Set((data[WATCHES_KEY] || []).map((watch) => watch.baseUrl))];
  let persisted = 0;
  for (const baseUrl of baseUrls) {
    const cookie = await chrome.cookies.get({ url: baseUrl, name: RANCHER_SESSION_COOKIE });
    if (await persistSessionCookie(baseUrl, cookie)) persisted += 1;
  }
  return { ok: true, persisted };
}

async function handleCookieChanged(changeInfo) {
  const cookie = changeInfo?.cookie;
  if (changeInfo?.removed || cookie?.name !== RANCHER_SESSION_COOKIE || cookie.expirationDate) return;
  const data = await storageGet([WATCHES_KEY, SETTINGS_KEY]);
  if (data[SETTINGS_KEY]?.rememberLogin !== true) return;
  const matchingWatch = (data[WATCHES_KEY] || []).find((watch) => cookieMatchesBaseUrl(cookie, watch.baseUrl));
  if (matchingWatch) await persistSessionCookie(matchingWatch.baseUrl, cookie);
}

function ensureCookieListener() {
  if (cookieListenerRegistered || !chrome.cookies?.onChanged) return;
  chrome.cookies.onChanged.addListener((changeInfo) => {
    handleCookieChanged(changeInfo).catch((error) => console.warn("保持 Rancher 登录失败", error?.message || error));
  });
  cookieListenerRegistered = true;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`Rancher API 返回 ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("json")) throw new Error("Rancher 返回了非 JSON 页面，请重新登录后刷新");
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshWatch(watch) {
  const urls = buildApiUrls(watch);
  try {
    const deployment = await fetchJson(urls.deployment);
    const selector = selectorFromDeployment(deployment);
    if (!selector) throw new Error("Deployment 没有可用的 Pod 标签选择器");
    const replicaSetsUrl = `${urls.replicaSetsPrefix}?labelSelector=${encodeURIComponent(selector)}`;
    const podsUrl = `${urls.podsPrefix}?labelSelector=${encodeURIComponent(selector)}`;
    const [replicaSetList, podList] = await Promise.all([
      fetchJson(replicaSetsUrl),
      fetchJson(podsUrl)
    ]);
    const pods = podsForDeployment(deployment, replicaSetList.items || [], podList.items || []);
    return { ok: true, ...summarizeDeployment(deployment, pods) };
  } catch (error) {
    return {
      ok: false,
      status: "unknown",
      error: readableError(error, error.status),
      checkedAt: new Date().toISOString()
    };
  }
}

async function discoverClusters(baseUrl) {
  const attempts = [];
  let sawEmptyCollection = false;
  for (const url of clusterDiscoveryUrls(baseUrl)) {
    const path = new URL(url).pathname;
    try {
      const payload = await fetchJson(url);
      if (!isCollectionPayload(payload)) {
        attempts.push({ path, label: discoveryProblemLabel("not-a-list"), status: 0 });
        continue;
      }
      const clusters = normalizeClusterList(payload);
      if (clusters.length) return { clusters };
      sawEmptyCollection = true;
    } catch (error) {
      attempts.push({ path, label: discoveryProblemLabel(error), status: error?.status || 0 });
    }
  }
  if (sawEmptyCollection) return { clusters: [] };
  throw new Error(clusterListFailureMessage(attempts));
}

async function discoverDeployments(baseUrl, clusterId, knownNamespaces = []) {
  const cluster = { baseUrl, clusterId };
  const problems = [];

  const clusterWide = await readPagedDeployments(deploymentDiscoveryUrl, cluster);
  if (!clusterWide.problem) return discoveryResult(clusterWide, "cluster");
  problems.push({ path: "Cluster 级列表", ...clusterWide.problem });

  // Rancher 的 Cluster 级代理列表可能被拒或返回空对象，改用 Rancher 自己的集合接口。
  const collection = await readPagedDeployments(deploymentCollectionDiscoveryUrl, cluster);
  if (!collection.problem) return discoveryResult(collection, "collection");
  problems.push({ path: "Rancher 集合列表", ...collection.problem });

  // 项目级角色通常只有命名空间权限，最后逐个命名空间读取。
  const listing = await discoverNamespaces(cluster, knownNamespaces);
  if (listing.problem) problems.push({ path: "命名空间列表", ...listing.problem });
  const plan = prioritizeNamespaces(listing.namespaces);
  const deployments = [];
  let truncated = plan.truncated;
  let denied = 0;
  let invalid = 0;
  await runLimited(plan.namespaces, DISCOVERY_NAMESPACE_CONCURRENCY, async (namespace) => {
    try {
      const payload = await fetchJson(namespacedDeploymentDiscoveryUrl(cluster, namespace));
      if (!isCollectionPayload(payload)) {
        invalid += 1;
        return;
      }
      deployments.push(...normalizeDeploymentList(payload));
      if (isCollectionTruncated(payload)) truncated = true;
    } catch (error) {
      if (error.status === 403 || error.status === 401) {
        denied += 1;
        problems.push({ path: "命名空间内列表", label: "", status: error.status });
      } else {
        problems.push({ path: "命名空间内列表", label: discoveryProblemLabel(error), status: error?.status || 0 });
      }
    }
  });
  const read = plan.namespaces.length - denied - invalid;
  if (deployments.length) {
    return {
      deployments: sortDiscoveryRows(deployments),
      truncated,
      source: "namespace",
      skipped: denied + invalid,
      namespacesRead: read
    };
  }
  if (!problems.length) {
    return { deployments: [], truncated: plan.truncated, source: "cluster", skipped: 0, namespacesRead: read };
  }
  throw new Error(discoveryFailureMessage({ problems, denied, invalid }));
}

function discoveryResult({ deployments, truncated }, source) {
  return {
    deployments: sortDiscoveryRows(deployments),
    truncated,
    source,
    skipped: 0,
    namespacesRead: 0
  };
}

async function readPagedDeployments(urlFor, cluster) {
  const deployments = [];
  let url = urlFor(cluster, "");
  let truncated = true;
  for (let page = 0; page < DISCOVERY_MAX_PAGES; page += 1) {
    let payload;
    try {
      payload = await fetchJson(url);
    } catch (error) {
      return { deployments, problem: { label: discoveryProblemLabel(error), status: error?.status || 0 } };
    }
    // Rancher 在无权限时可能返回 200 和空对象，这不是一个可用的列表。
    if (!isCollectionPayload(payload)) {
      return { deployments, problem: { label: discoveryProblemLabel("not-a-list"), status: 0 } };
    }
    deployments.push(...normalizeDeploymentList(payload));
    const next = nextCollectionPageUrl(payload, urlFor, cluster);
    if (!next) {
      truncated = isCollectionTruncated(payload);
      break;
    }
    url = next;
  }
  return { deployments, truncated, problem: null };
}

// 返回可用的命名空间；两者都不可用时记下问题，供界面说明失败原因。
async function discoverNamespaces(cluster, knownNamespaces) {
  const namespaces = new Set(knownNamespaces.filter(Boolean));
  let problem = null;
  for (const url of namespaceDiscoveryUrls(cluster)) {
    try {
      const payload = await fetchJson(url);
      const found = isCollectionPayload(payload) ? normalizeNamespaceList(payload) : [];
      if (found.length) {
        for (const namespace of found) namespaces.add(namespace);
        return { namespaces: [...namespaces], problem: null };
      }
      if (!isCollectionPayload(payload)) problem = problem || { label: discoveryProblemLabel("not-a-list"), status: 0 };
    } catch (error) {
      problem = problem || { label: discoveryProblemLabel(error), status: error?.status || 0 };
    }
  }
  return { namespaces: [...namespaces], problem };
}

async function runLimited(items, limit, worker) {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    })
  );
}

async function updateBadge(results) {
  const data = await storageGet([SETTINGS_KEY]);
  if (isMonitoringPaused(data[SETTINGS_KEY] || {})) return updatePausedBadge();
  const values = Object.values(results);
  const problemCount = values.filter(
    (result) => !result.ok || ["degraded", "unavailable"].includes(result.status)
  ).length;
  await chrome.action.setBadgeBackgroundColor({ color: problemCount ? "#D92D20" : "#16803C" });
  await chrome.action.setBadgeText({ text: problemCount ? String(problemCount) : values.length ? "✓" : "" });
}

async function updatePausedBadge() {
  await chrome.action.setBadgeBackgroundColor({ color: "#8a939e" });
  await chrome.action.setBadgeText({ text: "⏸" });
}

function isProblemResult(result) {
  return !result?.ok || ["degraded", "unavailable", "unknown"].includes(result?.status);
}

function watchLabel(watch, settings = {}) {
  const display = String(watch?.label || "").trim();
  if (display) return display;
  const env = String(watch?.environment || "").trim();
  const cluster = String(settings?.clusterNames?.[[
    encodeURIComponent(watch?.baseUrl || ""),
    encodeURIComponent(watch?.clusterId || "")
  ].join("::")] || "").trim();
  return [env || cluster || watch?.clusterId, watch?.namespace, watch?.deployment]
    .filter(Boolean)
    .join(" / ");
}

function describeProblem(result) {
  if (!result?.ok) return result?.error || "请求失败";
  switch (result.status) {
    case "unavailable": return `不可用：${result.ready || 0}/${result.desired || 0} 就绪`;
    case "degraded": return `有风险：${result.ready || 0}/${result.desired || 0} 就绪${result.restarts ? `，重启 ${result.restarts}` : ""}`;
    case "unknown": return "状态未知";
    default: return result.status || "异常";
  }
}

async function maybeNotifyProblems(watches, results, settings) {
  if (isMonitoringPaused(settings)) return;
  const optedInIds = new Set(Object.keys(settings?.notifiedWatchIds || {}));
  if (!optedInIds.size) return;
  const { notifiedProblems = {} } = await storageGet(["notifiedProblems"]);
  const currentProblemIds = new Set(
    watches
      .filter((watch) => optedInIds.has(watchId(watch)) && isProblemResult(results[watchId(watch)]))
      .map(watchId)
  );

  const newlyBroken = watches.filter(
    (watch) => currentProblemIds.has(watchId(watch)) && !notifiedProblems[watchId(watch)]
  );

  if (newlyBroken.length) {
    const firstWatch = newlyBroken[0];
    const title = newlyBroken.length === 1
      ? `${watchLabel(firstWatch, settings)} 状态异常`
      : `${newlyBroken.length} 个 Deployment 状态异常`;
    const body = newlyBroken.slice(0, 5).map(
      (watch) => `${watchLabel(watch, settings)}：${describeProblem(results[watchId(watch)])}`
    ).join("\n");

    try {
      await chrome.notifications.create("rancher-problem", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title,
        message: body,
        priority: 2,
        requireInteraction: false
      });
    } catch (error) {
      console.warn("通知发送失败", error?.message || error);
    }
  }

  const nextNotified = Object.fromEntries(
    [...currentProblemIds].map((id) => [id, true])
  );
  if (JSON.stringify(nextNotified) !== JSON.stringify(notifiedProblems)) {
    await chrome.storage.local.set({ notifiedProblems: nextNotified });
  }
}

function enqueueResultWrite(operation) {
  const queued = resultWriteQueue.then(operation);
  resultWriteQueue = queued.catch(() => {});
  return queued;
}

async function reconcileResults(watches) {
  const activeIds = new Set(watches.map(watchId));
  return enqueueResultWrite(async () => {
    const data = await storageGet([RESULTS_KEY, HISTORY_KEY]);
    const results = Object.fromEntries(
      Object.entries(data[RESULTS_KEY] || {}).filter(([id]) => activeIds.has(id))
    );
    const history = (Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [])
      .filter((event) => activeIds.has(event.id));
    await chrome.storage.local.set({ [RESULTS_KEY]: results, [HISTORY_KEY]: history });
    await updateBadge(results);
    return results;
  });
}

async function refreshAndCommit(watch) {
  const id = watchId(watch);
  const version = (refreshVersions.get(id) || 0) + 1;
  refreshVersions.set(id, version);
  const result = await refreshWatch(watch);

  await enqueueResultWrite(async () => {
    if (refreshVersions.get(id) !== version) return;
    const data = await storageGet([WATCHES_KEY, RESULTS_KEY, HISTORY_KEY]);
    const currentWatches = data[WATCHES_KEY] || [];
    const activeWatch = currentWatches.find((item) => watchId(item) === id);
    if (!activeWatch) return;
    const activeIds = new Set(currentWatches.map(watchId));
    const previousResults = data[RESULTS_KEY] || {};
    const committed = {
      ...result,
      lastReadyAt: nextLastReadyAt(previousResults[id], result, result.checkedAt)
    };
    const results = Object.fromEntries(
      Object.entries({ ...previousResults, [id]: committed })
        .filter(([resultId]) => activeIds.has(resultId))
    );
    const previousHistory = (Array.isArray(data[HISTORY_KEY]) ? data[HISTORY_KEY] : [])
      .filter((event) => activeIds.has(event.id));
    const seenBefore = previousHistory.some((event) => event.id === id);
    const event = historyEventFor(activeWatch, committed, seenBefore ? previousResults[id] : undefined);
    const history = mergeHistory(previousHistory, [event], HISTORY_LIMIT);
    await chrome.storage.local.set({ [RESULTS_KEY]: results, [HISTORY_KEY]: history });
    await updateBadge(results);
    await maybeNotifyProblems(currentWatches, results, (await storageGet([SETTINGS_KEY]))[SETTINGS_KEY] || {});
  });
}

async function refreshAll(requestedIds = null) {
  const data = await storageGet([WATCHES_KEY, SETTINGS_KEY]);
  const settings = data[SETTINGS_KEY] || {};
  if (isMonitoringPaused(settings)) {
    const existing = await storageGet([RESULTS_KEY]);
    return existing[RESULTS_KEY] || {};
  }
  const watches = data[WATCHES_KEY] || [];
  const requested = Array.isArray(requestedIds) ? new Set(requestedIds) : null;
  const selectedWatches = requested
    ? watches.filter((watch) => requested.has(watchId(watch)))
    : watches;
  await reconcileResults(watches);
  await Promise.all(selectedWatches.map(refreshAndCommit));
  const finalData = await storageGet([RESULTS_KEY, SETTINGS_KEY]);
  const finalResults = finalData[RESULTS_KEY] || {};
  await maybeNotifyProblems(watches, finalResults, finalData[SETTINGS_KEY] || {});
  return finalResults;
}

async function ensureAlarm() {
  const data = await storageGet([SETTINGS_KEY]);
  const settings = data[SETTINGS_KEY] || {};
  await chrome.alarms.clear(ALARM_NAME);
  if (isMonitoringPaused(settings)) {
    await updatePausedBadge();
    return;
  }
  const interval = Math.max(0.5, refreshSecondsFromSettings(settings) / 60);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: interval });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  refreshAll();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshAll();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) refreshAll();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[SETTINGS_KEY]) {
    const oldSettings = changes[SETTINGS_KEY].oldValue || {};
    const newSettings = changes[SETTINGS_KEY].newValue || {};
    const intervalChanged = refreshSecondsFromSettings(oldSettings) !== refreshSecondsFromSettings(newSettings);
    const pausedChanged = isMonitoringPaused(oldSettings) !== isMonitoringPaused(newSettings);
    if (intervalChanged || pausedChanged) ensureAlarm();
  }
  if (changes[WATCHES_KEY]) {
    const previousIds = new Set((changes[WATCHES_KEY].oldValue || []).map(watchId));
    const currentWatches = changes[WATCHES_KEY].newValue || [];
    const addedIds = currentWatches.map(watchId).filter((id) => !previousIds.has(id));
    const update = addedIds.length ? refreshAll(addedIds) : reconcileResults(currentWatches);
    update.catch((error) => console.error("更新监控项失败", error));
    if (addedIds.length) persistCurrentSessions().catch((error) => console.warn("保持 Rancher 登录失败", error?.message || error));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let response;
  if (message?.type === "refresh") response = refreshAll(message.watchIds);
  else if (message?.type === "reset-alarm") response = ensureAlarm().then(() => ({ ok: true }));
  else if (message?.type === "remember-login-now") {
    ensureCookieListener();
    response = persistCurrentSessions();
  }
  else if (message?.type === "discover-clusters") response = discoverClusters(message.baseUrl);
  else if (message?.type === "discover-deployments") {
    response = discoverDeployments(message.baseUrl, message.clusterId, message.namespaces || []);
  }
  else return false;

  response.then(sendResponse).catch((error) => {
    sendResponse({ __rancherWatchError: error?.message || "后台操作失败" });
  });
  return true;
});

ensureCookieListener();
