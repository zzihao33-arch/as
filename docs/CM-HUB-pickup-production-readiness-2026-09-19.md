# CM-HUB 员工提货凭证生产发布准备（2026-09-19）

## 结论

生产环境尚不具备发布条件。本轮只执行只读核查，没有修改生产文件、配置、数据库、进程或网络。生产 API 健康检查保持 HTTP 200，`outboundWebhooks.enabled=false`。

当前提货凭证分支不能直接覆盖生产：生产最新补丁 `ca05db3` 与提货凭证验收提交 `9bb0bb4` 从 `0ff404d` 分叉，生产线包含集成日志和 TYG 修复，而提货凭证线不包含这些提交。直接部署 `9bb0bb4` 会删除或回退已上线的集成日志功能。

## 只读核查证据

目标为生产实例 `air-cargo-server / ins-dmx8z3xt`。所有命令均通过腾讯云 TAT 只读执行。

- `inv-u8v06cg8it`：确认原先假设的 `/opt/cmhub-api` 和 `cmhub` 用户不适用于生产。
- `inv-w8v08bg171`：定位实际运行布局、监听端口、进程、仓库和基础健康状态。
- `inv-v8v0a60g85`：核对部署文件、同步仓库版本、非敏感配置、数据库对象可见性和 Nginx 配置。
- `inv-u8v0ca0qg3`：核对 PM2 运行状态、最近发布清单、数据库权限、启动持久化和最终健康状态。

审计期间没有读取或记录密码、密钥、令牌等敏感值。

## 生产现状

- API 由 root 的 PM2 运行，进程命令为 `node /www/wwwroot/cloud-api/dist/index.js`，监听 `127.0.0.1:8080`。
- Node 可执行文件为 `/www/server/nodejs/v20.10.0/bin/node`。
- Nginx 由宝塔目录 `/www/server/nginx/sbin/nginx` 运行，不受发行版 `nginx.service` 管理。
- 同步仓库位于 `/opt/cmhub-github-sync/as`，`master` 干净，HEAD 为 `27d2a243`；实际部署目录不是该 Git 工作树。
- 最近生产发布清单为 `/root/cmhub-push-logs-20260917-ca05db3/release-manifest.json`，记录补丁提交 `ca05db3` 和备份目录 `/root/cmhub-push-logs-20260917-ca05db3/backup-2026-09-17T14-02-13-505Z`。
- 实际部署缺少 `dist/pickupDocuments.js`、`dist/pickupDocumentSandbox.js` 和 `dist/pickupDocumentsHttp.js`。
- 生产没有 Docker/Podman 和 rootless Docker，也没有 `cmhub` 用户；固定扫描镜像尚未安装。
- `PICKUP_DOCUMENTS_ENABLED`、`PICKUP_DOCUMENT_SANDBOX_IMAGE`、COS bucket/region/prefix 当前未配置。生产 `OUTBOUND_WEBHOOK_ENABLED=false`。
- 应用数据库账号不能读取 `schema_migrations`，返回 `ER_TABLEACCESS_DENIED_ERROR`；本机 root socket 也不能免密读取迁移账本。
- 可见业务表中只有旧表 `air_pickup_document_assets`；没有 `warehouse_ui_operations`，也没有新的提货凭证权限。
- `pm2-undefined.service` 虽为 enabled，但内容包含 `User=undefined` 且处于 inactive。当前 root PM2 的整机重启恢复路径没有可靠证据。

## 发布阻断项

1. **版本线必须先合并。** 以 `ca05db3` 为生产功能基线，叠加提货凭证代码并保留集成日志、TYG 修复和对应测试。两条线的 017/018 迁移编号冲突，提货凭证迁移必须改为生产账本中的下一个可用编号，不能覆盖或重放已应用迁移。
2. **迁移账本必须由有权限的管理员核对。** 发布前导出 `schema_migrations` 的文件名和 SHA-256，并核对 `017_use_utc_label_expiry_default.sql`、`018_add_integration_push_logs.sql` 是否已登记且与生产清单一致。未获得该证据前不得运行自动迁移器。
3. **扫描运行时必须先落地并验收。** 需要在生产建立与测试等价的受限运行身份、Docker 隔离、cgroup 委托和固定镜像摘要，再运行完整沙箱探针。不能让 root API 直接使用不受限的 Docker socket。
4. **私有对象存储必须配置并验证。** 应使用独立生产 COS 前缀和最小权限凭据，先执行 bucket/prefix 读写删除探针，再启动应用。凭据不得进入仓库、发布清单或命令输出。
5. **PM2 启动持久化必须修复。** 建立有效的 systemd 单元并完成一次整机重启恢复验收；宝塔 Nginx 的现有启动方式需保持不变并单独验证。
6. **Node 运行时兼容性必须确认。** 现有通用部署脚本要求 Node 22+，生产实际为 Node 20.10.0。发布候选应在生产同版本上通过安装、测试和构建，或先单独升级 Node 并验证现有服务。

## 发布候选构造

发布候选从 `ca05db3` 建立，合并提货凭证验收线，并满足以下要求：

- 保留 `services/cloud-api/src/integrationLogs.ts`、集成日志页面、通知逻辑、验证脚本和相关测试。
- 合并共享文件中的两组行为，重点包括 `config.ts`、`index.ts`、`warehouseAccess.ts`、`warehouseHttp.ts`、会话提供器和提货页面。
- 将生产线现有 017/018 保持原文件名和校验和；在管理员账本核对后，把提货凭证两份迁移顺延到未使用编号，并同步迁移测试和文档。
- 构建结果必须包含提货凭证三个运行模块，同时保留生产集成日志模块。
- 后端、前端、迁移校验、类型检查和构建全部通过；随后把该候选部署到测试环境重新执行 API、浏览器、恶意文件拒绝、权限和整机重启验收。

## 生产执行顺序

获得生产发布授权后，按以下顺序执行；任何一步失败都停止，不启用功能。

1. 再次记录生产健康、进程、监听、Nginx 配置测试、磁盘空间和当前发布清单。
2. 以时间戳目录备份 `/www/wwwroot/cloud-api`、PM2 dump、非敏感配置键名、Nginx 相关配置和迁移账本；生成 SHA-256 清单并设为仅 root 可读。
3. 由数据库管理员备份受影响表和迁移账本，核对迁移文件校验和；先执行仅结构检查，再应用新的增量迁移。
4. 安装发布候选到新的时间戳目录，使用生产 Node 版本执行 `npm ci`、测试、类型检查和构建，不直接覆盖正在运行目录。
5. 配置生产 COS 和受限扫描运行时，保持 `PICKUP_DOCUMENTS_ENABLED=false`；完成存储与完整沙箱探针。
6. 原子切换 API 目录或 PM2 script 路径，重载 PM2；验证本机和公网健康、现有 TYG API、集成日志及核心仓库业务。
7. 给指定试点角色授予最小权限，再把功能开关改为 true，重载服务并执行一张合成提单的上传、预览、下载、撤权和拒绝用例。
8. 清理合成数据和对象，观察错误率、PM2 重启次数、MySQL/Redis、COS、扫描容器和 webhook 状态。
9. 修复 PM2 systemd 持久化并安排一次受控整机重启验收。整机恢复通过后才结束发布窗口。

## 回滚原则

- 功能级回退优先把 `PICKUP_DOCUMENTS_ENABLED` 设为 false 并重载 API；新增权限从试点角色撤回。
- 代码级回退恢复发布前目录和 PM2 dump，验证健康及集成日志/TYG 接口。不要以 `git pull` 代替文件级回退。
- 新迁移为增量结构，发布窗口内不自动删除表、列或权限目录。代码回退后保留新增结构；如确需数据库反向变更，必须基于发布前备份另行审批。
- 已保存的私有对象不因代码回退自动删除；按数据库记录与对象清单对账，避免形成不可追踪孤儿对象。

## 进入生产发布的最低证据

- 已合并且重新验收的发布候选提交 SHA。
- 生产迁移账本和待执行迁移 SHA-256 对照表。
- 生产受限扫描器、COS 权限与关闭开关启动探针全部通过。
- 生产备份路径、校验清单和可执行回滚命令已在发布窗口复核。
- 用户对生产发布给出明确授权。
