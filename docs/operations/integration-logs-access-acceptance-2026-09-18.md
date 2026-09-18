# 推送日志权限回归（2026-09-18）

## 候选及改动

候选位于 `.worktrees/integration-logs-release`，分支 `codex/integration-logs-release`。基线 `806cff2` 上的音效提交为 `1815acf`、`1151513`、`f627d23`、`eb1b07c`。本轮增加权限重新确认；未推送或部署。

复现的问题：通知接口返回 401/403 后只停止轮询，没有更新会话缓存，撤权账号仍能看到旧日志表和导航。现在触发一次会话重新确认：同身份更新权限，身份变化重新激活，失效回登录页，确认失败清除旧会话并显示重连入口。会话版本及对象校验防止旧确认响应覆盖后续登录、退出、切仓或重试。接口拒绝但会话仍授权时保持停止状态，避免循环刷新。

## 验证结果与边界

- 修改后的代码通过 `npm run typecheck`、`npm test`（33/33）、物理路径下 `npm run build`、`git diff --check`；构建仍有现存的大分包提示。
- 独立代码审查未发现可操作问题。33 项自动测试为候选现有套件，新增会话刷新通过下列真实 Chrome + 合成 API 验证，并非新增 React 自动测试。
- 同一 fixture-a 撤销权限：转入角色配置，日志菜单及表格消失；两次统计观察间通知/会话请求数不再增加。
- 会话过期：回登录页。随后登录 fixture-b，已有 3 条记录仍为该账号未读，进入页面后独立已读；fixture-a 的已读位置未串入 B。
- 会话确认返回 503：旧日志页面被移除，显示云端连接不可用及重新连接；恢复服务并重试后正常。
- 日志 403、会话仍返回同身份授权：显示拒绝错误，重复观察请求计数稳定，没有 403/重挂载循环。
- 延迟 60 秒的旧会话失败请求期间点击退出：最终保持登录页，随后可登录 fixture-a。没有精确记录退出网络请求及旧响应完成的先后，不能将此项声称为“新账号已登录后旧响应返回”的完整竞态验收；该精确时序仍待补充。
- 权限恢复通过服务恢复后刷新/重新连接验证，未声称无刷新自动恢复权限。

## 可复现的本地夹具

只监听回环地址、只使用合成账号及记录，不使用真实凭据。两个 PowerShell 终端均进入本候选的物理路径：

```powershell
node tests/fixtures/integrationLogAccessServer.mjs
```

```powershell
$env:VITE_CMHUB_API_BASE_URL = 'http://127.0.0.1:4818'
$env:VITE_CMHUB_MOCK_API = 'false'
npm run dev -- --host 127.0.0.1 --port 4817 --strictPort
```

浏览器打开 `http://127.0.0.1:4817/admin/integration-logs`，初始身份 fixture-a。登录表单只接受 fixture-a / fixture-b，合成密码为 fixture-password。

```powershell
Invoke-RestMethod -Method Post 'http://127.0.0.1:4818/__control?mode=denied'
Invoke-RestMethod 'http://127.0.0.1:4818/__stats'
Invoke-RestMethod -Method Post 'http://127.0.0.1:4818/__control?mode=allowed&delay=0'
```

mode 另支持 expired、session-failure、contradictory；delay 为会话 GET 延迟毫秒；user 可切换合成身份，advance 增加通知游标。失效或停止后下一场景应先恢复 allowed 并刷新页面。该服务器是手工浏览器回归夹具，不是生产服务或多客户端隔离测试服务器。

## 真实环境观察与剩余门禁

- 正式站当前管理员会话已实际打开日志列表和详情：近 24 小时 859 条记录，6 条未读进入页面后变为 0，刷新后保持 0。详情显示既有上游 HTTP 422 / INVALID_LABEL_PDF。未重放业务请求、未改变账号权限。
- 上述为已部署版本的 UI 消费与已读持久化证据，不是本候选线上验收，也没有捕获完整认证 HTTP 响应结构。
- 测试前端入口：https://test.cmhubtool.com/；测试 API：https://api-test.cmhubtool.com/。前端 HTTP 200，健康检查通过且 outboundWebhooks.enabled=false。
- 但测试 API 的 `/warehouse/v1/integration-logs/notifications` 实测返回 404 ROUTE_NOT_FOUND。不能仅登录测试站就声称完成日志验收，需要先核对 staging 部署版本并补齐对应测试 API。
- 仍缺普通专用测试账号的真实撤权/恢复及账号切换验证。不要修改正式管理员权限来替代此项。
- 本候选不包含 Office 预览、司机入口、preview worker、017/018 迁移或后端变更；不得整体部署业务工作树。本轮没有部署或迁移。
