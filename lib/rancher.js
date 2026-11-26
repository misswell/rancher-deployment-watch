export const WATCHES_KEY = "watches";
export const RESULTS_KEY = "results";
export const SETTINGS_KEY = "settings";
export const HISTORY_KEY = "history";
export const HISTORY_LIMIT = 300;

export function parseDeploymentUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("请输入完整的 Rancher Deployment 地址");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const dashboardIndex = parts.indexOf("dashboard");
  const clusterMarker = parts[dashboardIndex + 1];
  const clusterId = parts[dashboardIndex + 2];
  const resourceType = parts[dashboardIndex + 4];
  const namespace = parts[dashboardIndex + 5];
  const deployment = parts[dashboardIndex + 6];

  if (
    dashboardIndex < 0 ||
    clusterMarker !== "c" ||
    !clusterId ||
    resourceType !== "apps.deployment" ||
    !namespace ||
    !deployment
  ) {
    throw new Error("地址不是 Rancher Deployment 详情页");
  }

  return {
    baseUrl: url.origin,
    clusterId: decodeURIComponent(clusterId),
    namespace: decodeURIComponent(namespace),
    deployment: decodeURIComponent(deployment),
    sourceUrl: `${url.origin}${url.pathname}#pods`
  };
}

export function parseDeploymentUrls(input) {
  const lines = String(input || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("请至少输入一个 Rancher Deployment 地址");

  const parsed = lines.map((line, index) => {
    try {
      return parseDeploymentUrl(line);
    } catch (error) {
      throw new Error(`第 ${index + 1} 行：${error.message}`);
    }
  });
  return [...new Map(parsed.map((watch) => [watchId(watch), watch])).values()];
}

export function permissionPattern(baseUrl) {
  return `${new URL(baseUrl).origin}/*`;
}

export function watchId(watch) {
  return [watch.baseUrl, watch.clusterId, watch.namespace, watch.deployment]
    .map((part) => encodeURIComponent(part))
    .join("::");
}

export function clusterKey(watch) {
  return [watch.baseUrl, watch.clusterId].map((part) => encodeURIComponent(part)).join("::");
}

export function clusterDisplayName(watch, settings = {}) {
  const customName = String(settings.clusterNames?.[clusterKey(watch)] || "").trim();
  return customName || watch.environment || watch.clusterId;
}

export function settingsWithClusterName(settings = {}, watch, name) {
  const clusterNames = { ...(settings.clusterNames || {}) };
  const customName = String(name || "").trim();
  const key = clusterKey(watch);
  if (customName) clusterNames[key] = customName;
  else delete clusterNames[key];
  return { ...settings, clusterNames };
}

// 时间线环境筛选：与时间线里显示的环境名称保持一致，同一 Cluster 只出现一次。
export function timelineEnvironmentOptions(watches = [], settings = {}) {
  const byKey = new Map();
  for (const watch of watches) {
    if (!watch) continue;
    const key = clusterKey(watch);
    if (byKey.has(key)) continue;
    byKey.set(key, { key, name: clusterDisplayName(watch, settings) });
  }
  return [...byKey.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "zh-CN") || left.key.localeCompare(right.key)
  );
}

export function refreshSecondsFromSettings(settings = {}) {
  const explicitSeconds = Number(settings.refreshSeconds);
  if (Number.isFinite(explicitSeconds) && explicitSeconds >= 5) return explicitSeconds;
  const legacyMinutes = Number(settings.refreshMinutes);
  if (Number.isFinite(legacyMinutes) && legacyMinutes > 0) return legacyMinutes * 60;
  return 60;
}

export function isMonitoringPaused(settings = {}) {
  return settings.monitoringPaused === true;
}

export function settingsWithMonitoringPaused(settings = {}, paused) {
  return { ...settings, monitoringPaused: Boolean(paused) };
}

export const CONFIG_EXPORT_KIND = "rancher-deployment-watch-config";
export const CONFIG_EXPORT_VERSION = 1;
const CONFIG_NAME_LIMIT = 40;

function trimmedText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function configText(value) {
  const text = trimmedText(value);
  return text.slice(0, CONFIG_NAME_LIMIT);
}

function earliestIso(first, second) {
  const times = [first, second]
    .filter((value) => typeof value === "string" && !Number.isNaN(Date.parse(value)))
    .map(Date.parse)
    .sort((left, right) => left - right);
  return times.length ? new Date(times[0]).toISOString() : new Date().toISOString();
}

function watchToUrl(watch) {
  if (typeof watch?.sourceUrl === "string" && watch.sourceUrl) return watch.sourceUrl;
  const origin = new URL(watch.baseUrl).origin;
  return [
    origin,
    "dashboard",
    "c",
    encodeURIComponent(watch.clusterId),
    "explorer",
    "apps.deployment",
    encodeURIComponent(watch.namespace),
    encodeURIComponent(watch.deployment)
  ].join("/").concat("#pods");
}
export function configExportFilename(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `rancher-deployment-watch-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.json`;
}

export function buildConfigExport(watches = [], settings = {}, exportedAt = new Date()) {
  const clusterKeys = new Set(watches.map(clusterKey));
  const watchIds = new Set(watches.map(watchId));
  return {
    kind: CONFIG_EXPORT_KIND,
    version: CONFIG_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    settings: {
      refreshSeconds: refreshSecondsFromSettings(settings),
      monitoringPaused: isMonitoringPaused(settings),
      viewMode: settings.viewMode === "compact"
        ? "compact"
        : settings.viewMode === "timeline" ? "timeline" : "standard",
      clusterNames: Object.fromEntries(
        Object.entries(settings.clusterNames || {})
          .filter(([key, name]) => clusterKeys.has(key) && configText(name))
          .map(([key, name]) => [key, configText(name)])
      ),
      notifiedWatchIds: Object.fromEntries(
        [...watchIds]
          .filter((id) => settings.notifiedWatchIds?.[id])
          .map((id) => [id, true])
      )
    },
    watches: watches.map((watch) => ({
      url: watchToUrl(watch),
      environment: trimmedText(watch.environment),
      label: configText(watch.label),
      addedAt: typeof watch.createdAt === "string" && !Number.isNaN(Date.parse(watch.createdAt))
        ? new Date(watch.createdAt).toISOString()
        : exportedAt.toISOString()
    }))
  };
}

function watchFromParts(entry) {
  const baseUrl = trimmedText(entry.baseUrl);
  const clusterId = trimmedText(entry.clusterId);
  const namespace = trimmedText(entry.namespace);
  const deployment = trimmedText(entry.deployment);
  if (!baseUrl || !clusterId || !namespace || !deployment) {
    throw new Error("既没有 url，也没有完整的 baseUrl、clusterId、namespace、deployment");
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl 不是有效地址");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("baseUrl 必须是 http 或 https 地址");
  const watch = { baseUrl: parsed.origin, clusterId, namespace, deployment };
  return { ...watch, sourceUrl: watchToUrl(watch) };
}

function importedWatch(entry) {
  if (!entry || typeof entry !== "object") throw new Error("配置项不是对象");
  const url = trimmedText(entry.url);
  const identity = url ? parseDeploymentUrl(url) : watchFromParts(entry);
  return {
    ...identity,
    environment: trimmedText(entry.environment),
    label: configText(entry.label),
    createdAt: typeof entry.addedAt === "string" && !Number.isNaN(Date.parse(entry.addedAt))
      ? new Date(entry.addedAt).toISOString()
      : new Date().toISOString()
  };
}

function sanitizeImportedSettings(raw, watches) {
  const source = raw && typeof raw === "object" ? raw : {};
  const clusterKeys = new Set(watches.map(clusterKey));
  const watchIds = new Set(watches.map(watchId));
  const refreshSeconds = Number(source.refreshSeconds);
  const settings = {
    clusterNames: Object.fromEntries(
      Object.entries(source.clusterNames || {})
        .filter(([key, name]) => clusterKeys.has(key) && configText(name))
        .map(([key, name]) => [key, configText(name)])
    ),
    notifiedWatchIds: Object.fromEntries(
      Object.entries(source.notifiedWatchIds || {})
        .filter(([id, enabled]) => watchIds.has(id) && enabled === true)
        .map(([id]) => [id, true])
    )
  };
  if (Number.isFinite(refreshSeconds) && refreshSeconds >= 5) {
    settings.refreshSeconds = Math.round(refreshSeconds);
  }
  if (typeof source.monitoringPaused === "boolean") settings.monitoringPaused = source.monitoringPaused;
  if (["compact", "standard", "timeline"].includes(source.viewMode)) settings.viewMode = source.viewMode;
  return settings;
}

export function parseConfigImport(input) {
  let data;
  try {
    data = JSON.parse(String(input || ""));
  } catch {
    throw new Error("配置文件不是有效的 JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("配置文件内容不是对象");
  if (typeof data.kind === "string" && data.kind !== CONFIG_EXPORT_KIND) {
    throw new Error("这不是 Deployment Watch 导出的配置文件");
  }
  const version = Number(data.version ?? CONFIG_EXPORT_VERSION);
  if (!Number.isFinite(version) || version > CONFIG_EXPORT_VERSION) {
    throw new Error(`配置文件版本为 ${data.version}，当前扩展最高支持 ${CONFIG_EXPORT_VERSION}`);
  }
  if (!Array.isArray(data.watches)) throw new Error("配置文件缺少 watches 列表");

  const parsed = data.watches.map((entry, index) => {
    try {
      return importedWatch(entry);
    } catch (error) {
      throw new Error(`第 ${index + 1} 项：${error.message}`);
    }
  });
  const watches = [...new Map(parsed.map((watch) => [watchId(watch), watch])).values()];
  return { watches, settings: sanitizeImportedSettings(data.settings, watches) };
}

export function applyConfigImport(existing, imported, mode = "merge") {
  const existingWatches = Array.isArray(existing?.watches) ? existing.watches : [];
  const existingSettings = existing?.settings || {};
  const importedWatches = Array.isArray(imported?.watches) ? imported.watches : [];
  const importedSettings = imported?.settings || {};
  // rememberLogin 与浏览器 Cookie 绑定，不参与导出，导入时必须保留本机选择。
  const rememberLogin = existingSettings.rememberLogin === true;

  if (mode === "replace") {
    return {
      watches: importedWatches.map((watch) => ({ ...watch })),
      settings: { ...importedSettings, rememberLogin }
    };
  }

  const byId = new Map(existingWatches.map((watch) => [watchId(watch), watch]));
  for (const incoming of importedWatches) {
    const current = byId.get(watchId(incoming));
    byId.set(watchId(incoming), current
      ? {
          ...current,
          ...incoming,
          environment: incoming.environment || current.environment || "",
          label: incoming.label || current.label || "",
          createdAt: earliestIso(current.createdAt, incoming.createdAt)
        }
      : { ...incoming });
  }
  return {
    watches: [...byId.values()],
    settings: {
      ...existingSettings,
      ...importedSettings,
      clusterNames: { ...existingSettings.clusterNames, ...importedSettings.clusterNames },
      notifiedWatchIds: { ...existingSettings.notifiedWatchIds, ...importedSettings.notifiedWatchIds },
      rememberLogin
    }
  };
}

export function deploymentDisplayName(watch) {
  return String(watch.label || "").trim() || watch.deployment;
}

export function watchesWithDeploymentName(watches, target, name) {
  const targetId = watchId(target);
  const displayName = String(name || "").trim();
  return watches.map((watch) =>
    watchId(watch) === targetId ? { ...watch, label: displayName } : watch
  );
}

export function watchMatchesQuery(watch, query, settings = {}) {
  const normalized = String(query || "").trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [
    watch.baseUrl,
    watch.clusterId,
    watch.namespace,
    watch.deployment,
    watch.environment,
    watch.label,
    clusterDisplayName(watch, settings)
  ].some((value) => String(value || "").toLocaleLowerCase().includes(normalized));
}

export function compareWatchesByHealth(left, right, resultForWatch) {
  const priority = { unavailable: 0, unknown: 1, degraded: 2, paused: 3, healthy: 4 };
  const leftStatus = resultForWatch(left)?.status || "unknown";
  const rightStatus = resultForWatch(right)?.status || "unknown";
  const statusDifference = (priority[leftStatus] ?? 1) - (priority[rightStatus] ?? 1);
  if (statusDifference) return statusDifference;

  return ["environment", "clusterId", "namespace", "deployment"]
    .map((key) => String(left[key] || "").localeCompare(String(right[key] || ""), "zh-CN"))
    .find((difference) => difference !== 0) || 0;
}

function timestampOrNull(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

// 最近一次就绪时间：仅在首次观测或从非正常转为正常时取新值，持续正常时保留原时间。
export function nextLastReadyAt(previousResult, result, now = new Date().toISOString()) {
  const previous = timestampOrNull(previousResult?.lastReadyAt);
  if (!result?.ok || result?.status !== "healthy") return previous;
  if (previous && previousResult?.status === "healthy") return previous;
  const observedNow = timestampOrNull(result.checkedAt) || now;
  // 首次观测没有本地历史时，用 Rancher 里 Available 条件的最后切换时间兜底。
  if (!previousResult) return timestampOrNull(result.readySince) || observedNow;
  return observedNow;
}

// 最后就绪的排在前面；都没有就绪时间时退回健康度排序。
export function compareWatchesByLastReady(left, right, resultForWatch) {
  const leftTime = Date.parse(resultForWatch(left)?.lastReadyAt || "") || 0;
  const rightTime = Date.parse(resultForWatch(right)?.lastReadyAt || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return compareWatchesByHealth(left, right, resultForWatch);
}

// 状态发生切换（或首次观测）时生成一条历史事件，供时间线展示。
export function historyEventFor(watch, result, previousResult) {
  if (!watch) return null;
  const nextStatus = result?.ok === false ? "unknown" : (result?.status || "unknown");
  const previousStatus = previousResult
    ? (previousResult.ok === false ? "unknown" : (previousResult.status || "unknown"))
    : null;
  if (previousStatus === nextStatus) return null;
  const at = timestampOrNull(result?.checkedAt) || new Date().toISOString();
  const readyAt =
    timestampOrNull(result?.lastReadyAt) ||
    timestampOrNull(previousResult?.lastReadyAt);
  return {
    id: watchId(watch),
    at,
    status: nextStatus,
    // 正常时间取最近一次就绪；异常时间只在真正异常时记录。
    normalAt: nextStatus === "healthy" ? (readyAt || at) : readyAt,
    abnormalAt: ["degraded", "unavailable", "unknown"].includes(nextStatus) ? at : null,
    ready: Number.isFinite(Number(result?.ready)) ? Number(result.ready) : null,
    desired: Number.isFinite(Number(result?.desired)) ? Number(result.desired) : null,
    error: result?.ok === false ? String(result?.error || "") : ""
  };
}

export function mergeHistory(history = [], events = [], limit = HISTORY_LIMIT) {
  const additions = events.filter(Boolean);
  if (!additions.length) return history;
  const capped = Math.max(1, limit);
  return [...history, ...additions].slice(-capped);
}

// 时间线按事件时间（就绪时间）倒序，最后就绪的排在最上面。
export function sortedTimeline(history = []) {
  return [...history].sort(
    (left, right) => (Date.parse(right?.at || "") || 0) - (Date.parse(left?.at || "") || 0)
  );
}

const ABNORMAL_TIMELINE_STATUSES = new Set(["degraded", "unavailable", "unknown"]);

// 给每条事件补上双时间：左侧“正常时间”取同一次正常周期内最近的就绪时间，
// 右侧“异常时间”取异常状态切换的时间。旧历史没有 normalAt 时按事件顺序补算。
export function timelineEventsWithTimes(history = [], normalTimeById = new Map()) {
  const fallbackNormalTime = (id) => timestampOrNull(
    normalTimeById instanceof Map ? normalTimeById.get(id) : normalTimeById?.[id]
  );
  const lastNormal = new Map();
  const ordered = [...history]
    .filter((event) => event?.id)
    .sort((left, right) => (Date.parse(left.at || "") || 0) - (Date.parse(right.at || "") || 0));
  return ordered.map((event) => {
    const at = timestampOrNull(event.at);
    const status = event.status || "unknown";
    let normalAt = timestampOrNull(event.normalAt);
    if (!normalAt && status === "healthy") normalAt = at;
    if (!normalAt) normalAt = lastNormal.get(event.id) || null;
    if (!normalAt) {
      const fallback = fallbackNormalTime(event.id);
      if (fallback && at && Date.parse(fallback) <= Date.parse(at)) normalAt = fallback;
    }
    if (status === "healthy" && normalAt) lastNormal.set(event.id, normalAt);
    const abnormalAt = ABNORMAL_TIMELINE_STATUSES.has(status)
      ? timestampOrNull(event.abnormalAt) || at
      : null;
    return { ...event, normalAt, abnormalAt };
  });
}

export function compareTimelineByNormalTime(left, right) {
  const leftNormal = Date.parse(left.normalAt || left.at || "") || 0;
  const rightNormal = Date.parse(right.normalAt || right.at || "") || 0;
  if (leftNormal !== rightNormal) return rightNormal - leftNormal;
  const leftAbnormal = Date.parse(left.abnormalAt || "") || 0;
  const rightAbnormal = Date.parse(right.abnormalAt || "") || 0;
  if (leftAbnormal !== rightAbnormal) return rightAbnormal - leftAbnormal;
  return (Date.parse(right.at || "") || 0) - (Date.parse(left.at || "") || 0);
}

export function compareTimelineByAbnormalTime(left, right) {
  const leftAbnormal = Date.parse(left.abnormalAt || "") || 0;
  const rightAbnormal = Date.parse(right.abnormalAt || "") || 0;
  if (leftAbnormal !== rightAbnormal) return rightAbnormal - leftAbnormal;
  return compareTimelineByNormalTime(left, right);
}

export function compareTimelineByMergedTime(left, right) {
  const leftTime = Date.parse(left.abnormalAt || left.normalAt || left.at || "") || 0;
  const rightTime = Date.parse(right.abnormalAt || right.normalAt || right.at || "") || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return compareTimelineByNormalTime(left, right);
}

export function sortTimelineEvents(events = [], mode = "normal") {
  const comparator = mode === "abnormal"
    ? compareTimelineByAbnormalTime
    : mode === "merged" ? compareTimelineByMergedTime : compareTimelineByNormalTime;
  return [...events].sort(comparator);
}

// 时间线按正常时间倒序，同一正常周期内的异常按异常时间倒序。
export function sortedTimelineByNormalTime(history = [], normalTimeById = new Map()) {
  return sortTimelineEvents(timelineEventsWithTimes(history, normalTimeById), "normal");
}

// 按异常时间倒序；没有异常时间的正常记录排在异常记录之后。
export function sortedTimelineByAbnormalTime(history = [], normalTimeById = new Map()) {
  return sortTimelineEvents(timelineEventsWithTimes(history, normalTimeById), "abnormal");
}

export function buildApiUrls(watch) {
  const base = watch.baseUrl.replace(/\/$/, "");
  const cluster = encodeURIComponent(watch.clusterId);
  const namespace = encodeURIComponent(watch.namespace);
  const deployment = encodeURIComponent(watch.deployment);
  const prefix = `${base}/k8s/clusters/${cluster}`;
  return {
    deployment: `${prefix}/apis/apps/v1/namespaces/${namespace}/deployments/${deployment}`,
    replicaSetsPrefix: `${prefix}/apis/apps/v1/namespaces/${namespace}/replicasets`,
    podsPrefix: `${prefix}/api/v1/namespaces/${namespace}/pods`
  };
}

export function selectorFromDeployment(deployment) {
  const selector = deployment?.spec?.selector || {};
  const labels = Object.entries(selector.matchLabels || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`);
  const expressions = (selector.matchExpressions || []).map((expression) => {
    const key = expression.key;
    const values = expression.values || [];
    switch (expression.operator) {
      case "In": return `${key} in (${values.join(",")})`;
      case "NotIn": return `${key} notin (${values.join(",")})`;
      case "Exists": return key;
      case "DoesNotExist": return `!${key}`;
      default: throw new Error(`不支持的 Deployment 标签选择器：${expression.operator}`);
    }
  });
  return [...labels, ...expressions].join(",");
}

function nonnegativeInteger(value, fallback = 0) {
  const numeric = Number(value ?? fallback);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : fallback;
}

function podIsReady(pod) {
  return pod?.status?.conditions?.some(
    (condition) => condition.type === "Ready" && condition.status === "True"
  ) || false;
}

function podRestarts(pod) {
  return (pod?.status?.containerStatuses || []).reduce(
    (sum, container) => sum + nonnegativeInteger(container.restartCount),
    0
  );
}

function podReason(pod) {
  const statuses = pod?.status?.containerStatuses || [];
  for (const status of statuses) {
    const waiting = status?.state?.waiting;
    if (waiting?.reason) return waiting.reason;
    const terminated = status?.state?.terminated;
    if (terminated?.reason) return terminated.reason;
  }
  const readyCondition = pod?.status?.conditions?.find(
    (condition) => condition.type === "Ready" && condition.status !== "True"
  );
  if (readyCondition?.reason) return readyCondition.reason;
  return pod?.status?.reason || pod?.status?.phase || "Unknown";
}

function controlledBy(resource, kind, uid) {
  return resource?.metadata?.ownerReferences?.some(
    (owner) => owner.kind === kind && owner.uid === uid && owner.controller !== false
  ) || false;
}

export function podsForDeployment(deployment, replicaSets = [], pods = []) {
  const deploymentUid = deployment?.metadata?.uid;
  if (!deploymentUid) return pods;
  const replicaSetUids = new Set(
    replicaSets
      .filter((replicaSet) => controlledBy(replicaSet, "Deployment", deploymentUid))
      .map((replicaSet) => replicaSet?.metadata?.uid)
      .filter(Boolean)
  );
  return pods.filter((pod) =>
    [...replicaSetUids].some((replicaSetUid) => controlledBy(pod, "ReplicaSet", replicaSetUid))
  );
}

export function summarizeDeployment(deployment, pods = []) {
  const desired = nonnegativeInteger(deployment?.spec?.replicas, 1);
  const ready = nonnegativeInteger(deployment?.status?.readyReplicas);
  const available = nonnegativeInteger(deployment?.status?.availableReplicas);
  const updated = nonnegativeInteger(deployment?.status?.updatedReplicas);
  const unavailable = nonnegativeInteger(deployment?.status?.unavailableReplicas);
  const generationObserved =
    (deployment?.status?.observedGeneration ?? 0) >=
    (deployment?.metadata?.generation ?? 0);
  const podSummaries = pods.map((pod) => ({
    name: pod?.metadata?.name || "unknown",
    phase: pod?.status?.phase || "Unknown",
    ready: podIsReady(pod),
    restarts: podRestarts(pod),
    reason: podReason(pod),
    node: pod?.spec?.nodeName || "—",
    ip: pod?.status?.podIP || "—",
    images: (pod?.spec?.containers || []).map((container) => container.image).filter(Boolean),
    age: pod?.metadata?.creationTimestamp || null
  }));
  const allPodsReady =
    desired === 0 ||
    (podSummaries.length >= desired &&
      podSummaries.every((pod) => pod.phase === "Running" && pod.ready));
  const conditions = (deployment?.status?.conditions || []).map((condition) => ({
    type: condition.type || "Unknown",
    status: condition.status || "Unknown",
    reason: condition.reason || "",
    message: condition.message || "",
    lastTransitionTime: condition.lastTransitionTime || ""
  }));
  const hasFailureCondition = conditions.some((condition) =>
    (condition.type === "ReplicaFailure" && condition.status === "True") ||
    (condition.type === "Progressing" && condition.status === "False")
  );

  let status = "healthy";
  if (desired === 0) status = "paused";
  else if (available === 0 || ready === 0) status = "unavailable";
  else if (
    ready < desired ||
    available < desired ||
    updated < desired ||
    unavailable > 0 ||
    !generationObserved ||
    !allPodsReady ||
    hasFailureCondition
  ) status = "degraded";

  const containers = deployment?.spec?.template?.spec?.containers || [];
  const availableCondition = (deployment?.status?.conditions || []).find(
    (condition) => condition.type === "Available" && condition.status === "True"
  );
  return {
    status,
    desired,
    ready,
    available,
    updated,
    unavailable,
    generationObserved,
    restarts: podSummaries.reduce((sum, pod) => sum + pod.restarts, 0),
    images: containers.map((container) => container.image).filter(Boolean),
    conditions,
    pods: podSummaries,
    createdAt: deployment?.metadata?.creationTimestamp || null,
    readySince: availableCondition?.lastTransitionTime || null,
    checkedAt: new Date().toISOString()
  };
}

export function readableError(error, responseStatus) {
  if (responseStatus === 401 || responseStatus === 403) {
    return "Rancher 登录已失效或当前账号无权限";
  }
  if (responseStatus === 404) return "找不到该 Deployment，请检查 Cluster、命名空间和名称";
  if (error?.name === "AbortError") return "Rancher 请求超时，请检查网络或 VPN";
  if (error?.message?.includes("非 JSON")) return error.message;
  if (error?.message?.includes("Unexpected token")) return "Rancher 返回了登录页面，请重新登录后刷新";
  if (error?.message === "Failed to fetch") return "无法访问 Rancher，请检查网络、证书或站点权限";
  return error?.message || `请求失败${responseStatus ? ` (${responseStatus})` : ""}`;
}

// Rancher 的代理对 Cluster 级列表按 500 一页才会正常返回；请求 1000 时会得到空对象。
export const DISCOVERY_PAGE_SIZE = 500;
export const DISCOVERY_MAX_PAGES = 5;
export const DISCOVERY_MAX_NAMESPACES = 50;
export const DISCOVERY_NAMESPACE_CONCURRENCY = 5;
const SYSTEM_NAMESPACE_PREFIXES = ["kube-", "cattle-", "fleet-", "rancher-", "harvester-"];
const SYSTEM_NAMESPACES = new Set(["ingress-nginx"]);

export function isSystemNamespace(namespace) {
  const name = String(namespace || "").toLocaleLowerCase();
  return SYSTEM_NAMESPACE_PREFIXES.some((prefix) => name.startsWith(prefix)) || SYSTEM_NAMESPACES.has(name);
}

export function collectionRows(payload) {
  if (Array.isArray(payload)) return payload;
  // Rancher 的 Steve 列表（/v1/apps.deployment 等）把条目放在 rows。
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

// Cluster 列表接口不可用时，仍能从 Rancher 页面地址或扩展代理地址确定 Cluster。
export function clusterFromUrl(input) {
  let url;
  try {
    url = new URL(String(input || ""));
  } catch {
    return null;
  }
  const decode = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const parts = url.pathname.split("/").filter(Boolean);
  const dashboardIndex = parts.indexOf("dashboard");
  if (dashboardIndex >= 0 && parts[dashboardIndex + 1] === "c" && parts[dashboardIndex + 2]) {
    return { baseUrl: url.origin, clusterId: decode(parts[dashboardIndex + 2]) };
  }
  if (parts[0] === "k8s" && parts[1] === "clusters" && parts[2]) {
    return { baseUrl: url.origin, clusterId: decode(parts[2]) };
  }
  return null;
}

// 后到的同名 Cluster 只补充名称与来源，避免下拉里出现重复项。
export function mergeClusterSources(...sources) {
  const merged = new Map();
  for (const source of sources) {
    for (const cluster of source?.clusters || []) {
      const id = String(cluster?.id || "").trim();
      if (!id) continue;
      const existing = merged.get(id);
      if (existing) {
        if (source.origin && !existing.origins.includes(source.origin)) existing.origins.push(source.origin);
        if (!existing.name && cluster.name) existing.name = cluster.name;
        continue;
      }
      merged.set(id, {
        id,
        name: cluster.name || id,
        state: cluster.state || "",
        origins: source.origin ? [source.origin] : []
      });
    }
  }
  return [...merged.values()];
}

export function clusterListFailureMessage(attempts = []) {
  if (attempts.length && attempts.every((attempt) => attempt.status === 401)) {
    return "Rancher 登录已失效，请重新登录后再试。";
  }
  const detail = attempts.filter((attempt) => attempt.label).map((attempt) => `${attempt.path}：${attempt.label}`);
  return `读不到 Cluster 列表（${detail.join("；") || "接口未返回数据"}）。已监控的 Cluster 和“用当前标签页”仍可用，也可以粘贴 Deployment 地址添加。`;
}

export function clusterDiscoveryUrls(baseUrl) {
  const origin = new URL(baseUrl).origin;
  return [`${origin}/v1/management.cattle.io.clusters`, `${origin}/k8s/clusters`];
}

export function normalizeClusterList(payload) {
  const clusters = new Map();
  for (const row of collectionRows(payload)) {
    const id = String(row?.id ?? row?.metadata?.name ?? "").trim();
    if (!id || clusters.has(id)) continue;
    const name = [row?.displayName, row?.spec?.name, row?.name, row?.metadata?.name]
      .map((value) => String(value ?? "").trim())
      .find((value) => value && value !== id) || id;
    const state = String(row?.state ?? row?.status?.state ?? row?.status?.phase ?? "").toLocaleLowerCase();
    clusters.set(id, { id, name, state });
  }
  return [...clusters.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
}

export function deploymentDiscoveryUrl(cluster, continueToken = "") {
  const origin = new URL(cluster.baseUrl).origin;
  const query = new URLSearchParams({ limit: String(DISCOVERY_PAGE_SIZE) });
  if (continueToken) query.set("continue", continueToken);
  return `${origin}/k8s/clusters/${encodeURIComponent(cluster.clusterId)}/apis/apps/v1/deployments?${query}`;
}

export function namespaceDiscoveryUrls(cluster) {
  const origin = new URL(cluster.baseUrl).origin;
  const proxy = `${origin}/k8s/clusters/${encodeURIComponent(cluster.clusterId)}`;
  return [`${proxy}/v1/namespaces`, `${proxy}/api/v1/namespaces?limit=${DISCOVERY_PAGE_SIZE}`];
}

export function deploymentCollectionDiscoveryUrl(cluster, page = "") {
  const origin = new URL(cluster.baseUrl).origin;
  // Steve 列表用 page/max 分页，参数与 Kubernetes 的 limit/continue 不同。
  const query = new URLSearchParams({ page: String(page || 1), max: String(DISCOVERY_PAGE_SIZE) });
  return `${origin}/k8s/clusters/${encodeURIComponent(cluster.clusterId)}/v1/apps.deployment?${query}`;
}

export function normalizeNamespaceList(payload) {
  const namespaces = new Set();
  for (const row of collectionRows(payload)) {
    const name = String(row?.metadata?.name ?? row?.id ?? "")
      .trim()
      .split(/[/:]/)
      .pop();
    if (name) namespaces.add(name);
  }
  return [...namespaces].sort((left, right) => left.localeCompare(right, "zh-CN"));
}

export function namespacedDeploymentDiscoveryUrl(cluster, namespace) {
  const origin = new URL(cluster.baseUrl).origin;
  const query = new URLSearchParams({ limit: String(DISCOVERY_PAGE_SIZE) });
  return `${origin}/k8s/clusters/${encodeURIComponent(cluster.clusterId)}/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments?${query}`;
}

export function prioritizeNamespaces(namespaces, limit = DISCOVERY_MAX_NAMESPACES) {
  const business = namespaces.filter((namespace) => !isSystemNamespace(namespace));
  const ordered = [...business, ...namespaces.filter((namespace) => isSystemNamespace(namespace))];
  return { namespaces: ordered.slice(0, limit), truncated: ordered.length > limit };
}

export function isCollectionPayload(payload) {
  return Array.isArray(payload)
    || Array.isArray(payload?.items)
    || Array.isArray(payload?.data)
    || Array.isArray(payload?.rows);
}

// Kubernetes 用 metadata.continue 令牌翻页，Rancher 的 Steve 列表用 links.next。
export function nextCollectionPageUrl(payload, urlFor, cluster) {
  const token = String(payload?.metadata?.continue || "");
  if (token) return urlFor(cluster, token);
  const next = String(payload?.links?.next || "");
  if (!next) return "";
  try {
    return new URL(next, cluster.baseUrl).toString();
  } catch {
    return "";
  }
}

// Steve 列表用 count 表示总数，没有下一页链接时也能判断是否还有没读到的条目。
export function isCollectionTruncated(payload) {
  if (String(payload?.metadata?.continue || "")) return true;
  if (payload?.links?.next) return true;
  const count = Number(payload?.count);
  return Number.isFinite(count) && count > collectionRows(payload).length;
}

export function discoveryProblemLabel(error) {
  if (!error) return "";
  if (error === "not-a-list") return "未返回列表";
  if (error.name === "AbortError") return "请求超时";
  if (error.status === 401 || error.status === 403) return `无权限（${error.status}）`;
  if (error.status) return String(error.status);
  return error.message || "请求失败";
}

export function discoveryFailureMessage({ problems = [], denied = 0, invalid = 0 } = {}) {
  if (problems.length && problems.every((problem) => problem.status === 401)) {
    return "Rancher 登录已失效，请重新登录后再试。";
  }
  const detail = problems.filter((problem) => problem.label).map((problem) => `${problem.path}：${problem.label}`);
  if (denied) detail.push(`${denied} 个命名空间无权限`);
  if (invalid) detail.push(`${invalid} 个命名空间未返回列表`);
  return `读不到 Deployment（${detail.join("；") || "接口未返回数据"}）。可粘贴 Deployment 详情页地址添加，或请管理员授予该 Cluster 中 Deployment 的 list 权限。`;
}

export function sortDiscoveryRows(rows) {
  return rows.sort((left, right) =>
    left.namespace.localeCompare(right.namespace, "zh-CN") || left.name.localeCompare(right.name, "zh-CN")
  );
}

export function normalizeDeploymentList(payload) {
  return sortDiscoveryRows(collectionRows(payload)
    .map((item) => ({
      ...deploymentIdentity(item),
      desired: nonnegativeInteger(item?.spec?.replicas, 1),
      ready: nonnegativeInteger(item?.status?.readyReplicas)
    }))
    .filter((row) => row.namespace && row.name));
}

function deploymentIdentity(item) {
  const namespace = String(item?.metadata?.namespace || "").trim();
  const name = String(item?.metadata?.name || "").trim();
  if (namespace && name) return { namespace, name };
  // Rancher Steve 的行可能只给出 "c-m-969:payments/api" 形式的 id。
  const tail = String(item?.id || "").trim().split(":").pop();
  const [rowNamespace = "", rowName = ""] = tail.split("/");
  return { namespace: rowNamespace.trim(), name: rowName.trim() };
}

export function discoveredDeploymentToWatch(cluster, deployment) {
  const watch = {
    baseUrl: new URL(cluster.baseUrl).origin,
    clusterId: cluster.id,
    namespace: deployment.namespace,
    deployment: deployment.name
  };
  return {
    ...watch,
    sourceUrl: watchToUrl(watch),
    environment: cluster.name && cluster.name !== cluster.id ? cluster.name : "",
    label: ""
  };
}

export function discoveryRowMatches(row, query) {
  const normalized = String(query || "").trim().toLocaleLowerCase();
  if (!normalized) return true;
  return `${row.namespace}/${row.name}`.toLocaleLowerCase().includes(normalized);
}

export function mergeMonitors(existing = [], incoming = []) {
  const byId = new Map(existing.map((watch) => [watchId(watch), watch]));
  const addedIds = [];
  const skippedIds = [];
  for (const item of incoming) {
    const id = watchId(item);
    const current = byId.get(id);
    byId.set(id, {
      ...current,
      ...item,
      environment: item.environment || current?.environment || item.clusterId,
      label: item.label || current?.label || "",
      sourceUrl: item.sourceUrl || current?.sourceUrl || watchToUrl(item),
      createdAt: current?.createdAt || new Date().toISOString()
    });
    (current ? skippedIds : addedIds).push(id);
  }
  return { watches: [...byId.values()], addedIds, skippedIds };
}
