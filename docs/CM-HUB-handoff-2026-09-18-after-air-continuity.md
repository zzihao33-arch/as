# CM-HUB 任务1接续：空提列表连续性候选

当前候选提交 `6b22e89`，基于已发布 `8b89e0e`。本批完成客户组合筛选、跨页选择快照和批量目标完整读取，代码与测试已提交并推送到 `master` 与 `codex/integration-logs-release`。

验证结果见 `docs/operations/air-pickup-continuity-release-2026-09-18.md`。正式部署尚未产生新的 Vercel deployment，上一正式版本 `8b89e0e` 保持在线，回退目标为 `dpl_EfCaNEn3MXK2Ws5pnDPBic1eJVL7`。

继续工作时先检查 Vercel 是否已为 `6b22e89` 创建 READY 部署；部署后使用现有管理员会话验证客户＋关键词交集、翻页保留选择、批量窗口跨页目标和空页分页恢复，再更新本文件。不要把业务工作树中的迁移、worker、Office 预览或司机入口带入发布。
