# CM-HUB 仓库工作台 API

该接口只供 CM-HUB 第一方网页使用，生产基址为 `https://api.cmhubtool.com/warehouse/v1`。它与上游客户使用的 `/api/v1` 完全分离；浏览器不得保存或发送上游 `X-API-Key`。

## 核心约定

- 内部用户使用全局唯一的 `loginName + password` 登录，不再使用“仓库代码 + 邮箱 + 密码”。
- 登录成功后服务设置 host-only、`HttpOnly`、`Secure`、`SameSite=Strict` Cookie；数据库仅保存令牌 SHA-256。
- 会话活动期为 8 小时，可续期，但自首次登录起单次最长 16 小时。
- 用户可以选择自己已加入的仓库作为当前工作空间；身份与角色是全局的，仓库成员关系只决定可进入哪些仓库。
- 权限以服务端返回的 permission code 为准。前端隐藏菜单只是体验优化，服务端仍对每次请求做权限校验。
- 上游客户代码只用于鉴权、来源、幂等与回调归属，不构成仓内数据隔离。所有拥有相应功能权限的仓库用户共享上游数据、人工导入批次和拦截名单。
- PDF 不提供公开 URL。每次下载都需要有效内部会话和对应权限，并返回 `private, no-store`。

## 身份与会话

### `POST /sessions`

```json
{ "loginName": "max.zhang", "password": "..." }
```

成功返回 `201`，设置会话 Cookie，并返回用户、可进入的仓库、当前工作空间、角色与权限。账号或密码错误统一返回 `401 INVALID_CREDENTIALS`；同一账号连续失败 5 次锁定 30 分钟。

### `GET /session`

恢复当前会话并重新加载最新角色权限。角色或账号被禁用、删除后，下一次请求立即失效。

### `POST /session/renew`

在绝对 16 小时上限内把活动期续为 8 小时。超过绝对上限后必须重新登录。

### `PATCH /session/workspace`

```json
{ "warehouseId": "warehouse-uuid" }
```

切换到用户拥有有效成员关系的仓库。切换会撤销旧会话并签发绑定新工作空间的会话。

### `POST /session/password`

```json
{ "currentPassword": "...", "newPassword": "至少16位强密码" }
```

修改成功后撤销该用户其他会话。管理员创建或重置账号时返回的一次性临时密码会要求用户首次登录后修改。

### `DELETE /session`

撤销当前会话并返回 `204`。

## 工作站

### `POST /workstations`

```json
{ "installationId": "550e8400-e29b-41d4-a716-446655440000", "displayName": "Packing Station 01" }
```

同一仓库与安装标识重复登记时更新名称和最后在线时间。工作站标识只用于审计，不是认证凭据。

## 账户管理

以下接口要求 `accounts.view` 或更高权限；写操作要求 `accounts.manage`，密码重置要求 `accounts.reset_password`。

- `GET /accounts?search=&status=&roleId=&page=1&pageSize=10`：查询账户。
- `POST /accounts`：创建全局账号，可同时指定角色；响应只展示一次强随机临时密码。
- `PATCH /accounts/{userId}`：修改姓名、工号、手机、邮箱和状态。
- `PUT /accounts/{userId}/role`：替换账号角色；无角色账号禁止登录。
- `POST /login-locks/{loginName}/unlock`：解除登录失败锁定。
- `POST /accounts/{userId}/reset-password`：生成一次性强随机临时密码并撤销现有会话。
- `DELETE /accounts/{userId}`：硬删除账号、凭据和个人信息；既有业务事实只保留不可逆匿名引用。

当前登录账号不能删除自己。所有账号安全操作均写入安全审计日志。

## 角色与权限

读取要求 `roles.view`，写操作要求 `roles.manage`。

- `GET /permissions`：返回按模块分组的权限点目录。
- `GET /roles`：返回角色及关联员工数量。
- `POST /roles`：创建角色并分配权限。
- `PATCH /roles/{roleId}`：携带 `expectedVersion` 修改角色名称、描述和完整权限集合；版本冲突返回 `409 ROLE_VERSION_CONFLICT`。
- `DELETE /roles/{roleId}`：硬删除角色；关联账号立即成为无角色状态并禁止登录。

`SYSTEM_ADMIN` 是全局系统管理员，通过数据库字段识别并拥有全部权限，不依赖普通角色记录。考勤薪酬默认只授予系统管理员，也可以由管理员创建“薪酬专员”角色并授予对应权限。

## 考勤与薪酬

考勤接口使用仓库 HttpOnly 会话，并要求已选择仓库工作空间。时间统一按 `America/New_York` 由服务器判定。

- `GET /attendance/context`：返回本人今日打卡、有效班次、可用打卡地和服务器时间。要求 `attendance.punch`。
- `PUT /attendance/punches`：原始请求体为 JPEG/PNG，查询参数包含 `punchType`、渠道、随机动作、动作结果、客户端抓拍时间及可选位置；固定电脑还需 `workstationId`。服务端校验真实图片类型、1MB 上限、工作站/围栏和 18 小时限制，并持久化所有尝试。要求 `attendance.punch`。
- `GET /attendance/daily-results?dateFrom=&dateTo=`：本人只读取自己的记录；`attendance.team_view` 可读取当前仓库团队记录。
- `GET/POST /attendance/appeals`：查询或在 72 小时内提交本人异常申诉。创建要求 `attendance.appeal`。
- `PATCH /attendance/appeals/{appealId}/review`：仓库主管通过或驳回；禁止审批自己的申诉。要求 `attendance.review`。
- `GET/PUT /attendance/locations`：维护圆形打卡围栏。要求 `attendance.locations.manage`。
- `GET/PUT /attendance/shift-rules`：维护生效日期、工作日、班次和宽限。要求 `attendance.rules.manage`。
- `GET /attendance/payroll-preview`：按日期区间预览薪酬；缺少时薪或考勤异常返回阻断问题。要求 `payroll.view`。
- `POST /attendance/payroll-runs`：按当前规则固化不可变计算快照，成功后前端才生成 Excel。要求 `payroll.export`。
- `PUT /attendance/pay-profiles` 与 `PUT /attendance/payroll-adjustments`：维护生效时薪、奖金和油补。要求 `payroll.manage`。

## 共享导入批次

共享批次用于多人同时处理同一批货。Excel 映射和 PDF 面单上传一次后，所有拥有扫描权限的仓库电脑都可以使用，不按操作员或上游客户分配。

### `POST /work-batches`

创建当前仓库的 `DRAFT` 批次。要求 `batches.create`。

### `GET /work-batches?status=ACTIVE&limit=50`

查看共享批次。要求 `batches.view`。

### `POST /work-batches/{batchId}/items`

分块写入 Excel 映射；每个请求最多 1000 条。核心字段为 `firstLegTrackingNo` 和 `courierTrackingNo`。同一批次内两侧单号必须唯一。

### `PUT /work-batches/{batchId}/items/by-first-leg/{firstLegTrackingNo}/label?filename=<fileName>`

上传单个 PDF，必须携带：

- `Content-Type: application/pdf`
- `X-Label-SHA256: <64位小写十六进制>`

服务端校验文件头、大小和内容哈希，并以私有资产保存。前端可以并发上传，但不能绕过逐文件校验。

### `POST /work-batches/{batchId}/publish`

只有映射数与 PDF 数相等且均大于 0 时才能把草稿发布为 `ACTIVE`。要求 `batches.publish`。

### `POST /work-batches/{batchId}/close`

关闭批次，不再参与新的扫码匹配。要求 `batches.close`。

## 原子扫码认领

### `POST /work-batch-claims`

```json
{
  "trackingNo": "HHWVP6223341301YQ",
  "workstationId": "workstation-uuid"
}
```

服务端在一个事务内完成标准化、全局拦截校验、活动批次匹配、重复处理校验和认领租约创建。成功响应包含短期 `claimToken`、`item.id` 及受控 PDF 下载路径。若同一单号同时出现在多个活动批次中，返回业务冲突并要求主管先关闭错误批次；客户端不得自行任选一个。

### `GET /shared-label-assets/{assetId}/content`

下载共享批次内的私有 PDF。要求有效工作空间和 `scan.use` 权限。

### `POST /work-batch-items/{itemId}/complete`

```json
{
  "workstationId": "workstation-uuid",
  "clientAttemptId": "browser-generated-uuid",
  "claimToken": "short-lived-opaque-token",
  "outcome": "SUBMITTED",
  "printerName": "Brother DCP-L2640DW Printer",
  "message": "QZ Tray accepted the job",
  "occurredAt": "2026-08-28T15:02:03.000Z"
}
```

允许的终态：

- `SUBMITTED`：QZ 已接受任务，不等于纸张物理打印成功。
- `FAILED`：提交前或 QZ 明确失败。
- `RESULT_UNKNOWN`：QZ 超时，可能已经进入本机打印队列；作为终态处理，避免自动重复提交。
- `BLOCKED`：命中全局拦截。

相同 `clientAttemptId` 与相同载荷幂等返回原记录；同一标识配不同载荷返回 `409 IDEMPOTENCY_CONFLICT`。网页在调用云端前先把结果写入 IndexedDB outbox，断网后使用同一标识按顺序补传。

## 全局拦截名单

读取要求 `intercepts.view`，写操作要求 `intercepts.manage`。

- `GET /intercepts?cursor=<opaque>&limit=1000`：按单调游标增量同步全局拦截变化。
- `POST /intercepts/check`：在非共享批次打印前实时复核头程/快递单号；在线失败时默认阻断打印。
- `POST /intercepts`：新增或恢复一个拦截单号，可填写原因。
- `DELETE /intercepts/{trackingNo}`：解除拦截，并保留变化记录供其他电脑同步。

扫码认领时服务端会同时检查头程单号与快递单号。浏览器每 15 秒增量同步一份只读本地缓存，供主管授权的单机应急模式使用。

## 离线应急模式

- 共享模式在线时以服务端原子认领与全局拦截为准。
- 断网时，主管可以明确开启单机应急打印；仅能使用该电脑已经验证并缓存的映射、PDF 和拦截快照。
- 现场确认不同电脑处理不同实物包裹，因此业务接受离线时没有跨电脑重复认领保护；界面必须持续显示“离线应急”和最后一次拦截同步时间。
- 恢复连接后只补传打印事实，不把过期本地状态覆盖到云端。离线期间新增的全局拦截无法提前到达该电脑，这是必须显式接受的剩余风险。

## 空提管理

空提与其物流单据采用一对多关系。来源客户用于追溯和上游回调，不限制仓库可见性；所有具备相应权限的账号共享同一批数据。列表中的换单进度由服务端按每条物流单据最新一次 `print_attempts` 聚合，`SUBMITTED` 只表示 QZ 已接受，不表示物理出纸。

- `GET /air-pickups?search=&status=&evidenceStatus=&page=1&pageSize=20`：返回列表、分页、全局状态汇总和换单进度。搜索支持提货单号与来源客户。
- `GET /air-pickup-clients`：返回可供人工录入选择的启用客户；要求 `air_pickups.create`。
- `POST /air-pickups`：人工录入时 `clientId` 必填；服务端保存客户名称快照并标记来源为 `MANUAL`。
- `GET /air-pickups/{orderId}`：返回入库照、POD、装车照及带缩略图引用的流转记录。
- `POST /air-pickups/{orderId}/void`：已录入状态可作废，要求纠错权限、操作密码和原因。
- `POST /air-pickup-receipt-batches`：1～200张已录入提单原子批量入库；实际值有任一差异时，差异说明必填。
- `PUT /air-pickup-receipt-batches/{batchId}/evidence?filename=...`：上传0～9张共享入库照。
- `POST /air-handover-batches`：1～200张已入库提单建立同车交仓草稿。
- `PUT /air-handover-batches/{batchId}/evidence?type=POD|LOADING&filename=...`：POD与装车照各0～9张；POD至少1张且装车照至少3张时为完整凭证，否则允许交仓并标记凭证待补。
- `POST /air-handover-batches/{batchId}/confirm`：原子确认交仓，不可直接撤回。

所有入库照、POD和装车照只接受真实 JPG/JPEG/PNG，单张不超过10MB且至少800×600。图片内容哈希、真实类型和申报类型在服务端再次校验。文件通过需要会话的私有内容端点延迟加载，不提供公开 URL。

## 安全审计

`GET /security-audit?limit=100` 要求 `security_audit.view`。日志包含操作类型、结果、操作人匿名引用、目标匿名引用、IP、设备类型和时间，不返回密码、会话令牌或上游 API Key。
