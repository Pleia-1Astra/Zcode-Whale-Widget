# 点击穿透与交互状态自愈修复验证

版本：0.4.2-zcode.17。日期：2026-10-26。

## 修复范围

- `assets/whale-widget.js`：导出复用现有 alpha 判定的 `window.__dshWhaleHitTest(x, y)`，排除隐藏/透明/未加载状态；修正水平翻转首列读到第 610 列的问题。保留既有图像读回失败时的图片矩形降级，不扩大为整窗命中。
- `assets/overlay-bridge.js`：现有 200ms 光标消息驱动重新命中；接管状态 600ms 续租、穿透状态每秒重申，失配回执触发有界重试；发送失败不缓存成成功。跨几何纪元、尺寸与显隐清除旧命中点，8px 边缘迟滞最长 300ms。
- `desktop/interaction-guard.cjs`：新增确定性纯逻辑控制器。仅在原生调用成功后更新已应用状态，每秒重新应用同值状态；调用失败从 250ms 起指数退避，最高 2s。无接管续租 1.5s 后，下一个 200ms tick 尝试恢复穿透；原生 API 持续报错时继续退避重试，不声称必然成功。
- `desktop/main.cjs`：接入控制器，隐藏期间仍运行释放重试；光标附带已应用状态、成功标志与几何纪元，按 Electron zoomFactor 把 DIP 转为 CSS 坐标；诊断 JSON 增加不含凭据的 `input` 状态。
- `desktop/preload.cjs`：保留最小桥接面，复用原有 cursor 消息传回执，无新增 Node 权限。
- package、插件清单与原市场条目版本同步为 .17，保留 .16 安装器等既有修改。未改余额配置或 NO_KEY 行为。

## 自动化验证

独立测试执行者在插件根目录对最终代码实际执行：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --test` | 0 | 212 通过，0 失败、0 跳过，约 7 秒 |
| `node --check assets/overlay-bridge.js` | 0 | 通过 |
| `node --check assets/whale-widget.js` | 0 | 通过 |
| `node --check desktop/main.cjs` | 0 | 通过 |
| `node --check desktop/preload.cjs` | 0 | 通过 |
| `node --check desktop/interaction-guard.cjs` | 0 | 通过 |

新增 11 项行为测试（`overlay-interaction.test.mjs` 7 项，`overlay-visibility.test.mjs` 4 项），覆盖：静止光标续租/丢失消息重试、发送抛错重试、显隐与几何纪元清理、迟滞过期、原生同值漂移纠正、失败回执/退避、渲染断流自动释放与恢复、隐藏时释放失败后的重试，以及负坐标屏幕和 zoomFactor 换算。命中测试执行实际函数代码，覆盖缩放、透明像素、翻转首列与隐藏状态。

开发自检时一个像素坐标断言因浮点计算向下取整得到 49 而非预期 50 失败，核对真实计算后修正断言；最终全量独立复跑通过，没有跳过失败用例。

## 真实页面验证

使用 `tests/manual-ui-host.mjs` 的隔离本地宿主、无私人凭据/无真实厂商余额调用，在 ZCode 内置浏览器加载源码页面：

- 真实鲸鱼 PNG 加载成功，原图 610×610。
- 对图像矩形内 20×20 网格调用实际页面导出的命中函数，262 个点命中、138 个点未命中；页面外部点 `(10,10)` 返回 false，证明未退化为整块矩形/整窗接管。
- 通过真实按钮点击打开“提示与音效设置”面板，页面出现标题、取消/保存等控件。
- 本次临时页面和宿主已关闭，未修改生产实例。

该验证不是原生 Windows 鼠标穿透的端到端点击验证；浏览器页面没有真实 Electron preload。

## 原生隔离冒烟

使用现有只读共享 Electron runtime、独立数据/profile/端口运行 `tests/manual-native-smoke.mjs`。最终代码运行 10 秒，退出码 0：

- MCP 初始化、独立 HTTP 宿主、浮层与 Win32 跟随器成功启动。
- 负坐标副屏 bounds 为 `x:-1748,y:285,width:1505,height:800`，心跳显示 `shown:true,nativeVisible:true,opacity:1,offscreen:false`。
- `input` 显示 `desired:false,applied:false,verified:true,failures:0,geometryEpoch:1`；后续心跳 `appliedAt` 前进，证明同值原生重申持续执行。
- 脚本结束时停止自己的浮层和宿主，移除自己的 runtime junction，未停止生产挂件。

最终原生证据保留在本机临时目录 `C:\Users\Administrator\AppData\Local\Temp\whale-native-IZ66yf`，不随插件分发。

## 验收结论与限制

源码修复及自动化回归通过，页面真实命中/面板验证和短时原生启动验证通过。未完成长时间多屏/DPI 反复移动压测，也未声称排除所有可能的操作系统/Electron 卡顿。已识别的状态失步具有重试和失联释放机制，不依赖用户每次手动重启。

市场名仍为 `dev-deepseek-whale-widget`，完整插件 ID `deepseek-whale-widget@dev-deepseek-whale-widget`。源码和市场清单已准备，已安装副本没有被直接覆盖，插件更新与新任务实机验收待用户完成。

更新：在“插件市场 → 市场源”刷新原市场，再到“个人”更新至 .17。市场根目录是 `D:\EXE\ZCode\余额挂件\plugins`，不是插件子目录；不需要重复添加已有市场。若本机尚未添加，使用“插件市场 → 添加 → 添加插件市场”填写该根目录。保留原启用状态，可在“设置 → 插件”核对版本。

新任务试用提示：“检查余额挂件状态并显示挂件”。预期宿主报告 .17；随后跨屏移动、最小化恢复并反复打开/关闭菜单，鲸鱼本体可操作、透明区不阻挡 ZCode。此项真实安装后验收尚未执行。
