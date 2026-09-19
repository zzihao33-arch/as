# CM-HUB 接续摘要（2026-09-19）

当前任务：01a0bb83-cc47-7bf2-8a35-5ac17afe2f63。直接前序：标题「1」，ID 01a0bb46-d279-7091-a7fb-bb3b88fad51b。

## 当前状态

- 目标：CM-HUB 员工私有提货凭证上传、检查、授权读取/下载、PDF/图片查看。
- 测试业务验收、浏览器验收、合成数据清理及整机重启恢复验收均已完成。
- 后端 150/150、前端 48/48；18 份迁移校验、类型检查和构建通过。
- 生产未发布，功能保持关闭。Office 在线预览、转换 worker、公共司机入口延期，旧 `.xls` 拒绝保存。

## 版本与环境

- 分支 `codex/pickup-api-recovery`，原验收证据提交 `9bb0bb4`；本文件及整机重启证据在其后续提交中。
- 测试部署：后端 `16caa30`，前端/staging `4cfb6c3`。
- 测试主机 `tyg-api-test / ins-nm8jebfh`，数据库 `tyg_integration_test`，COS 前缀 `test`。
- 生产发布仍需明确授权。

## 整机重启恢复验收

- 重启前预检：`inv-w8uxmxg6sx`，退出码 0；boot ID `a9e10bc8-5d76-484d-9e03-c4d43a7a06c2`。
- 重启触发：`inv-x8uxqt03di`，仅操作 `ins-nm8jebfh`。
- 公网 API 经超时、502、503 后于 2026-09-19 21:30:11 UTC 恢复 200，随后连续 6 次为 200。
- 环境诊断：`inv-x8uxwagrc6`；新 boot ID `a2223083-5429-41b8-a020-db6dd2e2b8e8`，`Linger=yes`、状态 `lingering`。
- 最终验收：`inv-u8v00d06u3`，退出码 0；PM2、Nginx、用户级 Docker、固定扫描镜像、完整容器隔离探针、cgroup 限制、本机及公网健康检查全部通过。
- 首次重启后验收 `inv-v8uxu7ghj0` 的失败源于脚本误把 `.env` 配置当成必须直接注入 `/proc/<pid>/environ`；诊断确认应用按设计从 `.env` 加载，服务配置未漂移。

## 下一阶段

生产只读核查已经完成，详细结果见 `docs/CM-HUB-pickup-production-readiness-2026-09-19.md`。生产仍健康且未做任何改动，但当前不具备发布条件：实际布局为宝塔 Nginx、root PM2 和 `/www/wwwroot/cloud-api`；缺少新模块、两份提货凭证迁移、扫描运行时与 COS 配置；应用账号无权读取迁移账本；`pm2-undefined.service` 无效。

隔离候选 `codex/pickup-production-candidate` 已从 `ca05db3` 构造完成并推送，测试部署精确 SHA 为 `8023f306f1be1059ec8a68f5653e73b7ec677565`。集成日志和 TYG 修复得到保留；提货凭证迁移顺延为 019/020。本地前端 54/54、后端 221/221、20 份迁移校验、类型检查、构建、浏览器合成回归及扫描脚本语法检查均通过。

候选已在测试环境完成真实 API、恶意文件拒绝、权限、浏览器及整机重启重新验收：只读报告核验 `inv-v8v27f0mp8` 确认 62 项检查、5 个资产和 11 次上传路径；最终重启后核验 `inv-w8v2jtgkpj` 确认新 boot ID、精确 SHA、PM2、rootless Docker、固定镜像、完整隔离参数和公网健康。专用提单 `E2E1789858163890A` 的合成业务记录与 5 个对象仍保留，等待精确清理。

1. 清理本轮专用测试提单、客户、管理员、文档记录及 COS 对象，并保留安全审计。
2. 取得管理员迁移账本证据，确认生产 017/018 的文件名与 SHA-256；配置受限扫描运行时、独立生产 COS 前缀和有效 PM2 systemd 持久化。
3. 固化生产备份、增量迁移、原子切换和回退命令，并在关闭功能开关的状态下完成发布前演练。
4. 获得明确生产发布授权后部署、受控启用并完成生产业务验收和观察。

测试证据见 `docs/CM-HUB-pickup-acceptance-2026-09-19.md`；生产核查与发布门槛见 `docs/CM-HUB-pickup-production-readiness-2026-09-19.md`。账号凭据不写入文档。
