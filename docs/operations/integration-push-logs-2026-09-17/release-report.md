# 客户推送日志发布记录 · 2026-09-17

## 范围与版本

- 用户授权开发、测试、上线，随后明确只给现有线上前端增加日志模块，未完成的任务 1 前端重构不发布。
- 前端从线上 `3d98a79bd34619939ed1212e6fb1f79d750a3f3f` 建立独立发布树，仅 cherry-pick 日志模块与修复。
- 前端正式提交：`4d7c1199650310fe0ee99d9d81dc9fab628e60dd`，相对线上基线 11 个文件，未修改后端、打印签名接口、依赖锁文件或工作流。
- 后端提交：`ca05db3b5a6473c158121047a04d8dea50abc594`，基于含 TYG FOR SHARE 热修复的 `33ce775`。仅替换 auth/db/index/integrationLogs/warehouseAccess 五组源文件和编译文件。
- 可复核发布脚本提交：`680704a8cc7bcecead6935182143c0f65f8dc2ca`，保留在 `codex/integration-push-logs`。不要把整个开发分支合并到重构版本。

## 功能

- `/admin/integration-logs`：全客户推送列表、成功/失败统计、客户/接口/状态/时间筛选、单号与 Request ID 检索、分页和详情。
- TYG 原单号、转单号、提单号可检索；详情只保留安全标识和摘要，无 API 密钥、PDF/Base64、完整请求或收件人信息。
- 独立权限 `integration_logs.view`，菜单、路由、API 同时限制；系统管理员及有 accounts.manage 和 roles.manage 的角色初始获得权限，后续可通过角色配置管理。
- 每 5 秒轮询未读数；首次加载静默、15 秒合并提醒、浏览器手势解锁声音。进入页面确认当时已有日志，后续新增继续未读；已读水位按账号持久化且只前进。
- 列表持续推送合并刷新，过滤变化取消旧请求，所有日志 HTTP 请求 10 秒超时；已读失败提示可以重试原快照。
- 审计在业务响应后独立写入，专用单连接池、单工作队列、最多 256 个小摘要、整体 5 秒截止，避免审计阻塞业务连接池。

## API / 数据库

- GET `/warehouse/v1/integration-logs`：列表、统计、客户选项、快照游标。
- GET `/warehouse/v1/integration-logs/:id`：安全详情。
- GET `/warehouse/v1/integration-logs/notifications`：cursor/readCursor/unreadCount。
- POST `/warehouse/v1/integration-logs/read`：`{cursor}`，限制到账号已观测游标并单调前进。
- 游标/id 为十进制字符串，时间为 UTC ISO；前端显示纽约时间。
- 018 新增 integration_push_logs / integration_push_log_sequence / integration_push_log_reads，schema_migrations 登记为 EXECUTED，旧 17 条历史保留。
- cmhub_api@127.0.0.1 最小授权：logs SELECT,INSERT；sequence SELECT,UPDATE；reads SELECT,INSERT,UPDATE。无 DDL 权限扩大。

## 已验证

- 前端 28 项测试、TypeScript、生产构建通过；Vercel 单独预览 READY。
- 浏览器桌面/390px 手机布局、详情/摘要、失败筛选、空结果、接口异常恢复、无权限路由与菜单、新增未读角标已验证。
- 后端 207 项测试、18 项迁移检查、TypeScript、构建通过。两轮独立审查发现并修复 SQL 保留字、连接池隔离、跟踪号缺失及前端两项竞态。
- 正式机器 Node 20.10.0 / MySQL 8.0.45 隔离随机临时数据库测试通过：迁移/权限种子、延迟提交排序、回滚、并发已读、账号隔离、过滤与 LIKE 转义、原/转/提单检索、精确应用授权、锁等待超时不占用业务池且后续可恢复。临时数据库已清理。
- 14:02 UTC 后端正式发布 PASS：018、健康检查、真实 HTTP 401 与 malformed JSON 400 入站日志、匿名读取 401、应用账号详情查询；环境配置和 TYG 热修复 hash 不变。
- 服务器发布目录 `/root/cmhub-push-logs-20260917-ca05db3`，保存 `release-result.json`、`deploy.log`、`backup-*` 和发布前权限/迁移快照。
- 前端正式 Vercel 部署：`dpl_6AkajL9C2JjFGtT5acGDKnyxyB3T`，READY，cmhubtool.com 与 www.cmhubtool.com 已绑定，commit 与发布树一致。
- 用户登录后，正式工作概览出现日志菜单及 2 条未读；进入日志页后清为 0。新增 1 条技术验收请求和 3 条真实 TYG 请求后，未读累积为 4；详情打开期间未被自动清除。手动已读、跨页面刷新持久化已验证。
- 正式详情返回 HTTP 400 / INVALID_JSON；真实 TYG 原单/转单同时展示，按转单号精确找到对应记录。浏览器未捕获到页面 error 日志。
- 验收期间真实 TYG 请求出现 422 / INVALID_LABEL_PDF；已向用户提示。这是日志捕获的现有面单校验错误，本次未修改面单校验/重放请求。正式成功请求尚未在该验收窗口观察到，成功分支由后端测试与隔离 MySQL 覆盖。

## 回退与边界

- 应用回退恢复服务器 backup 中原文件并 reload cloud-api；保留新增表及已记录日志，不逆向删除数据。发布脚本故障会自动恢复原文件并清理本次新增模块文件。
- 前端回退到上一部署或反向撤销两个日志提交；不要发布任务 1 的工作区。
- 日志从部署时开始记录。数据库不可用、进程崩溃或队列过载时属于尽力记录，会输出限字段故障事件；不伪造历史记录、不代客户重放真实业务请求。
- 此次保留三条明确标识为 push-log-release 的技术验收失败日志，没有创建或修改客户运单。
