# 空提列表读取与显示可靠性批次

## 范围

正式基线 b4a99a0；复用发布树 codex/integration-logs-release（原 HEAD b33b4a1，仅比正式多上一批记录）。从既有业务树切出进度、成功/失败显示和3处移动样式修正，补充慢请求轮询去重与显式刷新优先级。没有另建基线。

- 49,900/50,000显示99.8%，49,999/50,000显示99.9%，实际完成才100%。
- 首次未成功读取时统计为“—”，错误和空数据明确区分；静默重试保留错误，同查询刷新失败保留旧数据并说明。
- 新查询清除旧记录、计数和选择；仅最新且仍挂载的请求可以更新列表、错误和加载状态。
- 慢请求未结束时轮询不叠加、不覆盖前台请求；选中/编辑期间暂停轮询，已发出的轮询返回时也检查编辑状态。显式刷新和业务操作后的刷新仍可执行。
- 最近成功时间使用既有纽约时间格式。移动 grid-area:time 限于表格行，避免污染页面网格。

不含 clientId 组合过滤、跨页选择/批量快照、会话恢复 T1—T3、文件原件 T4、Office/T5/worker、司机入口、后端/迁移/依赖锁/工作流。其余未提交内容保留。测试站 staging 和 test 别名保持不变。

## 本地验证

- 旧版本浏览器复现：两条未完成记录均显示100%；首次503同时显示0和“当前筛选条件下没有提货记录”。新增进度单测先失败，再切入已有算法后通过。
- 发布候选34/34测试、严格typecheck、物理路径生产build通过。业务树增量同步后typecheck通过。仅既有 >500k 分包提示。
- 合成API为 tests/fixtures/airPickupListServer.mjs，回环4820；Vite回环4819，VITE_CMHUB_API_BASE_URL仅在该开发进程中设置。合成账号仅air_pickups.view，业务写请求拒绝405。
- 首次503：计数“—”，无空态；15秒静默重试期间保留错误，未每5秒叠加请求；手动重试能在旧轮询完成前成功。
- 同筛选503：保留三条旧记录和计数3，提示“当前保留上次成功同步的数据”。
- 旧失败时序：slow于17:04:58.700Z请求，fast于17:05:13.552Z已成功；手动释放旧503后仍为FIXTURE-fast，无错误、无加载状态。
- 旧成功时序：slow于17:05:32.847Z请求；latest成功后释放旧响应，仍为FIXTURE-latest，无错误。
- 挂起slow超过多个轮询周期仍只有一次请求；选择后最新请求停留17:06:30.565Z，后续检查没有继续轮询。
- 390像素截图检查真实进度与布局；320/390/768/1024/1440像素DOM宽度不超视口。浏览器用Chrome、cua_repl；未使用真实提单写操作。
- 生产构建产物不含4820合成API、测试API或FIXTURE-99字符串。
- 清除选择后重新同步，真实成功空结果显示0及空态；桌面1440截图检查正常，浏览器最终error日志为空。viewport已恢复。
- 独立只读审查完成，未发现阻止合并问题；额外运行两项空提单测及diff检查通过，没有修改工作树。

## 发布

已发布：master和远端发布分支均从b4a99a0快进至 `8b89e0e42ad31c1399365d0ad36f975d80a9b989`。本地后续仅记录文档提交，不据本地HEAD误判生产SHA。

- 独立预览 `dpl_665n1DkYDibijUMk28MK9JPbjPSs`，2026-09-18T17:09:06.717Z READY；https://as-jr2iwuras-zzihao33-8750s-projects.vercel.app/ 。
- 正式 `dpl_EfCaNEn3MXK2Ws5pnDPBic1eJVL7`，2026-09-18T17:10:40.470Z READY；cmhubtool.com和www.cmhubtool.com均绑定。预览/正式SHA精确对应8b89e0e。
- 远端入口 `index-CFH57Fgm.js`，空提chunk `AirPickupPage-rdvqjoGT.js`；预览产物确认有保留旧数据提示/暂停同步/99.9，指向正式API，不含测试API或本地fixture。远端构建哈希与本机构建不同，以实际远端部署产物为准。
- 正式HTML200，healthz ok=true、outboundWebhooks.enabled=false。带正式Origin的匿名列表请求401 SESSION_REQUIRED；无Origin请求403 ORIGIN_NOT_ALLOWED，均未放宽保护。
- 正式既有Max Zhang管理员会话重载后列表1单、凭证待补1、实际进度0/1,102正常；显示新的最近成功同步时间，浏览器入口确认新hash，最终error日志为空。只读取列表，没有修改提单或账号权限。
- staging仍为644d0de，未变更test别名或部署后端。合成浏览器标签页关闭，本轮4819/4820进程停止，响应式viewport已恢复。

当前正式回退目标：b4a99a0 / dpl_dkmRn4dwZMgZMkGqAYoW65Bzm5Rn。

## 后续

下一阶段先核对正式后端对空提clientId组合过滤、空页total与operations版本契约的支持，再切跨页批量目标或员工提货凭证。不得直接复制整个AirPickupPage/warehouseApi/SessionProvider；业务树包含未验收能力，且其日志部分落后于正式权限刷新补丁。

没有真实普通账号撤权、入库/交仓/打印或人工听音验收；本批只声称上述读取与显示覆盖。
