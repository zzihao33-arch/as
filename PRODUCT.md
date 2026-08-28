# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

上游头程物流货代系统、仓库操作员、现场主管与负责配置打印设备的管理人员。上游通过服务器接口主动推送物流数据；仓库人员通过扫码枪快速处理包裹、匹配面单、输出标签，并在需要时生成 BOL 与处理考勤薪酬数据。

## Product Purpose

CM-HUB 的目标是在美国云端保留上游物流数据和面单资产的受控副本，并将扫码、面单打印、BOL 单据与考勤薪酬处理集中在同一套运营工具中。仓库不应为日常换单再请求境内上游服务器。成功标准是：上游只需主动推送，操作员即可在不中断作业节奏的前提下准确完成扫描、打印、留档和结果回传。

## Positioning

这是一个由美国云端业务 API 与仓库浏览器工作台组成的物流工具站：上游主动推送数据和 PDF 到云端，授权仓库浏览器增量缓存面单，网页再通过 QZ Tray 在操作员当前电脑上调用本机打印机。Excel/PDF 手工导入继续作为异常情况下的兜底流程。

## Operating Context

- Windows 电脑、Chrome 与 QZ Tray 是主要打印环境。
- 扫码枪通常以键盘输入方式工作，连续扫描需要即时的视觉和声音反馈。
- 物流主来源是上游服务器主动推送并由获授权仓库增量缓存；Excel 手工单和面单 PDF 文件夹保留为异常兜底。
- 上游 API Key 只允许存在于上游和 CM-HUB 服务端，不能进入浏览器包或浏览器存储。
- 云端不直接驱动打印机；仓库网页不直接下载上游境内面单 URL。
- BOL 用于现场提货和归档；考勤数据用于按周计算薪酬与油补。

## Capabilities and Constraints

- 支持 Excel 映射导入、PDF 面单匹配、扫码打印、重复扫描防护和打印日志。
- 支持 QZ Tray 签名打印；QZ Tray 是唯一保留的本机打印组件，不使用 Node 轮询或本地打印代理。
- QZ Tray 接受请求表示“已提交”，不等于物理打印成功。
- 云端已实现上游物流单据写入/查询、PDF 主动上传、仓库登录/角色授权、增量交付、浏览器缓存、QZ 提交审计，以及带签名、重试、死信和人工重放的回调出站箱。
- 支持 BOL 多渠道及对应包裹、箱数、板数的填写、预览、打印与 PDF 导出。
- 支持考勤 Excel 解析、正常/加班工时与油补计算、薪酬汇总导出。
- 打印日志需能承载至少 5,000–10,000 条数据，并以分页或虚拟化方式避免卡顿。
- 当前项目是 React 18 + TypeScript + Vite；本轮以 Arco Design React 组件库建立可渐进迁移的架构。

## Brand Commitments

- 产品名：CM-HUB。
- 以 CM-HUB 蓝色作为主操作色；绿色只表达在线、完成等正向状态，不作为扫码核心区主色。
- 界面要适合仓库现场高频操作：信息明确、可快速扫描、弱光环境下可读、避免装饰性干扰。
- 本轮新增的结构、令牌和组件遵循 Arco Design 的颜色、间距、排版、阴影和交互规范。

## Evidence on Hand

- 现有可运行 React 项目：`src/app`、`src/features/printing`、`src/features/bol`、`src/features/payroll`。
- 云端 API：`services/cloud-api`；业务边界与目标流见 `docs/architecture.md`。
- BOL 图形模板：`src/features/bol/assets/bol-template-figma.svg`。
- QZ 签名 API：`api/qz-certificate.ts`、`api/qz-sign.ts`。
- 用户已提供的 Arco Design Figma 链接及当前功能、截图与工作流说明。

## Product Principles

1. 先让操作完成，再增强表现：关键扫描与打印路径不因重构而中断。
2. 本机能力显式可见：打印机、QZ 连接和异常恢复必须有清晰状态。
3. 高频操作少一步：快捷入口、连续扫描和数据复用优先于层级复杂度。
4. 真实数据优先：不以虚构 KPI 代替当前可用的业务信息。
5. 大数据仍保持顺畅：记录、表格与导入结果按需加载和渲染。

## Accessibility & Inclusion

键盘操作可达、清晰焦点态、文本对比度符合 WCAG AA 基线；不只依赖颜色表达打印、连接或匹配结果。
