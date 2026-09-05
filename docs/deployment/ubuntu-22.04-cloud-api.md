# 在 Ubuntu 22.04 部署 CM-HUB 云端对接 API

本文说明 `services/cloud-api` 的**仓库部署模板**及已知生产漂移。服务提供上游物流单据写入/查询、PDF 面单主动上传、第一方仓库登录与交付，以及持久化签名回调。业务边界见 [架构与业务流](../architecture.md)。仓库代码完成不等于生产已上线；未经批准不得按本文直接修改现网。

## 先确认：仓库模板不等于当前生产

本轮核验到的两套运行标识不一致：

| 项目 | 仓库模板 | 已核验生产现状 |
| --- | --- | --- |
| 应用根目录 | `/opt/cmhub-api` | `/www/wwwroot/cloud-api` |
| PM2 应用名 | `cmhub-cloud-api` | `cloud-api` |
| 来源 | `deploy/ubuntu/deploy-api.sh`、`deploy/ubuntu/ecosystem.config.cjs` | 现有服务器运行状态 |

因此，仓库中的脚本和 PM2 配置目前只能视为**拟议的新环境模板**，不是现有生产操作手册。不得直接在生产执行模板脚本、切换目录或另起 `cmhub-cloud-api` 进程。变更生产前必须先核对实际 PM2 `cwd`/脚本、代码来源、环境文件、Nginx upstream、数据库迁移记录和回滚方式，再由批准的变更单决定统一到哪一套布局。

以下命令除“生产漂移核对”一节外，均面向全新的模板化环境。

## 当前运行边界

```text
上游服务 → HTTPS + API Key → Nginx → Ubuntu Node API → MySQL + Redis
```

- 唯一公开业务基址是 `/api/v1`；没有 `/v1` 别名。
- 云端只鉴权、限流、持久化和查询，不安装打印驱动，不调用 QZ Tray，也不打印。
- 上游客户 API Key 只能存在于上游服务端；仓库浏览器不得持有该 Key。
- 当前 `labelUrl` 只作为兼容元数据存入 MySQL，服务不会反向抓取。上游通过 PDF 上传接口主动把文件写入美国服务器的 CM-HUB 私有存储；仓库不得直接请求上游/境内 URL。
- 仓库接口只位于 `/warehouse/v1`，使用 HttpOnly 会话和仓库权限；没有外部 `print-events` 写入接口。打印审计会原子写入出站箱，由服务端主动签名回调上游。
- 仓库网页直接连接本机 QZ Tray；不部署轮询 API 的本地 Node 打印桥。

MySQL、Redis 和 Node 应只监听本机；公网只开放 SSH、HTTP 和 HTTPS。本文沿用仓库模板中的示例 IP/域名时，部署人员必须先用获批生产值替换，不得凭文档假定当前 DNS 或主机归属。

## 新环境一次性准备（模板）

以有 `sudo` 权限的部署用户执行。SSH 应限制为批准的办公出口 IP：

```bash
sudo adduser --disabled-password --gecos '' cmhub
sudo usermod -aG sudo cmhub
sudo ufw allow from <办公公网IP> to any port 22 proto tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo mkdir -p /opt/cmhub-api
sudo chown cmhub:cmhub /opt/cmhub-api
```

不要开放 `3306`、`6379` 或应用的 `8080` 端口。安装 Node.js 22 LTS、Git 和 PM2：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2
sudo env PATH="$PATH:/usr/bin" pm2 startup systemd -u cmhub --hp /home/cmhub
```

## 初始化或迁移 MySQL

数据库脚本是不可变、只执行一次的顺序迁移。以 [database/README.md](../../database/README.md) 为准；新数据库须按编号依次执行当前全部迁移：

1. `database/001_create_logistics_api_schema.sql`
2. `database/002_add_upstream_raw_payload.sql`
3. `database/003_harden_upstream_integrations.sql`
4. `database/004_add_label_assets_and_shipment_events.sql`
5. `database/005_add_warehouse_identity_and_print_attempts.sql`
6. `database/006_add_outbound_webhook_outbox.sql`
7. `database/007_add_global_identity_and_rbac.sql`
8. `database/008_add_shared_work_batches_and_intercepts.sql`
9. `database/009_add_air_pickup_lifecycle.sql`
10. `database/010_integrate_handover_document_permissions.sql`
11. `database/011_link_air_pickups_clients_shipments_and_receipt_evidence.sql`
12. `database/012_add_attendance_and_payroll.sql`
13. `database/013_add_tyg_v11_label_versions.sql`
14. `database/014_add_customer_profiles.sql`
15. `database/015_add_air_pickup_documents.sql`

在受控副本中替换 `001` 的 `REPLACE_WITH_A_LONG_RANDOM_PASSWORD`，不得把真实密码提交到仓库。新数据库示例：

```bash
sudo mysql < /opt/cmhub-api/database/001_create_logistics_api_schema.sql
sudo mysql < /opt/cmhub-api/database/002_add_upstream_raw_payload.sql
sudo mysql < /opt/cmhub-api/database/003_harden_upstream_integrations.sql
sudo mysql < /opt/cmhub-api/database/004_add_label_assets_and_shipment_events.sql
sudo mysql < /opt/cmhub-api/database/005_add_warehouse_identity_and_print_attempts.sql
sudo mysql < /opt/cmhub-api/database/006_add_outbound_webhook_outbox.sql
sudo mysql < /opt/cmhub-api/database/007_add_global_identity_and_rbac.sql
sudo mysql < /opt/cmhub-api/database/008_add_shared_work_batches_and_intercepts.sql
sudo mysql < /opt/cmhub-api/database/009_add_air_pickup_lifecycle.sql
sudo mysql < /opt/cmhub-api/database/010_integrate_handover_document_permissions.sql
sudo mysql < /opt/cmhub-api/database/011_link_air_pickups_clients_shipments_and_receipt_evidence.sql
sudo mysql < /opt/cmhub-api/database/012_add_attendance_and_payroll.sql
sudo mysql < /opt/cmhub-api/database/013_add_tyg_v11_label_versions.sql
sudo mysql < /opt/cmhub-api/database/014_add_customer_profiles.sql
sudo mysql < /opt/cmhub-api/database/015_add_air_pickup_documents.sql
```

以后增加的编号迁移同样按升序执行一次。不要重放已执行的脚本。旧环境若已通过早期草稿迁移或扩展版 `001` 获得 `order_id`/`raw_data` 等字段，应把当前 `002` 视为同一个逻辑变更，先由数据库负责人核对实际 schema 和部署记录，**不要再次执行**。

当前表的职责：

- `clients`：上游客户主体；不再等同于某一把凭据。
- `integration_api_keys`：客户的一对多 API Key、作用域、有效期、停用状态、限流和使用时间。
- `inbound_messages`：不可变请求原文、载荷哈希和持久化幂等响应。
- `shipments`：上游物流单据、最新原始载荷和当前面单资产指针。
- `label_assets`：私有 PDF 的内容哈希、内部存储键和准备状态。
- `shipment_events`：物流单据通用审计事件；订单写入不再借用打印日志。
- `print_logs`：保留给后续真实打印提交和结果事件。
- `warehouses`、`warehouse_users`、`warehouse_memberships`：第一方仓库身份与角色。
- `warehouse_client_access`：迁移 `005` 留下的废弃授权结构；当前应用采用全局仓库可见性，不再读取该表。
- `warehouse_sessions`、`workstations`：HttpOnly 会话和浏览器工作站审计身份。
- `shipment_delivery_changes`：仓库增量同步使用的单调修订账本。
- `print_attempts`：QZ 提交、失败、未知和拦截结果；不表示物理出纸。
- `client_callback_endpoints`：每客户 HTTPS 地址与 AES-256-GCM 加密的回调签名密钥。
- `outbound_webhook_events`、`outbound_webhook_attempts`：事务出站事件、租约、重试、死信、重放周期和逐次投递审计。
- `warehouse_permissions`、`warehouse_roles`、`warehouse_role_permissions`：全局权限目录、运营角色和角色授权。
- `warehouse_security_audit_events`：登录、密码、账户、角色和解锁安全审计。
- `warehouse_work_batches`、`warehouse_work_batch_items`、`warehouse_work_batch_assets`：多工作站共享的 Excel/PDF 作业批次。
- `warehouse_work_batch_print_attempts`：共享批次的幂等 QZ 提交回执。
- `global_intercepts`、`global_intercept_changes`：所有仓库工作站共享的拦截规则和增量修订账本。
- `air_pickup_orders`、`air_pickup_events`：记录来源客户、空提生命周期及一对多换单关联的主单据和审计轨迹。
- `air_receipt_batches`、`air_receipt_evidence_assets`：多人共享的批量入库事实与入库照片。
- `air_handover_batches`、`air_handover_evidence_assets`：多提单同车交仓及 POD/装车凭证。

存储 Adapter 支持美国服务器私有磁盘与腾讯云 COS。共享测试/生产环境应使用私有 COS，开发环境可继续使用本地磁盘；两种后端不改变业务接口。

## 配置服务（模板）

```bash
sudo -iu cmhub
git clone --branch master https://github.com/<组织或账号>/<仓库>.git /opt/cmhub-api
cd /opt/cmhub-api/services/cloud-api
cp .env.example .env
chmod 600 .env
nano .env
```

先创建不在 Git 仓库和 Nginx 静态目录中的私有存储目录：

```bash
sudo install -d -o cmhub -g cmhub -m 0700 /var/lib/cmhub/labels
```

填写实际值并保留本机监听：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8080
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=cmhub
MYSQL_USER=cmhub_api
MYSQL_PASSWORD=<真实随机密码>
REDIS_URL=redis://127.0.0.1:6379/0
JSON_BODY_LIMIT=256kb
INBOUND_BATCH_JSON_LIMIT=10mb
LABEL_PDF_LIMIT=20mb
LABEL_STORAGE_BACKEND=filesystem
LABEL_STORAGE_ROOT=/var/lib/cmhub/labels
# 切换 COS 时改为 LABEL_STORAGE_BACKEND=cos，并配置：
# COS_BUCKET=<完整 BucketName-APPID>
# COS_REGION=na-ashburn
# COS_PREFIX=production
# COS_SECRET_ID=<最小权限 CAM SecretId>
# COS_SECRET_KEY=<最小权限 CAM SecretKey>
WAREHOUSE_ALLOWED_ORIGINS=https://cmhubtool.com
WAREHOUSE_SESSION_HOURS=8
OUTBOUND_WEBHOOK_ENABLED=false
OUTBOUND_WEBHOOK_MASTER_KEY=<base64 编码的 32 字节主密钥>
# 主密钥轮换窗口改用：OUTBOUND_WEBHOOK_MASTER_KEYS=v1=<旧>,v2=<新>
OUTBOUND_WEBHOOK_KEY_VERSION=v1
OUTBOUND_WEBHOOK_POLL_INTERVAL_MS=5000
OUTBOUND_WEBHOOK_BATCH_SIZE=20
OUTBOUND_WEBHOOK_LEASE_SECONDS=60
OUTBOUND_WEBHOOK_TIMEOUT_MS=10000
OUTBOUND_WEBHOOK_MAX_ATTEMPTS=12
```

`WAREHOUSE_ALLOWED_ORIGINS` 必须是允许携带仓库 Cookie 的精确前端 Origin 列表，不能使用 `*`。`INBOUND_BATCH_JSON_LIMIT=10mb` 仅用于已通过 API Key 与作用域校验的批量入口，以支持约 2,000 条物流映射；普通 JSON 接口继续受 `JSON_BODY_LIMIT=256kb` 限制。两者均不得无限放大。Redis 不可用时，登录和上游请求会失败，以避免绕过限流和幂等保护。文件系统模式下，`LABEL_STORAGE_ROOT` 必须位于美国服务器持久磁盘且不得映射成 Nginx `root` 或 `alias`；COS 模式必须使用私有桶、美国区地域、独立环境前缀和最小权限 CAM 凭据。

主密钥与每客户 HMAC 密钥是两类不同凭据。主密钥只存在于 CM-HUB 服务环境和备份密钥库；客户密钥由 `generate-webhook-secret` 生成，经安全渠道交付客户，并通过 `CMHUB_WEBHOOK_SIGNING_SECRET` 临时环境变量写入密文。先保持 worker 关闭完成联调：

```bash
cd /opt/cmhub-api/services/cloud-api
npm run generate-webhook-secret
read -s CMHUB_WEBHOOK_SIGNING_SECRET
export CMHUB_WEBHOOK_SIGNING_SECRET
npm run configure-client-callback -- --client-code acme-logistics --url https://partner.example.com/hooks/cmhub
unset CMHUB_WEBHOOK_SIGNING_SECRET
```

上游验签和 `eventId` 去重通过后，把 `OUTBOUND_WEBHOOK_ENABLED` 改为 `true` 并经批准重启。回调运行合同见 [上游结果回调 v1](../api/upstream-callbacks-v1.md)。生产回调强制 HTTPS、拒绝私网目标和重定向；仍应通过主机出站防火墙限制可达网段。

轮换主密钥时必须同时配置旧、新版本并把 `OUTBOUND_WEBHOOK_KEY_VERSION` 指向新版本，再运行 `npm run rotate-webhook-master-key`。确认所有端点均为新版本且实测回调成功后才能删除旧 key；不得只替换单一环境变量，否则旧密文将无法解密。

## 构建与启动新模板环境

仓库提供 [deploy-api.sh](../../deploy/ubuntu/deploy-api.sh) 和 [PM2 模板](../../deploy/ubuntu/ecosystem.config.cjs)。它们固定使用 `/opt/cmhub-api` 和进程名 `cmhub-cloud-api`，只适用于已明确采用该布局的新环境。

```bash
sudo -iu cmhub
cd /opt/cmhub-api
REPO_URL=https://github.com/<组织或账号>/<仓库>.git \
  bash deploy/ubuntu/deploy-api.sh
```

脚本执行快进更新、`npm ci`、TypeScript 类型检查与测试、构建、受控的顺序迁移、移除开发依赖并 `pm2 startOrReload`。只有本机 `/healthz` 成功才会写入 `.deployed-sha`。迁移失败或健康检查失败时脚本以非零状态退出；迁移本身不可自动回滚，因此上线前必须具备已验证的数据库备份和回滚提交。模板环境检查：

```bash
pm2 status cmhub-cloud-api
pm2 logs cmhub-cloud-api --lines 100
curl -fsS http://127.0.0.1:8080/healthz
```

健康响应包含 `ok: true` 及不含密钥的 `outboundWebhooks.enabled` 配置状态。它只证明 API、MySQL、Redis 和私有面单目录的探针通过；不证明某张面单已进入仓库缓存、打印已完成或某次回调已送达。

## 生产漂移核对（只读后再制定变更）

现有生产使用 `/www/wwwroot/cloud-api` 和 PM2 名 `cloud-api`。部署前至少记录并评审：

1. `pm2 describe cloud-api` 中的 `cwd`、入口文件、解释器、环境和重启策略。
2. Nginx 实际 `proxy_pass`、域名、证书和当前 upstream 端口。
3. `/www/wwwroot/cloud-api` 的代码来源、分支/提交、构建产物和本地改动。
4. MySQL 实际列、索引、账号授权，以及 `001` 至 `008` 对应变更是否已经执行。
5. 当前 `.env` 的变量名是否与 `services/cloud-api/.env.example` 一致；只比较键名，不把密钥复制到日志或工单。
6. 备份、健康检查、回滚提交和 PM2 回滚命令。

在这些差异被明确处理前，不要把模板路径或进程名写入生产自动化，也不要同时运行两套进程争用端口。

## Nginx 与 HTTPS（模板）

将仓库 [Nginx 模板](../../deploy/ubuntu/nginx/cmhub-cloud-api.conf) 复制到新环境后，把 `server_name _;` 替换为获批域名，再配置证书：

模板的 `client_max_body_size 20m` 与默认 `LABEL_PDF_LIMIT` 对齐。若调整文件上限，必须同时调整两处并重新测试 `413` 行为；JSON 仍由 `JSON_BODY_LIMIT` 单独限制。

```bash
sudo cp /opt/cmhub-api/deploy/ubuntu/nginx/cmhub-cloud-api.conf /etc/nginx/sites-available/cmhub-cloud-api
sudo ln -s /etc/nginx/sites-available/cmhub-cloud-api /etc/nginx/sites-enabled/cmhub-cloud-api
sudo nginx -t
sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.cmhubtool.com
```

上游只使用 `https://api.cmhubtool.com/api/v1`。不要向客户提供 IP、HTTP 或 `/v1`。验证当前已实现合同：

```bash
curl -fsS https://api.cmhubtool.com/healthz
curl -i https://api.cmhubtool.com/api/v1/shipments/by-first-leg/TEST-NOT-A-REAL-ORDER
```

第二个请求未携带 Key 时必须返回 `401`。非规范 `/v1/...` 应返回 `404`；在携带有效客户 Key 时，未实现的打印事件路径也应返回 `404`。不得通过代理重写制造兼容接口。

## 创建客户 API Key

配置并构建服务后，从 `services/cloud-api` 使用 CLI 创建客户；Key 原文只输出一次：

```bash
npm run create-client-key -- --code acme-logistics --name 'Acme Logistics' --rate-limit 600
```

立即把原文移入批准的密码管理器或安全交付渠道。数据库只保存哈希。再次对相同 `--code` 执行命令会创建可并行验证的新 Key，不会重复创建客户。上游切换并验证完成后，再按输出的旧 Key ID 撤销旧 Key：

```bash
npm run revoke-client-key -- --key-id OLD_KEY_ID
```

不要先撤旧再发新，不要尝试恢复原文，也不要用 SQL seed 保存测试 Key。迁移 `003` 必须先完成，否则新版本在启动后无法查询新的鉴权和入站记录表。

## 创建首个仓库管理员

迁移 `005` 和构建完成后，使用 [数据库迁移说明](../../database/README.md) 中的 `create-warehouse-admin` 命令。密码通过交互式隐藏输入进入临时环境变量，不写入 argv、仓库或 SQL。该命令同时创建仓库、管理员成员关系，并把仓库授权到明确列出的上游客户；它不会输出或复用上游 API Key。

## 上线边界检查

- 上游从服务端主动推送，并只使用 `/api/v1`。
- 仓库网页和静态前端包中不存在客户 API Key。
- 云端主机没有打印驱动或 QZ Tray；仓库没有 Node 轮询桥。
- 文档和告警将 QZ 接受请求表述为“已提交”，不表述为物理打印成功。
- 仓库使用内部账号与 HttpOnly Cookie；前端包、localStorage 和 IndexedDB 中不存在客户 API Key。
- 已授权云端面单进入 IndexedDB；Excel/PDF 手工导入仍是异常兜底。
- QZ 只记录“已提交/失败/未知/拦截”；不要声称 `SUBMITTED` 等于物理出纸。
- 签名回调只有在 `006`、主密钥、客户地址/签名密钥、上游验签与 `eventId` 去重、死信告警和人工重放均验证后才能宣称上线。
