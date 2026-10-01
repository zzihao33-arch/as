# 考勤申诉取消 72 小时时限

状态：代码与发布补丁已完成；**尚未发布线上**。

## 改动

- 基于 `codex/payroll-rest-api` / `5ec3d689`，包含 2026-09-30 已发布的薪酬休息规则。
- 删除 `createAppeal` 中 `APPEAL_WINDOW_EXPIRED` 拦截。不论考勤记录多久以前更新，或者是否存在日汇总，都不再因超过 72 小时拒绝申诉。
- 保留其他输入、身份及审批校验。现有数据库 `expires_at` 非空字段和 API `expiresAt` 字段仅为旧结构兼容而保留，不再执行期限限制；现有前端不使用该字段拦截或展示申诉期限。
- 不迁移数据库、不修改员工考勤、不更新前端。线上只修改 `src/attendanceOperations.ts` 和 `dist/attendanceOperations.js`。

## 已完成验证

- 修改前新增回归测试：历史记录和无日汇总记录两项均复现 `APPEAL_WINDOW_EXPIRED`。
- 修改后后端完整测试 240/240 通过，22 项迁移检查通过；测试 TypeScript 编译及生产构建通过。
- 发布补丁构建与脚本语法检查通过。构建脚本对照上次实际发布包校验源码和编译产物，确认仅移除期限拦截，没有夹带其他差异。
- 尚未执行服务器预检、应用、线上历史考勤申诉验收。

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

此前通过浏览器工具访问腾讯云控制台被安全检查拒绝：`saved browser permissions could not be verified` / `Browser Use could not request permission`。没有通过其他通道绕过该限制。2026-10-01 用户调整环境后正常权限验证已恢复，并完成腾讯云登录；生产实例 `ins-dmx8z3xt`（air-cargo-server，Virginia）可见且 Running。正在继续执行预检、发布和线上验证，最终状态以实际执行记录为准。
