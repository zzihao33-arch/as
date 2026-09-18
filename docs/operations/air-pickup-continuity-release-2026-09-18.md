# 空提列表连续性发布记录（2026-09-18）

本批候选提交：`6b22e89`（`fix: preserve air pickup selection across filtered pages`）。

## 范围

- 来源客户筛选通过 `clientId` 与提单号、状态、凭证状态取交集；空页总数由独立 COUNT 查询保留。
- 跨页选择保存完整记录快照；返回页面时刷新同一记录，改变筛选时清空选择。
- 批量入库和交仓打开前按选中 ID 读取完整目标并校验当前状态，批量表单不再依赖当前页数据。
- Mock API 与正式 HTTP API 使用相同的 `clientId` 查询参数。

## 验证

- 云端服务测试：65/65 通过。
- 前端测试：35/35 通过。
- 前端严格类型检查：通过。
- 物理工作树生产构建：通过；保留既有超过 500KB 的分包提示。
- `git diff --check`：通过。

## 发布状态

- `codex/integration-logs-release` 和 `master` 已推送至 `6b22e89`。
- 上一正式版本 `8b89e0e` 的回退部署仍为 `dpl_EfCaNEn3MXK2Ws5pnDPBic1eJVL7`。
- Vercel 尚未返回 `6b22e89` 的新部署记录；生产切换需在部署 READY 后再做管理员冒烟。
- 本批未修改数据库、worker、司机入口、Office 预览或测试环境。

真实普通账号撤权、扫码、打印和人工听音仍未覆盖。
