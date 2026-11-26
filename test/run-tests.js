import assert from "assert";
import { readFile } from "node:fs/promises";
import {
  parseDeploymentUrl,
  parseDeploymentUrls,
  buildApiUrls,
  selectorFromDeployment,
  summarizeDeployment,
  podsForDeployment,
  watchMatchesQuery,
  compareWatchesByHealth,
  compareWatchesByLastReady,
  nextLastReadyAt,
  historyEventFor,
  mergeHistory,
  sortedTimeline,
  sortedTimelineByNormalTime,
  sortedTimelineByAbnormalTime,
  sortTimelineEvents,
  timelineEventsWithTimes,
  timelineEnvironmentOptions,
  clusterKey,
  watchId,
  permissionPattern,
  clusterDisplayName,
  settingsWithClusterName,
  refreshSecondsFromSettings,
  deploymentDisplayName,
  watchesWithDeploymentName,
  isMonitoringPaused,
  settingsWithMonitoringPaused,
  CONFIG_EXPORT_KIND,
  buildConfigExport,
  parseConfigImport,
  applyConfigImport,
  configExportFilename,
  isSystemNamespace,
  collectionRows,
  clusterDiscoveryUrls,
  normalizeClusterList,
  clusterFromUrl,
  mergeClusterSources,
  clusterListFailureMessage,
  deploymentDiscoveryUrl,
  normalizeDeploymentList,
  namespaceDiscoveryUrls,
  normalizeNamespaceList,
  namespacedDeploymentDiscoveryUrl,
  deploymentCollectionDiscoveryUrl,
  prioritizeNamespaces,
  isCollectionPayload,
  discoveryProblemLabel,
  nextCollectionPageUrl,
  isCollectionTruncated,
  discoveryFailureMessage,
  discoveredDeploymentToWatch,
  discoveryRowMatches,
  mergeMonitors
} from "../lib/rancher.js";

const tests = [];
function test(name, run) { tests.push({ name, run }); }

test("parses a Rancher deployment URL", () => {
  const parsed = parseDeploymentUrl(
    "https://rancher.example.com/dashboard/c/c-m-cl28nrjg/explorer/apps.deployment/test/deploy-tg-tg-sync#pods"
  );
  assert.deepStrictEqual(parsed, {
    baseUrl: "https://rancher.example.com",
    clusterId: "c-m-cl28nrjg",
    namespace: "test",
    deployment: "deploy-tg-tg-sync",
    sourceUrl: "https://rancher.example.com/dashboard/c/c-m-cl28nrjg/explorer/apps.deployment/test/deploy-tg-tg-sync#pods"
  });
});

test("rejects non-deployment Rancher URLs", () => {
  assert.throws(
    () => parseDeploymentUrl("https://rancher.example.com/dashboard/home"),
    /不是 Rancher Deployment/
  );
});

test("parses multiple deployment URLs and reports the failing line", () => {
  const parsed = parseDeploymentUrls(`
    https://rancher.example.com/dashboard/c/cluster-a/explorer/apps.deployment/test/api#pods

    https://rancher.example.com/dashboard/c/cluster-b/explorer/apps.deployment/prod/worker#pods
  `);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].clusterId, "cluster-a");
  assert.equal(parsed[1].deployment, "worker");
  assert.throws(
    () => parseDeploymentUrls("https://rancher.example.com/dashboard/home"),
    /第 1 行/
  );
});

test("builds Kubernetes proxy URLs and stable selectors", () => {
  const watch = {
    baseUrl: "https://rancher.example.com/",
    clusterId: "local",
    namespace: "my namespace",
    deployment: "web/api"
  };
  const urls = buildApiUrls(watch);
  assert.match(urls.deployment, /clusters\/local\/apis\/apps\/v1\/namespaces\/my%20namespace\/deployments\/web%2Fapi$/);
  assert.match(urls.replicaSetsPrefix, /namespaces\/my%20namespace\/replicasets$/);
  assert.equal(
    selectorFromDeployment({ spec: { selector: { matchLabels: { tier: "api", app: "web" } } } }),
    "app=web,tier=api"
  );
});

test("filters pods through ReplicaSet ownership when workloads share labels", () => {
  const deployment = { metadata: { uid: "deployment-uid" } };
  const replicaSets = [
    { metadata: { uid: "our-rs", ownerReferences: [{ kind: "Deployment", uid: "deployment-uid", controller: true }] } },
    { metadata: { uid: "other-rs", ownerReferences: [{ kind: "Deployment", uid: "other-deployment", controller: true }] } }
  ];
  const pods = [
    { metadata: { name: "ours", ownerReferences: [{ kind: "ReplicaSet", uid: "our-rs", controller: true }] } },
    { metadata: { name: "theirs", ownerReferences: [{ kind: "ReplicaSet", uid: "other-rs", controller: true }] } },
    { metadata: { name: "standalone" } }
  ];
  assert.deepStrictEqual(podsForDeployment(deployment, replicaSets, pods).map((pod) => pod.metadata.name), ["ours"]);
});

test("serializes expression-only and mixed Kubernetes selectors", () => {
  assert.equal(
    selectorFromDeployment({ spec: { selector: { matchExpressions: [
      { key: "track", operator: "In", values: ["stable", "canary"] },
      { key: "debug", operator: "DoesNotExist" }
    ] } } }),
    "track in (stable,canary),!debug"
  );
  assert.equal(
    selectorFromDeployment({ spec: { selector: {
      matchLabels: { app: "web" },
      matchExpressions: [{ key: "tier", operator: "Exists" }]
    } } }),
    "app=web,tier"
  );
});

test("summarizes a healthy deployment and pod restarts", () => {
  const deployment = {
    metadata: { generation: 4 },
    spec: { replicas: 1, template: { spec: { containers: [{ image: "example/web:v2" }] } } },
    status: { observedGeneration: 4, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 }
  };
  const pods = [{
    metadata: { name: "web-abc", creationTimestamp: "2026-07-15T08:00:00Z" },
    spec: { nodeName: "node-1" },
    status: {
      phase: "Running",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [{ restartCount: 2, state: { running: {} } }]
    }
  }];
  const result = summarizeDeployment(deployment, pods);
  assert.equal(result.status, "healthy");
  assert.equal(result.restarts, 2);
  assert.deepStrictEqual(result.images, ["example/web:v2"]);
});

test("marks missing replicas unavailable and partial rollout degraded", () => {
  const base = { metadata: { generation: 2 }, spec: { replicas: 2, template: { spec: { containers: [] } } } };
  assert.equal(summarizeDeployment({ ...base, status: { observedGeneration: 2 } }, []).status, "unavailable");
  assert.equal(summarizeDeployment({
    ...base,
    status: { observedGeneration: 2, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 }
  }, [{ status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }]).status, "degraded");
});

test("marks a deployment with a failure condition degraded", () => {
  const deployment = {
    metadata: { generation: 1 },
    spec: { replicas: 1, template: { spec: { containers: [] } } },
    status: {
      observedGeneration: 1,
      readyReplicas: 1,
      availableReplicas: 1,
      updatedReplicas: 1,
      conditions: [{ type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" }]
    }
  };
  const pods = [{ status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }];
  assert.equal(summarizeDeployment(deployment, pods).status, "degraded");
});

test("matches watches across cluster, namespace, name, label and host", () => {
  const watch = {
    baseUrl: "https://rancher.example.com",
    clusterId: "cluster-prod",
    namespace: "payments",
    deployment: "settlement-api",
    environment: "生产环境",
    label: "结算服务"
  };
  for (const query of ["prod", "payments", "settlement", "生产", "结算", "rancher.example"]) {
    assert.equal(watchMatchesQuery(watch, query), true, query);
  }
  assert.equal(watchMatchesQuery(watch, "warehouse"), false);
});

test("builds a stable cluster identity", () => {
  assert.equal(clusterKey({ baseUrl: "https://rancher.example.com", clusterId: "prod" }), "https%3A%2F%2Francher.example.com::prod");
});

test("stores and clears an independent Cluster display name", () => {
  const watch = {
    baseUrl: "https://rancher.example.com",
    clusterId: "c-m-prod",
    environment: "生产环境"
  };
  const renamed = settingsWithClusterName({ refreshMinutes: 5 }, watch, "核心生产集群");
  assert.equal(clusterDisplayName(watch, renamed), "核心生产集群");
  assert.equal(watchMatchesQuery(watch, "核心生产", renamed), true);
  assert.equal(renamed.refreshMinutes, 5);

  const cleared = settingsWithClusterName(renamed, watch, "  ");
  assert.equal(clusterDisplayName(watch, cleared), "生产环境");
  assert.deepStrictEqual(cleared.clusterNames, {});
});

test("migrates refresh minutes and supports a five-second interval", () => {
  assert.equal(refreshSecondsFromSettings({ refreshMinutes: 5 }), 300);
  assert.equal(refreshSecondsFromSettings({ refreshSeconds: 5 }), 5);
  assert.equal(refreshSecondsFromSettings({}), 60);
});

test("reports and persists the global monitoring pause", () => {
  assert.equal(isMonitoringPaused({}), false);
  assert.equal(isMonitoringPaused({ monitoringPaused: false }), false);
  assert.equal(isMonitoringPaused({ monitoringPaused: true }), true);

  const paused = settingsWithMonitoringPaused({ refreshSeconds: 30, notifiedWatchIds: { a: true } }, true);
  assert.equal(isMonitoringPaused(paused), true);
  assert.equal(paused.refreshSeconds, 30, "暂停设置应保留其它配置");
  assert.deepStrictEqual(paused.notifiedWatchIds, { a: true });

  const resumed = settingsWithMonitoringPaused(paused, false);
  assert.equal(isMonitoringPaused(resumed), false);
  assert.equal(resumed.refreshSeconds, 30);
});

test("stores and clears a Deployment display name without changing its identity", () => {
  const target = { baseUrl: "https://rancher.example.com", clusterId: "prod", namespace: "pay", deployment: "api" };
  const other = { ...target, deployment: "worker" };
  const renamed = watchesWithDeploymentName([target, other], target, "支付接口");
  assert.equal(deploymentDisplayName(renamed[0]), "支付接口");
  assert.equal(renamed[0].deployment, "api");
  assert.equal(renamed[1], other);

  const cleared = watchesWithDeploymentName(renamed, target, "  ");
  assert.equal(deploymentDisplayName(cleared[0]), "api");
});

test("sorts problem deployments before healthy deployments", () => {
  const healthy = { deployment: "api" };
  const unknown = { deployment: "worker" };
  const results = new Map([
    [healthy, { ok: true, status: "healthy" }],
    [unknown, { ok: false, status: "unknown" }]
  ]);
  assert.ok(compareWatchesByHealth(unknown, healthy, (watch) => results.get(watch)) < 0);
});

test("records the last ready time only when readiness is (re)reached", () => {
  const at = (iso) => ({ ok: true, status: "healthy", checkedAt: iso, readySince: "2026-10-01T00:00:00.000Z" });
  const broken = { ok: false, status: "unknown", checkedAt: "2026-10-05T00:00:00.000Z" };
  // 首次观测：用 Rancher 的 Available 切换时间兜底。
  assert.equal(nextLastReadyAt(undefined, at("2026-10-03T00:00:00.000Z")), "2026-10-01T00:00:00.000Z");
  // 持续正常：保留最初的就绪时间。
  const healthy = { ...at("2026-10-03T00:00:00.000Z"), lastReadyAt: "2026-10-01T00:00:00.000Z" };
  assert.equal(nextLastReadyAt(healthy, at("2026-10-04T00:00:00.000Z")), "2026-10-01T00:00:00.000Z");
  // 异常：保留上一次就绪时间。
  assert.equal(nextLastReadyAt(healthy, broken), "2026-10-01T00:00:00.000Z");
  // 从异常见恢复：取本次检查时间。
  assert.equal(nextLastReadyAt(broken, at("2026-10-06T00:00:00.000Z")), "2026-10-06T00:00:00.000Z");
});

test("sorts watches by last ready time, newest first", () => {
  const a = { deployment: "a" };
  const b = { deployment: "b" };
  const c = { deployment: "c" };
  const results = new Map([
    [a, { ok: true, status: "healthy", lastReadyAt: "2026-10-01T00:00:00.000Z" }],
    [b, { ok: true, status: "healthy", lastReadyAt: "2026-10-08T00:00:00.000Z" }],
    [c, { ok: false, status: "unknown" }]
  ]);
  const ordered = [a, b, c].sort((left, right) => compareWatchesByLastReady(left, right, (watch) => results.get(watch)));
  assert.deepStrictEqual(ordered.map((watch) => watch.deployment), ["b", "a", "c"]);
});

test("turns status changes into timeline events", () => {
  const watch = { baseUrl: "https://rancher.example.com", clusterId: "prod", namespace: "pay", deployment: "api" };
  const first = historyEventFor(watch, { ok: true, status: "healthy", ready: 2, desired: 2, checkedAt: "2026-10-01T00:00:00.000Z" }, undefined);
  assert.equal(first.status, "healthy");
  assert.equal(first.ready, 2);
  assert.equal(first.at, "2026-10-01T00:00:00.000Z");
  assert.equal(first.normalAt, "2026-10-01T00:00:00.000Z");
  assert.equal(first.abnormalAt, null);
  // 状态未变：不追加事件。
  assert.equal(historyEventFor(watch, { ok: true, status: "healthy", checkedAt: "2026-10-02T00:00:00.000Z" }, { status: "healthy" }), null);
  // 状态变化：记录新事件；失败归一化为 unknown。
  const broken = historyEventFor(
    watch,
    { ok: false, error: "超时", checkedAt: "2026-10-03T00:00:00.000Z" },
    { status: "healthy", lastReadyAt: "2026-10-01T00:00:00.000Z" }
  );
  assert.equal(broken.status, "unknown");
  assert.equal(broken.error, "超时");
  assert.equal(broken.normalAt, "2026-10-01T00:00:00.000Z");
  assert.equal(broken.abnormalAt, "2026-10-03T00:00:00.000Z");
});

test("caps history and sorts the timeline by ready time descending", () => {
  const events = [
    { id: "a", at: "2026-10-01T00:00:00.000Z", status: "healthy" },
    { id: "b", at: "2026-10-03T00:00:00.000Z", status: "degraded" },
    { id: "c", at: "2026-10-02T00:00:00.000Z", status: "healthy" }
  ];
  const capped = mergeHistory([{ id: "old", at: "2026-09-01T00:00:00.000Z", status: "healthy" }], events, 2);
  assert.equal(capped.length, 2);
  assert.deepStrictEqual(capped.map((event) => event.id), ["b", "c"]);
  assert.deepStrictEqual(sortedTimeline(events).map((event) => event.id), ["b", "c", "a"]);
});

test("fills normal and abnormal times for new and legacy timeline events", () => {
  const events = [
    { id: "a", at: "2026-10-01T00:00:00.000Z", status: "healthy" },
    { id: "a", at: "2026-10-02T00:00:00.000Z", status: "degraded" },
    { id: "a", at: "2026-10-03T00:00:00.000Z", status: "healthy" },
    { id: "b", at: "2026-10-04T00:00:00.000Z", status: "unknown" }
  ];
  const entries = timelineEventsWithTimes(events);
  assert.equal(entries[0].normalAt, "2026-10-01T00:00:00.000Z");
  assert.equal(entries[0].abnormalAt, null);
  assert.equal(entries[1].normalAt, "2026-10-01T00:00:00.000Z");
  assert.equal(entries[1].abnormalAt, "2026-10-02T00:00:00.000Z");
  assert.equal(entries[2].normalAt, "2026-10-03T00:00:00.000Z");
  assert.equal(entries[3].normalAt, null);
  assert.equal(entries[3].abnormalAt, "2026-10-04T00:00:00.000Z");

  const withFallback = timelineEventsWithTimes(
    [{ id: "b", at: "2026-10-04T00:00:00.000Z", status: "unavailable" }],
    new Map([["b", "2026-10-03T00:00:00.000Z"]])
  );
  assert.equal(withFallback[0].normalAt, "2026-10-03T00:00:00.000Z");
  assert.equal(withFallback[0].abnormalAt, "2026-10-04T00:00:00.000Z");
});

test("sorts the timeline by normal time and groups anomalies into their normal episode", () => {
  const events = [
    { id: "a", at: "2026-10-01T00:00:00.000Z", status: "healthy" },
    { id: "a", at: "2026-10-05T00:00:00.000Z", status: "degraded" },
    { id: "b", at: "2026-10-04T00:00:00.000Z", status: "healthy" },
    { id: "b", at: "2026-10-06T00:00:00.000Z", status: "unknown" }
  ];
  const ordered = sortedTimelineByNormalTime(events);
  assert.deepStrictEqual(
    ordered.map((event) => `${event.id}:${event.status}`),
    ["b:unknown", "b:healthy", "a:degraded", "a:healthy"]
  );
});

test("sorts the timeline by abnormal time and leaves normal records after anomalies", () => {
  const events = [
    { id: "a", at: "2026-10-01T00:00:00.000Z", status: "healthy" },
    { id: "a", at: "2026-10-05T00:00:00.000Z", status: "degraded" },
    { id: "b", at: "2026-10-04T00:00:00.000Z", status: "healthy" },
    { id: "b", at: "2026-10-06T00:00:00.000Z", status: "unknown" }
  ];
  const ordered = sortedTimelineByAbnormalTime(events);
  assert.deepStrictEqual(
    ordered.map((event) => `${event.id}:${event.status}`),
    ["b:unknown", "a:degraded", "b:healthy", "a:healthy"]
  );
});

test("separates normal and abnormal records for independent sorting", () => {
  const events = [
    { id: "a", at: "2026-10-01T00:00:00.000Z", status: "healthy" },
    { id: "a", at: "2026-10-05T00:00:00.000Z", status: "degraded" },
    { id: "b", at: "2026-10-04T00:00:00.000Z", status: "healthy" },
    { id: "b", at: "2026-10-06T00:00:00.000Z", status: "unknown" }
  ];
  const entries = timelineEventsWithTimes(events);
  const normal = sortTimelineEvents(entries.filter((event) => !event.abnormalAt), "normal");
  const abnormal = sortTimelineEvents(entries.filter((event) => event.abnormalAt), "abnormal");
  assert.deepStrictEqual(
    normal.map((event) => `${event.id}:${event.status}`),
    ["b:healthy", "a:healthy"]
  );
  assert.deepStrictEqual(
    abnormal.map((event) => `${event.id}:${event.status}`),
    ["b:unknown", "a:degraded"]
  );
});

test("merges normal and abnormal records using each record's own time", () => {
  const events = [
    { id: "a", at: "2026-10-01T00:00:00.000Z", status: "healthy" },
    { id: "a", at: "2026-10-05T00:00:00.000Z", status: "degraded" },
    { id: "b", at: "2026-10-10T00:00:00.000Z", status: "healthy" }
  ];
  const merged = sortTimelineEvents(timelineEventsWithTimes(events), "merged");
  assert.deepStrictEqual(
    merged.map((event) => `${event.id}:${event.status}`),
    ["b:healthy", "a:degraded", "a:healthy"]
  );
});

test("builds environment filter options from displayed Cluster names", () => {
  const watches = [
    {
      baseUrl: "https://rancher.example.com",
      clusterId: "c-a",
      namespace: "pay",
      deployment: "api",
      environment: "生产环境"
    },
    {
      baseUrl: "https://rancher.example.com",
      clusterId: "c-a",
      namespace: "pay",
      deployment: "worker",
      environment: "生产环境"
    },
    {
      baseUrl: "https://rancher.example.com",
      clusterId: "c-b",
      namespace: "test",
      deployment: "api",
      environment: "测试环境"
    },
    {
      baseUrl: "https://rancher.example.com",
      clusterId: "c-c",
      namespace: "dev",
      deployment: "api"
    }
  ];
  const settings = {
    clusterNames: { [clusterKey(watches[0])]: "主生产" }
  };
  const options = timelineEnvironmentOptions(watches, settings);
  assert.equal(options.length, 3);
  assert.equal(options.find((option) => option.key === clusterKey(watches[0]))?.name, "主生产");
  assert.equal(options.find((option) => option.key === clusterKey(watches[2]))?.name, "测试环境");
  assert.equal(options.find((option) => option.key === clusterKey(watches[3]))?.name, "c-c");
});

test("accepts the timeline view mode through export and import", () => {
  const settings = { viewMode: "timeline" };
  const exported = buildConfigExport([], settings);
  assert.equal(exported.settings.viewMode, "timeline");
  const parsed = parseConfigImport(JSON.stringify({ kind: CONFIG_EXPORT_KIND, version: 1, watches: [], settings }));
  assert.equal(parsed.settings.viewMode, "timeline");
});

test("round-trips the full configuration through export and import", () => {
  const watches = [
    {
      baseUrl: "https://rancher.example.com",
      clusterId: "c-m-prod",
      namespace: "payments",
      deployment: "api",
      sourceUrl: "https://rancher.example.com/dashboard/c/c-m-prod/explorer/apps.deployment/payments/api#pods",
      environment: "生产环境",
      label: "支付接口",
      createdAt: "2026-07-01T00:00:00.000Z"
    },
    {
      baseUrl: "https://rancher.test",
      clusterId: "local",
      namespace: "kube-system",
      deployment: "coredns",
      sourceUrl: "https://rancher.test/dashboard/c/local/explorer/apps.deployment/kube-system/coredns#pods",
      environment: "",
      label: "",
      createdAt: "2026-08-02T00:00:00.000Z"
    }
  ];
  const settings = {
    refreshSeconds: 30,
    monitoringPaused: true,
    viewMode: "compact",
    rememberLogin: true,
    clusterNames: { [clusterKey(watches[0])]: "核心生产集群", "https%3A%2F%2Fold::gone": "已删除集群" },
    notifiedWatchIds: { [watchId(watches[0])]: true, "https%3A%2F%2Fold::x::y::z": true }
  };
  const file = JSON.stringify(buildConfigExport(watches, settings, new Date("2026-10-09T00:00:00Z")));
  assert.doesNotMatch(
    file,
    /rememberLogin|R_SESS|cookie|results/i,
    "导出配置不应包含登录保持开关、Cookie 或状态结果"
  );

  const applied = applyConfigImport({ watches: [], settings: {} }, parseConfigImport(file), "replace");
  assert.deepStrictEqual(applied.watches, watches);
  assert.deepStrictEqual(applied.settings, {
    refreshSeconds: 30,
    monitoringPaused: true,
    viewMode: "compact",
    clusterNames: { [clusterKey(watches[0])]: "核心生产集群" },
    notifiedWatchIds: { [watchId(watches[0])]: true },
    rememberLogin: false
  });
});

test("rejects config files that are not a Deployment Watch export", () => {
  assert.throws(() => parseConfigImport("{"), /不是有效的 JSON/);
  assert.throws(() => parseConfigImport("[1]"), /内容不是对象/);
  assert.throws(() => parseConfigImport(JSON.stringify({ kind: "other", watches: [] })), /不是 Deployment Watch 导出/);
  assert.throws(
    () => parseConfigImport(JSON.stringify({ kind: CONFIG_EXPORT_KIND, version: 99, watches: [] })),
    /版本/
  );
  assert.throws(() => parseConfigImport(JSON.stringify({ settings: {} })), /缺少 watches 列表/);
  assert.throws(
    () => parseConfigImport(JSON.stringify({ watches: [{ url: "https://rancher.example.com/dashboard/home" }] })),
    /第 1 项/
  );
  assert.throws(
    () => parseConfigImport(JSON.stringify({
      watches: [{ baseUrl: "javascript:alert(1)", clusterId: "prod", namespace: "pay", deployment: "api" }]
    })),
    /http 或 https/
  );
});

test("sanitizes untrusted config entries instead of importing them as-is", () => {
  const parsed = parseConfigImport(JSON.stringify({
    watches: [
      { baseUrl: "https://rancher.example.com/extra", clusterId: "prod", namespace: "pay", deployment: "api", label: "  支付  " },
      { url: "https://rancher.example.com/dashboard/c/prod/explorer/apps.deployment/pay/worker%2Fx#pods", environment: "测试", addedAt: "not-a-date" },
      { url: "https://rancher.example.com/dashboard/c/prod/explorer/apps.deployment/pay/api#pods", label: "重复项以最后一项为准" }
    ],
    settings: {
      refreshSeconds: "abc",
      monitoringPaused: "yes",
      viewMode: "dense",
      clusterNames: { junk: "x", "https%3A%2F%2Francher.example.com::prod": " 核心 " },
      notifiedWatchIds: { junk: true, "https%3A%2F%2Francher.example.com::prod::pay::api": true }
    }
  }));

  assert.equal(parsed.watches.length, 2, "重复监控项应合并为一个");
  assert.equal(parsed.watches[0].baseUrl, "https://rancher.example.com", "baseUrl 应归一化为站点 origin");
  assert.equal(
    parsed.watches[0].sourceUrl,
    "https://rancher.example.com/dashboard/c/prod/explorer/apps.deployment/pay/api#pods",
    "结构化字段也应能还原 Rancher 详情页地址"
  );
  assert.equal(parsed.watches[0].label, "重复项以最后一项为准");
  assert.equal(parsed.watches[1].deployment, "worker/x");
  assert.ok(Date.parse(parsed.watches[1].createdAt) > 0, "非法 addedAt 应回退为有效时间");
  assert.deepStrictEqual(parsed.settings, {
    clusterNames: { "https%3A%2F%2Francher.example.com::prod": "核心" },
    notifiedWatchIds: { [watchId(parsed.watches[0])]: true }
  }, "非法取值与不属于本次导入的键应被丢弃");
});

test("merges imported watches without losing local names, and replaces only on request", () => {
  const identity = {
    baseUrl: "https://rancher.example.com",
    clusterId: "prod",
    namespace: "pay",
    deployment: "api",
    sourceUrl: "https://rancher.example.com/dashboard/c/prod/explorer/apps.deployment/pay/api#pods"
  };
  const localOnly = { ...identity, deployment: "worker", sourceUrl: identity.sourceUrl.replace("/api", "/worker") };
  const existing = {
    watches: [
      { ...identity, environment: "旧环境", label: "本机改名", createdAt: "2026-01-01T00:00:00.000Z" },
      localOnly
    ],
    settings: { rememberLogin: true, viewMode: "compact", refreshSeconds: 300 }
  };
  const imported = {
    watches: [{ ...identity, environment: "", label: "文件改名", createdAt: "2026-06-01T00:00:00.000Z" }],
    settings: { refreshSeconds: 10, clusterNames: {}, notifiedWatchIds: {} }
  };

  const merged = applyConfigImport(existing, imported, "merge");
  assert.equal(merged.watches.length, 2, "合并不应删除本机监控项");
  assert.equal(merged.watches[0].label, "文件改名");
  assert.equal(merged.watches[0].environment, "旧环境", "文件里没有环境名称时应保留本机值");
  assert.equal(merged.watches[0].createdAt, "2026-01-01T00:00:00.000Z", "添加时间应保留更早的一次");
  assert.equal(merged.settings.refreshSeconds, 10);
  assert.equal(merged.settings.viewMode, "compact", "文件未导出的设置不应被清空");
  assert.equal(merged.settings.rememberLogin, true);

  const replaced = applyConfigImport(existing, imported, "replace");
  assert.deepStrictEqual(replaced.watches, imported.watches);
  assert.equal(replaced.settings.refreshSeconds, 10);
  assert.equal(replaced.settings.viewMode, undefined);
  assert.equal(replaced.settings.rememberLogin, true, "保持登录与浏览器 Cookie 绑定，不应被导入覆盖");
});

test("names the export file after the export date", () => {
  assert.equal(configExportFilename(new Date(2026, 9, 9)), "rancher-deployment-watch-2026-10-09.json");
});

test("normalizes cluster lists from every Rancher response shape", () => {
  assert.deepStrictEqual(collectionRows([1, 2]), [1, 2]);
  assert.deepStrictEqual(collectionRows({ data: [{ id: "local" }] }), [{ id: "local" }]);
  assert.deepStrictEqual(collectionRows({ items: [{ id: "c-1" }] }), [{ id: "c-1" }]);
  assert.deepStrictEqual(collectionRows({ metadata: {} }), []);

  const steve = {
    data: [
      { id: "local", name: "local", displayName: "管理集群", state: "active" },
      { id: "c-m-prod", name: "c-m-prod", spec: { name: "core-prod" } },
      { type: "management.cattle.io.cluster", id: "local" }
    ]
  };
  assert.deepStrictEqual(normalizeClusterList(steve), [
    { id: "local", name: "管理集群", state: "active" },
    { id: "c-m-prod", name: "core-prod", state: "" }
  ]);
  assert.deepStrictEqual(
    normalizeClusterList([{ metadata: { name: "c-a" }, status: { state: "Active" } }]),
    [{ id: "c-a", name: "c-a", state: "active" }]
  );
  assert.deepStrictEqual(normalizeClusterList({ items: [{ metadata: { name: "c-b" } }] }), [
    { id: "c-b", name: "c-b", state: "" }
  ]);
});

test("prefers the Steve cluster collection and falls back to the legacy proxy", () => {
  assert.deepStrictEqual(clusterDiscoveryUrls("https://rancher.example.com/dashboard/c/local/home"), [
    "https://rancher.example.com/v1/management.cattle.io.clusters",
    "https://rancher.example.com/k8s/clusters"
  ]);
});

test("recovers cluster candidates from the page and local config", () => {
  assert.deepStrictEqual(clusterFromUrl("https://r.example.com/dashboard/c/c-m-969/explorer"), {
    baseUrl: "https://r.example.com",
    clusterId: "c-m-969"
  });
  assert.deepStrictEqual(clusterFromUrl("https://r.example.com/k8s/clusters/c-m-969/v1/namespaces"), {
    baseUrl: "https://r.example.com",
    clusterId: "c-m-969"
  });
  assert.equal(clusterFromUrl("https://r.example.com/dashboard/home"), null, "没有 Cluster 的页面不应猜测");
  assert.equal(clusterFromUrl("不是地址"), null);

  assert.deepStrictEqual(
    mergeClusterSources(
      { clusters: [{ id: "c-m-969", name: "生产" }], origin: "api" },
      { clusters: [{ id: "c-m-969" }, { id: "c-local" }], origin: "local" }
    ),
    [
      { id: "c-m-969", name: "生产", state: "", origins: ["api", "local"] },
      { id: "c-local", name: "c-local", state: "", origins: ["local"] }
    ],
    "同一 Cluster 只保留一条，并记下它来自哪些来源"
  );

  assert.match(
    clusterListFailureMessage([
      { path: "/v1/management.cattle.io.clusters", label: "无权限（403）", status: 403 },
      { path: "/k8s/clusters", label: "404", status: 404 }
    ]),
    /\/v1\/management\.cattle\.io\.clusters：无权限（403）；\/k8s\/clusters：404/
  );
  assert.equal(
    clusterListFailureMessage([{ path: "/v1", label: "无权限（401）", status: 401 }]),
    "Rancher 登录已失效，请重新登录后再试。"
  );
  assert.match(clusterListFailureMessage([]), /接口未返回数据/);
});

test("pages deployments through the Kubernetes proxy", () => {
  const cluster = { baseUrl: "https://rancher.example.com", clusterId: "c-m prod" };
  assert.equal(
    deploymentDiscoveryUrl(cluster),
    "https://rancher.example.com/k8s/clusters/c-m%20prod/apis/apps/v1/deployments?limit=500"
  );
  assert.match(deploymentDiscoveryUrl(cluster, "abc/def"), /continue=abc%2Fdef$/);

  assert.deepStrictEqual(collectionRows({ rows: [{ id: "a" }] }), [{ id: "a" }], "Rancher Steve 列表的行在 rows 里");
  assert.equal(isCollectionPayload({ rows: [] }), true, "rows 也是可用列表");
  assert.equal(
    nextCollectionPageUrl({ metadata: { continue: "t" } }, deploymentDiscoveryUrl, cluster),
    "https://rancher.example.com/k8s/clusters/c-m%20prod/apis/apps/v1/deployments?limit=500&continue=t"
  );
  assert.equal(
    nextCollectionPageUrl({ links: { next: "/k8s/clusters/c-m prod/v1/apps.deployment?page=2&max=500" } }, deploymentCollectionDiscoveryUrl, cluster),
    "https://rancher.example.com/k8s/clusters/c-m%20prod/v1/apps.deployment?page=2&max=500",
    "Steve 用 links.next 给出下一页"
  );
  assert.equal(nextCollectionPageUrl({ count: 9 }, deploymentCollectionDiscoveryUrl, cluster), "", "没有下一页链接时不应自己编造分页");
  assert.equal(isCollectionTruncated({ count: 9, rows: [1, 2] }), true, "count 大于已读行数时应如实说明被截断");
  assert.equal(isCollectionTruncated({ count: 2, rows: [1, 2] }), false);
  assert.deepStrictEqual(
    normalizeDeploymentList({ rows: [{ id: "c-m-prod:payments/api", spec: { replicas: 2 } }] }),
    [{ namespace: "payments", name: "api", desired: 2, ready: 0 }]
  );

  const rows = normalizeDeploymentList({
    items: [
      { metadata: { namespace: "payments", name: "worker" }, spec: { replicas: 2 }, status: { readyReplicas: 1 } },
      { metadata: { namespace: "payments", name: "api" }, spec: {}, status: {} },
      { metadata: { name: "no-namespace" } },
      { metadata: { namespace: "kube-system", name: "coredns" } }
    ],
    metadata: { continue: "token-2" }
  });
  assert.deepStrictEqual(rows, [
    { namespace: "kube-system", name: "coredns", desired: 1, ready: 0 },
    { namespace: "payments", name: "api", desired: 1, ready: 0 },
    { namespace: "payments", name: "worker", desired: 2, ready: 1 }
  ]);
});

test("falls back to per-namespace discovery when cluster-wide listing is denied", () => {
  const cluster = { baseUrl: "https://rancher.example.com", clusterId: "c-m-prod" };
  assert.deepStrictEqual(namespaceDiscoveryUrls(cluster), [
    "https://rancher.example.com/k8s/clusters/c-m-prod/v1/namespaces",
    "https://rancher.example.com/k8s/clusters/c-m-prod/api/v1/namespaces?limit=500"
  ]);
  assert.equal(
    namespacedDeploymentDiscoveryUrl(cluster, "kube-system"),
    "https://rancher.example.com/k8s/clusters/c-m-prod/apis/apps/v1/namespaces/kube-system/deployments?limit=500"
  );
  assert.equal(
    deploymentCollectionDiscoveryUrl(cluster),
    "https://rancher.example.com/k8s/clusters/c-m-prod/v1/apps.deployment?page=1&max=500"
  );
  assert.deepStrictEqual(
    normalizeDeploymentList({
      type: "collection",
      data: [
        { id: "c-m-prod:payments/api", spec: { replicas: 2 }, status: { readyReplicas: 1 } },
        { id: "c-m-prod:default/web" }
      ]
    }),
    [
      { namespace: "default", name: "web", desired: 1, ready: 0 },
      { namespace: "payments", name: "api", desired: 2, ready: 1 }
    ],
    "Rancher 集合列表只用 id 标示命名空间与名称"
  );
  assert.deepStrictEqual(
    normalizeNamespaceList({
      data: [
        { id: "c-m-prod:payments", metadata: { name: "payments" } },
        { id: "c-m-prod:kube-system" },
        { metadata: { name: "payments" } }
      ]
    }),
    ["kube-system", "payments"]
  );

  const plan = prioritizeNamespaces(["kube-system", "payments", "default"], 2);
  assert.deepStrictEqual(plan.namespaces, ["payments", "default"]);
  assert.equal(plan.truncated, true, "命名空间过多时应如实告知只读取了一部分");
  assert.equal(prioritizeNamespaces(["a", "b"], 2).truncated, false);

  assert.equal(isCollectionPayload({}), false, "Rancher 无权限时可能返回 200 和空对象");
  assert.equal(isCollectionPayload({ items: [] }), true);
  assert.equal(isCollectionPayload({ data: [] }), true);
  assert.equal(isCollectionPayload([]), true);

  assert.equal(discoveryProblemLabel({ status: 403 }), "无权限（403）");
  assert.equal(discoveryProblemLabel({ status: 401 }), "无权限（401）");
  assert.equal(discoveryProblemLabel("not-a-list"), "未返回列表");
  assert.equal(discoveryProblemLabel({ name: "AbortError" }), "请求超时");
  assert.equal(discoveryProblemLabel(""), "");

  const denied = discoveryFailureMessage({
    problems: [
      { path: "Cluster 级列表", label: "无权限（403）", status: 403 },
      { path: "Rancher 集合列表", label: "未返回列表", status: 0 }
    ],
    denied: 4
  });
  assert.match(denied, /Cluster 级列表：无权限（403）/);
  assert.match(denied, /Rancher 集合列表：未返回列表/);
  assert.match(denied, /4 个命名空间无权限/);
  assert.match(denied, /粘贴/);
  assert.match(discoveryFailureMessage({ invalid: 2 }), /2 个命名空间未返回列表/);
  assert.match(discoveryFailureMessage({ problems: [{ path: "Cluster 级列表", label: "请求超时" }] }), /请求超时/);
  assert.equal(
    discoveryFailureMessage({
      problems: [
        { path: "Cluster 级列表", label: "无权限（401）", status: 401 },
        { path: "Rancher 集合列表", label: "无权限（401）", status: 401 }
      ]
    }),
    "Rancher 登录已失效，请重新登录后再试。"
  );
});

test("hides Rancher system namespaces from discovery", () => {
  for (const namespace of ["kube-system", "cattle-prometheus", "fleet-default", "rancher-operator-system", "harvester-system", "ingress-nginx"]) {
    assert.equal(isSystemNamespace(namespace), true, namespace);
  }
  for (const namespace of ["default", "payments", "CATTLE"]) {
    assert.equal(isSystemNamespace(namespace), false, namespace);
  }
});

test("turns a discovered deployment into a monitorable watch", () => {
  const watch = discoveredDeploymentToWatch(
    { baseUrl: "https://rancher.example.com", id: "c-m-prod", name: "核心生产" },
    { namespace: "payments", name: "api" }
  );
  assert.equal(watch.baseUrl, "https://rancher.example.com");
  assert.equal(watch.clusterId, "c-m-prod");
  assert.equal(watch.namespace, "payments");
  assert.equal(watch.deployment, "api");
  assert.equal(watch.environment, "核心生产");
  assert.equal(watch.sourceUrl, "https://rancher.example.com/dashboard/c/c-m-prod/explorer/apps.deployment/payments/api#pods");
  assert.equal(parseDeploymentUrl(watch.sourceUrl).deployment, "api");

  const unnamed = discoveredDeploymentToWatch(
    { baseUrl: "https://rancher.example.com", id: "local", name: "local" },
    { namespace: "default", name: "web" }
  );
  assert.equal(unnamed.environment, "");
});

test("searches discovered rows by namespace and deployment name", () => {
  const rows = [
    { namespace: "payments", name: "settlement-api" },
    { namespace: "kube-system", name: "settlement-sidecar" }
  ];
  assert.equal(discoveryRowMatches(rows[0], "payment"), true);
  assert.equal(discoveryRowMatches(rows[0], "SETTLEMENT-API"), true);
  assert.equal(discoveryRowMatches(rows[0], "  "), true, "空查询应保留全部条目");
  assert.equal(discoveryRowMatches(rows[1], "payments"), false);
  assert.equal(rows.filter((row) => discoveryRowMatches(row, "settlement")).length, 2);
});

test("merges discovered watches and reports what was actually added", () => {
  const existing = {
    baseUrl: "https://rancher.example.com",
    clusterId: "prod",
    namespace: "payments",
    deployment: "api",
    environment: "生产",
    label: "支付接口",
    createdAt: "2026-01-01T00:00:00.000Z"
  };
  const incoming = [
    { baseUrl: "https://rancher.example.com", clusterId: "prod", namespace: "payments", deployment: "api" },
    { baseUrl: "https://rancher.example.com", clusterId: "prod", namespace: "payments", deployment: "worker" }
  ];
  const merged = mergeMonitors([existing], incoming);
  assert.equal(merged.watches.length, 2);
  assert.equal(merged.addedIds.length, 1);
  assert.equal(merged.skippedIds.length, 1);

  const kept = merged.watches.find((watch) => watch.deployment === "api");
  assert.equal(kept.label, "支付接口", "重复添加不应清掉显示名称");
  assert.equal(kept.environment, "生产");
  assert.equal(kept.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(kept.sourceUrl, "https://rancher.example.com/dashboard/c/prod/explorer/apps.deployment/payments/api#pods");

  const added = merged.watches.find((watch) => watch.deployment === "worker");
  assert.equal(added.environment, "prod", "没有显示名称时用 Cluster ID 作为环境名");
  assert.ok(added.createdAt);
});

test("integrates Chrome 122 messaging with incremental and race-safe refreshes", async () => {
  let messageListener;
  const watch = {
    baseUrl: "https://rancher.example.com",
    clusterId: "prod",
    namespace: "payments",
    deployment: "api"
  };
  const store = { watches: [watch], results: {} };
  const event = { addListener() {} };
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
        set: async (values) => Object.assign(store, values)
      },
      onChanged: event
    },
    alarms: { clear: async () => {}, create: async () => {}, onAlarm: event },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    runtime: {
      onInstalled: event,
      onStartup: event,
      onMessage: { addListener(listener) { messageListener = listener; } }
    }
  };
  globalThis.fetch = async (url) => {
    let body;
    if (url.includes("/deployments/")) {
      body = {
        metadata: { uid: "deployment-uid", generation: 1 },
        spec: { replicas: 1, selector: { matchLabels: { app: "api" } }, template: { spec: { containers: [] } } },
        status: { observedGeneration: 1, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 }
      };
    } else if (url.includes("/replicasets?")) {
      body = { items: [{ metadata: { uid: "our-rs", ownerReferences: [{ kind: "Deployment", uid: "deployment-uid", controller: true }] } }] };
    } else {
      body = { items: [
        { metadata: { name: "ours", ownerReferences: [{ kind: "ReplicaSet", uid: "our-rs", controller: true }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } },
        { metadata: { name: "theirs", ownerReferences: [{ kind: "ReplicaSet", uid: "other-rs", controller: true }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }
      ] };
    }
    return { ok: true, headers: { get: () => "application/json" }, json: async () => body };
  };
  await import(`../background.js?test=${Date.now()}`);
  assert.equal(typeof messageListener, "function");

  let response;
  const keepChannelOpen = messageListener({ type: "reset-alarm" }, {}, (value) => { response = value; });
  assert.equal(keepChannelOpen, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepStrictEqual(response, { ok: true });

  response = await new Promise((resolve) => {
    assert.equal(messageListener({ type: "refresh" }, {}, resolve), true);
  });
  assert.equal(response[watchId(watch)].status, "healthy");
  assert.deepStrictEqual(response[watchId(watch)].pods.map((pod) => pod.name), ["ours"]);

  let deploymentRequest = 0;
  let releaseOlderRequest;
  globalThis.fetch = async (url) => {
    let body;
    if (url.includes("/deployments/")) {
      deploymentRequest += 1;
      const requestNumber = deploymentRequest;
      if (requestNumber === 1) {
        await new Promise((resolve) => { releaseOlderRequest = resolve; });
      }
      body = {
        metadata: { uid: "deployment-uid", generation: 1 },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "api" } },
          template: { spec: { containers: [{ image: requestNumber === 1 ? "api:old" : "api:new" }] } }
        },
        status: { observedGeneration: 1, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 }
      };
    } else if (url.includes("/replicasets?")) {
      body = { items: [{ metadata: { uid: "our-rs", ownerReferences: [{ kind: "Deployment", uid: "deployment-uid", controller: true }] } }] };
    } else {
      body = { items: [{ metadata: { ownerReferences: [{ kind: "ReplicaSet", uid: "our-rs", controller: true }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }] };
    }
    return { ok: true, headers: { get: () => "application/json" }, json: async () => body };
  };
  const olderRefresh = new Promise((resolve) => messageListener({ type: "refresh" }, {}, resolve));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const newerRefresh = new Promise((resolve) => messageListener({ type: "refresh" }, {}, resolve));
  await newerRefresh;
  releaseOlderRequest();
  await olderRefresh;
  assert.deepStrictEqual(store.results[watchId(watch)].images, ["api:new"]);

  const slowWatch = { ...watch, deployment: "slow" };
  const fastWatch = { ...watch, deployment: "fast" };
  store.watches = [slowWatch, fastWatch];
  let releaseSlowCluster;
  globalThis.fetch = async (url) => {
    let body;
    if (url.includes("/deployments/slow")) {
      await new Promise((resolve) => { releaseSlowCluster = resolve; });
      body = {
        metadata: { uid: "deployment-uid", generation: 1 },
        spec: { replicas: 1, selector: { matchLabels: { app: "api" } }, template: { spec: { containers: [{ image: "api:slow" }] } } },
        status: { observedGeneration: 1, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 }
      };
    } else if (url.includes("/deployments/fast")) {
      body = {
        metadata: { uid: "deployment-uid", generation: 1 },
        spec: { replicas: 1, selector: { matchLabels: { app: "api" } }, template: { spec: { containers: [{ image: "api:fast" }] } } },
        status: { observedGeneration: 1, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 }
      };
    } else if (url.includes("/replicasets?")) {
      body = { items: [{ metadata: { uid: "our-rs", ownerReferences: [{ kind: "Deployment", uid: "deployment-uid", controller: true }] } }] };
    } else {
      body = { items: [{ metadata: { ownerReferences: [{ kind: "ReplicaSet", uid: "our-rs", controller: true }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }] };
    }
    return { ok: true, headers: { get: () => "application/json" }, json: async () => body };
  };
  const mixedRefresh = new Promise((resolve) => messageListener({ type: "refresh" }, {}, resolve));
  for (let attempt = 0; attempt < 10 && !store.results[watchId(fastWatch)]; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(store.results[watchId(fastWatch)].images[0], "api:fast");
  assert.equal(store.results[watchId(slowWatch)], undefined);
  releaseSlowCluster();
  await mixedRefresh;
  assert.equal(store.results[watchId(slowWatch)].images[0], "api:slow");

  assert.equal(messageListener({ type: "unknown" }, {}, () => {}), false);
  delete globalThis.chrome;
  delete globalThis.fetch;
});

test("pauses all monitoring and resumes without losing other settings", async () => {
  let messageListener;
  const watch = {
    baseUrl: "https://rancher.example.com",
    clusterId: "prod",
 namespace: "payments",
 deployment: "api"
 };
 const store = {
 watches: [watch],
 results: {},
 settings: { monitoringPaused: true, refreshSeconds: 10, notifiedWatchIds: { [watchId(watch)]: true } }
 };
 const event = { addListener() {} };
 let fetchCalls = 0;
 let alarmsCreated = 0;
 let alarmsCleared = 0;
 let badgeText = null;
 let badgeColor = null;
 let notificationCalls = 0;
 globalThis.chrome = {
 storage: {
 local: {
 get: async (keys) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
 set: async (values) => Object.assign(store, values)
 },
 onChanged: event
 },
 alarms: {
 clear: async () => { alarmsCleared += 1; },
 create: async () => { alarmsCreated += 1; },
 onAlarm: event
 },
 action: {
 setBadgeBackgroundColor: async (opts) => { badgeColor = opts.color; },
 setBadgeText: async (opts) => { badgeText = opts.text; }
 },
 runtime: {
 onInstalled: event,
 onStartup: event,
 onMessage: { addListener(listener) { messageListener = listener; } }
 },
 notifications: { create: async () => { notificationCalls += 1; } }
 };
 globalThis.fetch = async (url) => {
 fetchCalls += 1;
 let body;
 if (url.includes("/deployments/")) {
 body = {
 metadata: { uid: "deployment-uid", generation: 1 },
 spec: { replicas: 1, selector: { matchLabels: { app: "api" } }, template: { spec: { containers: [{ image: "api:v1" }] } } },
 status: { observedGeneration: 1, readyReplicas: 1, availableReplicas: 1, updatedReplicas: 1 }
 };
 } else if (url.includes("/replicasets?")) {
 body = { items: [{ metadata: { uid: "our-rs", ownerReferences: [{ kind: "Deployment", uid: "deployment-uid", controller: true }] } }] };
 } else {
 body = { items: [{ metadata: { ownerReferences: [{ kind: "ReplicaSet", uid: "our-rs", controller: true }] }, status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] } }] };
 }
 return { ok: true, headers: { get: () => "application/json" }, json: async () => body };
 };
 await import(`../background.js?pause=${Date.now()}`);
 assert.equal(typeof messageListener, "function");

 // 暂停时：reset-alarm 不应创建定时器，并显示暂停角标
 const pausedAlarm = await new Promise((resolve) => {
 assert.equal(messageListener({ type: "reset-alarm" }, {}, resolve), true);
 });
 await new Promise((resolve) => setTimeout(resolve, 0));
 assert.deepStrictEqual(pausedAlarm, { ok: true });
 assert.equal(alarmsCreated, 0, "暂停时不应创建定时刷新");
 assert.ok(alarmsCleared >= 1, "暂停时应清除已有定时器");
 assert.equal(badgeText, "⏸");
 assert.equal(badgeColor, "#8a939e");

 // 暂停时：refresh 不发起任何请求，返回已有结果且不通知
 const pausedRefresh = await new Promise((resolve) => {
 assert.equal(messageListener({ type: "refresh" }, {}, resolve), true);
 });
 assert.equal(fetchCalls, 0, "暂停时不应发起 Rancher 请求");
 assert.deepStrictEqual(pausedRefresh, {});
 assert.equal(notificationCalls, 0, "暂停时不应发送异常通知");

 // 恢复：保留其它设置，重建定时器
 store.settings = { ...store.settings, monitoringPaused: false };
 const resumedAlarm = await new Promise((resolve) => {
 assert.equal(messageListener({ type: "reset-alarm" }, {}, resolve), true);
 });
 await new Promise((resolve) => setTimeout(resolve, 0));
 assert.deepStrictEqual(resumedAlarm, { ok: true });
 assert.ok(alarmsCreated >= 1, "恢复后应重建定时器");
 assert.equal(store.settings.refreshSeconds, 10, "恢复后应保留原有刷新间隔");

 // 恢复后：refresh 发起请求并写入结果
 const resumedRefresh = await new Promise((resolve) => {
 assert.equal(messageListener({ type: "refresh" }, {}, resolve), true);
 });
 assert.ok(fetchCalls > 0, "恢复后刷新应发起 Rancher 请求");
 assert.equal(resumedRefresh[watchId(watch)].status, "healthy");
 assert.equal(store.results[watchId(watch)].images[0], "api:v1");

 delete globalThis.chrome;
 delete globalThis.fetch;
});

test("persists the current Rancher session when remember-login is enabled", async () => {
  let messageListener;
  let cookieChangedListener;
  const watch = {
    baseUrl: "https://rancher.example.com",
    clusterId: "prod",
    namespace: "payments",
    deployment: "api"
  };
  const store = {
    watches: [watch],
    results: {},
    settings: { rememberLogin: true }
  };
  const event = { addListener() {} };
  const sessionCookie = {
    name: "R_SESS",
    value: "current-session",
    domain: "rancher.example.com",
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    storeId: "0",
    session: true
  };
  const persistedCookies = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
        set: async (values) => Object.assign(store, values)
      },
      onChanged: event
    },
    cookies: {
      get: async ({ name }) => name === "R_SESS" ? sessionCookie : null,
      set: async (details) => {
        persistedCookies.push(details);
        return { ...sessionCookie, ...details, session: false };
      },
      onChanged: { addListener(listener) { cookieChangedListener = listener; } }
    },
    alarms: { clear: async () => {}, create: async () => {}, onAlarm: event },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    runtime: {
      onInstalled: event,
      onStartup: event,
      onMessage: { addListener(listener) { messageListener = listener; } }
    },
    notifications: { create: async () => {} }
  };

  await import(`../background.js?remember=${Date.now()}`);
  assert.equal(typeof messageListener, "function");
  assert.equal(typeof cookieChangedListener, "function", "应监听登录后新写入的 Rancher 会话 Cookie");

  const response = await new Promise((resolve) => {
    assert.equal(messageListener({ type: "remember-login-now" }, {}, resolve), true);
  });
  assert.deepStrictEqual(response, { ok: true, persisted: 1 });
  assert.equal(persistedCookies.length, 1);
  assert.equal(persistedCookies[0].name, "R_SESS");
  assert.equal(persistedCookies[0].value, "current-session");
  assert.doesNotMatch(JSON.stringify(store), /current-session/, "Cookie 值不应写入扩展本地存储");
  assert.ok(
    persistedCookies[0].expirationDate > Date.now() / 1000 + 29 * 24 * 60 * 60,
    "持久会话应至少保留约 30 天，避免关闭浏览器后立即丢失"
  );

  cookieChangedListener({
    removed: false,
    cause: "explicit",
    cookie: { ...sessionCookie, value: "new-session" }
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(persistedCookies.at(-1).value, "new-session", "后续登录应自动记住最新会话");

  delete globalThis.chrome;
});

test("discovers clusters and deployments through the background worker", async () => {
  let messageListener;
  const event = { addListener() {} };
  const store = { watches: [], results: {}, settings: {} };
  const requests = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
        set: async (values) => Object.assign(store, values)
      },
      onChanged: event
    },
    alarms: { clear: async () => {}, create: async () => {}, onAlarm: event },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    runtime: {
      onInstalled: event,
      onStartup: event,
      onMessage: { addListener(listener) { messageListener = listener; } }
    }
  };

  const pages = new Map([
    [1, {
      items: [{ metadata: { namespace: "payments", name: "api" }, spec: { replicas: 2 }, status: { readyReplicas: 2 } }],
      metadata: { continue: "token-2" }
    }],
    [2, {
      items: [
        { metadata: { namespace: "kube-system", name: "coredns" } },
        { metadata: { namespace: "payments", name: "worker" }, spec: { replicas: 1 } }
      ]
    }]
  ]);
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url.includes("/v1/management.cattle.io.clusters")) {
      return { ok: false, status: 404, headers: { get: () => "text/html" }, json: async () => ({}) };
    }
    if (url.includes("/k8s/clusters?") || url.endsWith("/k8s/clusters")) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ data: [{ id: "c-m-prod", name: "c-m-prod", displayName: "核心生产", state: "Active" }] })
      };
    }
    if (url.includes("/apis/apps/v1/deployments")) {
      const page = url.includes("continue=token-2") ? pages.get(2) : pages.get(1);
      return { ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => page };
    }
    throw new Error(`测试未预期的请求：${url}`);
  };
  await import(`../background.js?discover=${Date.now()}`);

  const ask = (payload) => new Promise((resolve) => {
    assert.equal(messageListener(payload, {}, resolve), true);
  });

  const clusterResponse = await ask({ type: "discover-clusters", baseUrl: "https://rancher.example.com" });
  assert.deepStrictEqual(clusterResponse, { clusters: [{ id: "c-m-prod", name: "核心生产", state: "active" }] });
  assert.deepStrictEqual(requests.slice(0, 2), [
    "https://rancher.example.com/v1/management.cattle.io.clusters",
    "https://rancher.example.com/k8s/clusters"
  ], "Steve 接口 404 时应回退到旧版代理接口");

  const deploymentResponse = await ask({
    type: "discover-deployments",
    baseUrl: "https://rancher.example.com",
    clusterId: "c-m-prod"
  });
  assert.equal(deploymentResponse.truncated, false);
  assert.equal(deploymentResponse.source, "cluster", "Cluster 级列表可用时不必逐个命名空间读取");
  assert.deepStrictEqual(deploymentResponse.deployments, [
    { namespace: "kube-system", name: "coredns", desired: 1, ready: 0 },
    { namespace: "payments", name: "api", desired: 2, ready: 2 },
    { namespace: "payments", name: "worker", desired: 1, ready: 0 }
  ]);
  assert.ok(requests.some((url) => url.includes("continue=token-2")), "应带上 continue 令牌读取下一页");

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ items: [], metadata: { continue: "always" } })
  });
  const stalled = await ask({ type: "discover-deployments", baseUrl: "https://rancher.example.com", clusterId: "c-m-prod" });
  assert.equal(stalled.truncated, true, "分页不止时应如实告知列表被截断");

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ items: [] })
  });
  const empty = await ask({ type: "discover-clusters", baseUrl: "https://rancher.example.com" });
  assert.deepStrictEqual(empty, { clusters: [] }, "两个接口都可用但无数据时应返回空列表而非报错");

  delete globalThis.chrome;
  delete globalThis.fetch;
});

let discoverBackgroundBust = 0;

async function askDiscoveringBackground(fetchImpl) {
  let messageListener;
  const store = { watches: [], results: {}, settings: {} };
  const requests = [];
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])),
        set: async (values) => Object.assign(store, values)
      },
      onChanged: { addListener() {} }
    },
    alarms: { clear: async () => {}, create: async () => {}, onAlarm: { addListener() {} } },
    action: { setBadgeBackgroundColor: async () => {}, setBadgeText: async () => {} },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } }
    }
  };
  globalThis.fetch = async (url) => {
    requests.push(url);
    return fetchImpl(url);
  };
  discoverBackgroundBust += 1;
  await import(`../background.js?fallback=${Date.now()}-${discoverBackgroundBust}`);
  const ask = (payload) => new Promise((resolve) => {
    assert.equal(messageListener(payload, {}, resolve), true);
  });
  ask.requests = requests;
  return ask;
}

const jsonResponse = (body) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  json: async () => body
});
const statusResponse = (status) => ({
  ok: false,
  status,
  headers: { get: () => "application/json" },
  json: async () => ({})
});

test("reads deployments namespace by namespace when the cluster-wide list is denied", async () => {
  const deployments = {
    payments: { items: [{ metadata: { namespace: "payments", name: "worker" } }] },
    default: { items: [{ metadata: { namespace: "default", name: "web" }, spec: { replicas: 3 }, status: { readyReplicas: 3 } }] },
    "pay-backup": { items: [{ metadata: { namespace: "pay-backup", name: "api" } }] }
  };
  let namespaceListAllowed = true;
  const ask = await askDiscoveringBackground((url) => {
    if (url.includes("/apis/apps/v1/deployments?limit=") && !url.includes("/namespaces/")) return statusResponse(403);
    if (url.includes("/v1/apps.deployment?page=")) return jsonResponse({});
    if (url.endsWith("/v1/namespaces") || url.includes("/api/v1/namespaces?")) {
      return namespaceListAllowed
        ? jsonResponse({ data: [{ id: "c-m-969:payments", metadata: { name: "payments" } }, { metadata: { name: "default" } }] })
        : statusResponse(403);
    }
    const match = url.match(/\/namespaces\/([^/]+)\/deployments/);
    if (match) return jsonResponse(deployments[match[1]] || { items: [] });
    throw new Error(`测试未预期的请求：${url}`);
  });

  const response = await ask({
    type: "discover-deployments",
    baseUrl: "https://rancher.example.com",
    clusterId: "c-m-969"
  });
  assert.equal(response.source, "namespace", "Cluster 级列表被拒时应回退到按命名空间读取");
  assert.equal(response.truncated, false);
  assert.deepStrictEqual(response.deployments, [
    { namespace: "default", name: "web", desired: 3, ready: 3 },
    { namespace: "payments", name: "worker", desired: 1, ready: 0 }
  ]);
  assert.ok(
    ask.requests.some((url) => url.includes("/apis/apps/v1/namespaces/payments/deployments")),
    "应逐个命名空间读取 Deployment"
  );

  namespaceListAllowed = false;
  const localOnly = await ask({
    type: "discover-deployments",
    baseUrl: "https://rancher.example.com",
    clusterId: "c-m-969",
    namespaces: ["pay-backup"]
  });
  assert.deepStrictEqual(localOnly.deployments, [
    { namespace: "pay-backup", name: "api", desired: 1, ready: 0 }
  ], "命名空间列表无权限时应继续读取本机已监控的命名空间");

  delete globalThis.chrome;
  delete globalThis.fetch;
});

test("reads the Rancher Steve collection when the proxy list returns an empty object", async () => {
  const ask = await askDiscoveringBackground((url) => {
    if (url.includes("/apis/apps/v1/deployments?limit=") && !url.includes("/namespaces/")) return jsonResponse({});
    if (url.includes("/v1/apps.deployment?page=")) {
      // Rancher 的 Steve 列表把条目放在 rows，行里带着完整的 metadata。
      return jsonResponse({
        type: "collection",
        links: { self: url },
        resourceType: "apps.deployment",
        count: 2,
        rows: [
          { id: "c-m-969:pay-backup/api", type: "apps.deployment", metadata: { namespace: "pay-backup", name: "api" }, spec: { replicas: 2 }, status: { readyReplicas: 2 } },
          { id: "c-m-969:abc-nw/web", type: "apps.deployment", links: { self: "https://rancher.example.com/v1/apps.deployment/abc-nw/web" } }
        ]
      });
    }
    throw new Error(`测试未预期的请求：${url}`);
  });

  const response = await ask({
    type: "discover-deployments",
    baseUrl: "https://rancher.example.com",
    clusterId: "c-m-969"
  });
  assert.equal(response.source, "collection", "代理列表返回空对象时应改用 Rancher 集合接口");
  assert.deepStrictEqual(response.deployments, [
    { namespace: "abc-nw", name: "web", desired: 1, ready: 0 },
    { namespace: "pay-backup", name: "api", desired: 2, ready: 2 }
  ], "rows 里的行应能解析，只给 id 的行也要认出命名空间与名称");
  assert.equal(response.truncated, false, "count 与 rows 数量一致时不应谎称被截断");
  assert.equal(
    ask.requests.filter((url) => url.includes("/namespaces/")).length,
    0,
    "集合接口可用时不应再逐个命名空间读取"
  );

  delete globalThis.chrome;
  delete globalThis.fetch;
});

test("reports a permission error when no discovery path is allowed", async () => {
  const ask = await askDiscoveringBackground(() => statusResponse(403));

  const response = await ask({
    type: "discover-deployments",
    baseUrl: "https://rancher.example.com",
    clusterId: "c-m-969"
  });
  assert.match(response.__rancherWatchError, /Cluster 级列表：无权限（403）/, "应说明是哪一步读不到");
  assert.match(response.__rancherWatchError, /命名空间列表：无权限（403）/);
  assert.match(response.__rancherWatchError, /粘贴/, "应给出可执行的下一步");
  assert.equal(
    ask.requests.filter((url) => url.includes("/apis/apps/v1/deployments?limit=500")).length,
    1,
    "Cluster 级列表失败后不应继续分页重试"
  );

  globalThis.fetch = async () => statusResponse(401);
  const expired = await ask({
    type: "discover-deployments",
    baseUrl: "https://rancher.example.com",
    clusterId: "c-m-969"
  });
  assert.equal(expired.__rancherWatchError, "Rancher 登录已失效，请重新登录后再试。");

  delete globalThis.chrome;
  delete globalThis.fetch;
});

test("lists the Cluster endpoints it tried when the cluster list fails", async () => {
  const ask = await askDiscoveringBackground((url) => {
    if (url.endsWith("/v1/management.cattle.io.clusters") || url.endsWith("/k8s/clusters")) return statusResponse(404);
    throw new Error(`测试未预期的请求：${url}`);
  });

  const response = await ask({ type: "discover-clusters", baseUrl: "https://rancher.example.com" });
  assert.match(response.__rancherWatchError, /\/v1\/management\.cattle\.io\.clusters：404/, "应写出 Steve 接口返回 404");
  assert.match(response.__rancherWatchError, /\/k8s\/clusters：404/, "应写出旧代理接口也返回 404");
  assert.match(response.__rancherWatchError, /标签页/, "应给出可执行的下一步");

  delete globalThis.chrome;
  delete globalThis.fetch;
});

test("exposes remember-login as an optional, user-triggered permission", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../popup.js", import.meta.url), "utf8");
  assert.ok(manifest.optional_permissions?.includes("cookies"), "cookies 应保持为用户主动授权的可选权限");
  assert.match(html, /id="remember-login"/, "弹窗应提供显式的保持登录开关");
  assert.match(js, /permissions\.request\(\{ permissions: \["cookies"\] \}\)/, "点击开关后才应请求 Cookie 权限");
  assert.match(js, /type: "remember-login-now"/, "开启后应立即持久化当前会话");
});

test("keeps the Chrome popup at a usable fixed width", async () => {
  const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");
  assert.match(css, /body\s*\{[^}]*width:\s*780px/s);
  assert.doesNotMatch(
    css,
    /@media[^\{]*\{[\s\S]*?body\s*\{[^}]*width:\s*100vw/s,
    "窄视口媒体查询不能把 Chrome popup 的固定宽度覆盖为 100vw"
  );
});

test("provides a five-column global overview mode", async () => {
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");
  assert.match(html, /data-view="compact"[^>]*>全局</);
  assert.match(css, /\.compact-mode \.cards\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s);
});

test("vertically centers the Cluster rename row", async () => {
  const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");
  assert.match(css, /\.cluster-heading\s*\{[^}]*align-items:\s*center/s);
  assert.match(css, /\.cluster-title h2\s*\{[^}]*align-items:\s*center[^}]*line-height:\s*1\.2/s);
  assert.match(css, /\.edit-cluster-name\s*\{[^}]*display:\s*inline-flex[^}]*align-items:\s*center/s);
});

test("declares every Chrome icon size", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.deepStrictEqual(Object.keys(manifest.icons), ["16", "32", "48", "128"]);
  for (const [size, path] of Object.entries(manifest.icons)) {
    const icon = await readFile(new URL(`../${path}`, import.meta.url));
    assert.ok(icon.length > 100, `${path} 应包含有效 PNG 数据`);
    assert.equal(icon.subarray(1, 4).toString(), "PNG");
    assert.equal(icon.readUInt32BE(16), Number(size));
    assert.equal(icon.readUInt32BE(20), Number(size));
  }
  assert.equal(manifest.action.default_icon[16], "icons/icon16.png");
  assert.equal(manifest.action.default_icon[32], "icons/icon32.png");
});

test("declares notifications permission and popup toggle", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  assert.ok(manifest.permissions.includes("notifications"), "manifest 应声明 notifications 权限");

  const js = await readFile(new URL("../popup.js", import.meta.url), "utf8");
  assert.match(js, /notifiedWatchIds/, "popup.js 应读写 per-deployment 通知设置");
  assert.match(js, /notify-toggle-input/, "popup.js 应绑定每个 Deployment 的通知复选框");

  const bg = await readFile(new URL("../background.js", import.meta.url), "utf8");
  assert.match(bg, /maybeNotifyProblems/, "background.js 应包含通知逻辑");
  assert.match(bg, /chrome\.notifications\.create/, "background.js 应调用 chrome.notifications.create");
  assert.match(bg, /notifiedWatchIds/, "background.js 应按 Deployment 选择性通知");

  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="notify-problems"/, "全局通知开关应已移除");
});

test("wires config export and import into the popup", async () => {
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../popup.js", import.meta.url), "utf8");
  assert.match(html, /id="config-menu"/, "顶部应提供配置入口");
  assert.match(html, /id="export-config"/, "配置弹窗应提供导出按钮");
  assert.match(html, /<input type="file" id="import-file"[^>]*accept="[^"]*\.json/, "导入应限制为 JSON 文件");
  assert.match(html, /value="merge" checked/, "导入默认应为合并，避免误删本机监控项");
  assert.match(html, /value="replace"/, "导入应提供替换模式");
  assert.match(js, /configExportFilename\(\)/, "导出文件名应带日期");
  assert.match(js, /applyConfigImport\(\{ watches, settings \}, pendingImport, mode\)/, "导入应走统一的合并或替换逻辑");
  assert.match(js, /chrome\.permissions\.request\(\{ origins \}\)/, "确认导入时才申请站点权限");
});

test("wires service discovery into the popup", async () => {
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../popup.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../popup.css", import.meta.url), "utf8");
  const discovery = await readFile(new URL("../background.js", import.meta.url), "utf8");
  assert.match(html, /id="browse-deployments"/, "添加弹窗应提供发现服务入口");
  assert.match(html, /<dialog id="discover-dialog"/, "应有独立的发现服务弹窗");
  assert.match(html, /id="discover-search"[^>]*type="search"/, "发现列表应支持搜索");
  assert.match(html, /id="discover-system"/, "系统命名空间应默认隐藏并可手动展开");
  assert.match(html, /id="discover-grant"/, "列表读取失败时应能就地申请站点权限");
  assert.match(html, /<button[^>]*id="discover-add"[^>]*disabled/, "未选择任何服务时不应允许添加");
  assert.match(js, /type: "discover-clusters"/, "Cluster 列表应通过后台读取");
  assert.match(js, /type: "discover-deployments"/, "Deployment 列表应通过后台读取");
  assert.match(js, /namespaces: knownNamespaceNames\(cluster\)/, "应把本机已监控的命名空间交给后台兜底读取");
  assert.match(js, /discoverFailed/, "读取失败时应区分“没有 Deployment”和“读不到”");
  assert.match(js, /按命名空间读取/, "状态栏应说明使用了兜底读取方式");
  assert.match(js, /discoverStatus\.textContent = `正在读取 \$\{cluster\.name/, "读取过程中应显示进度，不能停留在旧结果");
  assert.match(discovery, /namespacedDeploymentDiscoveryUrl/, "后台应支持按命名空间读取 Deployment");
  assert.match(discovery, /discoveryFailureMessage/, "后台应把权限错误翻译成中文说明");
  assert.match(js, /discoveryRowMatches/, "应按搜索词过滤发现结果");
  assert.match(js, /clusterFromUrl/, "应能从当前标签页地址确定 Cluster");
  assert.match(js, /mergeClusterSources/, "Cluster 下拉应合并接口、本机与当前标签页三种来源");
  assert.match(js, /本机已监控/, "应说明 Cluster 来自本机配置");
  assert.match(js, /showDiscoverError\(discoverClusterNotice\)/, "读取 Deployment 时不应清掉 Cluster 阶段的失败说明");
  assert.match(js, /getManifest\(\)\.version/, "弹窗应显示当前构建版本");
  assert.match(html, /id="discover-build"/, "发现弹窗应留出构建版本位置");
  assert.match(js, /isSystemNamespace/, "应按系统命名空间过滤发现结果");
  assert.match(js, /mergeMonitors\(watches, pending\)/, "批量添加应走统一的合并逻辑");
  assert.doesNotMatch(js, /fetch\(/, "popup.js 不应直接请求 Rancher");
  assert.match(css, /\.discover-list\s*\{[^}]*overflow-y: auto/, "发现列表应可滚动");
  assert.match(css, /#discover-form/, "发现弹窗应有内边距");
});

test("declares each top-level entry only once in the popup and the worker", async () => {
  for (const file of ["../popup.js", "../background.js"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const counts = new Map();
    for (const match of source.matchAll(/^(?:let|const|var|function|class)\s+([A-Za-z0-9_$]+)/gm)) {
      counts.set(match[1], (counts.get(match[1]) || 0) + 1);
    }
    const duplicated = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
    assert.deepStrictEqual(duplicated, [], `${file} 重复声明了 ${duplicated.join("、")}，脚本会直接解析失败`);
  }
});

test("imports every Rancher helper each entry point uses", async () => {
  const rancher = await import("../lib/rancher.js");
  const exported = Object.keys(rancher);
  for (const file of ["../popup.js", "../background.js"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    const block = source.match(/^import \{([\s\S]*?)\} from "\.\/lib\/rancher\.js";/m);
    assert.ok(block, `${file} 应从 lib/rancher.js 引入纯逻辑`);
    const imported = new Set(
      block[1]
        .split(",")
        .map((entry) => entry.trim().split(/\s+as\s+/)[0])
        .filter(Boolean)
    );
    for (const name of imported) assert.ok(exported.includes(name), `${file} 引入了不存在的 ${name}`);
    const body = `${source.slice(0, block.index)}${source.slice(block.index + block[0].length)}`;
    for (const name of exported.filter((entry) => new RegExp(`\\b${entry}\\b`).test(body))) {
      assert.ok(imported.has(name), `${file} 使用了 ${name} 却没有导入`);
    }
  }
});

test("resolves every element id referenced from the popup", async () => {
  const html = await readFile(new URL("../popup.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../popup.js", import.meta.url), "utf8");
  const referenced = [...js.matchAll(/querySelector\(\s*(['"])#([\w-]+)\1\s*\)/g)].map((match) => match[2]);
  assert.ok(referenced.length > 20, "应检查到弹窗使用的全部元素 id");
  const markup = `${html}${js}`;
  for (const id of new Set(referenced)) {
    assert.ok(markup.includes(`id="${id}"`), `popup.js 引用的 #${id} 不存在`);
  }
});

let failed = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(error);
  }
}

if (failed) process.exitCode = 1;
else console.log(`\n${tests.length} tests passed`);
