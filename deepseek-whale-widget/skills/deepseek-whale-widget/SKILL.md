---
name: deepseek-whale-widget
description: 在 ZCode 主窗口右下角显示透明悬浮的小鲸鱼余额挂件（随主窗口移动），也可在侧栏 MCP 面板打开；包含启动/诊断/停止本地宿主与浮层的命令。
---

# DeepSeek Whale Widget for ZCode

两条显示通道共用同一份前端与 HTTP 宿主：

1. **桌面透明浮层（主通道）**：独立 Electron 进程创建透明、无边框、不进任务栏、
   跟随 ZCode 层级的所属窗口（不覆盖其他应用），矩形紧贴 ZCode 主窗口客户区 —— 页面 `innerWidth/innerHeight`
   就等于聊天区尺寸，因此原项目前端（`assets/whale-widget.js`，未修改）的尺寸、
   吸附、菜单定位逻辑天然正确。默认鼠标穿透，指针落到鲸鱼/菜单上时才临时接管。
2. **MCP App 面板（备用/诊断）**：侧栏或对话内 iframe，普通浏览器语义。

## 自动启动

- 插件 `hooks/hooks.json` 的 `SessionStart` 调用 `lib/autostart.mjs`；
- MCP 握手成功后也会在后台调用一次 `startOverlay()`（幂等）。
- 两者共享跨进程启动锁与命令行亲缘判定，不会起第二个浮层。
- 关闭自启：设置环境变量 `DEEPSEEK_WHALE_DISABLE_AUTOSTART=1`。
- MCP 连接存活期间定期恢复异常退出；主动 stop/quit 会持久化停用状态，显式 start 才重新开启。
- `status` 的 `diagnosis` 和 `overlay-window-state.json` 区分隐藏、屏外、窗口销毁、进程退出与心跳过期。

## 手动命令（插件根目录）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-runtime.ps1 -ZCodeExe "C:\path\to\ZCode.exe" # 替换本机路径，一次性安装
node .\lib\overlay-cli.mjs start      # 启动宿主 + 浮层（已有实例则复用）
node .\lib\overlay-cli.mjs status     # 浮层 pid / 宿主健康 / 运行时版本
node .\lib\overlay-cli.mjs stop       # 只停本插件自己的浮层进程
```

先在插件配置中为 `zcode_exe` 选择本机 ZCode.exe。首次安装使用上方脚本（无需单独安装 Node），脚本通过 ZCode 内置 Node 探测 Electron 版本。普通 Node 手动命令需要已有 Node 环境；首次 setup 必须明确提供 `DEEPSEEK_WHALE_ELECTRON_VERSION`。

`setup` 优先使用 `%LOCALAPPDATA%\electron\Cache` 里与目标版本匹配的
`electron-v<ver>-win32-x64.zip`；没有缓存时下载 Electron 官方发行包并校验 SHA-256。
也可用 `DEEPSEEK_WHALE_ELECTRON_ZIP` 显式指定可信、版本匹配的官方 zip 路径。安装不会在会话 hook 内自动执行。

## 余额与 API key

余额来源（按优先级）：

1. `DEEPSEEK_API_KEY` 环境变量；
2. `%USERPROFILE%\.dsh\.zcode-whale-credentials.json` 里的
   `{ "DEEPSEEK_API_KEY": "..." }`。

没有 key 时界面显示明确错误（`NO_KEY`），**不会**显示成 0。`/dsh-whale/balance.json`
在 HTTP 出口做了严格归一化：`null` / 空字符串 / 非有限数一律返回 `code: "SHAPE"`，
避免 `Number(null) === 0` 让"读不到余额"变成"余额见底"。

## 会话 usage（仍未接入）

每轮 token 消耗 / 今日已用目前只来自原项目的本地记账（余额差推算）。
ZCode 的 `%USERPROFILE%\.zcode\cli\db\db.sqlite`（`turn_usage`）与
`rollout\model-io-<sessionId>.jsonl` 里确实有真实 usage，但**尚未接入**：
本版本没有验证过这些表/文件在不同 ZCode 版本的稳定性，为避免展示错误数字，
不读取未经验证的数据库。接入前需要先做跨版本字段核对。

## Verification

```powershell
Invoke-WebRequest http://127.0.0.1:3080/healthz      # plugin/version/routes=26
Invoke-WebRequest http://127.0.0.1:3080/dsh-whale/size.json
node --test                                          # 插件目录下运行
```

日志目录：`%USERPROFILE%\.zcode\deepseek-whale-widget\`（`host.log`、`overlay-debug.log`）。
浮层调试端口：设置 `DEEPSEEK_WHALE_DEBUG_PORT=9555` 后可用 CDP 连入。
