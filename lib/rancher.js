export const WATCHES_KEY = "watches";
export const RESULTS_KEY = "results";
export const SETTINGS_KEY = "settings";

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

export function watchMatchesQuery(watch, query) {
  const normalized = String(query || "").trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [
    watch.baseUrl,
    watch.clusterId,
    watch.namespace,
    watch.deployment,
    watch.environment,
    watch.label
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
    message: condition.message || ""
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
