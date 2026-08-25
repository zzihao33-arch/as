# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

仓库操作员、现场主管与负责配置打印设备的管理人员。用户在仓库的连续作业环境中，通过扫码枪快速处理包裹、匹配面单、输出标签，并在需要时生成 BOL 与处理考勤薪酬数据。

## Product Purpose

CM-HUB 将扫码、面单打印、BOL 单据与考勤薪酬处理集中在同一套运营工具中，减少人工查找、确认与重复录入。成功标准是：操作员能在不中断作业节奏的前提下，准确完成扫描、打印与留档。

## Positioning

这是一个面向现场物流操作的浏览器工作台：网页通过 QZ Tray 在操作员当前电脑上发现并调用本机打印机，同时将 Excel、PDF、扫码与单据流程串联。

## Operating Context

- Windows 电脑、Chrome 与 QZ Tray 是主要打印环境。
- 扫码枪通常以键盘输入方式工作，连续扫描需要即时的视觉和声音反馈。
- 输入来源包括 Excel 手工单、面单 PDF 文件夹、BOL 模板与月度考勤表。
- BOL 用于现场提货和归档；考勤数据用于按周计算薪酬与油补。

## Capabilities and Constraints

- 支持 Excel 映射导入、PDF 面单匹配、扫码打印、重复扫描防护和打印日志。
- 支持 QZ Tray 签名打印；浏览器不能直接枚举系统打印机，必须通过本机桥接程序。
- 支持 BOL 多渠道及对应包裹、箱数、板数的填写、预览、打印与 PDF 导出。
- 支持考勤 Excel 解析、正常/加班工时与油补计算、薪酬汇总导出。
- 打印日志需能承载至少 5,000–10,000 条数据，并以分页或虚拟化方式避免卡顿。
- 当前项目是 React 18 + TypeScript + Vite；本轮以 Arco Design React 组件库建立可渐进迁移的架构。

## Brand Commitments

- 产品名：CM-HUB。
- 保留高识别度的 CM-HUB 绿色作为运营状态和主操作色。
- 界面要适合仓库现场高频操作：信息明确、可快速扫描、弱光环境下可读、避免装饰性干扰。
- 本轮新增的结构、令牌和组件遵循 Arco Design 的颜色、间距、排版、阴影和交互规范。

## Evidence on Hand

- 现有可运行 React 项目：`src/App.tsx`、`src/BolManager.tsx`、`src/PayrollManager.tsx`。
- BOL 图形模板：`src/assets/bol-template-figma.svg`。
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
