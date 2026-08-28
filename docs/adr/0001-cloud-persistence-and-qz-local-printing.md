---
status: accepted
---

# 云端持久化与 QZ Tray 本地打印分离

云端服务负责服务器端鉴权、持久化、限流和业务结果；Windows 仓库电脑通过网页中的 QZ Tray WebSocket 访问已连接的标签打印机。云端不打印，仓库不使用上游 API Key，也不运行轮询云端的 Node 打印代理。完整业务流和当前/目标差距以 [架构来源](../architecture.md) 为准。

## Consequences

上游只主动调用云端 API；现场网页只通过 QZ Tray 发起打印。目标链路由美国云端持有 CM-HUB 面单资产，仓库不得直接获取上游面单 URL。QZ 接受请求只能证明已提交，不能证明物理出纸；面向上游的结果通过未来的 CM-HUB 出站箱签名回调交付，而不是开放入站打印事件接口。
