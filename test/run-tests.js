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
  clusterKey,
  watchId,
  clusterDisplayName,
  settingsWithClusterName,
  refreshSecondsFromSettings,
  deploymentDisplayName,
  watchesWithDeploymentName
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
