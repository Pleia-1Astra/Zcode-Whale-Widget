# 余额挂件刷新与交互稳定性修复

版本：0.4.2-zcode.15。日期：2026-10-26。

## 确认的问题及触发条件

### 1. 隐藏队列破坏 fetch 的取消语义

`assets/overlay-bridge.js` 在浮层隐藏期间暂存 `/dsh-whale/` 请求，却不监听 AbortSignal。请求在隐藏期间超过余额的 25 秒超时或模型列表的 40 秒超时，Promise 仍不结束。余额 `refresh()` 的 finally 因而不能释放 busy。恢复显示时旧代码又删除已取消的信号，将过期请求重新发出；若此时宿主不返回，请求已失去原有超时保护。

修复：同时支持 init.signal 和 Request.signal，已取消的请求立即拒绝；排队期间取消即移除队列项并拒绝 Promise；恢复时解除队列监听并保留原请求参数和信号。没有取消的请求继续按原顺序恢复，隐藏暂停和可见时补刷行为不变。

### 2. 模型列表旧请求误释放新刷新锁，退避重试越过代次边界

`assets/whale-widget.js` 中 GET 尚未返回时，POST 保存可以更新列表、释放 loading 并允许下一次 GET。旧 GET 随后返回或失败，会无条件清除新 GET 的 loading 并提前唤醒其等待者，导致重复请求。另一个时序是 GET 失败排定重试后，POST 保存已成功，旧重试仍然启动并取得新的请求代次。

修复：记录持有 loading 的 GET 代次；过期回包只能释放自己持有的锁。退避定时器执行前重新检查代次，已被取代则不发请求。不改变现有重试次数、间隔、失败限频、余额失效显示或保存语义。

### 3. 页面生命周期未释放旧输入接管

`desktop/main.cjs` 在页面重新加载或渲染进程退出时没有释放旧页面申请的鼠标、键盘接管。旧菜单已经消失，但透明窗口仍可能继续接管点击或保持可激活。新桥接实例的初始状态也与主进程遗留状态不一致。

修复：在 did-start-loading 和 render-process-gone 释放旧输入接管并标记页面未就绪；加载完成后应用最近的跟随状态，没有跟随消息时也发送当前可见性。未新增重载或刷新机制，保留原有异常恢复机制。

## 改动范围

业务代码仅三个文件：
- assets/overlay-bridge.js
- assets/whale-widget.js
- desktop/main.cjs

回归用例：
- tests/overlay-bridge.test.mjs
- tests/api-models-refresh.test.mjs
- tests/overlay-visibility.test.mjs

同步 package.json、.zcode-plugin/plugin.json、../marketplace.json 版本号。未修改安装缓存、用户凭据、余额账本、界面样式或生产运行进程。

## 验证证据

运行环境：Windows，Node v24.22.1。

1. 修改前相关三个测试文件：49/49 通过，说明旧测试未覆盖这些边界。
2. 新增取消和生命周期用例在修复前出现 7 项预期失败，包括实际 refresh 函数 busy 无法释放。
3. 新增响应乱序和退避竞态用例在修复前出现 3 项预期失败。
4. 修复后相关用例全部通过，并补充恢复后的悬挂请求仍能取消、Request 信号覆盖等验证。
5. 完整自动化测试：179/179 通过，退出码 0，无跳过。命令：

```text
# Run from the deepseek-whale-widget directory
node --test
```

最后一次全量运行使用 `--test-reporter=dot`，同一测试集合通过。

6. 三个修改的业务脚本均通过 `node --check`。
7. 插件清单、package、市场版本一致，目录名称与插件身份一致；技能、命令、hook、MCP 入口存在且位于插件目录内。此项是本地结构检查，不代表执行过 ZCode CLI schema 校验。
8. 全量测试包含真实隔离 HTTP 宿主（26 条路由）、MCP 握手、余额解析、模型保存、单实例与恢复测试。输入接管、页面生命周期和 1000 次窗口切换为模拟 Electron/DOM 测试，不是真实桌面 GUI 长期压测。

## 安装与真实环境验收边界

源码：仓库中的 `deepseek-whale-widget/`。
市场根目录：仓库根目录（添加市场时填写本机克隆路径）。
市场清单：仓库根目录下的 `marketplace.json`。
市场名：`dev-deepseek-whale-widget`。
完整插件 ID：`deepseek-whale-widget@dev-deepseek-whale-widget`。

源码修复不会热更新正在运行的安装副本。请在插件市场的齿轮 → 市场源中刷新现有 dev-deepseek-whale-widget，再到个人页更新插件并确认版本 0.4.2-zcode.15；也可在设置 → 插件查看已安装状态。尚未添加市场时，在插件市场 → 添加 → 添加插件市场填入上述市场根目录，再安装。本次没有替用户执行这些操作。

更新后可在新任务选择鲸鱼插件技能，发送：“检查余额挂件状态并显示挂件”。验收场景：正常刷新；网络慢或请求失败后恢复；最小化超过 40 秒再恢复；刷新过程中保存模型配置；打开菜单和输入框后经历页面恢复，再确认点击、输入和鼠标穿透正常。预期不用手动刷新页面即可继续工作；真实上游失败仍按原有错误/占位语义显示，不伪造余额。

没有事故发生时间、操作录像或现场日志，不能断言这三处代码缺陷涵盖用户遇到的所有卡死原因。本次已复现并修复的是可确定的代码路径，不是对实际现场的完整复现；安装更新和真实桌面长时运行验收仍待完成。

若更新后仍出现问题，需要补充：
- 发生前是否最小化、切换显示器/DPI、休眠唤醒，是否正打开菜单/编辑模型；
- 选择的余额厂商、网络状态、开始异常的大致时间与持续时长；
- 是画面动画也停止、仅余额不更新，还是菜单/拖动/输入无法操作；恢复窗口后是否自行恢复；
- `%USERPROFILE%\.zcode\deepseek-whale-widget\overlay-debug.log`、`host.log` 中故障前后约两分钟，以及 `overlay-window-state.json`。使用自定义 ZCODE_HOME 或 DEEPSEEK_WHALE_DATA_DIR 时以实际数据目录为准。

分享日志前隐藏 API Key、Authorization、账号和余额等敏感信息；不要提交凭据文件或带关停令牌的 host.json。
