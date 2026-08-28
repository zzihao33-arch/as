# CM-HUB 上游结果回调 v1

CM-HUB 在仓库发生打印提交、失败、结果未知或拦截事实后，向每个上游客户配置的 HTTPS 地址发送服务器到服务器回调。该通道是 **CM-HUB 主动通知上游**，不是上游写入 CM-HUB 状态的接口。

> 当前仓库代码和迁移已实现本合同；生产只有在执行 `006`、配置加密主密钥与客户回调、启用投递器并完成验签联调后才算上线。

## 1. 投递请求

```http
POST <客户配置的 HTTPS URL>
Content-Type: application/json
User-Agent: CM-HUB-Webhooks/1.0
X-CMHUB-Event-ID: 7b486dee-d506-41aa-9a46-631f26acd8f4
X-CMHUB-Timestamp: 1787943723
X-CMHUB-Signature: v1=<64 位十六进制 HMAC-SHA256>
```

签名原文是以下 UTF-8 字节，句点不可省略：

```text
<X-CMHUB-Timestamp>.<HTTP 原始请求体>
```

使用双方单独保存的客户回调签名密钥计算 HMAC-SHA256。不要重新格式化或解析后再序列化 JSON 才验签；必须对收到的原始 body 验签。建议拒绝与服务器时间相差超过 5 分钟的请求，并使用常量时间比较签名。

## 2. 事件负载

```json
{
  "specVersion": "1.0",
  "eventId": "7b486dee-d506-41aa-9a46-631f26acd8f4",
  "eventType": "shipment.print.submitted",
  "occurredAt": "2026-08-28T18:22:03.000Z",
  "data": {
    "shipment": {
      "id": "5ee2d9bb-42f6-4ef4-80c1-847b93e23cc9",
      "firstLegTrackingNo": "HHWV06218005702YQ",
      "courierTrackingNo": "LC095500137US",
      "carrier": "USPS",
      "status": "READY_TO_PRINT",
      "version": 2
    },
    "printAttempt": {
      "id": "bd364225-83a3-4e26-a702-5b4090681af0",
      "outcome": "SUBMITTED",
      "printerName": "Brother DCP-L2640DW Printer",
      "message": "QZ Tray accepted the job"
    },
    "warehouse": { "code": "jfk-warehouse" }
  }
}
```

事件类型：

| `eventType` | `outcome` | 语义 |
| --- | --- | --- |
| `shipment.print.submitted` | `SUBMITTED` | QZ 已接受/提交任务；**不代表物理出纸成功** |
| `shipment.print.failed` | `FAILED` | 提交前或 QZ 明确失败 |
| `shipment.print.result_unknown` | `RESULT_UNKNOWN` | 提交调用超时，结果不可确定 |
| `shipment.print.blocked` | `BLOCKED` | 命中 CM-HUB 拦截规则，未提交打印 |

负载不会包含 `raw_data`、收件人姓名、电话、地址、面单内容、浏览器用户 ID 或客户 API Key。

## 3. 响应、重试与幂等

- 任意 `2xx`：CM-HUB 标记投递完成。
- `408`、`425`、`429`、任意 `5xx` 或网络错误：指数退避重试，最多 12 次，最大间隔 1 小时；`Retry-After` 会在上限内被尊重。
- 其他 `4xx`：视为合同或权限错误，直接进入死信。
- 达到最大次数后进入死信，由 CM-HUB 仓库管理员排查后人工重放。
- CM-HUB 在网络超时等情况下可能重复发送同一 `eventId`。上游必须先完成验签，再用 `eventId` 建立唯一约束或幂等账本；重复事件应返回 `2xx`，不能重复执行业务副作用。
- 回调失败不回滚已经发生的打印事实；事件在 CM-HUB 出站箱中独立审计。
- 为避免把上游错误页中的凭据或个人信息带入仓库审计，CM-HUB 最多读取 1 KiB 响应并只保存其 SHA-256/捕获字节数，不保存响应正文。

推荐的处理顺序：读取原始 body → 校验时间窗 → 验证 HMAC → 原子插入 `eventId` → 执行业务 → 返回 `204`。若 `eventId` 已存在，直接返回 `204`。

## 4. Node.js 验签示例

```js
import crypto from 'node:crypto';

export function verifyCmhubWebhook({ rawBody, timestamp, signature, secret }) {
  if (!/^\d{10}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v1=${crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`;
  const received = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return received.length === wanted.length && crypto.timingSafeEqual(received, wanted);
}
```

生产中应在 JSON middleware 解析前捕获原始字节。签名密钥只进入上游服务端密钥管理系统，不得写入网页、移动端、日志或工单。

## 5. 密钥配置与轮换

CM-HUB 运维先生成每客户独立签名密钥，通过安全渠道交付上游；上游配置并确认后，CM-HUB 才激活对应 HTTPS URL。数据库只保存 AES-256-GCM 密文；加密主密钥只在 CM-HUB 服务端环境中。

更新 URL 或密钥会保留同一客户的持久化事件，并把尚未配置地址时积压的事件排入投递队列。密钥轮换应先让上游在短暂窗口同时接受新旧密钥，再由 CM-HUB 激活新密钥；不要在聊天、命令行参数或截图里传递明文。
