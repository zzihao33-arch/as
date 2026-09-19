# CM-HUB 任务1接续：空提列表连续性候选

## 版本范围已冻结（2026-09-18）

用户确认：本版本不包含Office在线预览和公共司机入口，两项整体排到下个版本。当前版本保留已上线后台、空提、推送日志，以及员工凭证的私有上传/原件下载/PDF图片查看基础范围。Word/Excel不要求网页转PDF；内部交仓批次中的司机姓名、电话和车牌字段仍属于仓库记录，不视为公共司机入口。

详细边界及剩余收尾见 `docs/CM-HUB-v1-scope-freeze-2026-09-18.md`。业务工作树中的017预览迁移、Office worker、LibreOffice容器和司机公共链路不得带入本版本；`PICKUP_DOCUMENTS_ENABLED`在基础能力真实验收通过前保持关闭。

## 当前断点：2026-09-18 跨页验收与筛选竞态补丁

**22:42:44Z更新：正式已加载本修复。** 入口 `index-ye71hHip.js` / 空提模块 `AirPickupPage-BZkE7EOg.js`，已核对模块中的失效序号递增与加载状态清除。正式HTML和API健康200；真实管理员验收仍待登录。详见下方验收报告及其中production-verification.json。之后的旧资源记录仅为部署过程快照。

`31e9cae` 已提交并推送 master / 发布分支。合成浏览器完成跨页入库、跨页交仓、客户＋关键词交集、详情503/状态变化保护、末页自动回退。发现并修复：筛选变化清空选择后，旧批量目标响应仍打开旧窗口；现在筛选变化使该读取失效。修复前浏览器断言失败、修复后通过，新选择仍可正常打开窗口。35项前端测试、严格类型检查、构建通过。

验收详情及复现入口：`docs/operations/air-pickup-continuity-acceptance-2026-09-18.md`。87个业务请求全部GET，未提交入库/交仓。正式站点已打开但仍为登录页，等待用户自行登录；不能将合成结果记为正式管理员验收。

22:39:54Z GitHub部署记录确认 `31e9cae` 的 **Preview** 成功：`https://as-1w4x07gzv-zzihao33-8750s-projects.vercel.app`；本次检查正式域名仍为旧入口 `index-B09MuhEk.js`，尚未确认正式生效。后续部署证据优先于此快照。

环境纠正：本机没有Docker不代表没有远端环境。根目录 `docs/operations/cmhub-preview-acceptance-2026-09-15/SYNTHETIC-ACCEPTANCE-RESULT.md` 已记录 `ins-nm8jebfh` 上真实合成11/11、镜像PDF回归11/11通过；续做T4/T5时先复核现有测试机身份/负载/健康，不重复从零搭建。业务保真、容量、worker恢复与页面链路仍有缺口，生产文件开关保持关闭。

下方为历史发布与检查记录。

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
