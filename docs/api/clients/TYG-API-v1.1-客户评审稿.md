# CM-HUB × TYG 系统对接 API 接口文档

> 文档版本：v1.1（客户评审稿）  
> 更新日期：2026-08-31  
> 接口状态：待开发部署 / 待联调  
> 调用方向：TYG 服务端 → CM-HUB  
> 生产基址：`https://api.cmhubtool.com/api/v1`（部署后启用）

> 本文用于双方确认接口合同，不代表接口已经上线。测试地址、测试 API Key 和生产 API Key 将在部署后通过安全渠道提供。

## 1. 对接目标与接口范围

TYG 先预报空运提单，再通过一个统一接口逐票推送原单号、转单号和 PDF Base64。首次面单、迟到补传、同转单号换 PDF、转单号变化后的新版面单全部使用同一个面单接口。

| 顺序 | 接口 | 用途 |
| --- | --- | --- |
| 1 | `POST /api/v1/air-shipments` | 创建或更新空运提单预报 |
| 2 | `POST /api/v1/label-pushes` | 首次面单、补传、换 PDF、转单号更新 |

不再设置独立的换面单接口。

## 2. 核心业务规则

1. TYG 必须先成功创建空运提单预报，再推送该提单下的面单。
2. TYG 提供预报总箱数、预报总包裹数、预报总重量和重量单位；仓库实收数据由 CM-HUB 内部记录。
3. 仓库开始收货前允许 TYG 更新预报；开始收货后预报字段锁定。
4. 空运提单到仓或业务关闭后，面单接口仍持续接收首次面单、迟到补传和新版面单。
5. 仓库实收数量与面单接收数量独立统计。例如预报 5,000、实收到仓 5,000、已收到面单 4,500 时，仍允许补传剩余 500 票。
6. 有效包裹数按唯一 `originalTrackingNo` 统计；重复请求、换 PDF 和转单号更新不增加包裹数。
7. 同一原单号可在原空运提单内版本化更新转单号，但不能自动改到另一张空运提单。
8. 更新转单号和 PDF 时必须原子生效；若更新失败，旧关系和旧 PDF 保持有效。

## 3. 通用协议

### 3.1 传输与认证

- 仅支持 HTTPS。
- 请求与响应均为 JSON、UTF-8。
- 仅允许 TYG 服务端调用。
- 测试和生产使用不同的 TYG 专属 API Key。

```http
Content-Type: application/json
X-API-Key: <TYG 专属 API Key>
Idempotency-Key: <本次业务提交的稳定唯一键>
X-Request-ID: <可选，建议每次请求唯一>
```

| Header | 必填 | 说明 |
| --- | --- | --- |
| `Content-Type` | 是 | 固定为 `application/json` |
| `X-API-Key` | 是 | TYG 专属服务器端密钥 |
| `Idempotency-Key` | 是 | 8～128 位；真实业务变更使用新键，网络重试复用原键 |
| `X-Request-ID` | 否 | 8～64 位字母、数字、下划线或连字符，用于链路追踪 |

### 3.2 幂等与业务顺序

- 同一 `Idempotency-Key` 和完全相同请求体重复提交：返回第一次的处理结果，不重复写入。
- 同一 `Idempotency-Key` 对应不同请求体：返回 `409 IDEMPOTENCY_CONFLICT`。
- 首次上传、换 PDF 或更换转单号属于不同业务提交，必须分别使用新的 `Idempotency-Key`。
- 网络超时后的重试必须复用原键和原请求体，不得给旧请求更换新键。
- 同一 `originalTrackingNo` 的不同业务版本必须按顺序提交，并等待前一个版本成功后再发送下一个版本。
- 第一阶段不要求 `labelRevision`。若 TYG 后续无法保证同一原单号顺序推送，双方再增加显式版本号。

### 3.3 通用成功响应

```json
{
  "code": "SUCCESS",
  "message": "接收成功",
  "data": {},
  "requestId": "TYG-20260831-000001"
}
```

### 3.4 通用失败响应

```json
{
  "code": "INVALID_LABEL_PDF",
  "message": "labelBase64 解码后不是完整的 PDF 文件",
  "requestId": "TYG-20260831-000002"
}
```

TYG 应保存 `requestId`，双方排障时使用该值定位请求，不需要传输完整 PDF Base64。

## 4. 接口一：空运提单预报

```http
POST /api/v1/air-shipments
```

### 4.1 请求字段

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `airWaybillNo` | string | 是 | 空运提单号，去除首尾空格后最长 32 字符 |
| `forecastCartons` | integer | 是 | 预报总箱数，正整数 |
| `forecastPackages` | integer | 是 | 预报总包裹数，正整数 |
| `forecastWeight` | number | 是 | 预报总重量，大于 0，最多 3 位小数 |
| `weightUnit` | string | 是 | 仅支持 `KG` 或 `LB` |

### 4.2 请求示例

```json
{
  "airWaybillNo": "180-98109734",
  "forecastCartons": 120,
  "forecastPackages": 50000,
  "forecastWeight": 1850.5,
  "weightUnit": "KG"
}
```

### 4.3 成功响应示例

```json
{
  "code": "SUCCESS",
  "message": "空运提单预报保存成功",
  "data": {
    "airWaybillNo": "180-98109734",
    "forecastCartons": 120,
    "forecastPackages": 50000,
    "forecastWeight": 1850.5,
    "weightUnit": "KG",
    "duplicate": false,
    "updated": false
  },
  "requestId": "TYG-20260831-000101"
}
```

### 4.4 创建、更新与锁定

| 情形 | 系统处理 |
| --- | --- |
| 首次推送提单号 | 创建预报并返回成功 |
| 完全相同数据重复推送 | 返回成功，`duplicate: true` |
| 仓库尚未开始收货，预报发生变化 | 更新预报，`updated: true`，保留修改审计 |
| 仓库已经开始收货，预报发生变化 | 返回 `AIR_SHIPMENT_LOCKED`，不修改预报 |

预报字段锁定不影响该提单下的面单继续上传或更新。

## 5. 接口二：统一逐票面单推送

```http
POST /api/v1/label-pushes
```

每次请求只推送一票包裹和一份 PDF 面单。单号关系与 PDF 均可靠保存后才返回成功。

### 5.1 请求字段

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `airWaybillNo` | string | 是 | 已成功创建的空运提单号 |
| `originalTrackingNo` | string | 是 | 原单号，最长 128 字符 |
| `transferTrackingNo` | string | 是 | 当前转单号/快递单号，最长 128 字符 |
| `labelBase64` | string | 是 | PDF 原始字节的标准 Base64，不带 Data URL 前缀 |
| `replacementReason` | string | 否 | 补传或更新原因，最长 200 字符；未提供时系统记录默认原因 |

### 5.2 请求示例

```json
{
  "airWaybillNo": "180-98109734",
  "originalTrackingNo": "HHWV06218005702YQ",
  "transferTrackingNo": "9400111899560000000000",
  "labelBase64": "JVBERi0xLjcKJc...",
  "replacementReason": "转单号变更后重新生成面单"
}
```

### 5.3 成功响应示例

```json
{
  "code": "SUCCESS",
  "message": "接收成功",
  "data": {
    "airWaybillNo": "180-98109734",
    "originalTrackingNo": "HHWV06218005702YQ",
    "transferTrackingNo": "9400111899560000000000",
    "operation": "CREATED",
    "labelVersion": 1,
    "duplicate": false,
    "latePush": false,
    "relationshipChanged": false,
    "reprintRequired": false
  },
  "requestId": "TYG-20260831-000201"
}
```

| `operation` | 含义 |
| --- | --- |
| `CREATED` | 首次创建包裹和面单 |
| `DUPLICATE` | 单号关系和 PDF 均相同，不创建新版本 |
| `PDF_REPLACED` | 转单号不变、PDF 变化，创建新版本 |
| `TRACKING_AND_PDF_UPDATED` | 原单号不变、转单号变化，原子更新关系和面单版本 |
| `FILE_RESTORED` | PDF 已按保存策略删除，重传后恢复文件并重新计算 7 天 |

### 5.4 首次、重复、补传与覆盖规则

| 情形 | 系统处理 |
| --- | --- |
| 提单不存在 | 返回 `AIR_SHIPMENT_NOT_FOUND`，不暂存孤立面单 |
| 原单号不存在 | 创建包裹、转单号关系和面单版本 1 |
| 原单号、转单号和 PDF 均相同 | 返回成功，`duplicate: true`，不重复保存或计数 |
| 原单号和转单号相同、PDF 不同 | 创建新 PDF 版本并设为当前有效面单 |
| 原单号相同，原 A→B 现改为 A→C | 若 C 未绑定其他原单号，原子更新为 A→C 并创建新面单版本 |
| 新转单号已绑定其他原单号 | 返回 `TRACKING_ALREADY_BOUND`，不覆盖其他包裹 |
| 原单号已属于另一张空运提单 | 返回 `TRACKING_ALREADY_BOUND`，不改变提单归属 |
| 提单已到仓或已关闭 | 仍接收首次、补传和更新，并返回 `latePush: true` |

以 A→B 更新为 A→C 为例：更新成功后，A 的当前有效转单号为 C；B 和旧 PDF 不再用于后续操作，但关系历史、PDF 哈希、接收时间和变更原因保留用于审计。

### 5.5 PDF 与请求限制

| 项目 | 限制 |
| --- | --- |
| 文件格式 | 仅支持 PDF，不接受 JPG、PNG、HTML 或第三方下载链接 |
| Base64 | 标准 Base64，不带 `data:application/pdf;base64,` 前缀，不带换行 |
| 原始 PDF 大小 | 最大 5 MiB |
| 完整 JSON 请求体 | 最大 7 MiB |
| 服务端校验 | 检查 PDF 完整性并计算 SHA-256 |

### 5.6 版本、打印与计数

- 更新转单号关系和 PDF 必须原子完成；失败时旧关系和旧 PDF 继续有效。
- 更新成功后，仓库扫描原单号只使用最新有效转单号和最新有效 PDF。
- 如果旧面单已经打印，响应返回 `reprintRequired: true`，仓库系统提示重新打印。
- 更换 PDF 或转单号只增加版本数，不增加有效包裹数。
- 每个 PDF 版本独立计算 7×24 小时保存期。
- 首次迟到面单和关闭后更新都返回 `latePush: true`，但仍按正常成功语义处理。

## 6. 可靠保存、容量与重试

### 6.1 成功语义

CM-HUB 只有在业务数据和 PDF 文件均可靠保存后，才返回 HTTP 200 和 `code: SUCCESS`。成功表示数据不会因后续异步流程丢失，不表示仓库已经打印。

### 6.2 初始容量约定

| 项目 | 约定 |
| --- | --- |
| 第一阶段限流 | 每分钟 1,200 次请求，以联调配置为准 |
| 建议并发 | 不超过 20 个并发请求 |
| 5 万票初始预计 | 按 1,200 次/分钟约需 42 分钟 |
| 超限处理 | HTTP 429，并返回 `Retry-After` |
| 后续目标 | 持续约 100 票/秒，5 万票在 10 分钟内可靠接收；真实 PDF 压测通过后再作为正式承诺 |

### 6.3 自动重试

- 网络超时、HTTP 429、500、503 可以使用原 `Idempotency-Key` 和完全相同请求体重试。
- 建议最多重试 5 次，等待 1、2、4、8、16 秒并加入随机抖动。
- 字段错误、PDF 错误、文件过大、单号冲突、幂等冲突和预报锁定不应原样自动重试。
- 连续失败 5 次后停止自动重试并告警。

## 7. 数据保存与隐私

| 数据 | 保存期限 | 到期处理 |
| --- | --- | --- |
| 每个版本的 PDF 原文件 | 自成功接收起 7×24 小时 | 私有对象存储自动删除；删除后不能查看或重新打印 |
| 完整 `labelBase64` | 不长期保存 | 解码、校验后不作为业务数据保留 |
| 空运提单号、原单号、转单号 | 2 年 | 按数据保留策略到期处理 |
| PDF 哈希、接收时间、版本和审计记录 | 2 年 | 用于对账、重复识别和操作审计 |

PDF 保存期内可在 CM-HUB 仓库内部查看和重新打印。本期不向 TYG 提供状态查询或 PDF 下载接口。PDF 删除后，TYG 重新推送完全相同数据时，系统恢复 PDF 并重新计算 7 天保存期。

- 日志不得记录完整 API Key、完整 Base64 或面单个人信息。
- PDF 存放于私有对象存储，并执行最小权限访问和操作审计。
- API Key 泄露后应立即停用并换发。

## 8. 错误码

| HTTP | 错误码 | TYG 处理方式 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 修正字段后重新提交 |
| 400 | `INVALID_BASE64` | 修正 Base64 编码 |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | 补充幂等键 |
| 401 | `INVALID_API_KEY` | 检查 Key 或联系 CM-HUB 换发 |
| 404 | `AIR_SHIPMENT_NOT_FOUND` | 先创建空运提单预报 |
| 409 | `AIR_SHIPMENT_LOCKED` | 仓库已开始收货，不能修改预报 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一键对应不同请求体，不得自动重试 |
| 409 | `TRACKING_ALREADY_BOUND` | 人工核查原单号所属提单或转单号归属 |
| 413 | `PAYLOAD_TOO_LARGE` | 缩小文件或请求体 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 修正 `Content-Type` |
| 422 | `INVALID_LABEL_PDF` | 修正 PDF 内容 |
| 429 | `RATE_LIMITED` | 按 `Retry-After` 降速重试 |
| 500/503 | `INTERNAL_ERROR` | 使用原幂等键和原请求体重试 |

## 9. 首轮联调验收

1. 创建包含预报箱数、包裹数、重量和单位的空运提单。
2. 重复推送相同预报，不产生重复记录。
3. 仓库未收货时更新预报；开始收货后验证预报锁定。
4. 推送不少于 10 票真实格式 PDF，验证可靠保存和重复请求。
5. 验证提单不存在、非法 Base64、非 PDF、超尺寸和单号冲突。
6. 验证到仓或关闭后仍可补传首次面单。
7. 使用同一接口更换 PDF，确认生成新版本。
8. 将 A→B 更新为 A→C，确认关系和 PDF 原子生效；C 已占用时必须拒绝。
9. 旧面单已打印时，验证重新打印提醒。
10. 验证相同幂等键重放、同键不同请求体冲突以及旧请求重试不会覆盖新版本。
11. 验证 PDF 7 天删除和元数据 2 年保留策略。
12. 使用 TYG 真实 PDF 样本进行集中推送压测。

## 10. TYG 联调前需提供

- 几份真实 PDF 面单样本，包括常规大小和最大文件样本。
- 单次集中推送的最大提单数、最大包裹数和预计推送时间窗口。
- 空运提单号、箱数、包裹数、重量和单位在 TYG 系统中的实际字段名称。
- TYG 出站服务器公网 IP（如需配置 IP 白名单）。
- 技术联系人、联调时间窗口和故障通知方式。

