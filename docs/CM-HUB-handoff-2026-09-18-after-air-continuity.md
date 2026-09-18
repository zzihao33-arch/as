# CM-HUB 任务1接续：空提列表连续性候选

当前发布提交 `ec035ab`，基于已发布 `8b89e0e`。本批完成客户组合筛选、跨页选择快照和批量目标完整读取，代码与测试已提交并推送到 `master` 与 `codex/integration-logs-release`。

验证结果见 `docs/operations/air-pickup-continuity-release-2026-09-18.md`。Vercel 生产部署 `dpl_71fHQteiqZQzW1RSU9oZNsaX8Y38` 已对 `ec035ab` 返回 READY，部署根路径已通过 HTTP 200 冒烟；上一版本的回退目标为 `dpl_EfCaNEn3MXK2Ws5pnDPBic1eJVL7`。

继续工作时使用现有管理员会话验证客户＋关键词交集、翻页保留选择、批量窗口跨页目标和空页分页恢复，再更新本文件。不要把业务工作树中的迁移、worker、Office 预览或司机入口带入发布。

## 2026-09-18 后续网络错误批次

提交 `ae72eff` 已推送到 `master` 与 `codex/integration-logs-release`。前端请求现在把浏览器无法区分的 DNS/TLS/CORS/离线 `TypeError` 统一映射为 `NETWORK_UNAVAILABLE`，界面显示“无法连接云端 API，请检查网络后重试”，同时保留原始 cause 供诊断。类型检查、35 项前端测试、生产构建和 `git diff --check` 均通过。

正式站点已观察到新资源 `index-B09MuhEk.js`，其中包含该提示；`https://cmhubtool.com/` 与 `https://api.cmhubtool.com/healthz` 均返回 200。Vercel CLI 未配置本机凭据，因此未直接读取部署 ID；以正式域名资源和健康检查作为部署证据。管理员登录后的业务冒烟仍需在可用账号环境执行。

## T4/T5 候选工作树复核

已在 `codex/cmhub-t1-session-recovery` 业务工作树对现有候选实现做本地回归：云端服务 133 项通过、前端 73 项通过，前后端严格类型检查均通过；2 项真实 MySQL 测试按环境条件跳过。该工作树仍包含未提交的列表、文件凭证、预览 worker 和迁移混合修改，未合并到发布树。

当前机器未安装 Docker、LibreOffice 或 WSL，无法执行真实隔离检查器、Office 转换、资源预算和 worker 强杀恢复验收。T4 的检查器缺失保护仍有效，`PICKUP_DOCUMENTS_ENABLED` 不得在生产打开；T5 的合成/协议测试不能替代真实环境验收。下一步需要具备 Linux/Docker/LibreOffice 的专用测试环境后，按 `docs/operations/cmhub-preview-acceptance-2026-09-15/` 执行真实验收。

## 测试站只读核对

`https://test.cmhubtool.com/` 与 `https://api-test.cmhubtool.com/healthz` 当前返回 200。带 `Origin: https://test.cmhubtool.com` 请求 `/warehouse/v1/integration-logs/notifications` 返回 `404 ROUTE_NOT_FOUND`；省略 Origin 返回 `403 ORIGIN_NOT_ALLOWED`。测试 API 尚未部署推送日志路由，因此不能用该站完成普通账号权限撤销/恢复联调；本次未升级测试后端或改变其配置。
