# Rancher Deployment Watch

一个无需单独配置 Token 的 Chrome 扩展，用于集中查看多个 Rancher Cluster 中指定 Deployment 的状态。

## 功能

- 从当前 Rancher Deployment 页面一键添加，也可粘贴详情页地址
- 发现服务：直接浏览 Cluster 与 Deployment 列表，勾选后批量加入监控，不必逐个打开详情页；账号没有 Cluster 列表权限时，仍可从已监控项或当前标签页继续添加
- 支持每行一个地址批量添加，自动合并重复监控项
- 支持多个 Rancher 地址、多个 Cluster 和 Namespace
- 可按 Cluster、命名空间、Deployment、环境名称快速搜索
- 标准/全局/时间线视图切换；全局视图使用五列紧凑卡片展示更多 Deployment
- Cluster 和 Deployment 均可设置独立显示名称，清空后恢复原名称
- 按最近一次就绪时间排序：最后就绪的 Deployment 排在前面，卡片底部显示“就绪 X 分钟前”
- 历史时间线记录每次就绪与状态切换，支持按环境筛选和按正常时间、异常时间、分开排序或合并排序，左侧正常时间、右侧异常时间
- 可单独刷新某个 Cluster
- 显示期望/就绪/可用副本、Pod 状态、容器重启次数和镜像
- 通过 Deployment → ReplicaSet → Pod 所属关系过滤，避免共享标签的其他工作负载混入统计
- 自动判断正常、有风险、不可用、暂停和未知状态
- 5 秒至 10 分钟自动刷新；弹窗关闭后受 Chrome 限制，最短约 30 秒
- 扩展角标显示异常数量，支持只看异常
- 一键返回原 Rancher Deployment 页面
- 各监控项完成后立即更新，慢 Cluster 不会阻塞其他结果展示
- 全部暂停监控：不在内网或无网络时可一键暂停所有请求，保留上次状态、停止角标异常计数与异常通知，恢复后自动刷新
- 可选“保持登录”：将当前 Rancher `R_SESS` 会话 Cookie 设为约 30 天有效，关闭并重新打开浏览器后仍可继续监控
- 配置可导出为 JSON 文件，换浏览器或换电脑时导入，导入时可选合并或替换

## 安装

1. 打开 Chrome，在地址栏输入 `chrome://extensions/`。
2. 打开右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录 `rancher-deployment-watch`。
5. 将扩展固定到工具栏。

需要 Chrome 122 或更高版本。

也可以将发布包解压后，以相同方式选择解压目录。

## 使用

1. 先在 Chrome 中登录 Rancher。
2. 打开一个 Deployment 详情页，例如：

   ```text
   https://rancher.example.com/dashboard/c/<cluster-id>/explorer/apps.deployment/<namespace>/<deployment>#pods
   ```

3. 点击扩展图标，再点击“添加监控”。
4. 使用当前标签页，或每行粘贴一个详情页地址；可为这一批监控项填写环境名称。
5. Chrome 会请求访问该 Rancher 站点，授权后即可读取状态。

不想逐个打开 Deployment 详情页时，在“添加监控”里点击“浏览 Cluster 与 Deployment…”。弹窗会列出已授权站点（可用“用当前标签页”带入正在浏览的 Rancher 与 Cluster），选择 Cluster 后读取其中的 Deployment：默认隐藏 `kube-*`、`cattle-*`、`fleet-*` 等系统命名空间，可勾选“系统命名空间”展开；搜索框按命名空间或名称即时过滤，已监控的条目标记为“已监控”。可跨 Cluster 累积勾选，再点“添加到监控”一次性加入，重复项只会更新而不会新增。账号没有 Cluster 级 list 权限时，扩展会自动逐个命名空间读取，状态栏显示“按命名空间读取”。若站点未授权或读取失败，点“授权并重试”。

添加后可直接搜索 Cluster ID、命名空间或 Deployment。每个 Cluster 标题右侧提供独立刷新按钮，排查单一环境时无需等待其他 Cluster。

点击 Cluster 标题旁的“修改名称”可设置更易识别的显示名称。名称只保存在扩展本地，不会修改 Rancher 中的 Cluster。

Deployment 较多时切换到"全局"视图，可在同一屏查看五列紧凑状态卡片。点击"时间线"可查看历史记录：时间线工具栏可按环境筛选，默认显示全部环境；排序支持“正常时间”“异常时间”“分开排序”“合并排序”四种方式。分开排序会把正常记录和异常记录分组，分别按各自时间倒序；合并排序会把正常记录按正常时间、异常记录按异常时间合成一条时间线。每条记录左侧显示正常时间、右侧显示异常时间，点"打开 Rancher"可直接跳转。正常时间取该 Deployment 最近一次全部就绪的时间，异常时间取状态切换的时间；正常记录右侧显示“—”。标准模式和全局模式都按最近一次就绪时间排序，卡片底部显示"就绪 X 分钟前"；尚未观察到就绪时间的监控项排在后面。标准模式下点击 Deployment 卡片底部的"改名"，可以设置便于识别的显示名称。选择 5、10 或 15 秒刷新时，弹窗打开期间会按所选间隔触发；若上一次仍未完成，会合并为下一次刷新以避免堆积请求。弹窗关闭后 Chrome 后台定时器最短约 30 秒。

不在内网或无网络时，点击顶部"暂停监控"可暂停所有 Rancher 请求。暂停期间：扩展图标显示 ⏸ 角标，弹窗顶部出现暂停提示，已有状态保持不变（不会被刷成"未知"），后台定时器与异常通知均停止。需要恢复时点击"继续监控"，扩展会立即刷新一次并重建定时器。暂停状态保存在本机，重启浏览器后仍然生效。

若 Rancher 登录会在关闭浏览器后失效，可点击顶部“保持登录”并授权 Cookie 权限。扩展只处理已添加且已授权站点的 `R_SESS` 会话 Cookie：当前会话与后续新登录会话会被设为约 30 天有效。它不会保存用户名或密码；Rancher 服务端过期、管理员撤销会话或用户主动退出仍会立即结束登录。关闭此功能后不再延长新会话，已有会话可在 Rancher 中主动退出。

点击顶部 ⚙ 打开“导出与导入配置”。导出会下载一个 JSON 文件，内容是监控项地址、环境与显示名称、Cluster 改名、刷新间隔、暂停状态和通知开关，不包含 Cookie、Token 或 Pod 状态结果，可以放心存档或分享给同事。文件是普通 JSON，也可以手工增删（每项至少要有 `url`）。

导入时选择该文件，弹窗会先显示识别到的监控项数量、涉及几个 Cluster 与几个站点，再选择方式：**合并**保留本机监控项，重复项以文件为准；**替换**先清空本机监控项，只保留文件内容。确认导入时才申请文件中出现的 Rancher 站点权限，拒绝授权不会改动本机配置；导入成功后立即刷新状态。“保持登录”与本机浏览器 Cookie 绑定，不随配置导出，也不会被导入覆盖。

```json
{
  "kind": "rancher-deployment-watch-config",
  "version": 1,
  "settings": { "refreshSeconds": 30, "viewMode": "standard" },
  "watches": [
    {
      "url": "https://rancher.example.com/dashboard/c/c-m-prod/explorer/apps.deployment/payments/api#pods",
      "environment": "生产环境",
      "label": "支付接口"
    }
  ]
}
```

## 数据与权限

- 扩展不保存 Rancher 用户名、密码或 API Token。
- API 请求复用 Chrome 中已有的 Rancher 登录 Cookie；仅在用户主动开启“保持登录”时，通过可选 `cookies` 权限为 `R_SESS` 增加过期时间，Cookie 值不会写入扩展存储。
- 每个 Rancher 站点都在添加监控或发现服务授权时单独申请访问权限。
- 监控配置和最近结果仅保存在 `chrome.storage.local`。
- 导出的配置文件是纯 JSON，只含监控项地址与显示相关设置，不携带 Cookie 或 Token；导入时按文件内容重新申请站点访问权限。
- 扩展通过 Rancher Kubernetes 代理读取 Deployment 和 Pod：

  ```text
  /k8s/clusters/<cluster>/apis/apps/v1/namespaces/<namespace>/deployments/<name>
  /k8s/clusters/<cluster>/apis/apps/v1/namespaces/<namespace>/replicasets?labelSelector=...
  /k8s/clusters/<cluster>/api/v1/namespaces/<namespace>/pods?labelSelector=...
  ```

- 发现服务只在打开弹窗或切换 Cluster、点击重试时读取列表，不写入任何数据：

  ```text
  /v1/management.cattle.io.clusters（失败时回退 /k8s/clusters）
  /k8s/clusters/<cluster>/apis/apps/v1/deployments?limit=500[&continue=...]
  ```

  Cluster 级列表被拒绝或返回空响应时（Rancher 的项目级角色通常没有跨命名空间的 list 权限），会依次改用 Rancher 集合接口和逐个命名空间读取：

  ```text
  /k8s/clusters/<cluster>/v1/apps.deployment?page=1&max=500
  /k8s/clusters/<cluster>/v1/namespaces（失败时回退 /api/v1/namespaces?limit=500）
  /k8s/clusters/<cluster>/apis/apps/v1/namespaces/<namespace>/deployments?limit=500
  ```

  Rancher 的 Steve 列表把条目放在 `rows`、分页参数是 `page`/`max`，与 Kubernetes 的 `items`/`limit`/`continue` 不同，扩展两种都认。Cluster 级列表按 500 一页请求：实测请求 1000 时 Rancher 会返回空对象。

- Cluster 列表接口不可用时不会卡住发现服务：下拉框仍会列出本机已监控的 Cluster 和当前标签页里的 Cluster（从 `dashboard/c/<cluster>` 或 `k8s/clusters/<cluster>` 地址识别），状态栏与错误栏会写明每个接口各自的失败原因。发现服务标题旁显示当前构建版本，便于确认加载的是哪一版。

  状态栏会写明使用了哪种方式，例如“改用 Rancher 集合列表读取”或“改用按命名空间读取 12 个”；三条路径都不通时，错误提示会列出每一步失败的原因。

## 状态规则

- **正常**：期望、就绪、可用和已更新副本一致，并且所有 Pod 为 Running + Ready。
- **有风险**：仍有可用副本，但滚动更新未完成、部分 Pod 未 Ready 或副本不足。
- **不可用**：没有 Ready/Available 副本。
- **已暂停**：期望副本为 0。
- **未知**：网络失败、登录失效、权限不足或资源不存在。

## 常见问题

- **关闭浏览器后登录失效**：先登录 Rancher，再在扩展顶部开启“保持登录”。若仍失效，通常是 Rancher 服务端会话期限或管理员策略所致。
- **提示登录失效或无权限**：在同一 Chrome 中重新打开并登录 Rancher，然后点刷新。
- **无法访问 Rancher**：检查内网/VPN、HTTPS 证书以及 Chrome 给扩展的站点权限。
- **导入配置后状态为未知**：确认导入时需授权文件里出现的每个 Rancher 站点；已授权但登录失效或不在内网时，卡片同样显示未知，重新登录 Rancher 后刷新即可。
- **发现服务读不到 Cluster 或 Deployment**：当前账号需要 Deployment 的 list 权限。Cluster 级列表被拒绝时，扩展会退回逐个命名空间读取，状态栏显示“按命名空间读取”；Cluster 列表本身读不到时，下拉框仍会给出本机已监控和当前标签页里的 Cluster，可以直接继续添加。状态栏会写明用的是哪条读取路径，错误栏会列出每个接口各自的原因（无权限、未返回列表、超时）。仍不可用时点“授权并重试”，或改用粘贴地址添加，两种方式的监控效果一致。
- **一直找不到 Deployment**：确认地址是 Deployment 详情页，不是列表、Pod 或 StatefulSet 页面。
- **后台刷新不工作**：Chrome 可能会延迟休眠扩展的定时任务，重新打开弹窗会立即刷新。

## 开发验证

```bash
npm test
node --check background.js
node --check popup.js
node --check lib/rancher.js
python3 -m json.tool manifest.json >/dev/null
```

---

## 👨‍💻 作者的其他开源项目

**[MacPilot](https://github.com/misswell/MacPilot)** —— 开源 macOS 菜单栏效率工具箱（Swift 原生 · 零第三方依赖）：应用自动退出规则、BLE 靠近解锁、窗口切换器、剪贴板历史、平滑滚动、画中画、录屏、截图贴图等 11 合 1，Apple 公证签名，[免费下载](https://github.com/misswell/MacPilot/releases/latest)。觉得有用欢迎点个 Star ⭐
