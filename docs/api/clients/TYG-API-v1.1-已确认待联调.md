# CM-HUB 与 TYG 数据推送接口

版本：v1.1 已确认需求实现稿，待测试环境联调验收。更新日期：2026-09-09。

本文定义 TYG 已确认的提单预报和面单推送流程。正常业务使用批次接口：先预报提单，再在同一批次下推送面单；也可一次提交预报和面单。每张面单只需要原单号、转单号和 PDF Base64 三个业务字段。客户身份由 API Key 确定，提单归属由批次外层字段确定。

代码完成不等于上线或双方验收通过。测试基址为 `https://api-test.cmhubtool.com/api/v1`，以已部署的测试版本为准。正式 v1.0 PDF 在测试环境验收和双方联调通过后另行生成。

## 认证与通用约定

所有业务请求从 TYG 服务端发出，携带 `X-API-Key`。JSON 使用 `Content-Type: application/json`。所有 POST 必须提供 8–128 位 `Idempotency-Key`，只允许英文字母、数字、下划线、连字符。可选 `X-Request-ID` 为同类字符组成的 8–64 位排障标识。

- 提单及单号推送需要 `shipments:write`；包含 PDF 时还需要 `labels:write`；查询需要 `shipments:read`。
- 超时或 5xx 重试：复用相同幂等键和相同业务内容。相同请求返回历史成功结果及 `idempotentReplay: true`，不会重复更新或延长 PDF 保留期。
- 相同幂等键对应不同内容，返回 `409 IDEMPOTENCY_CONFLICT`。旧版纯单号推送和新版含 PDF 推送属于不同内容。
- 真实业务更新、替换面单、到期后重新补传：使用新的幂等键。
- 历史重放响应反映原请求被接受时的结果；需要确认当前面单是否仍有效时，调用查询接口。
- 限流按交付 API Key 的实际配置执行。遇到 `429` 或暂时失败，降低并发，按 1、2、4、8、16 秒并加入随机抖动退避。

## 提单预报

`POST /inbound-batches`

```json
{
  "batchId": "TYG-20260909-18098109734",
  "airPickup": {
    "billNo": "180-98109734",
    "forecastCartons": 120,
    "forecastPackages": 2000,
    "forecastWeight": 1850.5,
    "forecastWeightUnit": "KG"
  },
  "shipments": []
}
```

`batchId` 是 TYG 为该提单提供的稳定批次标识，最长 128 字符。提单已绑定某批次后，后续补传继续使用同一 `batchId`；不要为每个网络请求生成新批次标识。每个 POST 的幂等键可以不同。

| 字段 | 含义与校验 |
| --- | --- |
| `airPickup.billNo` | 空运提单号，最长 32 字符，字母、数字或连字符；按既有规则规范化 |
| `airPickup.forecastCartons` | 总箱数，1–999999 的整数 |
| `airPickup.forecastPackages` | 总包裹数，1–999999 的整数，不是本次分批推送数量 |
| `airPickup.forecastWeight` | 总重量，大于 0，最多保留 3 位小数 |
| `airPickup.forecastWeightUnit` | `KG` 或 `LB` |

先预报时 `shipments` 必须传空数组。重复提交预报时，未到仓提单可更新预报值；已到仓或交仓提单保留已有预报，继续接收补传面单。

## 统一推送面单

仍调用 `POST /inbound-batches`，保留同一 `batchId` 和提单预报外层信息，在 `shipments` 中放入本次推送的记录。每次请求使用新的幂等键，失败重试时保持原键。

```json
{
  "batchId": "TYG-20260909-18098109734",
  "airPickup": {
    "billNo": "180-98109734",
    "forecastCartons": 120,
    "forecastPackages": 2000,
    "forecastWeight": 1850.5,
    "forecastWeightUnit": "KG"
  },
  "shipments": [
    {
      "firstLegTrackingNo": "ORIGINAL-A",
      "courierTrackingNo": "COURIER-B",
      "labelPdfBase64": "<PDF 原始字节的标准 Base64>"
    }
  ]
}
```

| 面单字段 | 必填 | 说明 |
| --- | --- | --- |
| `firstLegTrackingNo` | 是 | 原单号／头程单号，最长 128 字符，在同一客户范围内唯一 |
| `courierTrackingNo` | 是 | 当前转单号／末端快递单号，最长 128 字符 |
| `labelPdfBase64` | 是 | 标准 Base64 字符串，保留标准末尾填充；不加 `data:application/pdf;base64,` 前缀，不插入空格或换行 |

服务端校验 PDF 文件标识与结束标记，并计算 SHA-256。TYG 无须增加哈希字段或单独调用更换面单接口。若兼容客户端额外发送 `labelSha256`，其值必须与本次 PDF 完全匹配。

同一请求最多 5,000 条记录，但含 Base64 的完整 JSON 默认不能超过 **32 MiB**，单个 PDF 解码后不能超过 **20 MiB**。这两个限制同时生效，不能将 5,000 条上限理解为允许一次提交任意大小的 PDF。Base64 大小约为原 PDF 的 4/3；建议按实际文件大小拆分，先用较小批次联调。

成功响应示例：

```json
{
  "data": {
    "batchId": "TYG-20260909-18098109734",
    "airPickupOrderId": "<CM-HUB 提单 ID>",
    "billNo": "180-98109734",
    "clientName": "TYG",
    "shipmentCount": 1,
    "labelCount": 1
  },
  "requestId": "<排障标识>"
}
```

HTTP 200 表示本次推送的 PDF 已存入私有存储，且提单关联、单号关系、当前面单和成功记录已在数据库中提交。TYG 应核对 `shipmentCount` 与 `labelCount`，两者均应等于本次含面单记录数。它不表示仓库已经打印或完成操作。

任一文件无效、存储失败或批次归属冲突时，不发布半批单号关系或面单。网络断开时无法仅凭客户端超时判断提交结果，应使用同一幂等键重试。

## 更新与补传

- 原单号 A、转单号 B 不变，换一份 PDF：使用新幂等键推送 A、B、新 PDF，当前面单被替换。
- A→B 改为 A→C：推送 A、C、新 PDF，C 成为当前转单号；单号关系与当前面单在同一事务生效。
- 相同 PDF 使用新幂等键补传：复用面单元数据标识，但保存新的文件版本并重新计算七天有效期。
- 提单到仓、处理中、已交仓或关闭不阻止补传。其他客户的提单、其他批次或已绑定另一张提单的原单号仍然会被拒绝。
- 更新面单保留仓库处理状态和审计记录，不允许 TYG 通过请求中的 `status` 推进仓库操作状态。

`POST /shipments` 同样支持上述三个字段，可修正已有单票或处理无提单上下文的单票。已有提单关联不会被清空，但该接口不会为新单票自动推断提单归属；正常提单业务使用批次接口。

## 查询与数据保留

`GET /shipments/by-first-leg/{firstLegTrackingNo}`，路径中的原单号需 URL 编码。只能查询当前 API Key 所属客户的记录。

返回 `data.labelAssetReady` 表示当前 PDF 是否仍有效，`data.labelExpiresAt` 表示该版本到期时间。PDF 默认从本次存储开始计时七天；新请求重传会重新计时，幂等重放不会。到期后停止提供下载和打印，数据库仍保留单号关系、状态、哈希及必要审计记录。七天内可经授权查询并重新打印。

PDF Base64 不写入长期原始请求或审计数据。订单关系、状态和必要操作记录保留两年；实际数据处置通过专用维护流程执行。云端生命周期、备份副本和维护任务需在上线前完成配置及验收。

## 兼容与错误处理

旧版纯 JSON 推送和独立 `PUT /shipments/by-first-leg/{firstLegTrackingNo}/label` 继续保留。独立 PUT 仍使用 `application/pdf` 和 `X-Label-SHA256` 校验本次上传内容，现在可直接替换旧 PDF。TYG 新对接使用统一 Base64 推送，不再依赖两步上传。

| HTTP | 典型错误 | 处理方式 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR`、`INVALID_LABEL_BASE64`、`LABEL_PDF_REQUIRED`、`IDEMPOTENCY_KEY_REQUIRED` | 修正字段、编码或请求头 |
| 401 / 403 | `INVALID_API_KEY`、`INSUFFICIENT_SCOPE` | 检查密钥及推送／面单权限 |
| 404 | `SHIPMENT_NOT_FOUND` | 核查单号、客户归属 |
| 409 | `IDEMPOTENCY_CONFLICT`、`REQUEST_IN_PROGRESS`、`AIR_PICKUP_CLIENT_CONFLICT`、`AIR_PICKUP_BATCH_CONFLICT`、`SHIPMENT_ALREADY_BOUND` | 幂等冲突或归属错误需核查；处理中可稍后原样重试 |
| 410 | `LABEL_EXPIRED` | 仓库下载面单已过期，请 TYG 用新幂等键重新推送 |
| 413 | `PAYLOAD_TOO_LARGE` | 减小批次或文件；同时检查网关及应用大小限制 |
| 422 | `INVALID_LABEL_PDF`、`LABEL_HASH_MISMATCH` | 检查 PDF 内容及可选哈希 |
| 429 | `RATE_LIMITED` | 降低并发并退避 |
| 500 / 503 | `INTERNAL_ERROR`、`LABEL_STORAGE_UNAVAILABLE`、`IDEMPOTENCY_UNAVAILABLE` | 用相同幂等键和内容退避重试 |

## 测试环境验收

1. 先预报一张提单，然后推送两张 PDF；核对提单、单号映射及仓库可见内容。
2. 重放成功请求、同键改内容、PDF 存储故障和数据库提交故障，核对重试及无半批发布。
3. 分别验证 A→B 替换 PDF、A→B 改为 A→C、相同 PDF 重传和两个并发更新。
4. 提单到仓、交仓或关闭后再次补传；用另一客户 Key 验证隔离。
5. 验证七天过期下载与打印拒绝、过期对象删除、重新补传恢复，以及数据库仍保留必要记录。
6. 使用代表性真实 PDF 执行批量压力测试。几万单尽量在十分钟内完成为验收目标，需要实际 MySQL、COS、网络和 Key 限流配置支持。

双方完成以上验收并确认部署版本后，再安排正式发布。
