# TYG 服务器实时查号（2026-09-25）

## 已实施

- 后端分支 `codex/tyg-live-scan-api`，提交 `74d996107f444de832cd16aa24f244ee15d3ac78`，工作区 `.worktrees/tyg-live-scan-continuation`，基线 `d01d8a08`。
- 前端分支 `codex/tyg-live-scan-ui`，提交 `233b556d2fc0423fa3ef7db6f3dfad9a126286ed`，工作区 `.worktrees/tyg-live-scan-ui`，基线 `cdf66367`；已快进推送 master 触发正式发布。
- 新接口 `GET /warehouse/v1/shipments/lookup?trackingNo=...` 需要有效会话、scan.use 权限及已选择仓库，响应 no-store。原/转单号查最新运单，无匹配返回 null，多票匹配或不可打印/面单失效均拒绝。
- 共享导入批次优先规则保留；共享批次未匹配时服务器实时查号，明确无匹配才尝试本机会话文件。网络/权限等错误不会回退浏览器旧云端映射。
- 扫码页不再调用单号库同步 hook，不等待浏览器同步整个映射。PDF 仍按需从自有云端读取，校验格式、长度、SHA-256；缓存读写不可用时可使用在线校验后的文件。
- 原/转单号并发以 shipmentId 锁定，近期重复需确认；打印前再次查号核对 version、两种单号、面单 ID 和 SHA。拦截检查覆盖两种单号，云端票不可因应急模式跳过实时拦截。

## 验证

- 后端 226/226 测试通过、21 个迁移检查通过、TypeScript 构建通过。
- 前端 51/51 测试通过、严格类型检查和生产构建通过。Vite 仍有原有大包提示。
- 新测试逐项先失败后通过：实时匹配、无本地索引、查询失败不回退、缓存不可用、重号、面单过期、原/转并发、下载中版本变更、同 PDF 转单号变更、重复重打确认。
- 独立 GPT-6 Astra 审查发现并修复：同 PDF 改转单号可能漏查新号拦截；IN + UNION 查询性能风险改为派生表限量后 JOIN。后者已通过真实 MySQL EXPLAIN 验证。
- 本地 Chrome 真页面显示“实时查号”和“本机面单”；不存在单号明确显示“服务器未找到该单号”；没有浏览器错误日志。验证未调用实体打印机。

## 生产后端发布证据

- 实例 `ins-dmx8z3xt`，应用 `/www/wwwroot/releases/cloud-api-b1c897a-20260920T170700Z`。
- 只读预检 `cmd-1lirbqse` / `inv-u94t820t3e`：原四个目标文件 SHA 与 d01d8a08 构建完全一致，MySQL 8.0.45，15957 票。
- 发布命令 `cmd-6it2p08i` / `inv-x94tcm0083`：2026-09-25 16:38:03–16:38:07 纽约时间，退出 0。
- 两个单号索引已添加。真实 EXPLAIN：原单号和转单号各用新索引 ref 查询，主表及面单表用 PRIMARY eq_ref；不扫描整个运单主表。
- `ZS20860104699` 原单号及其转单号返回同一有效 shipment；不存在的合成号码返回 null；服务健康通过；未登录 HTTP 查询返回 401。
- 仅增量更改四个源码/编译文件，不覆盖其他后端模块。原文件备份 `/root/tyg-live-scan-backup-qW7KcZ`。
- 发布脚本和校验清单位于后端分支 `deploy/apply-live-scan-patch.mjs`、`deploy/live-scan-patch.json`；代码更改后健康失败自动恢复。索引为附加结构，回退代码时可保留，不删除业务数据。

## 后续验收与兼容性

- 前端正式部署 `dpl_CXeKdX4x5TgEpj5wMWDVaqwQ1P12` 已 READY，cmhubtool.com 指向提交 233b556d。旧前端回退点 `dpl_9bQPqabemxjqJxMo7QXNqt1CEdzW`；后端旧同步接口保留，兼容旧页。
- 用户自行恢复生产 Chrome 登录后，正式扫码页显示“实时查号”，16:40:21 对合成不存在号码 `LIVE-SCAN-NONEXISTENT-20260925` 返回明确无匹配提示，浏览器错误日志为空。该测试只产生一条本机失败日志，没有触发实体打印；实际出纸仍须仓库现场确认。
- 预报 7956 与实际 7952 的 4 票差异不属于本次查号改造，仍需 TYG 对账。
- 后端和前端基线不同：后续前端重构须保留 233b556d，后端后续版本须包含 74d9961 和数据库迁移 021。不可用 master 的旧后端整体覆盖当前生产后端。
