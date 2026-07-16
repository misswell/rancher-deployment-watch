# Rancher Deployment Watch 隐私政策

最后更新：2026 年 7 月 16 日

Rancher Deployment Watch（以下简称“本扩展”）用于集中监控用户指定的多个 Rancher Cluster 中 Deployment 与 Pod 的运行状态。

## 处理的数据

本扩展仅为实现监控功能而处理以下数据：

- 用户主动添加的 Rancher 地址、Cluster 标识、Namespace、Deployment 名称和自定义显示名称；
- 用户设置的刷新间隔、筛选条件和视图模式；
- 从用户已授权的 Rancher 站点读取的 Deployment、ReplicaSet 和 Pod 运行状态，包括副本数、镜像、节点、IP、重启次数和 Conditions；
- 为提升打开速度而保存在本机的最近一次状态结果和更新时间。

## 身份验证

本扩展复用用户在 Chrome 中已有的 Rancher 登录会话，请求由浏览器直接发送到用户授权的 Rancher 站点。本扩展不会读取或保存用户名、密码、Cookie 值或 API Token。

## 数据存储与传输

- 配置和最近状态仅保存在 `chrome.storage.local` 中；
- Rancher 状态数据仅在本扩展与用户明确授权的 Rancher 站点之间传输；
- 本扩展不设开发者数据服务器，不会向开发者或第三方上传监控数据；
- 本扩展不出售、出租或共享用户数据，也不用于广告、画像、信用评估或与核心功能无关的用途。

用户可删除单个监控项、清除扩展数据或卸载扩展，以删除本机保存的数据。

## 权限用途

- `activeTab`：仅在用户选择"使用当前标签页"时读取当前标签页 URL，以解析 Rancher Deployment 地址并快速添加监控；
- `alarms`：按用户设置的周期触发后台刷新并更新异常数量角标；
- `notifications`：当用户开启异常通知且检测到新的异常 Deployment 时，在浏览器中弹出桌面通知，提醒用户及时处理；
- `storage`：在本机保存监控配置、显示名称、设置和最近状态；
- 可选站点权限：仅在用户添加 Rancher 地址并明确授权后，访问对应站点的 Kubernetes 代理 API。

## 远程代码

本扩展不下载或执行远程代码。所有 JavaScript 均包含在已安装的扩展包中；网络请求只用于读取 Rancher 状态数据。

## 联系方式

如对本隐私政策有疑问，请通过本扩展发布页面提供的开发者联系方式联系开发者。
