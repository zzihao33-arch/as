# CM-HUB × TYG 数据推送接口文档

> **历史旧稿，请勿发送给 TYG 或用于新联调。** 本文件描述旧的“批次 JSON + 原始 PDF 上传”流程。当前双方评审口径见 `TYG-API-v1.1-客户评审稿.md`；新接口尚未开发部署。

> 文档版本：v1.0
>
> 更新日期：2026-08-30
>
> 对接客户：TYG
>
> 接口状态：历史旧稿 / 停止作为新对接依据
>
> 生产基址：`https://api.cmhubtool.com/api/v1`

## 1. 对接目标

TYG 通过服务器端接口主动向 CM-HUB 推送一条完整业务链路：

1. 一张空运提货单预报；
2. 该提货单下的头程单号与末端快递单号映射；
3. 每个头程单号对应的一份 PDF 面单。

数据写入后，CM-HUB 美国服务器会持久保存业务数据和 PDF 面单。所有具备相应权限的仓库操作电脑共享同一批数据，无需每台电脑重复导入，也不需要 TYG 指定仓库账号或操作员。

### 1.1 TYG 字段与 CM-HUB 字段对应关系

| TYG 业务含义 | CM-HUB 字段 | 说明 |
| --- | --- | --- |
| TYG 批次号 | `batchId` | TYG 内部稳定且唯一的批次标识 |
| 空运提单号 | `airPickup.billNo` | 例如 `180-98109734` |
| 预报箱数 | `airPickup.forecastCartons` | 正整数 |
| 预报包裹数 | `airPickup.forecastPackages` | 正整数，通常与本批物流单据数一致 |
| 预报重量 | `airPickup.forecastWeight` | 大于 0 |
| 重量单位 | `airPickup.forecastWeightUnit` | `KG` 或 `LB` |
| 运单号 / 头程单号 | `shipments[].firstLegTrackingNo` | 扫码换单时扫描的号码；本批内不能重复 |
| 参考单号 / 快递单号 | `shipments[].courierTrackingNo` | 换单后打印的末端快递单号 |
| TYG 订单号 | `shipments[].order_id` | 选填；用于双方排查和对账 |
| PDF 面单 | 独立 PDF 上传接口 | 先推送批次 JSON，再逐票上传 PDF |

客户身份不需要放在 JSON 中。CM-HUB 会根据 TYG 专属的 `X-API-Key` 自动识别来源为 TYG。

## 2. 认证与安全要求

除健康检查外，所有接口都必须从 TYG **服务端**发起，并携带：

```http
X-API-Key: cmh_live_<由 CM-HUB 通过安全渠道提供>
```

CM-HUB 当前只签发一串完整 API Key，不需要再拼接第二个 Secret。该 Key：

- 只能保存在 TYG 服务端环境变量或密钥管理系统中；
- 不得写入浏览器 JavaScript、APP 安装包、公开代码仓库、截图或普通业务日志；
- 不得通过 URL 查询参数传递；
- 泄露后应立即通知 CM-HUB 撤销并换发。

计划为 TYG 开通的权限为：

| 权限 | 用途 |
| --- | --- |
| `shipments:write` | 推送空提批次和物流单据 |
| `labels:write` | 上传 PDF 面单 |
| `shipments:read` | 按头程单号查询 TYG 自有物流单据 |

默认限流为每把 Key 每分钟 600 次，以正式交付 Key 的实际配置为准。收到 `429` 时应降低并发并进行带随机抖动的指数退避。

## 3. 通用协议

### 3.1 请求头

| Header | 何时必填 | 规则 |
| --- | --- | --- |
| `X-API-Key` | 除健康检查外均必填 | TYG 专属服务器端 API Key |
| `Content-Type` | 写入时必填 | JSON 为 `application/json`；PDF 为 `application/pdf` |
| `Idempotency-Key` | 两个 `POST` 接口必填 | 8～128 位，只允许字母、数字、`_`、`-` |
| `X-Request-ID` | 选填 | 8～64 位，只允许字母、数字、`_`、`-`；建议每次请求唯一 |
| `X-Label-SHA256` | 上传 PDF 时必填 | PDF 原始字节的 64 位十六进制 SHA-256 |

### 3.2 幂等约定

`POST` 请求必须使用稳定且唯一的 `Idempotency-Key`。建议格式：

```text
TYG-<batchId>-v1
```

网络超时或 `5xx` 重试时必须复用原来的幂等键和原始请求体：

- 相同键、相同请求体：返回原成功结果，并增加 `idempotentReplay: true`；
- 相同键、不同请求体：返回 `409 IDEMPOTENCY_CONFLICT`；
- 同一业务内容发生真实变更时：将版本号改为 `v2`、`v3`，使用新的幂等键。

### 3.3 通用响应

成功：

```json
{
  "data": {},
  "requestId": "TYG-20260830-000001"
}
```

失败：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "firstLegTrackingNo 为必填项。",
    "requestId": "TYG-20260830-000001"
  }
}
```

请保存响应中的 `requestId`，双方排障时以该值定位请求。日志中不要记录完整 API Key、完整地址、电话等敏感信息。

## 4. 主接口：推送空提及整批物流单据

```http
POST /api/v1/inbound-batches
Content-Type: application/json
X-API-Key: <TYG API Key>
Idempotency-Key: <稳定唯一的幂等键>
```

该接口是 TYG 的首选入口。一次请求会在同一个事务中写入一张空运提货单，并关联本批 1～5,000 条物流单据。任一记录校验或关联失败时整批不落库，避免出现半批成功。

### 4.1 请求字段

#### 顶层字段

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `batchId` | string | 是 | TYG 内唯一且稳定，最长 128 字符 |
| `airPickup` | object | 是 | 空运提货单预报 |
| `shipments` | array | 是 | 1～5,000 条 |

#### `airPickup`

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `billNo` | string | 是 | 最长 32 字符，只允许字母、数字、连字符 |
| `cargoName` | string | 否 | 货物名称，最长 100 字符 |
| `forecastCartons` | integer | 是 | 1～999999 |
| `forecastPackages` | integer | 是 | 1～999999 |
| `forecastWeight` | number | 是 | 大于 0，最多保留 3 位小数 |
| `forecastWeightUnit` | string | 是 | `KG` 或 `LB`，不区分大小写 |
| `remarks` | string | 否 | 最长 200 字符 |

提单号会忽略空格、大小写和连字符差异。因此 `abc-123`、`ABC-123`、`ABC123`、`abc123` 会被识别为同一个提单号。标准 11 位数字提单号会统一显示为 `123-12345678`。

#### `shipments[]`

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `firstLegTrackingNo` | string | 是 | 运单号/头程单号，最长 128 字符；TYG 客户范围内唯一 |
| `courierTrackingNo` | string | 否 | 参考单号/末端快递单号，最长 128 字符 |
| `carrier` | string | 否 | 末端承运商，最长 64 字符 |
| `labelSha256` | string | 否 | 对应 PDF 的 64 位十六进制 SHA-256；若提供，后续上传必须匹配 |
| `order_id` | string | 否 | TYG 订单参考号，最长 128 字符 |
| `recipient_name` | string | 否 | 收件人姓名，最长 128 字符 |
| `phone` | string | 否 | 收件电话，最长 64 字符 |
| `address` | string/object | 否 | 非空地址字符串或对象 |
| `items` | array | 否 | 商品明细 |
| `attributes` | object | 否 | TYG 自定义扩展属性；不得包含密码或 API Key |

请求可以携带未列出的合法 JSON 字段。CM-HUB 不会因未知顶层字段拒绝请求，并会完整保留原始数据用于兼容和对账；已定义字段仍按上表严格校验。

不要发送 `status` 来推进仓库流程。入库、交仓、打印和拦截状态只由 CM-HUB 仓库业务操作产生。

### 4.2 完整请求示例

```json
{
  "batchId": "TYG-20260830-18098109734",
  "airPickup": {
    "billNo": "180-98109734",
    "cargoName": "E-commerce parcels",
    "forecastCartons": 120,
    "forecastPackages": 2,
    "forecastWeight": 1850.5,
    "forecastWeightUnit": "KG",
    "remarks": "JFK warehouse forecast"
  },
  "shipments": [
    {
      "firstLegTrackingNo": "HHWV06218005702YQ",
      "courierTrackingNo": "LC095500137US",
      "carrier": "USPS",
      "order_id": "TYG-SO-20260830-0001"
    },
    {
      "firstLegTrackingNo": "HHWVP6225107301YQ",
      "courierTrackingNo": "LP095529498US",
      "carrier": "USPS",
      "order_id": "TYG-SO-20260830-0002"
    }
  ]
}
```

```bash
curl --request POST 'https://api.cmhubtool.com/api/v1/inbound-batches' \
  --header 'Content-Type: application/json' \
  --header 'X-API-Key: cmh_live_<由安全渠道取得>' \
  --header 'Idempotency-Key: TYG-20260830-18098109734-v1' \
  --header 'X-Request-ID: TYG-20260830-000001' \
  --data @TYG-inbound-batch.example.json
```

### 4.3 成功响应

`200 OK`

```json
{
  "data": {
    "batchId": "TYG-20260830-18098109734",
    "airPickupOrderId": "6feff09c-925d-46fa-8cd2-e69751fbb2d7",
    "billNo": "180-98109734",
    "clientName": "TYG",
    "shipmentCount": 2
  },
  "requestId": "TYG-20260830-000001"
}
```

### 4.4 整批冲突规则

以下情况会返回错误并整批回滚：

- 同一请求中出现重复头程单号；
- 某头程单号已经绑定到另一张提货单；
- 该提单已经属于另一客户或另一批次；
- 任一必填字段缺失或格式错误；
- 请求体或批次数量超过限制。

## 5. 上传 PDF 面单

必须先通过上一节创建物流单据，再为每个头程单号逐票上传 PDF。

```http
PUT /api/v1/shipments/by-first-leg/{firstLegTrackingNo}/label
Content-Type: application/pdf
X-API-Key: <TYG API Key>
X-Label-SHA256: <PDF 原始字节 SHA-256>
```

规则：

- `{firstLegTrackingNo}` 必须进行 URL 编码；
- 一次请求只上传一个 PDF；
- 默认单文件最大 20 MiB；
- 服务端会校验真实 PDF 内容和 SHA-256，不只检查扩展名；
- 相同物流单据重复上传相同文件会复用已有资产；
- 如果批次 JSON 已提供 `labelSha256`，上传的文件必须与之完全一致；
- CM-HUB 不会主动抓取第三方 `labelUrl`，必须把 PDF 文件本身推送到此接口。

计算 SHA-256：

```bash
sha256sum label.pdf
```

Windows PowerShell：

```powershell
(Get-FileHash -Algorithm SHA256 .\label.pdf).Hash.ToLower()
```

上传示例：

```bash
curl --request PUT \
  'https://api.cmhubtool.com/api/v1/shipments/by-first-leg/HHWV06218005702YQ/label' \
  --header 'Content-Type: application/pdf' \
  --header 'X-API-Key: cmh_live_<由安全渠道取得>' \
  --header 'X-Label-SHA256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' \
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

建议 TYG 先以 5 个并发上传，并根据响应时间和 `429` 情况动态调低；不要一次建立数千个并发连接。

## 6. 查询单条物流单据

```http
GET /api/v1/shipments/by-first-leg/{firstLegTrackingNo}
X-API-Key: <TYG API Key>
```

该接口只允许查询 TYG 自己推送的记录。

```bash
curl --get \
  'https://api.cmhubtool.com/api/v1/shipments/by-first-leg/HHWV06218005702YQ' \
  --header 'X-API-Key: cmh_live_<由安全渠道取得>'
```

成功返回的 `data` 中，`labelAssetReady: true` 表示 CM-HUB 已保存当前 PDF 面单。未找到时返回 `404 SHIPMENT_NOT_FOUND`。

## 7. 可选：单条物流单据补充或修正

```http
POST /api/v1/shipments
```

仅在没有空提上下文的单条数据，或需要补充/修正已存在物流单据字段时使用。正常整批业务必须优先使用 `/inbound-batches`，以确保提单、客户、批次和换单数据建立完整关联。

请求头同批次接口，并且每次业务变更使用新的 `Idempotency-Key`。请求体字段与 `shipments[]` 单项相同：

```json
{
  "firstLegTrackingNo": "HHWV06218005702YQ",
  "courierTrackingNo": "LC095500137US",
  "carrier": "USPS",
  "order_id": "TYG-SO-20260830-0001"
}
```

## 8. 健康检查

```http
GET https://api.cmhubtool.com/healthz
```

该接口不需要 API Key。`200 OK` 且响应中 `ok` 为 `true` 表示服务可用。调用方只应依赖 `ok` 字段，其他健康信息可能扩展。

## 9. 错误码与重试策略

| HTTP | 常见错误码 | TYG 处理方式 |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR`、`INVALID_JSON`、`IDEMPOTENCY_KEY_REQUIRED`、`LABEL_SHA256_REQUIRED` | 修正请求，不要原样盲目重试 |
| `401` | `INVALID_API_KEY` | 检查 Key；若可能泄露，联系 CM-HUB 换发 |
| `403` | `INSUFFICIENT_SCOPE` | 联系 CM-HUB 调整该 Key 权限 |
| `404` | `SHIPMENT_NOT_FOUND`、`ROUTE_NOT_FOUND` | 检查路径、客户归属及头程单号 |
| `409` | `REQUEST_IN_PROGRESS` | 短暂等待后用相同幂等键和请求体重试 |
| `409` | `IDEMPOTENCY_CONFLICT` | 不可重试；为真实新版本换用新幂等键 |
| `409` | `SHIPMENT_ALREADY_BOUND` | 人工核查该头程单号所属提单 |
| `413` | `PAYLOAD_TOO_LARGE` | 缩小批次或文件；单批仍不可超过 5,000 条 |
| `415` | `UNSUPPORTED_MEDIA_TYPE` | 修正 `Content-Type` |
| `422` | `INVALID_LABEL_PDF`、`LABEL_HASH_MISMATCH` | 修正 PDF 内容或 SHA-256 |
| `429` | `RATE_LIMITED` | 降低并发，带随机抖动指数退避 |
| `500` / `503` | `INTERNAL_ERROR`、依赖暂不可用 | 带随机抖动指数退避；POST 复用原幂等键 |

建议退避间隔为 `1s、2s、4s、8s、16s`，每次增加随机抖动；不要对 `400`、`401`、`403`、`404`、`IDEMPOTENCY_CONFLICT` 自动重试。

## 10. 推荐推送顺序

```text
TYG 生成批次及映射数据
  → POST /api/v1/inbound-batches
  → 校验 200 响应和 shipmentCount
  → 逐票计算 PDF SHA-256
  → PUT /api/v1/shipments/by-first-leg/{firstLegTrackingNo}/label
  → 必要时 GET 查询 labelAssetReady
  → 保存 requestId 供双方排障
```

## 11. 首轮联调验收清单

1. TYG 能访问 `GET https://api.cmhubtool.com/healthz`。
2. 使用单独安全渠道取得 TYG 专属 API Key。
3. 先推送一个仅含 2 条物流单据的测试批次。
4. 使用相同幂等键重放相同请求，确认收到幂等重放结果且未产生重复数据。
5. 使用同一幂等键发送不同请求体，确认收到 `409 IDEMPOTENCY_CONFLICT`。
6. 为 2 条物流单据分别上传 PDF，并确认 `labelAssetReady: true`。
7. CM-HUB 仓库端确认提单来源显示为 TYG，且两台授权电脑均可看到同一批数据。
8. 再测试 100 条批次及受控并发 PDF 上传。
9. 双方确认字段映射、错误处理、超时和日志脱敏后，再放大到正式批量。

## 12. TYG 对接前需反馈的信息

请 TYG 技术团队在联调前确认：

1. TYG 的批次唯一标识字段名称和生成规则；
2. 空运提单号、运单号/头程单号、参考单号/快递单号的实际字段名称；
3. 一批最大物流单据数量和日均/峰值批次数；
4. PDF 与头程单号的对应方式；
5. TYG 出站服务器公网 IP（如需后续增加 IP 白名单）；
6. 技术联系人、联调时间窗口和故障通知方式。

## 13. 不属于本次推送合同的接口

- TYG 不调用 CM-HUB 仓库内部接口；
- TYG 不调用打印事件写入接口；
- TYG 不设置入库、交仓、打印或拦截状态；
- 打印结果回调属于后续独立联调阶段，不应阻塞本次数据与 PDF 主动推送上线。
