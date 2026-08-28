# CM-HUB 物流对接

CM-HUB 物流对接负责接收上游客户的运单数据，并为仓库工作台和现场打印留存可追溯的业务记录。它不直接控制仓库电脑上的打印机。

## Language

**客户（Client）**：获授权通过服务端接口提交和查询自身物流数据的上游组织。
_Avoid_: 用户、账号、租户

**集成密钥（Integration API Key）**：归属于一个客户、具有明确作用域和独立生命周期的机器凭据。一个客户可以同时持有多把密钥以完成无中断轮换。
_Avoid_: 登录密码、访问令牌

**入站消息（Inbound Message）**：上游一次写入尝试的不可变接收记录，包含原始载荷、载荷哈希、幂等键和已提交响应；它与可持续更新的物流单据分离。
_Avoid_: 物流单据、Redis 缓存

**物流单据（Shipment）**：以头程单号为核心标识、可关联末端快递单号和面单文件的单个包裹记录。
_Avoid_: 订单、面单文件

**头程单号（First-leg Tracking Number）**：上游或头程承运商用于识别物流单据的业务单号。
_Avoid_: 运单号（当上下文不明确时）

**上游订单号（Upstream Order ID）**：上游系统对订单的参考标识；它关联物流单据，但不替代用于扫码匹配的头程单号。
_Avoid_: 头程单号

**末端快递单号（Courier Tracking Number）**：末端承运商用于投递和面单匹配的快递单号。
_Avoid_: 转单号、参考单号（除非该客户模板明确如此命名）

**上游面单源（Upstream Label Source）**：上游为某一物流单据附带的兼容来源元数据；CM-HUB 云端和仓库均不抓取，不是下载合同。
_Avoid_: 仓库面单 URL、打印地址

**CM-HUB 面单资产（CM-HUB-owned Label Asset）**：由上游主动上传并经 CM-HUB 校验、私有保存，可在授权后进入仓库缓存的 PDF。
_Avoid_: 上游面单源、PDF（文件格式不是业务实体）

**仓库用户（Warehouse User）**：使用内部邮箱和密码登录 CM-HUB 工作台的自然人身份；它不等于上游客户，也不持有上游集成密钥。
_Avoid_: 客户、API 用户

**仓库成员关系（Warehouse Membership）**：把仓库用户关联到一个仓库及 `OPERATOR`、`SUPERVISOR`、`ADMIN` 角色的授权事实。
_Avoid_: 浏览器权限、上游作用域

**工作站（Workstation）**：仓库用户登录后登记的浏览器安装实例，用于关联本机 QZ 提交审计；工作站标识不是认证凭据。
_Avoid_: 打印代理、API Key

**上游原始载荷（Upstream Raw Payload）**：某次订单写入请求完整、未改写的 JSON 报文快照，用于对账、排错和兼容未定义字段；它不是面向现场打印的读取模型。
_Avoid_: 扩展字段、打印字段

**打印提交（Print Submission）**：现场工作站把面单交给本机打印链路的一次可审计事实；它不等于纸张已成功输出。
_Avoid_: 打印成功、已出纸

**物理打印确认（Physical Print Confirmation）**：由打印机可靠回执或人工核验支持的纸张输出事实。
_Avoid_: QZ 已接受、请求已提交

**上游结果通知（Upstream Result Notification）**：由 CM-HUB 产生并交付给上游的物流处理结果。
_Avoid_: 上游打印事件、上游状态写入

**QZ Tray 打印适配器（QZ Tray Print Adapter）**：运行在 Windows 仓库电脑的 QZ Tray 客户端，由网页通过本机 WebSocket 调用真实打印机。
_Avoid_: 云端打印服务、本地 Node 打印代理
