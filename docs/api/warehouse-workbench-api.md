# CM-HUB 仓库工作台 API

该接口只供 CM-HUB 第一方网页使用，生产基址为 `https://api.cmhubtool.com/warehouse/v1`。它与上游 `/api/v1` 完全分离，浏览器不得持有或发送上游 `X-API-Key`。

## 安全合同

- 登录成功后服务设置 host-only、`HttpOnly`、`Secure`、`SameSite=Strict` Cookie；数据库只保存令牌 SHA-256。
- 所有请求必须来自 `WAREHOUSE_ALLOWED_ORIGINS` 中的精确 Origin，并使用 `credentials: include`。
- 会话绑定一个用户、一个仓库和一个有效成员角色。工作站安装标识只用于审计，不是凭据。
- 仓库只能读取 `warehouse_client_access` 明确授权的上游客户数据。
- PDF 没有公开 URL；下载前同时核验会话、仓库客户权限、当前资产指针及 `READY` 状态。

## 会话

### `POST /sessions`

```json
{ "warehouseCode": "jfk-warehouse", "email": "operator@example.com", "password": "..." }
```

成功返回 `201` 和用户、仓库、角色信息，并设置 HttpOnly Cookie。失败统一返回 `401 INVALID_CREDENTIALS`；登录按 IP+邮箱限流。

### `GET /session` / `DELETE /session`

分别恢复当前会话和撤销当前会话。`DELETE` 返回 `204`。

## 工作站

### `POST /workstations`

```json
{ "installationId": "550e8400-e29b-41d4-a716-446655440000", "displayName": "Packing Station 01" }
```

同一仓库和安装标识重复登记时更新名称与最后在线时间。工作站被停用后不能写入打印尝试。

## 成员与角色（仅 `ADMIN`）

- `GET /members`：列出当前仓库成员、角色、状态与最近登录时间。
- `POST /members`：创建新的内部仓库用户及成员关系；初始密码至少 16 位。若邮箱已存在则拒绝，仓库管理员不能接管其他身份。
- `PATCH /members/{userId}`：修改 `OPERATOR`、`SUPERVISOR`、`ADMIN` 角色或 `ACTIVE`、`DISABLED` 状态。停用成员会撤销其当前仓库会话；系统拒绝停用或降级最后一个有效管理员。

当前三个角色均可执行基础扫码、同步和打印审计；成员管理只允许 `ADMIN`。后续高风险业务审批应继续通过 `requireWarehouseRole` 增加最小角色要求，而不是在前端隐藏按钮代替服务端授权。

## 增量交付

### `GET /shipments?cursor=<opaque>&limit=200`

返回当前仓库获授权客户的操作字段，不返回 `raw_data`、收件人 PII、上游 `labelUrl` 或内部存储键。`cursor` 是不透明的单调修订游标；客户端在每页落库后保存该游标并在 `hasMore=true` 时继续读取。

```json
{
  "data": [{
    "id": "shipment-uuid",
    "firstLegTrackingNo": "HHWV...",
    "courierTrackingNo": "LP...US",
    "carrier": "USPS",
    "status": "READY_TO_PRINT",
    "version": 2,
    "updatedAt": "2026-08-28T15:00:00.000Z",
    "labelAsset": {
      "id": "asset-uuid",
      "sha256": "...64 hex...",
      "byteSize": 123456,
      "downloadPath": "/warehouse/v1/label-assets/asset-uuid/content"
    }
  }],
  "cursor": "opaque",
  "hasMore": false
}
```

### `GET /label-assets/{assetId}/content`

流式返回当前获授权 PDF，响应使用 `Cache-Control: private, no-store` 和 `nosniff`。网页在写入 IndexedDB 前再次核验 PDF 头、字节数及 SHA-256。

## QZ 提交审计

### `POST /print-attempts`

```json
{
  "workstationId": "workstation-uuid",
  "shipmentId": "shipment-uuid",
  "labelAssetId": "asset-uuid",
  "clientAttemptId": "browser-generated-uuid",
  "outcome": "SUBMITTED",
  "printerName": "Brother DCP-L2640DW Printer",
  "message": "QZ Tray accepted the job",
  "occurredAt": "2026-08-28T15:02:03.000Z"
}
```

允许的结果只有：

- `SUBMITTED`：QZ 已接受任务；不是物理打印成功。
- `FAILED`：提交前或 QZ 明确失败。
- `RESULT_UNKNOWN`：QZ 超时，任务可能已进入系统队列。
- `BLOCKED`：命中 CM-HUB 本机拦截规则。

同一工作站的 `clientAttemptId` 幂等重放返回既有记录。服务验证工作站归属、仓库客户权限以及面单仍为该物流单据的当前资产；不会根据 `SUBMITTED` 把物流单据改成 `PRINTED`。

网页在发请求前先把尝试写入本机 IndexedDB outbox；网络失败时保留并在上线事件及定时间隔中使用同一个 `clientAttemptId` 重试。服务端对完整规范化载荷做哈希，同一个标识配不同载荷会返回 `409 IDEMPOTENCY_CONFLICT`。

打印尝试、物流审计事件和上游回调事件在同一个数据库事务中写入。即使客户尚未配置回调地址，事件也会进入 `WAITING_CONFIGURATION`，不会因缺少地址而丢失。

## 上游回调审计（仅 `ADMIN`）

- `GET /outbound-events?status=DEAD_LETTER&limit=100`：查看当前仓库获授权客户的投递状态、次数、HTTP 状态和脱敏错误摘要。响应不包含回调 URL、签名密钥或请求负载。
- `GET /outbound-events/{eventId}/attempts`：查看该事件各重放周期的逐次投递结果、请求时间戳、HTTP 状态和响应体哈希摘要；不保存或返回上游响应正文、签名或请求负载。
- `POST /outbound-events/{eventId}/retry`：只允许重放 `DEAD_LETTER`。若客户仍没有有效回调配置，事件转为 `WAITING_CONFIGURATION`；否则开启新的审计重放周期并转为 `PENDING`。

回调合同及上游验签方式见 [上游结果回调 v1](./upstream-callbacks-v1.md)。人工重放不能改变打印事实，也不能把 `SUBMITTED` 提升为物理打印成功。
