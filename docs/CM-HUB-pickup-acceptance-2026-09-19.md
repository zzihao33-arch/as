# CM-HUB 员工提货凭证测试验收（2026-09-19）

## 已验证范围

测试主机 `tyg-api-test / ins-nm8jebfh`；数据库 `tyg_integration_test`；私有 COS 前缀 `test`；API `https://api-test.cmhubtool.com`。本轮只操作测试环境，生产开关保持原有关闭状态，未发布生产。测试出站 webhook 关闭。

- 后端代码 `16caa30`：列表分页 SQL 修复 `32e17ec`，上传租约 UTC 比较修复 `16caa30`。
- 后端部署工作流 [35467818039](https://github.com/zzihao33-arch/as/actions/runs/35467818039) 成功。
- 前端样式修复 `4e519ce` / 层级修复 `4cfb6c3`：补齐凭证组件使用的 Arco 基础样式，避免按钮和预览弹窗未应用样式，并将预览及维护弹窗放在 TDesign 提货抽屉之上。
- API 自动验收通过，完整脱敏请求状态、请求 ID 与清理结果见 [HTTP 报告](operations/cmhub-pickup-http-2026-09-19/http-acceptance.json)。
- PDF、PNG、DOCX、XLSX 原件上传/下载成功；下载 SHA-256 与上传一致。PDF/PNG 预览 API 返回相同字节，`private, no-store` 与 `nosniff` 头通过。
- 同一上传重放返回原资产；多轮相同 PNG/DOCX/XLSX 内容去重。
- 临时员工撤权后列表、下载、上传均 403，恢复权限后下载 200；匿名读取 401。
- 损坏、伪装、加密 PDF、含 JavaScript 的活动 PDF、标准 EICAR 原始测试串均 422，状态 `FAILED_NOT_SAVED`。
- 旧 `.xls` 返回 503 `DOCUMENT_CHECK_UNAVAILABLE` 且未保存；随后正常 PDF 上传仍成功。
- Office 只提供原件下载；Office 在线预览、转换 worker 和公共司机入口仍延期。

## 回归与运行环境

后端 150/150 测试、18 份迁移文件校验、类型检查和构建通过；前端 48/48 测试、严格类型检查和构建通过。后端回归使用 SQL 引擎复现分页语法错误，以及数据库时区 +8 时误拒有效租约、-8 时误放过过期租约；先观察失败，再验证修复。关闭功能的测试使用不可访问数据库/存储代理，证明开关关闭后不访问未迁移的文档存储。真实部署保持开关开启供上述业务验收；未以线上切换开关替代该隔离回归。

远端台账为 19 行，其中含已有历史 `017_use_utc_label_expiry_default`；当前仓库 18 个迁移校验通过，未改写历史台账。

API 用户 `cmhub`（UID 1001）使用独立 rootless Docker，固定镜像摘要 `sha256:7646609d5c8d1011d4e24169ef4b8ed73839c702967d74af9c51d05e111d0f51`。未向 API 用户开放 rootful Docker 或其他用户的 socket。该镜像从已验收用户的同一不可变镜像流式载入。

主机原先仅向用户委托 memory/pids，容器 `--cpus=1` 因缺少 `cpu.max` 无法启动。当前 `/etc/systemd/system/user@1001.service.d/90-cmhub-document-cpu.conf` 委托 cpu/cpuset/io/memory/pids，并配置 CPUQuota=400%、MemoryMax=8G、TasksMax=512。旧用户管理器直接重启曾出现 219/CGROUP / resource busy，已恢复，再通过 daemon-reload 和运行时资源属性在线应用成功；不要照抄失败的重启操作。整机重启恢复验收见下文。

真实 API 环境的完整容器参数探测退出 0（TAT `inv-u8uwh9gr5p`），随后完整上传扫描成功。每个扫描容器继续限制为非特权 UID 65532、无网络、只读根文件系统、全部 capabilities 移除、2 GiB 内存、1 CPU、64 PID、256 MiB 临时盘。

## 回退与测试数据

修复前回退目录 `/var/backups/cmhub-pickup-20260919-2018` 权限 0700，含原 `7f0e98c` 对应 dist、0600 环境文件副本与迁移摘要。旧版本本身存在列表 SQL 故障，因此该回退点用于应急恢复基线，不能当成业务验收通过版本。新增迁移保持向后兼容，未做破坏性回退。

合成提单 `E2E260919001` 与客户 `E2E260919` 专用于本次验收；临时员工账号和角色已由每轮脚本 finally 清理，安全审计按设计保留。业务记录及对象清理已完成，见下方收尾结果。

首次 EICAR 用例把测试串追加到完整 PDF 末尾，不能作为标准 EICAR 阳性样本，该用例的预期无效。正式通过报告改用标准原始 EICAR 测试串，并独立验证正确构造的活动 PDF；初次额外保存的合成 PDF 也纳入按提单清理。

## 重跑方法

从 `services/cloud-api` 运行 `python scripts/createPickupHttpFixtures.py`（需要 pypdf、Pillow、python-docx、openpyxl），准备新建的专用 E2E 提单，再设置 `CMHUB_TEST_ORDER_ID`、`CMHUB_TEST_BILL_NO`（E2E 前缀）、`CMHUB_TEST_LOGIN`、`CMHUB_TEST_PASSWORD`，运行 `node scripts/acceptPickupDocuments.mjs`。可用 `CMHUB_ACCEPT_OUTPUT` 指定报告。密码仅从进程环境读取，不写入报告；运行后清除进程环境变量。脚本只连接固定测试 API，保留文档供浏览器验证，测试完成后需按该次精确提单 ID 清理业务记录和对象。

运行配置参考：[Docker rootless 资源限制说明](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources)。

## 浏览器验证

测试域名已加载 `4cfb6c3` 的发布资源（入口 `index-BVkHcnWB.js`）。PNG 图片 `complete=true`，原始尺寸 64×64；图片中心的最上层命中元素为 IMG，预览 wrapper 的 z-index 为 1601，确认没有被 TDesign 抽屉遮挡。Chrome PDF 查看器已显示页数 1/1 及单页缩略图。Office 行显示“请下载原件查看”。

浏览器实际选择本地合成 PNG 并点击“上传 1 份文件”，最终显示“原件已保存”，同内容去重没有增加资产数；完成提示已关闭。

## 收尾结果

2026-09-19 21:07:51 UTC，TAT `inv-u8ux4jg6wn` 成功（退出码 0）：删除本次 1 条提单、1 条客户档案、7 条文档资产及其预览、22 条上传登记及对应操作、7 个私有 COS 对象；对象删除后逐一确认 404。本次订单/客户/资产/上传记录剩余均为 0。清理只使用精确 ID，并先断言没有关联货件、历史资产、入库/交仓批次、其他客户提单或处理中上传。安全审计保留。

API 用户的 `docker ps -a --filter name=cmhub-document-` 输出为空；最终健康检查 HTTP 200，`ok=true`、`outboundWebhooks.enabled=false`。清理摘要见 [cleanup.json](operations/cmhub-pickup-http-2026-09-19/cleanup.json)。测试阶段已完成；生产未发布。

## 整机重启恢复验收

2026-09-19 21:26:24 UTC，重启前严格预检 TAT `inv-w8uxmxg6sx` 成功（退出码 0）。预检确认实例为 `ins-nm8jebfh`，boot ID `a9e10bc8-5d76-484d-9e03-c4d43a7a06c2`；Nginx、`pm2-cmhub.service`、`user@1001.service`、cmhub 用户级 Docker 均已启用且运行；固定扫描镜像存在；真实 API 进程在线；完整无网络、只读根文件系统、非特权用户、capabilities 全移除、2 GiB/1 CPU/64 PID/256 MiB tmpfs 的 Docker 探针退出 0；本机及公网健康检查通过。

整机重启由 TAT `inv-x8uxqt03di` 仅在 `ins-nm8jebfh` 上延迟触发。公网监测从 21:29:42 UTC 开始观察到超时，随后经历 502、503，并于 21:30:11 UTC 恢复 HTTP 200；之后连续 6 次检查均为 HTTP 200，响应保持 `ok=true`、`outboundWebhooks.enabled=false`。

重启后环境诊断 TAT `inv-x8uxwagrc6` 显示新 boot ID `a2223083-5429-41b8-a020-db6dd2e2b8e8`，`Linger=yes`、状态 `lingering`，`pm2-cmhub.service`、`user@1001.service` 和用户级 Docker 自动恢复。第一次重启后验收 `inv-v8uxu7ghj0` 因脚本错误地要求功能开关直接存在于 `/proc/<pid>/environ` 而退出 1；诊断确认应用按设计从服务目录 `.env` 加载这些值，运行服务没有配置漂移。

2026-09-19 21:37:31 UTC，修正后的最终验收 TAT `inv-u8v00d06u3` 成功（退出码 0）。新旧 boot ID 不同，重启后 uptime 456 秒；PM2 进程在线（PID 1718）；运行环境的 HOME、USER、XDG_RUNTIME_DIR 正确；`.env` 中提货凭证开关开启、测试环境和 webhook 关闭、扫描镜像摘要固定；使用真实 API 进程环境执行完整隔离 Docker 探针通过。cgroup 的 cpu/cpuset/io/memory/pids 委托、CPUQuota=400%、MemoryMax=8G、TasksMax=512 均恢复；没有扫描容器残留；本机与公网健康检查通过。

测试阶段及整机重启恢复验收均已完成；生产仍未发布。

## 生产基线候选重新验收

从生产补丁 `ca05db3` 构造的隔离候选 `codex/pickup-production-candidate` 已以精确 SHA `8023f306f1be1059ec8a68f5653e73b7ec677565` 重新部署到同一测试实例。测试迁移账本先核对旧 017/018 提货迁移与新 019/020 的 SHA-256 完全一致，再由 `inv-w8v1ahgsup` 只登记新文件名别名，没有重放结构 SQL。部署记录为 `inv-x8v1idg2g6`，包含后端 221/221、类型检查、20 份迁移校验、构建、迁移、PM2 reload 和健康检查。

完整 HTTP 验收报告保存在测试主机 `/tmp/cmhub-candidate-accept-20260919T224921Z/http-acceptance.json`。实际验收 `inv-u8v23qg7r7` 完成 62 项请求并返回 `passed=true`；包装器仅因把脚本设计的 5 个保留资产误写为 7 而退出 1。随后只读核验 `inv-v8v27f0mp8` 退出 0，确认 62 项检查、5 个资产、11 次上传路径、数据库记录、临时账号与角色清理、无残留扫描容器及公网健康一致。四类外部文件由固定扫描镜像内置的 `pikepdf`、Pillow 和 LibreOffice 在无网络、只读根文件系统及资源限制下生成，宿主机未安装软件。

浏览器检索专用提单 `E2E1789858163890A` 后，凭证面板显示 5 份原件；PDF 阅读器成功显示 1/1 页，PNG 显示 64×64 图块，DOCX/XLSX 显示“请下载原件查看”。重启前预检 `inv-v8v2aw03qe`、测试实例重启 `inv-v8v2cvgnsw`、最终重启后严格核验 `inv-w8v2jtgkpj` 均完成；boot ID 从 `a2223083-5429-41b8-a020-db6dd2e2b8e8` 变为 `6da7c675-86c7-4842-9047-bce289b4dc6a`。公网短暂 503 后恢复并连续六次 200，PM2、rootless Docker、固定镜像、五类 cgroup 委托和完整容器隔离探针全部通过。重启后浏览器仍能查询该提单和 5 份凭证。

本轮合成数据已按精确 ID 清理完成。首次清理 `inv-x8v34c0ain` 先删除 5 个 COS 对象，随后因 MySQL `execute` 不会把数组展开到单个 `IN (?)` 占位符而触发操作账本删除数量断言；数据库事务完整回滚。只读诊断 `inv-u8v38u0m2x` 随后确认订单、客户、管理员、5 个资产、5 个预览、11 条上传、11 条操作、5 条订单事件、1 条客户事件、1 条成员关系和 1 条会话仍完整，5 个对象均已返回不存在，服务健康。

修正后的精确清理 `inv-x8v3aughkn` 使用 11 个显式占位符完成并提交数据库删除；命令只在提交后的证据查询中因引用不存在的 `event_metadata` 列而返回 1，没有回滚已提交事务。最终只读核验 `inv-x8v3cu0kji` 退出 0：订单、客户、管理员、资产、上传、订单/客户事件、成员关系、会话、文档操作和订单操作均为 0；9 条安全审计记录按 `actor_reference` 完整保留且 `actor_user_id` 已置空，审计表总数为 94；扫描容器为空，公网健康返回 `ok=true`、`outboundWebhooks.enabled=false`。Chrome 再次检索 `E2E1789858163890A` 显示“暂无提货单”。生产仍未发布。
