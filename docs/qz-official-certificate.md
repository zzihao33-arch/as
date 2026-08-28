# QZ Tray 官方证书静默打印配置

本项目已经接入 QZ Tray 官方推荐的服务端签名方案：

- 前端从 `/api/qz-certificate` 读取 QZ 官方 `digital-certificate.txt`
- 每次 QZ 打印请求通过 `/api/qz-sign` 使用私钥签名
- 私钥只存放在 Vercel 环境变量中，不进入前端代码，也不提交到 GitHub

该签名只授权浏览器与本机 QZ Tray 的请求，不是上游云端 API 认证。上游客户 API Key 不得进入浏览器。QZ Tray 接受已签名请求只表示打印内容已提交到本机打印链路，不等于打印机已经物理出纸；详细语义见 [架构与业务流](./architecture.md)。

## 需要从 QZ 官方获取

购买/开通 QZ 官方证书后，在 QZ 账号或官方支持渠道下载：

1. `digital-certificate.txt`
2. `private-key.pem`

## Vercel 环境变量

在 Vercel Project → Settings → Environment Variables 增加以下变量，并选择 Production：

```text
QZ_CERTIFICATE=粘贴 digital-certificate.txt 的完整内容
QZ_PRIVATE_KEY=粘贴 private-key.pem 的完整内容
QZ_ALLOWED_ORIGINS=https://as-zzihao33-8750s-projects.vercel.app
```

如果 Vercel 页面不方便粘贴多行 PEM，也可以使用 Base64 版本：

```text
QZ_CERTIFICATE_BASE64=把 digital-certificate.txt 转成 base64 后粘贴
QZ_PRIVATE_KEY_BASE64=把 private-key.pem 转成 base64 后粘贴
QZ_ALLOWED_ORIGINS=https://as-zzihao33-8750s-projects.vercel.app
```

二选一即可：普通 PEM 变量和 Base64 变量不要混用；如果同时存在，系统优先使用 Base64。

## 配置后要做什么

1. 重新部署 Vercel。
2. 打开线上系统。
3. 系统设置 → 打印机 → 刷新列表。
4. 看到“QZ Tray 已连接，官方证书签名已启用”后，再测试打印。

如果仍出现 QZ 弹窗，重点检查：

- Vercel 环境变量是否配置在 Production 环境。
- `QZ_ALLOWED_ORIGINS` 是否等于当前正式访问域名。
- `private-key.pem` 是否和 `digital-certificate.txt` 是同一套 QZ 官方证书。
- 新电脑右下角 QZ Tray 是否正在运行。
