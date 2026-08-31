# CM-HUB 上游客户对接 API v1

本文只描述仓库中**当前已实现**的上游服务器端接口。完整业务边界见 [物流面单架构与业务流](../architecture.md)，机器可读合同见 [OpenAPI](./openapi-v1.yaml)。

- 规范生产基址：`https://api.cmhubtool.com/api/v1`
- 数据格式：物流数据使用 JSON，面单上传使用原始 PDF 字节
- 字符编码：UTF-8
- 调用方：持有客户 API Key 的上游服务端

当前实现以下四条业务路由：

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/v1/inbound-batches` | 使用同一客户身份原子推送空提预报及其整批物流单据 |
| `POST /api/v1/shipments` | 创建或更新当前客户的物流单据 |
| `PUT /api/v1/shipments/by-first-leg/{firstLegTrackingNo}/label` | 主动上传并保存 PDF 面单资产 |
| `GET /api/v1/shipments/by-first-leg/{firstLegTrackingNo}` | 查询当前客户的物流单据 |

没有 `/v1` 兼容别名，没有外部 `print-events` 写入接口，也没有允许上游设置 CM-HUB 状态的接口。仓库网页不得持有此 API Key；这也不是仓库取单或打印合同。

## 1. 认证与通用请求头

除 `GET /healthz` 外，当前 `/api/v1/*` 请求都必须携带有效的客户 API Key：

```http
X-API-Key: cmh_live_<key-id>_<secret>
```

API Key 是服务器间机器凭据，不得写入网页、浏览器端 JavaScript、公开仓库、截图或普通业务日志。一个客户可以持有多把 Key 以便无中断轮换；CM-HUB 数据库只保存其 SHA-256 哈希。Key 缺失、格式错误、过期、已停用或校验失败均返回 `401`。

| Header | 必填 | 说明 |
| --- | --- | --- |
| `X-API-Key` | 是 | 客户专属服务器端 API Key |
| `Content-Type` | 写入是 | 物流数据使用 `application/json`；PDF 上传使用 `application/pdf` |
| `Idempotency-Key` | POST 是 | 8–128 位字母、数字、`_` 或 `-` |
| `X-Label-SHA256` | PDF 上传是 | PDF 原始字节的 64 位十六进制 SHA-256 |
| `X-Request-ID` | 否 | 8–64 位字母、数字、`_` 或 `-`；无效或未提供时由 CM-HUB 生成 |

每把 Key 只获得明确作用域：物流数据写入需要 `shipments:write`，查询需要 `shipments:read`，PDF 上传需要 `labels:write`；Key 有效但缺少权限返回 `403 INSUFFICIENT_SCOPE`。当前默认限流是每 Key 每分钟 600 次，以该 Key 的实际配置为准。

同一客户、业务操作及 `Idempotency-Key` 的请求和成功响应持久化到 MySQL，不再依赖 24 小时 Redis 结果缓存。网络超时重试必须复用原键；命中历史结果时返回原结果并增加 `idempotentReplay: true`。同一键携带不同 JSON 载荷返回 `409 IDEMPOTENCY_CONFLICT`，不得把幂等键用于另一笔请求。

订单写入采用兼容采集模式：未知顶层字段不会导致拒绝，完整 JSON 请求体会写入不可变的入站消息记录，同时作为物流单据的最新 `raw_data` 快照保存；已定义字段仍执行类型、长度和格式校验。原始载荷可能包含个人信息，不通过常规响应返回。

## 2. 通用响应和错误

成功响应：

```json
{
  "data": {},
  "requestId": "4b2c8080-87a4-4f5c-901d-2efcb3d8bba5"
}
```

错误响应：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "firstLegTrackingNo 为必填项。",
    "requestId": "4b2c8080-87a4-4f5c-901d-2efcb3d8bba5"
  }
}
```

| HTTP 状态 | 错误码示例 | 调用方处理 |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR`、`IDEMPOTENCY_KEY_REQUIRED`、`LABEL_SHA256_REQUIRED` | 修正请求；不要盲目重试 |
| `401` | `INVALID_API_KEY` | 检查或轮换 Key |
| `403` | `INSUFFICIENT_SCOPE` | 为该服务器使用具备所需读/写作用域的 Key |
| `404` | `SHIPMENT_NOT_FOUND`、`ROUTE_NOT_FOUND` | 检查客户归属、单号和规范路径 |
| `409` | `REQUEST_IN_PROGRESS`、`IDEMPOTENCY_CONFLICT`、`LABEL_UPLOAD_IN_PROGRESS`、`LABEL_SUPERSEDED` | 按错误码等待重试，或上传物流单据当前声明的最新文件 |
| `415` / `422` | `UNSUPPORTED_MEDIA_TYPE`、`INVALID_LABEL_PDF`、`LABEL_HASH_MISMATCH` | 修正文件类型、内容或声明哈希 |
| `429` | `RATE_LIMITED` | 带抖动指数退避 |
| `500` / `503` | `INTERNAL_ERROR`、依赖不可用 | 带抖动指数退避；POST 保持相同幂等键 |

该 API 仅面向服务器端调用方；浏览器调用不受支持，客户 Key 也不得下发到浏览器。

## 3. 推送空提预报与整批物流单据

```http
POST /api/v1/inbound-batches
```

这是推荐的完整业务链路入口。调用方继续使用当前客户的同一把 API Key，不需要为“空提”申请第二套接口或凭据。服务端从 API Key 确定来源客户，在一个事务中创建或更新一张空运提货单，并把本批 1～5,000 条物流单据全部关联到该提单。仓库工作台对所有有权限的操作员共享这些数据。

`batchId` 是当前客户的上游批次标识；同一客户内必须稳定唯一。`billNo` 做去空格、大小写和连字符归一化，因此 `abc-123`、`ABC-123`、`ABC123` 与 `abc123` 视为同一提货单号。完整请求保存在入站消息与空提原始载荷中，每条物流单据仍单独保留自身原始对象。

### 请求字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `batchId` | string | 是 | 当前客户内唯一，最长128字符 |
| `airPickup.billNo` | string | 是 | 全局归一化唯一，最长32字符 |
| `airPickup.cargoName` | string | 否 | 货物名称，最长100字符；当前列表不展示 |
| `airPickup.forecastCartons` | integer | 是 | 预报箱数，1～999999 |
| `airPickup.forecastPackages` | integer | 是 | 预报包裹数，1～999999 |
| `airPickup.forecastWeight` | number | 是 | 大于0，最多3位小数 |
| `airPickup.forecastWeightUnit` | string | 是 | `KG` 或 `LB` |
| `airPickup.remarks` | string | 否 | 最长200字符 |
| `shipments` | array | 是 | 1～5,000条；每项字段与单条物流单据接口一致 |

### 请求示例

```json
{
  "batchId": "TY-20260829-18098109734",
  "airPickup": {
    "billNo": "180-98109734",
    "forecastCartons": 120,
    "forecastPackages": 2000,
    "forecastWeight": 1850.5,
    "forecastWeightUnit": "KG",
    "remarks": "JFK 预报"
  },
  "shipments": [
    {
      "firstLegTrackingNo": "HHWV06218005702YQ",
      "courierTrackingNo": "LC095500137US",
      "carrier": "USPS",
      "order_id": "SO-20260829-0001"
    },
    {
      "firstLegTrackingNo": "HHWVP6225107301YQ",
      "courierTrackingNo": "LP095529498US",
      "carrier": "USPS",
      "order_id": "SO-20260829-0002"
    }
  ]
}
```

```bash
curl --request POST 'https://api.cmhubtool.com/api/v1/inbound-batches' \
  --header 'Content-Type: application/json' \
  --header 'X-API-Key: cmh_live_<请从安全渠道取得>' \
  --header 'Idempotency-Key: TY-20260829-18098109734-v1' \
  --data @inbound-batch.json
```

成功返回 `200 OK`：

```json
{
  "data": {
    "batchId": "TY-20260829-18098109734",
    "airPickupOrderId": "6feff09c-925d-46fa-8cd2-e69751fbb2d7",
    "billNo": "180-98109734",
    "clientName": "TY Logistics",
    "shipmentCount": 2000
  },
  "requestId": "upstream-20260829-0001"
}
```

整批采用事务提交：任一物流单据重复、已属于其他提单，或提货单已属于其他客户/批次时，整批回滚。更新已经入库或交仓的提货单不会改写其预报字段，只补齐同一客户、同一批次的物流关联。超时重试必须复用原 `Idempotency-Key`。

## 4. 创建或更新单条物流单据

```http
POST /api/v1/shipments
```

`firstLegTrackingNo` 是当前客户范围内的唯一业务键。首次提交创建记录；后续提交更新非空字段并递增版本。新记录的状态由 CM-HUB 设置为 `RECEIVED`；更新现有记录不会被请求体中的字段改变状态。

### 请求字段

| 字段 | 类型 | 必填 | 当前行为 |
| --- | --- | --- | --- |
| `firstLegTrackingNo` | string | 是 | 最长 128；当前客户内的唯一头程单号 |
| `courierTrackingNo` | string | 否 | 最长 128；末端快递单号 |
| `carrier` | string | 否 | 最长 64 |
| `labelUrl` | string | 否 | 最长 2048，必须是 HTTPS；当前只保存为上游面单源引用 |
| `labelSha256` | string | 否 | 64 位十六进制 SHA-256 |
| `attributes` | object | 否 | 客户扩展字段；不得包含密码或 API Key |
| `order_id` | string | 否 | 最长 128；上游订单参考号 |
| `recipient_name` | string | 否 | 最长 128 |
| `phone` | string | 否 | 最长 64 |
| `address` | string 或 object | 否 | 非空收件地址 |
| `items` | array | 否 | 商品明细；元素结构当前不作业务解释 |
| 其他顶层字段 | 任意合法 JSON | 否 | 仅在内部原始载荷快照中兼容保留 |

不要提交 `status` 来驱动流程。由于兼容采集，未知的 `status` 字段可能进入原始载荷快照，但当前解析器不会将它写入 CM-HUB 状态。

`labelUrl` 只是兼容保留的上游来源元数据。CM-HUB 不会反向抓取它，仓库也不会使用它。要让物流单据进入可打印状态，上游必须通过下一节的 PDF 上传接口主动把文件推送到美国云端。

### 请求示例

```bash
curl --request POST 'https://api.cmhubtool.com/api/v1/shipments' \
  --header 'Content-Type: application/json' \
  --header 'X-API-Key: cmh_live_<请从安全渠道取得>' \
  --header 'Idempotency-Key: 20260828-jfk-row-0001' \
  --header 'X-Request-ID: upstream-jfk-20260828-0001' \
  --data '{
    "firstLegTrackingNo": "HHWV06218005702YQ",
    "courierTrackingNo": "LC095500137US",
    "carrier": "USPS",
    "labelUrl": "https://labels.example.com/LC095500137US.pdf",
    "labelSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "labelAssetReady": false,
    "order_id": "SO-20260828-0001",
    "recipient_name": "Jane Doe",
    "phone": "+1-212-555-0100",
    "address": {
      "line1": "123 Example Ave",
      "city": "New York",
      "state": "NY",
      "postalCode": "10001",
      "country": "US"
    },
    "items": [
      { "sku": "SKU-RED-01", "name": "Red Widget", "quantity": 2 }
    ],
    "upstream_extension": {
      "channel": "shopify",
      "priority": "expedited"
    }
  }'
```

### 成功响应

返回 `200 OK`：

```json
{
  "data": {
    "id": "fcd25c21-8258-4b21-a7ab-d92abfe8ae25",
    "orderId": "SO-20260828-0001",
    "firstLegTrackingNo": "HHWV06218005702YQ",
    "courierTrackingNo": "LC095500137US",
    "carrier": "USPS",
    "labelUrl": "https://labels.example.com/LC095500137US.pdf",
    "labelSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "recipientName": "Jane Doe",
    "phone": "+1-212-555-0100",
    "address": {
      "line1": "123 Example Ave",
      "city": "New York",
      "state": "NY",
      "postalCode": "10001",
      "country": "US"
    },
    "items": [
      { "sku": "SKU-RED-01", "name": "Red Widget", "quantity": 2 }
    ],
    "status": "RECEIVED",
    "attributes": null,
    "rawDataCaptured": true,
    "version": 1,
    "createdAt": "2026-08-28T14:25:31.000Z",
    "updatedAt": "2026-08-28T14:25:31.000Z"
  },
  "requestId": "upstream-jfk-20260828-0001"
}
```

缺少或无效字段返回 `400 Bad Request`。缺少幂等键时的错误码为 `IDEMPOTENCY_KEY_REQUIRED`。

## 5. 主动上传 PDF 面单

```http
PUT /api/v1/shipments/by-first-leg/{firstLegTrackingNo}/label
Content-Type: application/pdf
X-Label-SHA256: <PDF 原始字节的 SHA-256>
```

必须先创建物流单据，再上传对应 PDF。该接口要求 `labels:write` 作用域，默认最大文件大小为 20 MiB。CM-HUB 会验证声明哈希、PDF 头部和结尾标识，然后把文件写入美国服务器的私有目录；存储目录不由 Nginx 直接公开。

内容哈希就是文件上传的去重键，同一物流单据重复上传相同文件不会产生多个资产。若物流单据在创建时声明了 `labelSha256`，上传内容必须与它一致。需要换新文件时，先使用订单写入接口更新 `labelSha256`，再上传新 PDF。

```bash
sha256sum label.pdf
curl --request PUT 'https://api.cmhubtool.com/api/v1/shipments/by-first-leg/HHWV06218005702YQ/label' \
  --header 'Content-Type: application/pdf' \
  --header 'X-API-Key: cmh_live_<请从安全渠道取得>' \
  --header 'X-Label-SHA256: <sha256sum 输出>' \
  --data-binary '@label.pdf'
```

成功返回 `200 OK`：

```json
{
  "data": {
    "id": "bd32e620-cd5b-48e0-b4c2-9c9d086f15b7",
    "shipmentId": "fcd25c21-8258-4b21-a7ab-d92abfe8ae25",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "byteSize": 184302,
    "contentType": "application/pdf",
    "shipmentStatus": "READY_TO_PRINT",
    "reused": false
  },
  "requestId": "4b2c8080-87a4-4f5c-901d-2efcb3d8bba5"
}
```

这不是公开下载接口。仓库端面单交付将在仓库身份和权限模块完成后开放；网页不会持有上游 API Key。

## 6. 按头程单号查询

```http
GET /api/v1/shipments/by-first-leg/{firstLegTrackingNo}
```

该接口只返回当前 API Key 所属客户的记录，不能跨客户访问。

```bash
curl --get 'https://api.cmhubtool.com/api/v1/shipments/by-first-leg/HHWV06218005702YQ' \
  --header 'X-API-Key: cmh_live_<请从安全渠道取得>'
```

成功返回 `200 OK`，`data` 与写入响应中的物流单据结构一致。`labelAssetReady` 表明是否已有当前 CM-HUB 私有面单资产；它不提供存储路径。未找到时返回 `404 SHIPMENT_NOT_FOUND`。

## 7. 健康检查

```http
GET https://api.cmhubtool.com/healthz
```

该探针不需要 API Key，不返回客户或物流数据；它检查 MySQL、Redis 和私有面单目录是否可用。`200` 响应为：

```json
{ "ok": true }
```

## 8. 结果通知

CM-HUB 将仓库打印事实与待通知事件原子写入持久化出站箱，再向客户预先配置的 HTTPS URL 投递 HMAC-SHA256 签名回调。上游仍不能调用打印事件写入接口，也不能设置 CM-HUB 状态。

事件字段、验签、幂等与重试合同见 [上游结果回调 v1](./upstream-callbacks-v1.md)。仓库代码已实现该能力；正式环境必须完成 `006` 迁移、密钥和 URL 配置、启用投递器及双方联调后才可视为上线。

## 9. 上游接入检查

1. API Key 只存入服务端密钥管理系统或受限环境变量。
2. 每次业务写入生成稳定唯一的 `Idempotency-Key`；超时重试复用原值。
3. 保存 `requestId` 供排障，日志中不得记录完整 API Key 或完整个人信息载荷。
4. 只使用 `/api/v1` 规范基址，不尝试 `/v1`、打印事件或仓库内部路径。
5. 不提交或依赖上游 `status`；CM-HUB 是内部业务状态的唯一所有者。
6. 一批货使用 `/inbound-batches` 一次建立空提与物流单据关联；只有确实没有空提上下文的单条更新才使用 `/shipments`。
7. 先推送物流数据，再主动上传 PDF；不要等待 CM-HUB 或仓库抓取 `labelUrl`。
