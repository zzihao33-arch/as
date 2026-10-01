# 考勤申诉取消 72 小时时限

状态：**已于 2026-10-01 发布生产环境**。腾讯云执行记录显示成功，退出码 0；服务重载、文件哈希及健康检查通过。

## 改动

- 基于 `codex/payroll-rest-api` / `5ec3d689`，包含 2026-09-30 已发布的薪酬休息规则。
- 删除 `createAppeal` 中 `APPEAL_WINDOW_EXPIRED` 拦截。不论考勤记录多久以前更新，或者是否存在日汇总，都不再因超过 72 小时拒绝申诉。
- 保留其他输入、身份及审批校验。现有数据库 `expires_at` 非空字段和 API `expiresAt` 字段仅为旧结构兼容而保留，不再执行期限限制；现有前端不使用该字段拦截或展示申诉期限。
- 不迁移数据库、不修改员工考勤、不更新前端。线上只修改 `src/attendanceOperations.ts` 和 `dist/attendanceOperations.js`。

## 已完成验证

- 修改前新增回归测试：历史记录和无日汇总记录两项均复现 `APPEAL_WINDOW_EXPIRED`。
- 修改后后端完整测试 240/240 通过，22 项迁移检查通过；测试 TypeScript 编译及生产构建通过。
- 发布补丁构建与脚本语法检查通过。构建脚本对照上次实际发布包校验源码和编译产物，确认仅移除期限拦截，没有夹带其他差异。
- 生产只读预检通过：命令 `cmd-1aeavgk6`，执行 `inv-w9ceip0hfb`，发布前文件哈希与预期版本一致。
- 生产应用通过：命令 `cmd-pyrsx5um`，执行 `inv-w9cemr0b97`，控制台显示 2026-10-01 11:02:11–11:02:14，退出码 0。输出 `ATTENDANCE_UNLIMITED_DEPLOY={"status":"PASS","backup":"/root/attendance-unlimited-backup-spHHcq","health":true}` 及 `ATTENDANCE_RELEASE_COMPLETE=PASS`。
- 在生产服务器导入实际部署模块，以内存数据库夹具验证 `2026-09-01`、`2000-01-01` 两个历史日期，各覆盖有/无日汇总记录，四项均通过；缺少修正时间仍拒绝。此检查没有连接或写入真实数据库，不能等同于真实员工的端到端申诉验收。
- 实际 HTTP 申诉路由未登录返回 401，公网 `/healthz` 返回 `ok: true`。尚未代员工提交真实申诉；用户可刷新后重试原有申诉。

## 发布

将 `deploy/apply-attendance-unlimited-patch.mjs` 和 `deploy/attendance-unlimited-patch.json` 放入生产服务器同一目录。

先执行只读预检：

```sh
/opt/node22/bin/node apply-attendance-unlimited-patch.mjs
```

预检须显示 `ATTENDANCE_UNLIMITED_PREFLIGHT=PASS`。脚本检查实例 `ins-dmx8z3xt`、PM2 工作目录、服务健康及两个文件的完整 SHA256；任何不匹配都会停止，不能绕过版本校验。

再应用：

```sh
/opt/node22/bin/node apply-attendance-unlimited-patch.mjs --apply
```

脚本备份原文件到私有的 `/root/attendance-unlimited-backup-*` 目录，原子替换两个文件，检查 JavaScript 语法，重载 `cloud-api` 并验证健康和发布后哈希。出现代码或健康错误时自动还原原文件、重载并检查健康。实际输出中必须确认 `ATTENDANCE_UNLIMITED_DEPLOY` 为 `PASS`，不能把本地测试当作上线成功。

上线后使用真实待处理申诉验收；不要制造员工考勤或审批记录。后续人工回滚可将备份的 `src-attendanceOperations.ts`、`dist-attendanceOperations.js` 分别还原到原发布目录对应文件，并重载 `cloud-api`，验证健康。回滚前需确认没有后续发布覆盖这些文件。

## 浏览器访问恢复

此前通过浏览器工具访问腾讯云控制台被安全检查拒绝：`saved browser permissions could not be verified` / `Browser Use could not request permission`。没有通过其他通道绕过该限制。2026-10-01 用户调整环境后正常权限验证已恢复，并完成腾讯云登录；随后通过正常 Chrome 控制台完成上述生产预检、发布和验证。浏览器恢复的具体根因未被证明。
