# CM-HUB 员工凭证检查器进度（2026-09-19）

基于独立候选 `72387b7`，分支 `codex/cmhub-pickup-documents-v1`。员工凭证 API 现在只在显式启用且配置不可变 SHA-256 镜像后，才注入隔离检查器；缺少配置时保留拒绝保存行为。

## 检查路径

- 新 Docker 检查镜像使用一次性网络隔离容器、只读根文件系统、非特权 UID、移除 Linux capabilities、2 GiB 内存、1 CPU、64 PID、256 MiB 私有临时盘和 75 秒硬终止。
- 镜像内用 ClamAV 查病毒，并校验 PDF、PNG/JPEG、DOC/DOCX/XLSX 格式；压缩文件大小和解包读取均受限。宏、加密内容、外部模板、活动 PDF 内容和损坏文件拒绝。
- 病毒库超过 7 天、扫描程序出错、超时或 `.xls` 请求都不会得到“干净”判定；当前 `.xls` 明确不可用并拒绝保存，直到另有通过验收的检查方法。
- 新检查镜像只接受 `mode=check`，无文件挂载或网络。Office 转换与预览仍保持延期。
- 13 项合成验收脚本覆盖现有 11 份文档样本、无害 EICAR 杀毒测试串，以及 `.xls` 故障关闭路径；报告不含文件内容或本机路径。

## 本地验证

- `services/cloud-api/npm test`：76/76 通过，0 跳过；14 份迁移校验通过。
- `npm run typecheck`、`npm run build`：通过。
- Python 沙箱脚本语法编译、Node 验收脚本语法检查、`git diff --check`：通过。
- 初次红灯：新增的适配器测试因尚无 `pickupDocumentSandbox.js` 而 TypeScript 编译失败；添加实现后回归通过。

## 尚待测试环境验收

Windows 开发机没有 Docker，故未构建或运行镜像。现有旧记录在 `tyg-api-test / ins-nm8jebfh` 上于 2026-09-15 对另一版带转换镜像完成的 11/11 合成冒烟，不证明当前检查镜像已通过。部署此候选前须重新只读确认主机身份、负载与 rootless cgroup 限制，然后在专用测试主机仅上传本候选文件和已核对摘要的合成样本，构建新镜像并运行 13 项测试。正式生产 `PICKUP_DOCUMENTS_ENABLED` 保持关闭。

本记录生成时未访问、未安装或修改远端主机，也未发布候选。
