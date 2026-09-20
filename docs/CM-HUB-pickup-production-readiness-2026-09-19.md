# CM-HUB 员工提货凭证生产发布准备（2026-09-19）

## 结论

生产发布已经完成。生产实例 `air-cargo-server / ins-dmx8z3xt` 现运行候选 `b1c897a`，发布目录为 `/www/wwwroot/releases/cloud-api-b1c897a-20260920T170700Z`，运行时为 Node.js 22.23.2；提货凭证开关、COS `production/*` 存储和固定摘要扫描镜像均已启用。1,212 个数据库引用的历史对象已迁移并逐对象校验，019/020 已登记，PM2、宝塔 Nginx、rootless Docker 和公网健康均通过受控重启恢复验证。最终公网健康为 HTTP 200、`ok=true`、`outboundWebhooks.enabled=false`。

最终检查发现 019/020 新表缺少 `cmhub_api` 的 MySQL 运行时权限，导致一次重启后的候选进程未监听 8080，公网短暂返回 502。已通过宝塔本机 root-only 解密通道应用逐表最小权限，未读取、打印或落盘数据库管理员密码；随后重启应用并完成整机重启验收。此次发布没有修改任何密码。

原提货凭证分支不能直接覆盖生产：生产最新补丁 `ca05db3` 与提货凭证验收提交 `9bb0bb4` 从 `0ff404d` 分叉，生产线包含集成日志和 TYG 修复，而提货凭证线不包含这些提交。直接部署 `9bb0bb4` 会删除或回退已上线的集成日志功能。现已从 `ca05db3` 建立隔离候选分支 `codex/pickup-production-candidate`，只叠加 `655956e` 起的提货凭证功能与修复，并保留生产集成日志代码。

## 只读核查证据

目标为生产实例 `air-cargo-server / ins-dmx8z3xt`。所有命令均通过腾讯云 TAT 只读执行。

- `inv-u8v06cg8it`：确认原先假设的 `/opt/cmhub-api` 和 `cmhub` 用户不适用于生产。
- `inv-w8v08bg171`：定位实际运行布局、监听端口、进程、仓库和基础健康状态。
- `inv-v8v0a60g85`：核对部署文件、同步仓库版本、非敏感配置、数据库对象可见性和 Nginx 配置。
- `inv-u8v0ca0qg3`：核对 PM2 运行状态、最近发布清单、数据库权限、启动持久化和最终健康状态。

审计期间没有读取或记录密码、密钥、令牌等敏感值。

## 发布前生产现状（归档）

- API 由 root 的 PM2 运行，进程命令为 `node /www/wwwroot/cloud-api/dist/index.js`，监听 `127.0.0.1:8080`。
- 当前线上 Node 可执行文件仍为 `/www/server/nodejs/v20.10.0/bin/node`；Node.js 22.23.2 已独立安装到 `/opt/node-v22.23.2-linux-x64`，稳定入口为 `/opt/node22`，尚未切换线上进程。
- Nginx 由宝塔目录 `/www/server/nginx/sbin/nginx` 运行，不受发行版 `nginx.service` 管理。
- 同步仓库位于 `/opt/cmhub-github-sync/as`，`master` 干净，HEAD 为 `27d2a243`；实际部署目录不是该 Git 工作树。
- 最近生产发布清单为 `/root/cmhub-push-logs-20260917-ca05db3/release-manifest.json`，记录补丁提交 `ca05db3` 和备份目录 `/root/cmhub-push-logs-20260917-ca05db3/backup-2026-09-17T14-02-13-505Z`。
- 实际部署缺少 `dist/pickupDocuments.js`、`dist/pickupDocumentSandbox.js` 和 `dist/pickupDocumentsHttp.js`。
- 生产已安装 Docker CE 29.8.1，并以 `cmhub` UID 1004 运行 rootless daemon；rootful Docker、containerd 服务仍保持 masked。固定扫描镜像为 `sha256:fa29284f4c743a2b9c599029ac1882fe06aa645f90199b2b33046d4a029df8e8`。
- `PICKUP_DOCUMENTS_ENABLED` 与 `LABEL_STORAGE_BACKEND=cos` 当前仍未启用；生产 `.env` 已预置 COS bucket、region、`production` 前缀、最终最小权限凭据及固定扫描镜像摘要，但尚未重载线上进程。生产 `OUTBOUND_WEBHOOK_ENABLED=false`。
- 应用数据库账号不能读取 `schema_migrations`，返回 `ER_TABLEACCESS_DENIED_ERROR`；已通过宝塔本机 root-only 解密通道只在内存中取得数据库管理凭据并读取迁移账本，未输出或保存密码。
- 可见业务表中只有旧表 `air_pickup_document_assets`；没有 `warehouse_ui_operations`，也没有新的提货凭证权限。
- 已建立并启用 `/etc/systemd/system/pm2-root.service`，保存 root PM2 dump；无效的 `pm2-undefined.service` 已备份后删除。当前应用 PID 未因该修复改变；整机重启恢复仍待受控验证。

## 发布前阻断项（均已解除）

1. **完成受控发布切换。** 生产 017/018 已核对，019/020 尚未应用；必须在已验证备份基础上应用增量结构、安装候选到新目录，并用 `/opt/node22/bin/node` 原子切换 PM2。功能开关先保持关闭。
2. **迁移共享文件存储。** 现网共有 1,212 个数据库引用的私有文件、67,874,066 字节，全部存在且路径安全；共享存储后端从文件系统切到 COS 前必须先把这些对象迁移到 `production/*`，停机窗口内补传增量并完成逐对象校验，避免历史标签和考勤图片失联。
3. **完成功能验收与重启恢复。** 代码和存储切换健康后，再启用提货凭证并执行合成上传/预览/拒绝/撤权测试；最后受控重启主机，验证 PM2、rootless Docker、Nginx 和公网健康恢复。

候选重新验收、COS 权限、Node 22 门禁、扫描运行时、迁移账本、PM2 单元、生产切换和恢复验收均已完成。以下内容保留为发布前决策记录。

## 2026-09-20 状态刷新

- 14:56:38 UTC 对 `https://api.cmhubtool.com/healthz` 发起公开只读 GET，HTTP 200，返回 `ok=true`、`outboundWebhooks.enabled=false`。
- 本地发布代码仍为候选分支提交 `b1c897ab0499d863b5c269f0dc1e22c126a48850`，并已确认与 `origin/codex/pickup-production-candidate` 一致；工作区仅有本报告的未提交更新。
- 再次核对测试部署工作流及 `deploy-test-api.sh`：测试目前使用 bucket 名 `cmhub-labels-prod-1476409815` 和 `COS_PREFIX=test`。生产需使用明确的独立前缀（建议 `production`）及生产专用最小权限凭据；需由云管理员证明测试凭据无法访问生产前缀、生产凭据无法写入测试前缀。仅使用不同前缀字符串不足以证明权限隔离。
- CVM 实例列表已确认 `rid=22` 实际为弗吉尼亚，测试机 `ins-nm8jebfh` 与生产机 `ins-dmx8z3xt` 均位于 Virginia Zone 1；先前 TAT 首屏显示广州是控制台地域状态未同步完成，不代表实例迁移或 `rid=22` 属于广州。
- 15:29:17 UTC 仅在生产实例运行既有只读基线命令，TAT `inv-u8vxd6g5vb` 退出 0。生产仍运行 `/www/server/nodejs/v20.10.0/bin/node /www/wwwroot/cloud-api/dist/index.js`；当前发布清单仍为 `ca05db3`，应用数据库账号仍无权读取迁移账本，可见业务结构仍只有旧 `air_pickup_document_assets`，没有新操作表或凭证权限；`pm2-undefined.service` 仍 enabled/inactive 且 `User=undefined`。内外网健康均为 `ok=true`、Webhook 关闭。
- 15:31:42 UTC 运行新建的只读运行环境预检 `cmhub-prod-runtime-preflight-readonly-20260920`，TAT `inv-w8vxff0exr` 退出 0。主机为 Ubuntu 22.04.5、Linux 5.15、cgroup v2；根卷 50 GB，约 35 GB 可用；内存 15 GiB，约 12 GiB 可用，无 swap。主机有 Node 20.10.0（宝塔路径）与系统 Node 18.20.8，但没有 `cmhub` 用户、Docker/Podman、dockerd、rootlesskit、rootless 安装工具或 `newuidmap/newgidmap`。扫描运行时仍需完整安装和隔离配置。
- COS 初始只读核查确认 bucket `cmhub-labels-prod-1476409815` 位于 `na-ashburn`，ACL 为私有读写；测试子账号 `cmhub_test_cos` 的 `CMHubTestCosPrefixAccess` 只允许 bucket 级 `cos:HeadBucket`，以及 `test/*` 下的对象读写删除。
- 获得明确授权后创建生产子账号 `cmhub_prod_cos` 和自定义策略 `CMHubProdCosPrefixAccess`。最终状态为仅一把启用密钥、没有停用密钥，且该用户已关联生产策略。两把在配置过程中进入可见控制台输出的临时密钥均在投入使用前停用并永久删除。
- 最终凭据通过关闭终端回显和 shell 历史写入 `/www/wwwroot/cloud-api/.env`；文件保持 `0600 root:root`，只记录五个 COS 配置键，凭据值未写入仓库或报告。没有设置 `LABEL_STORAGE_BACKEND=cos`，没有重启 PM2，因此当前运行进程行为未改变。
- 使用最终凭据运行一次性 COS 探针：`HeadBucket` 通过，`production/*` 写入、读取和删除通过，向 `test/*` 写入返回拒绝。探针对象均已删除。随后公网健康检查仍返回 `ok=true`、`outboundWebhooks.enabled=false`。
- 在生产主机的隔离工作树 `/root/cmhub-node20-compat-20260920T163041Z` 对精确候选提交运行 Node 20.10.0 验证。根项目安装、测试、类型检查、构建以及后端安装、类型检查、构建均能完成，但后端测试为 140/145：`airPickupOperations.test.js`、`labelRetention.test.js`、`pickupDocuments.test.js`、`tygReleaseScope.test.js`、`warehouseOperations.test.js` 均因 Node 20 不提供 `node:sqlite` 而失败。日志位于 `/root/cmhub-node20-compat-20260920T163041Z.log`。初始包装命令因使用分号继续执行并取最后构建步骤的退出码而打印了错误的 `PASS`；逐项日志和失败计数已纠正该结论，后续门禁必须使用失败即停止的串联方式。
- 从 Node.js 官方归档安装并校验 Node.js 22.23.2 到 `/opt/node-v22.23.2-linux-x64`，未替换系统 Node 或现行宝塔 Node。精确候选 `b1c897a` 在 `/root/cmhub-node22-compat-20260920T163509Z` 使用 Node 22 以失败即停止的命令重新执行根项目和后端的安装、测试、类型检查及构建；后端 221/221、20 份迁移校验及全部构建通过，日志为 `/root/cmhub-node22-compat-20260920T163509Z.log`。
- 生产安装 Docker CE 29.8.1、Docker CLI、rootless extras、containerd 2.3.5、UID 映射及 rootless 依赖；rootful 单元保持 masked。为 `cmhub` UID 1004 配置 linger、`cpu cpuset io memory pids` 委托、`CPUQuota=400%`、`MemoryMax=8G`、`TasksMax=512`，rootless daemon 在 `/run/user/1004/docker.sock` 运行。安装日志为 `/root/cmhub-rootless-install-20260920T163859Z.log`。
- 在生产从精确候选的 Dockerfile 独立构建扫描镜像 `sha256:fa29284f4c743a2b9c599029ac1882fe06aa645f90199b2b33046d4a029df8e8`，构建日志为 `/root/cmhub-checker-build-20260920T164829Z.log`。真实验收脚本在 rootless、无网络、只读根文件系统、非特权 UID、capabilities 全移除及资源限制下通过安全 PNG、EICAR 拒绝和旧 XLS 关闭失败三项用例；无残留扫描容器，日志为 `/root/cmhub-checker-probe-20260920T165133Z.log`。
- 修复 root PM2 持久化：新建并启用 `pm2-root.service`，以显式 Node 20 路径 resurrect 保存的 `/root/.pm2/dump.pm2`；旧 `pm2-undefined.service` 备份为 `/root/pm2-undefined.service.20260920T165323Z.bak` 后删除。修复过程未重启应用，PID 保持 `2538416`，内外网健康均正常。
- 通过宝塔 `public.M('config')` 的本机解密路径把 MySQL root 凭据只放入子进程内存，完整读取生产 `schema_migrations`。001–018 均已登记；017 文件哈希为 `D07DD7E456105D1F4F219CA1FB9B7811D4BEC7E2649210B7B6BEA759FE4393DF`，018 为 `045062620C5F335A6FD99E25A769D2C0B2B73746CB2D0D555569503805A89987`，与候选一致。凭据没有写入命令行、日志或报告。
- 发布前全库备份 `/root/cmhub-prod-backup-20260920T165914Z/cmhub.sql.gz` 已通过 gzip 完整性检查，大小 4,949,916 字节，SHA-256 为 `CDBEE435B76959ED23662FA3925DFA1E483338EEFA0EC64E7D28D545C2E1C0A1`，目录 0700、文件 0600。一次未压缩却使用 `.gz` 后缀的临时产物已识别并删除，没有用于回滚。
- 存储切换前枚举生产所有 `storage_key` 引用：4 个交接凭证、104 个考勤图片、1,104 个标签资产，共 1,212 个唯一对象、67,874,066 字节；没有不安全路径、缺失文件或标签大小不一致。文件系统总计 13,327 个文件、654,685,856 字节，未被数据库引用的历史文件暂不作为切换可达性依据。
- 页面访问公开健康端点被浏览器扩展拦截，随后通过 PowerShell 的只读 HTTP GET 成功；没有尝试绕过拦截。

### 生产发布完成记录

- 1,212 个数据库引用对象、67,874,066 字节已迁移到 COS `production/*`，并逐对象下载核对大小与 SHA-256；日志 `/root/cmhub-cos-migration-20260920.log` 结论为 `PASS`。
- 发布前全库备份为 `/root/cmhub-prod-backup-20260920T165914Z/cmhub.sql.gz`，大小 4,949,916 字节，SHA-256 为 `CDBEE435B76959ED23662FA3925DFA1E483338EEFA0EC64E7D28D545C2E1C0A1`。发布文件备份位于 `/root/cmhub-prod-release-20260920T170700Z`。
- 019/020 已应用并登记；候选安装到 `/www/wwwroot/releases/cloud-api-b1c897a-20260920T170700Z`，PM2 使用 `/opt/node22/bin/node` 启动该目录，随后保存新的 dump。
- 生产配置已启用 `PICKUP_DOCUMENTS_ENABLED=true`、`LABEL_STORAGE_BACKEND=cos`、`COS_PREFIX=production` 和 `DOCKER_HOST=unix:///run/user/1004/docker.sock`；扫描镜像固定为 `sha256:fa29284f4c743a2b9c599029ac1882fe06aa645f90199b2b33046d4a029df8e8`。
- 首次最终核验发现应用启动检查无权读取 `warehouse_ui_operations`。TAT `inv-v8w36c08cg` 通过宝塔本机解密通道应用最小数据库权限并重启应用，确认五张新表分别只有运行所需的 `SELECT`、`INSERT`、`UPDATE` 权限；本机与公网健康均恢复，PID 为 `3570870`。
- 重启前最终门禁 TAT `inv-x8w37hgphf` 退出 0：配置、Node 22、发布目录、PM2 dump、宝塔 Nginx、rootless Docker、固定扫描镜像、无残留扫描容器及内外网健康全部通过；boot ID 为 `ecc4998a-77b6-4c25-9ed3-acd53096e1ec`。
- 受控重启 TAT `inv-u8w38fg9x4` 退出 0。公网依次出现连接失败、502、503，随后于 2026-09-20 17:41:31 UTC 恢复 HTTP 200。
- 重启后最终门禁 TAT `inv-u8w39w00xa` 退出 0；boot ID 变为 `9a4cf104-c617-490c-92d4-30ffec7a694c`，进程 PID 为 `2372`。PM2、宝塔 Nginx、rootless Docker、扫描镜像、COS 配置、功能开关以及内外网健康均自动恢复。
- 两把曾进入可见控制台输出的临时 COS 密钥已永久删除；最终生产密钥仍只有一把启用。没有修改任何数据库、系统或业务账号密码。

### 已实施的生产 COS 最小权限方案

已新建独立子账号 `cmhub_prod_cos`，只关联策略 `CMHubProdCosPrefixAccess`。策略沿用已验证的测试策略形状，仅把对象资源收紧到 `production/*`：

```json
{
  "statement": [
    {
      "action": ["cos:HeadBucket"],
      "effect": "allow",
      "resource": ["qcs::cos:na-ashburn:uid/1476409815:cmhub-labels-prod-1476409815/*"]
    },
    {
      "action": ["cos:GetObject", "cos:HeadObject", "cos:PutObject", "cos:DeleteObject"],
      "effect": "allow",
      "resource": ["qcs::cos:na-ashburn:uid/1476409815:cmhub-labels-prod-1476409815/production/*"]
    }
  ],
  "version": "2.0"
}
```

不授予列出整个 bucket、修改 ACL/策略、跨前缀读取或任何公共访问权限。实测生产凭据可以完成 `production/*` 对象写入、读取和删除，不能写入 `test/*`；最终密钥只写入生产主机受限环境文件，不进入仓库或发布报告。

## 发布候选构造

发布候选从 `ca05db3` 建立，合并提货凭证验收线，并满足以下要求：

- 保留 `services/cloud-api/src/integrationLogs.ts`、集成日志页面、通知逻辑、验证脚本和相关测试。
- 合并共享文件中的两组行为，重点包括 `config.ts`、`index.ts`、`warehouseAccess.ts`、`warehouseHttp.ts`、会话提供器和提货页面。
- 保持生产线现有 `017_use_utc_label_expiry_default.sql` 和 `018_add_integration_push_logs.sql`；提货凭证迁移已顺延为 `019_add_warehouse_ui_operations.sql` 和 `020_add_pickup_documents.sql`。仍需管理员账本证据确认生产 017/018 与仓库校验和一致。
- 构建结果必须包含提货凭证三个运行模块，同时保留生产集成日志模块。
- 后端、前端、迁移校验、类型检查和构建全部通过；随后把该候选部署到测试环境重新执行 API、浏览器、恶意文件拒绝、权限和整机重启验收。

## 本地候选验证结果

候选代码合并点为 `fa32f91`。该提交之前的生产功能基线为 `ca05db3`，提货凭证功能、扫描器和后续修复均位于二者之间。

- 前端单元回归 54/54 通过；严格类型检查和生产构建通过。
- 后端单元回归 221/221 通过；20 份迁移校验、严格类型检查和构建通过。
- 浏览器合成回归通过：Office 仅下载、图片预览、上传响应丢失后的原编号查询、权限恢复、功能关闭，以及桌面/移动布局。
- Python 沙箱脚本语法编译、Node 验收脚本语法检查通过。
- 迁移 SHA-256：017 `D07DD7E456105D1F4F219CA1FB9B7811D4BEC7E2649210B7B6BEA759FE4393DF`；018 `045062620C5F335A6FD99E25A769D2C0B2B73746CB2D0D555569503805A89987`；019 `78D42E640103B9E42ECB405CEE04CB3DF42A5F367282A643C0E1E6E25148C8B6`；020 `1CEC418B52AFDB6DB37866DBC45778D3B23A363DD3A67E066041797FDA8659CB`。

这些结果验证了代码组合，但不替代测试主机上的真实 MySQL、COS、扫描器和重启验收。

## 测试环境候选重新验收

候选精确提交 `8023f306f1be1059ec8a68f5653e73b7ec677565` 已推送至 `origin/codex/pickup-production-candidate` 并部署到 `tyg-api-test / ins-nm8jebfh`。生产环境没有任何写入。

- `inv-v8v165g31b` 只读核对测试迁移账本；旧名 `017_add_warehouse_ui_operations.sql`、`018_add_pickup_documents.sql` 的哈希分别与候选 019/020 完全一致。
- `inv-w8v1ahgsup` 在严格断言旧哈希、五张提货凭证表及四项权限后，仅登记 019/020 新文件名别名，没有重放 SQL；UTC 017 和集成日志 018 的候选哈希也已核对。
- `inv-x8v1idg2g6` 从已验证的 `FETCH_HEAD` 建立候选分支并部署精确 SHA；远端完成依赖安装、后端 221/221、类型检查、迁移校验、构建、增量迁移、PM2 reload 及内外网健康检查。先前 `inv-x8v1fp0jpr` 只因测试仓库为 single-branch 克隆而在 checkout 前停止，没有代码、进程或数据库变更。
- `inv-u8v1pfghkg` 已确认精确提交、018/019/020 哈希、八张集成/提货表、五项相关权限、测试数据库、PM2 在线及 webhook 关闭；命令最后只因宿主机没有 `pypdf` 返回 1。
- 固定扫描镜像使用镜像内已有的 `pikepdf`、Pillow 和 LibreOffice，在无网络、只读根文件系统、capabilities 全移除及资源限制下生成 PDF、PNG、DOCX、XLSX 测试文件，无需安装宿主机软件。
- `inv-u8v23qg7r7` 的 HTTP 报告本身为 `passed=true`，62 项请求全部完成；外层包装器把设计上的 5 个保留资产误写成 7，故最终退出 1。只读复核 `inv-v8v27f0mp8` 退出 0，确认 62 项检查、5 个资产、11 次上传路径、数据库记录、临时账号/角色清理、无残留扫描容器及健康检查全部一致。
- Chrome 实际界面可检索专用提单 `E2E1789858163890A`，凭证面板显示 PDF、PNG、DOCX、XLSX 与拒绝后恢复 PDF 共 5 份；PDF 阅读器显示 1/1 页，PNG 显示 64×64 蓝绿色图块，Office 文件只提供原件下载。
- 重启前预检 `inv-v8v2aw03qe` 退出 0；`inv-v8v2cvgnsw` 仅调度测试实例重启。公网于 22:59:36 UTC 返回 503，22:59:41 UTC 起连续六次恢复 200。
- 只读诊断 `inv-x8v2i50rih` 确认 boot ID 从 `a2223083-5429-41b8-a020-db6dd2e2b8e8` 变为 `6da7c675-86c7-4842-9047-bce289b4dc6a`，提交 SHA 不变；PM2、Linger、五类 cgroup 委托、Docker 29.8.1、固定镜像及四项环境开关均恢复。最终严格核验 `inv-w8v2jtgkpj` 退出 0，并通过完整无网络、只读根文件系统、非特权 UID、capabilities 全移除、2 GiB/1 CPU/64 PID/256 MiB tmpfs 探针。
- 重启后浏览器会话恢复，专用提单与 5 份凭证仍可查询。随后按精确 ID 完成收尾：`inv-x8v34c0ain` 删除 5 个 COS 对象后因 `IN (?)` 数组占位问题回滚数据库事务，`inv-u8v38u0m2x` 只读确认数据库记录完整且对象均不存在；修正命令 `inv-x8v3aughkn` 提交全部数据库删除，最终只读核验 `inv-x8v3cu0kji` 退出 0。订单、客户、管理员、资产、上传、事件、成员关系、会话及相关操作均为 0，9 条安全审计记录保留并与已删除账号解绑，扫描容器为空，公网健康正常；Chrome 检索该提单显示“暂无提货单”。

## 生产执行顺序

获得生产发布授权后，按以下顺序执行；任何一步失败都停止，不启用功能。

1. 再次记录生产健康、进程、监听、Nginx 配置测试、磁盘空间和当前发布清单。
2. 以时间戳目录备份 `/www/wwwroot/cloud-api`、PM2 dump、非敏感配置键名、Nginx 相关配置和迁移账本；生成 SHA-256 清单并设为仅 root 可读。
3. 由数据库管理员备份受影响表和迁移账本，核对迁移文件校验和；先执行仅结构检查，再应用新的增量迁移。
4. 安装发布候选到新的时间戳目录，使用已验收的 Node 22+ 执行 `npm ci`、测试、类型检查和构建，并确保任何一步失败都中止；不直接覆盖正在运行目录。
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
