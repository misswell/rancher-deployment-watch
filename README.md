# Rancher Deployment Watch

一个无需单独配置 Token 的 Chrome 扩展，用于集中查看多个 Rancher Cluster 中指定 Deployment 的状态。

## 功能

- 从当前 Rancher Deployment 页面一键添加，也可粘贴详情页地址
- 支持每行一个地址批量添加，自动合并重复监控项
- 支持多个 Rancher 地址、多个 Cluster 和 Namespace
- 可按 Cluster、命名空间、Deployment、环境名称快速搜索
- 标准/全局视图切换；全局视图使用五列紧凑卡片展示更多 Deployment
- Cluster 和 Deployment 均可设置独立显示名称，清空后恢复原名称
- 异常项自动排在前面，并可单独刷新某个 Cluster
- 显示期望/就绪/可用副本、Pod 状态、容器重启次数和镜像
- 通过 Deployment → ReplicaSet → Pod 所属关系过滤，避免共享标签的其他工作负载混入统计
- 自动判断正常、有风险、不可用、暂停和未知状态
- 5 秒至 10 分钟自动刷新；弹窗关闭后受 Chrome 限制，最短约 30 秒
- 扩展角标显示异常数量，支持只看异常
- 一键返回原 Rancher Deployment 页面
- 各监控项完成后立即更新，慢 Cluster 不会阻塞其他结果展示

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

添加后可直接搜索 Cluster ID、命名空间或 Deployment。每个 Cluster 标题右侧提供独立刷新按钮，排查单一环境时无需等待其他 Cluster。

点击 Cluster 标题旁的“修改名称”可设置更易识别的显示名称。名称只保存在扩展本地，不会修改 Rancher 中的 Cluster。

Deployment 较多时切换到“全局”视图，可在同一屏查看五列紧凑状态卡片。标准模式下点击 Deployment 卡片底部的“改名”，可以设置便于识别的显示名称。选择 5、10 或 15 秒刷新时，弹窗打开期间会按所选间隔触发；若上一次仍未完成，会合并为下一次刷新以避免堆积请求。弹窗关闭后 Chrome 后台定时器最短约 30 秒。

## 数据与权限

- 扩展不保存 Rancher 用户名、密码或 API Token。
- API 请求复用 Chrome 中已有的 Rancher 登录 Cookie。
- 每个 Rancher 站点都在添加监控时单独申请访问权限。
- 监控配置和最近结果仅保存在 `chrome.storage.local`。
- 扩展通过 Rancher Kubernetes 代理读取 Deployment 和 Pod：

  ```text
  /k8s/clusters/<cluster>/apis/apps/v1/namespaces/<namespace>/deployments/<name>
  /k8s/clusters/<cluster>/apis/apps/v1/namespaces/<namespace>/replicasets?labelSelector=...
  /k8s/clusters/<cluster>/api/v1/namespaces/<namespace>/pods?labelSelector=...
  ```

## 状态规则

- **正常**：期望、就绪、可用和已更新副本一致，并且所有 Pod 为 Running + Ready。
- **有风险**：仍有可用副本，但滚动更新未完成、部分 Pod 未 Ready 或副本不足。
- **不可用**：没有 Ready/Available 副本。
- **已暂停**：期望副本为 0。
- **未知**：网络失败、登录失效、权限不足或资源不存在。

## 常见问题

- **提示登录失效或无权限**：在同一 Chrome 中重新打开并登录 Rancher，然后点刷新。
- **无法访问 Rancher**：检查内网/VPN、HTTPS 证书以及 Chrome 给扩展的站点权限。
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
