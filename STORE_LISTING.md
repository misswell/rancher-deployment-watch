# Chrome Web Store 发布资料

## 商品详情

- 默认语言：中文（简体）
- 类别：开发者工具
- 名称：Rancher Deployment Watch
- 商店图标：`store-assets/store-icon-128.png`
- 截图：`store-assets/screenshot-1280x800.png`

### 简短说明

集中监控多个 Rancher Cluster 中指定 Deployment 与 Pod 的状态，支持异常筛选、紧凑全局视图和定时刷新。

### 详细说明

Rancher Deployment Watch 用于集中查看多个 Rancher Cluster 中指定 Deployment 的运行状态，无需另存 API Token，直接复用当前 Chrome 中已登录的 Rancher 会话。

主要功能：

- 批量添加多个 Rancher、Cluster、Namespace 和 Deployment；
- 展示期望、就绪、可用副本，以及 Pod、镜像、节点、IP 和重启次数；
- 自动识别正常、有风险、不可用、暂停和未知状态；
- 支持异常筛选、五列全局视图和 5 秒起步的弹窗刷新；
- 支持开启异常浏览器通知，在后台发现新的异常时弹出桌面提醒；
- 支持修改 Cluster 与 Deployment 的本地显示名称；
- 单个 Cluster 请求异常或超时不会阻塞其他监控结果；
- 所有配置与最近状态仅保存在本机扩展存储中。

使用前请先在 Chrome 中登录目标 Rancher。添加监控时，扩展会按站点请求访问权限，并仅调用 Rancher Kubernetes 代理 API 读取用户指定的工作负载状态。

## 隐私权规范

### 单一用途说明

集中监控用户指定的多个 Rancher Cluster 中 Deployment 与 Pod 的运行状态，并在一个弹窗中提供状态概览、异常筛选和快速跳转。

### 远程代码

选择：否，我未使用远程代码。

理由：本扩展不执行远程代码。所有 JavaScript 均随扩展安装包发布；对 Rancher API 的网络请求仅用于读取 Deployment、ReplicaSet 和 Pod 状态数据，不会下载或执行脚本、WebAssembly 或其他可执行内容。

### activeTab 权限理由

仅在用户点击扩展并选择“使用当前标签页”时读取当前活动标签页的 URL，用于解析 Rancher Deployment 地址并快速添加监控。不会持续读取浏览历史或页面内容。

### alarms 权限理由

用于按用户选择的间隔在后台触发 Deployment 状态刷新并更新异常角标。Chrome 后台最短约 30 秒执行；不用于跟踪用户行为。

### notifications 权限理由

仅在用户主动开启"异常通知"开关后，当后台刷新发现新的异常 Deployment 时，通过 Chrome 桌面通知提醒用户。通知内容仅包含 Deployment 名称和状态摘要，不收集、上传或共享用户数据。

### storage 权限理由

用于在本机保存用户添加的 Rancher、Cluster、Deployment 监控配置、显示名称、刷新间隔、视图模式及最近一次状态结果。数据不会上传到开发者服务器或出售给第三方。

### 可选站点权限理由

仅在用户添加某个 Rancher 地址并明确授权后，访问该 Rancher 站点的 Kubernetes 代理 API，以读取指定 Deployment、ReplicaSet 和 Pod 的运行状态。权限按站点动态申请，不会访问未授权站点。

### 数据使用披露

- 勾选“网站内容”：扩展会读取用户明确指定的 Rancher 工作负载状态；
- 不勾选身份验证信息：扩展会复用浏览器已有登录会话，但不会读取或保存用户名、密码、Cookie 值或 API Token；
- 数据只在用户设备和用户授权的 Rancher 站点之间传输，不发送到开发者服务器；
- 勾选所有“有限使用”与开发者计划政策确认项；
- 隐私政策正文见项目根目录 `PRIVACY.md`。提交前需将其发布到公开可访问的 HTTPS 地址，并把该地址填入后台。

## 保存草稿检查表

- [ ] 选择默认语言“中文（简体）”
- [ ] 选择类别“开发者工具”
- [ ] 填写简短说明和详细说明
- [ ] 上传 128×128 商店图标
- [ ] 上传至少一张 1280×800 截图
- [ ] 填写单一用途和全部权限理由
- [ ] 远程代码选择“否”并填写理由
- [ ] 完成数据使用披露与政策确认
- [ ] 填写公开隐私政策 HTTPS 地址
- [ ] 在每个标签页点击“保存草稿”
