# 云端 PDF 取消浏览器持久化缓存（2026-09-25）

## 修改
- 每次云端打印重新下载 PDF，请求 cache: no-store；保留 PDF 头、长度、SHA-256 校验。
- 不读写 cloudLabels，不使用旧缓存兜底；下载失败直接停止本次打印。
- 删除已停用的浏览器全量同步 hook 和相关死代码。服务器实时查号、打印前版本复查、实时拦截和防重复打印保持原流程。
- 进入扫码页后台调用既有 clearWarehouseLabelCache，按 warehouseId 清理旧云端 PDF；失败被捕获，不阻断线上打印。
- 不清除打印记录、审计队列、手工导入文件、共享批次或其他仓库缓存。
- PDF File/Base64 为单次异步打印调用的局部值，没有加入 React state/ref 或数据库；调用结束后由浏览器回收内存。QZ 自身队列生命周期由 QZ 管理。

## 验证
- 新增无缓存行为及 HTTP cache 测试，已先确认旧实现失败，再修改通过。
- npm test：54/54；npm run typecheck：通过；npm run build：通过（已有大包警告）。
- 构建需使用实际路径 C:/Users/ZIHAO ZHANG/Desktop/代码/as/.worktrees/tyg-live-scan-ui；Desktop/as 别名会导致 Vite HTML 输出路径报错。
- 浏览器回归页已更新，尚未执行：浏览器工具无法核验已保存访问权限，拒绝访问本地测试页。未绕过权限控制，未触发实体打印机。

## 发布与回退
- 前端基线 master 233b556d，与正式域名部署 dpl_CXeKdX4x5TgEpj5wMWDVaqwQ1P12 一致。
- 只发布前端，不修改生产后端/数据库。
- 回退可恢复上述 Vercel 部署。旧缓存属可重新下载的云端 PDF，清理不会删除服务器源文件。
- 生产发布最终状态见主目录 docs/TYG-active-context.md。
