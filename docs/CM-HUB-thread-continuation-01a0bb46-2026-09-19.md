# CM-HUB 接续摘要（2026-09-19，本轮已完成）

本任务 `01a0bb46-d279-7091-a7fb-bb3b88fad51b` 承接任务「1」`01a0ba50-f414-71c1-abd6-745f05a9b8e9`。后续先读本文和下方验收记录，无需重新加载旧任务全部工具日志。

## 工作位置

独立工作树 `C:/Users/ZIHAO ZHANG/.codex/worktrees/pickup-api-recovery/as`，分支 `codex/pickup-api-recovery`。原 pickup-documents-integration 工作树已消失，本轮从保留提交 729b044 恢复。主工作区 `C:/Users/ZIHAO ZHANG/Desktop/代码/as` 的既有业务修改未覆盖。

## 已完成

- 测试环境员工私有提货凭证集成与验收已完成。后端 `16caa30`，测试前端/staging `4cfb6c3`；后续证据提交仅推送工作分支，不触发重复部署。
- 修复列表分页 SQL（32e17ec）、UTC 上传租约（16caa30）、组件基础样式（4e519ce）和预览/维护弹窗层级（4cfb6c3）。
- 后端部署 https://github.com/zzihao33-arch/as/actions/runs/35467818039 成功；前端 Vercel 自动部署成功，测试域名已加载新资源并实际验证。
- 后端 150/150、前端 48/48 测试，18 份迁移文件校验、类型检查和构建通过。
- 真实员工 API 62 次请求验收通过：4 类文件上传下载与哈希、重放/去重、私有预览、撤权/恢复、匿名拒绝；损坏/伪装/加密/活动 PDF 和标准 EICAR 拒绝；旧 XLS 拒绝保存且后续正常上传可恢复。
- 浏览器 PNG 64×64 解码并位于最上层、PDF 渲染 1/1 页，实际选择并上传 PNG 显示“原件已保存”。Office 保持原件下载。
- 本次 E2E260919 客户和 E2E260919001 提单、7 个资产/私有对象、22 条上传记录已清理；临时员工与角色均删除；安全审计保留。TAT inv-u8ux4jg6wn 退出 0，记录剩余均 0，COS 逐一 404，无扫描容器残留，health 200。

## 环境和限制

仅测试主机 `tyg-api-test / ins-nm8jebfh`、库 `tyg_integration_test`、COS 前缀 `test`；测试 webhook 关闭。生产功能保持关闭，未操作生产主机。

API 用户 cmhub UID1001 已建立独立 rootless Docker，镜像固定为 sha256:7646609d5c8d1011d4e24169ef4b8ed73839c702967d74af9c51d05e111d0f51。CPU 控制器原未委托，现已在线应用 cpu/cpuset/io/memory/pids 委托及资源上限，完整参数探测与真实扫描通过。直接重启旧用户管理器曾触发 219/CGROUP，已恢复；不要重复失败方案。完整主机重启尚未验收，正式发布准备需覆盖这一项。

迁移台账19行，包含已有额外历史017_use_utc_label_expiry_default，当前18个仓库迁移校验通过。回退目录 /var/backups/cmhub-pickup-20260919-2018 含旧7f0e98c dist、0600环境副本和台账；旧基线自身有列表SQL故障，不是已验收替代版本。

Office 在线预览、转换 worker、公共司机入口仍延期；旧 .xls 继续失败关闭。下一阶段是正式发布准备/整机重启验证，不得自动启用生产。已有授权覆盖测试推送/部署/迁移/合成验收及清理；无需为相同测试工作重复索取授权。测试凭据不写进摘要或报告，用户已在本任务提供。

## 证据入口

- docs/CM-HUB-pickup-acceptance-2026-09-19.md：根因、发布、运行时、浏览器与清理证据和限制。
- docs/operations/cmhub-pickup-http-2026-09-19/http-acceptance.json：62 次脱敏请求状态和请求 ID。
- docs/operations/cmhub-pickup-http-2026-09-19/cleanup.json：清理摘要。
- docs/superpowers/plans/2026-09-19-cmhub-pickup-test-integration.md：本阶段完成清单。
- services/cloud-api/scripts/acceptPickupDocuments.mjs + createPickupHttpFixtures.py：可重跑测试工具，需新建专用 E2E 提单；旧默认提单已清理。
