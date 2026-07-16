import {
  WATCHES_KEY,
  RESULTS_KEY,
  SETTINGS_KEY,
  buildApiUrls,
  selectorFromDeployment,
  summarizeDeployment,
  podsForDeployment,
  readableError,
  watchId,
  refreshSecondsFromSettings
} from "./lib/rancher.js";

const ALARM_NAME = "refresh-deployments";
const refreshVersions = new Map();
let resultWriteQueue = Promise.resolve();

async function storageGet(keys) {
  return chrome.storage.local.get(keys);
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

async function updateBadge(results) {
  const values = Object.values(results);
  const problemCount = values.filter(
    (result) => !result.ok || ["degraded", "unavailable"].includes(result.status)
  ).length;
  await chrome.action.setBadgeBackgroundColor({ color: problemCount ? "#D92D20" : "#16803C" });
  await chrome.action.setBadgeText({ text: problemCount ? String(problemCount) : values.length ? "✓" : "" });
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
    const data = await storageGet([RESULTS_KEY]);
    const results = Object.fromEntries(
      Object.entries(data[RESULTS_KEY] || {}).filter(([id]) => activeIds.has(id))
    );
    await chrome.storage.local.set({ [RESULTS_KEY]: results });
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
    const data = await storageGet([WATCHES_KEY, RESULTS_KEY]);
    const currentWatches = data[WATCHES_KEY] || [];
    if (!currentWatches.some((item) => watchId(item) === id)) return;
    const activeIds = new Set(currentWatches.map(watchId));
    const results = Object.fromEntries(
      Object.entries({ ...(data[RESULTS_KEY] || {}), [id]: result })
        .filter(([resultId]) => activeIds.has(resultId))
    );
    await chrome.storage.local.set({ [RESULTS_KEY]: results });
    await updateBadge(results);
    await maybeNotifyProblems(currentWatches, results, (await storageGet([SETTINGS_KEY]))[SETTINGS_KEY] || {});
  });
}

async function refreshAll(requestedIds = null) {
  const data = await storageGet([WATCHES_KEY]);
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
  const interval = Math.max(0.5, refreshSecondsFromSettings(data[SETTINGS_KEY]) / 60);
  await chrome.alarms.clear(ALARM_NAME);
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
  if (
    changes[SETTINGS_KEY] &&
    refreshSecondsFromSettings(changes[SETTINGS_KEY].oldValue) !==
      refreshSecondsFromSettings(changes[SETTINGS_KEY].newValue)
  ) ensureAlarm();
  if (changes[WATCHES_KEY]) {
    const previousIds = new Set((changes[WATCHES_KEY].oldValue || []).map(watchId));
    const currentWatches = changes[WATCHES_KEY].newValue || [];
    const addedIds = currentWatches.map(watchId).filter((id) => !previousIds.has(id));
    const update = addedIds.length ? refreshAll(addedIds) : reconcileResults(currentWatches);
    update.catch((error) => console.error("更新监控项失败", error));
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  let response;
  if (message?.type === "refresh") response = refreshAll(message.watchIds);
  else if (message?.type === "reset-alarm") response = ensureAlarm().then(() => ({ ok: true }));
  else return false;

  response.then(sendResponse).catch((error) => {
    sendResponse({ __rancherWatchError: error?.message || "后台操作失败" });
  });
  return true;
});
