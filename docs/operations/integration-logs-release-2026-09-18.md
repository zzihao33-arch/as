# 推送日志前端补丁发布（2026-09-18）

## 固定范围

候选 `b4a99a0a8cfb2c6e3e75c3e03598f62fe3a706ad`，基线为正式前端 `806cff276cd528f863738ea8625be6656e6e2757`。包括音效仲裁、取消/抢占竞态修复和通知 401/403 后的会话权限重新确认。前端生产代码已通过 33 项测试、类型检查、生产构建及独立审查。

不包括后台整体重构、Office 预览、司机入口、数据库或后端发布。

## 发布前实际环境

- 正式 Vercel：`dpl_66ouCL3AjnbzoAcUJevmesmBX4mc`，`806cff2`，READY；别名 cmhubtool.com / www.cmhubtool.com。此部署是前端回退目标。
- 测试 Vercel：`dpl_HtXuer3Lpppi8ahovpCYbzsg6nza`，`644d0de`，READY；test.cmhubtool.com 指向 staging 的另一版界面。保留该别名和分支。
- 测试后端只读命令 `cmd-67gmwv3q`，成功执行 `inv-w8td3d0sq6`，2026-09-18T16:39:55Z，退出码 0。实例仅 ins-nm8jebfh / tyg-api-test，执行用户 cmhub。
- 测试后端 Git HEAD 和部署标记均为 `59601291f431ce662f0614fbd79acd414d2a693d`，Node 22.23.2；所检查的 6 个既有源码和 package/lock 的 SHA-256 均与该提交一致，integrationLogs 源码和 dist 不存在。17 条迁移，没有 integration_push 表或 integration_logs.view 权限。配置校验确认 test 数据库、test API Key 环境、test COS 前缀、关闭回传，健康 200，允许来源仅 test.cmhubtool.com。
- 首次只读命令以 root 执行时被 Git 目录所有权检查拒绝（inv-u8td2bgs6s）；改用应用用户后成功，没有修改 Git safe.directory 或其他保护配置。
- 因此测试站日志路由 404 为后端未安装日志功能，不是本候选回归。独立范围审查确认不应为此前端发布升级测试后端或替换 staging UI。
- 用户接受使用当前 Test Admin 进行可行验收；它是系统管理员。真实普通账号撤权未验证，不把管理员结果替代此项；本地合成 API 用于撤权与账号隔离回归。

## 预览验证

候选已上传 `codex/integration-logs-release`。预览 `dpl_BFCCZPj5U7H7SPBo1fquNeqX38Me`，READY，提交精确为 b4a99a0；URL https://as-2tl8fmqsk-zzihao33-8750s-projects.vercel.app/ 。

Vercel 远端构建成功，公开 HTML 为 200。入口包 `index-BCGkwsLK.js` 含权限刷新代码、正式 API 基址，不含测试 API 或本地夹具基址。现存 >500k 分包提示保留。

预览不绑定正式/测试自定义域名。正式 API 的来源限制仍保留，预览公开可达及构建通过不等于认证业务联调。

## 发布状态

已按已有发布授权将 master 从 806cff2 快进至 b4a99a0。正式部署 `dpl_dkmRn4dwZMgZMkGqAYoW65Bzm5Rn` 于 2026-09-18T16:46:42.923Z READY；cmhubtool.com / www.cmhubtool.com 均绑定此部署，提交精确为 b4a99a0。

发布后验证：正式 HTML 200，入口包为预览同名 `index-BCGkwsLK.js`；后端健康 200、ok=true、outboundWebhooks.enabled=false；匿名日志通知仍 401 SESSION_REQUIRED。正式浏览器既有 Max Zhang 系统管理员会话重载成功，列表 859 条、详情及脱敏响应正常，18 条未读自动降至 0，随后刷新仍为 0，页面显示实时监测中。

详情中的 422 INVALID_LABEL_PDF 为已存在的上游业务失败，未重放请求或放宽校验。此次没有实际扫码/打印或人工听音验收，也没有普通真实账号撤权验收；音效仲裁/延迟响应/撤权边界依赖自动测试与合成浏览器回归的明确覆盖范围。

未部署测试/正式后端或迁移，未修改测试站别名、账号权限、凭据、业务运单或回传配置。读取正式日志页按产品行为更新了当前账号的日志已读水位。若发布异常，恢复上面的正式 Vercel 部署；不回退或改动数据库及后端。
