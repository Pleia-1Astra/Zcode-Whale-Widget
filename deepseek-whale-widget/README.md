# DeepSeek Whale Widget for ZCode

把原项目 _DeepSeek-Balance-Whale-Widget_ 移植为 **ZCode 桌面悬浮挂件**：
透明、无边框、不进任务栏的小鲸鱼，紧贴 ZCode 主窗口客户区右下角，
随主窗口移动/缩放及层级变化：在 ZCode 上方，但会被覆盖 ZCode 的其他应用正常遮挡。
主窗口最小化或不可见时隐身，恢复时重新显示，主窗口退出时浮层随之退出。
当前 ZCode 不支持 `SessionEnd` hook，因此不会承诺会话结束后自动关闭独立 HTTP 宿主；
需要释放宿主时可使用 CLI `stop-host`（仅通过本插件令牌关停）。

同时保留侧栏 **MCP App 面板**作为备用/诊断入口。

## 架构

```text
SessionStart hook (hooks/hooks.json) ─┐
MCP 握手后后台自启 (lib/mcp-server.mjs) ─┴─> lib/overlay-manager.mjs
                                              ├─ 单实例 / 启动锁 / 命令行亲缘判定
                                              ├─ HTTP 宿主健康等待（plugin+version）
                                              └─ Electron runtime（~/.zcode/deepseek-whale-widget/desktop-runtime）

Electron overlay (desktop/main.cjs)
   ├─ 透明 BrowserWindow（紧贴 ZCode 客户区）
   ├─ desktop/follow-window.ps1（Win32 客户区矩形 + 显示/最小化判定）
   ├─ desktop/preload.cjs（最小 IPC 面）
   └─ 加载 http://127.0.0.1:3080/?overlay=1
          ├─ /dsh-whale/widget.js       前端（保留上游界面/交互，另有本移植的最小适配）
          └─ /overlay/bridge.js         浮层专用：鼠标穿透 / 键盘焦点 / 点击重放

HTTP 宿主 (lib/server.mjs)
   └─ 复用 lib/index.js 的 26 条 /dsh-whale/* 与 lib/accounting.mjs
```

### 为什么用「客户区大小的窗口」而不是「覆盖工作区 + 页面自算视口」

上游前端本身不是可改动的第三方包，它的鲸鱼尺寸/吸附/菜单位置全部基于
`window.innerWidth/innerHeight`。参考实现（zcode-fox-local）的做法是让浮层
覆盖整个工作区，再用 IPC 把 ZCode 窗口矩形作为"逻辑视口"推给页面 —— 那要求
前端专门适配（fox 的 widget.js 里有一整套 `overlayBridge` 逻辑）。

本移植改为让 **浮层窗口矩形 = ZCode 客户区矩形**（物理像素 → DIP），于是页面
`innerWidth/innerHeight` 天然等于聊天区尺寸，原 JS 不需要任何改动。代价是
每次 ZCode 移动/缩放都要 `setBounds`（跟随脚本 40ms 一次，只在变化时调用）。

## 目录

```text
.zcode-plugin/plugin.json   清单（version 0.4.2-zcode.16，hooks，MCP，ui.surfaces）
hooks/hooks.json            SessionStart（当前宿主不支持 SessionEnd）
lib/index.js                原项目宿主逻辑（本移植保留上游行为；仅按需做最小适配，见文末「与上游的差异」）
lib/accounting.mjs          原项目记账内核（受保护，字节不变）
lib/server.mjs              HTTP 宿主适配（26 路由 + overlay 页面 + 余额归一化）
lib/mcp-server.mjs          MCP server（ui.csp、自动启动、状态工具）
lib/overlay-manager.mjs     运行时安装 / 宿主健康 / 单实例 / 启停
lib/overlay-cli.mjs         手动诊断命令
lib/autostart.mjs           SessionStart hook 入口
lib/paths.mjs               产品标识与路径（唯一来源）
lib/balance-normalize.mjs   余额出口归一化（纯函数）
desktop/main.cjs            Electron 主进程
desktop/preload.cjs         contextBridge
desktop/follow-window.ps1   ZCode 客户区跟随（C# 内联，40ms）
desktop/window-bounds.cjs   坐标 / DPI / 钳制（纯函数，可单测）
assets/whale-widget.js      原项目前端（本移植保留上游界面与交互；仅按需做最小适配，见文末「与上游的差异」）
assets/overlay-bridge.js    浮层专用桥接脚本（独立文件）
tests/                      自动测试
```

## 新电脑安装

支持 Windows 10/11 x64 与安装了 ZCode 的交互式桌面。插件不需要单独安装 Node 或 npm 包；Electron 浮层运行时首次安装时从 Electron 官方 GitHub 下载，并校验发行版 `SHASUMS256.txt`。需要能访问 `github.com`，后续启动使用本机缓存。余额查询还需要能访问所选服务商接口。

1. 克隆本仓库，并在 ZCode 的插件市场中添加克隆目录下的 `marketplace.json` 所在目录：

   ```powershell
   git clone https://github.com/Pleia-1Astra/Zcode-Whale-Widget.git
   ```

2. 在市场中安装 `deepseek-whale-widget`。
3. 打开插件配置，给 `zcode_exe` 选择**这台电脑实际安装的 `ZCode.exe`**。此路径是本机配置，不写入仓库；未配置时 MCP 与 hook 无法启动。
4. 在插件源码目录运行一次安装命令。请用 ZCode.exe 内置的 Node 运行，确保自动探测到与宿主匹配的 Electron 版本：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-runtime.ps1 -ZCodeExe "C:\path\to\ZCode.exe"
   ```

   将示例路径替换为本机 ZCode.exe 路径，并先切换到克隆仓库中的 `deepseek-whale-widget` 目录。setup 优先复用匹配的缓存；没有缓存时会下载官方 Windows x64 zip 到插件用户数据目录并校验 SHA-256。若网络策略阻止 GitHub，可预先取得同版本官方 zip，再设置 `DEEPSEEK_WHALE_ELECTRON_ZIP`。
5. 在 ZCode 中完全退出并重新启动，然后运行插件的 `status` 命令或鲸鱼状态工具。`installed` 与 `hostHealth.ok` 应为 `true`。
6. 若要显示余额，在本机凭据文件中配置对应服务商的 key；凭据、账号标识和余额数据不要放进仓库。默认凭据路径见下文“配置”。

安装不需要管理员权限。默认 HTTP 端口为 `3080`，必须未被其他服务占用。浮层跟随器依赖 Windows PowerShell 和 Win32 桌面窗口；无交互式桌面、精简掉 PowerShell/.NET 的系统不在支持范围内。

开发或手动恢复时也可在插件目录执行：

```powershell
node .\lib\overlay-cli.mjs setup
node .\lib\overlay-cli.mjs status
```

如直接用普通 Node 执行 setup，必须显式设置 `DEEPSEEK_WHALE_ELECTRON_VERSION` 为这台 ZCode 所用的 Electron 完整版本号。也可通过 `DEEPSEEK_WHALE_ELECTRON_ZIP` 提供与版本、平台和架构匹配的官方压缩包。显式提供的 zip 和系统 Electron 缓存是用户信任的本地输入，安装器检查匹配文件名与完整性，但不把这些文件的来源视为已验证；请自行从官方发行页下载并校验。

手动查询 ZCode 内置 Electron 版本或在未安装 Node 的电脑上运行诊断：

```powershell
$previous = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = '1'
  & "C:\path\to\ZCode.exe" -p "process.versions.electron"
  & "C:\path\to\ZCode.exe" .\lib\overlay-cli.mjs status
} finally {
  $env:ELECTRON_RUN_AS_NODE = $previous
}
```

需要强制重装时在 `setup-runtime.ps1` 命令后加 `-Force`；请先停止本插件的浮层，避免 Windows 对运行中的 exe 加锁。断网不影响已安装运行时启动，但余额刷新仍依赖服务商网络。

### 网络受限时离线安装

自动下载使用 Node 的 HTTPS 连接；某些企业代理、证书策略或网络环境可能允许浏览器下载但阻止 Node 连接。此时不要关闭 TLS 校验。

1. 用上面的命令查询本机 ZCode Electron 版本 `x.y.z`。
2. 在另一可联网环境访问 `https://github.com/electron/electron/releases/tag/vx.y.z`（替换版本），下载 `electron-vx.y.z-win32-x64.zip` 与同页 `SHASUMS256.txt`。
3. 执行 `Get-FileHash "C:\Downloads\electron-vx.y.z-win32-x64.zip" -Algorithm SHA256`，确认与清单中**同名文件**的摘要一致。
4. 将校验通过的 zip 放到目标电脑，在插件目录执行（替换路径与版本）：

   ```powershell
   $previousZip = $env:DEEPSEEK_WHALE_ELECTRON_ZIP
   try {
     $env:DEEPSEEK_WHALE_ELECTRON_ZIP = "C:\Downloads\electron-vx.y.z-win32-x64.zip"
     powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-runtime.ps1 -ZCodeExe "C:\path\to\ZCode.exe"
   } finally {
     $env:DEEPSEEK_WHALE_ELECTRON_ZIP = $previousZip
   }
   ```

显式 zip 不存在或文件名与目标版本/架构不符时，安装器明确失败，不会擅自回退联网下载。未安装成功时不会触发浮层；会话 hook 不执行下载或解压。

## 使用

正常情况下新开一个 ZCode 任务即可，浮层会自动出现。手动兜底：

```powershell
node .\lib\overlay-cli.mjs start
node .\lib\overlay-cli.mjs status
node .\lib\overlay-cli.mjs stop
```

交互：默认整窗鼠标穿透（不挡聊天）；指针移到鲸鱼或菜单按钮上时临时接管；
打开菜单/面板期间整窗接管，点击界面外会收起菜单并把这**一次**点击重放给 ZCode。
菜单里的文本框需要键盘时临时把窗口变成可激活，关闭面板后立即交还前台。

### 标题名称与谷价显示（0.4.2-zcode.10）

入口：桌宠菜单 → 音效与提示 → **音效/提示泡泡设置** → 底部余额厂商选项下方。

- **标题名称**：输入最多 80 个字符，保存后替换普通余额卡的标题；留空沿用原有标题。按纯文本显示，不解析 HTML。
- **谷价显示**：按钮明确显示“已开启 / 已关闭”，点击切换；默认开启，关闭时只隐藏普通余额卡中的峰谷状态及倒计时。
- 两项与原有设置一起保存，取消不生效，恢复默认只改缓冲（标题为空、谷价显示开启），点击保存后才持久化。
- 显示设置不修改气泡配置原文，不影响金额来源、币种、计价、记账、今日已用或系统提示；余额厂商与显示设置可以独立更新而不会互相清空。

验收：标题设为“我的钱包”，关闭谷价并保存 → 点击桌宠，标题应为“我的钱包”，峰谷标识与倒计时隐藏，余额和今日已用保持；重新开启后恢复峰谷显示；刷新/重启后选择保留。

### 点击桌宠显示的余额厂商（0.4.2-zcode.9）

「提示与音效设置」底部新增一行精确标签 **「点击桌宠显示的余额厂商」**：

- 选项只来自 `/dsh-whale/api-models.json` 的 `models`（你在「模型」里**真正接入**的厂商），
  模板里还没添加的厂商**不会**出现；第一项固定是「默认（DeepSeek）」。
- 选中后，**点击桌宠**时普通气泡里的通用余额模块（默认模板里的 `{balance_ds}`）改为显示该厂商的余额；
  选「默认」或留空 = 与旧版完全一致（空 ID / 内置 DeepSeek / id 已删除或不在列表里都会自动回默认）。
- 只影响这一处取数：DeepSeek 主余额、`balance.json`、账本、提醒、每轮消耗、显式指定厂商的模型模块、
  赠金（`{bonus_ds}`）与充值余额（`{recharge_ds}`）全部保持不变。
  旧版 **「余额内容」**（kind=normal，三行布局）的余额、标题与「今日已用」也会跟随选择；
  自定义内容中的文字及显式指定厂商的模块不改写。
- 金额格式/币种沿用既有 `apiModelBalanceText()`：0 显示 `¥ 0.00`；无余额接口、读取失败、字段缺失显示 `—`，
  **不会**伪装成 0。
- 「今日已用」同样跟随所选厂商（金额与币种由宿主按该模型下发：余额差＝厂商币种，会话事件＝CNY）。
  以下三种「还无法确定该显示谁」的情况一律显示 `—` 占位，**绝不**用 DeepSeek 的今日已用冒充：
  ① 读取配置（`usage-settings.json`）的请求尚未完成或失败 —— 此时无法判断用户是否已选厂商；
  ② 配置已确认选了厂商、但模型列表**首次加载尚未完成**；
  ③ 整次刷新失败（stale）。
  只有在**成功确认**配置为空 / 内置 DeepSeek / 已删除或未知 id 时，才恢复旧回退，显示 DeepSeek 的今日已用。
- 已选择厂商时，点击会顺带刷新一次模型余额（同一 10 秒窗口内复用已有请求/缓存，避免连点造成请求风暴）；
  回包只更新**仍然打开**的余额气泡（含旧版三行布局），不重开已关闭的气泡、不重置点击序列，旧回包也不会覆盖后来的选择。
  选「默认」时不额外请求。
- 保存语义与面板其它项一致：打开时只用内存缓冲，点「保存」才 `PUT /dsh-whale/usage-settings.json`
  （键 `settings.petBalance.modelId`）；「取消」不写盘；「恢复默认」回到 DeepSeek。
  未改过这一项时保存**不会**写入该键，旧用户的 `usage.json` 结构不变。

验收路径：先在「模型」里接入至少两个厂商 → 打开「提示与音效设置」，把该行切到厂商 A 保存 →
点击桌宠，第一次点击气泡里的余额应为厂商 A；再切到厂商 B 保存并点击 → 变为 B；选回「默认」→ 恢复 DeepSeek。
把厂商 B 在「模型」里删除后再次点击 → 自动回默认，且面板该行显示「默认（DeepSeek）」。

### 窗口层级与异常退出恢复（0.4.2-zcode.14）

不再设置全局 always-on-top/screen-saver 层级。Win32 跟随器将浮层设为 ZCode 的 owned window，
以 NOACTIVATE / NOOWNERZORDER 同步到 ZCode 正上方，不提升宿主，也不抢前台。
其他应用盖住 ZCode 时同样盖住桌宠；只切换焦点但未遮挡该区域时，桌宠不会被隐藏。
仍保留最小化、不可见、cloaked、宿主窗口丢失时隐藏，以及相同矩形恢复的补发逻辑。
最小化窗口按还原尺寸参与主窗口识别，且保留已跟随的最小化主窗口，防止误选 ZCode 的常驻小窗，
把桌宠移到 250×64 等小区域。延迟释放键盘前复查是否重新获得输入，避免快速重开文本框时失去键盘。

HTTP 宿主和桌面代码从内容寻址的 `app-snapshots` 运行，避免插件更新删除旧缓存后 preload、
跟随脚本及素材失效。MCP 连接存活期间每 15 秒检查，异常进程退出/宿主失联时经原有启动锁恢复；
失败指数退避，最多间隔 5 分钟。主动 stop/quit 将 `overlay-preference.json` 写为 disabled，
自动启动和恢复都尊重该状态；只有显式 start 再开启。最小化等正常隐藏不触发重启。
恢复依赖仍存活的 MCP 连接，不能保证恢复整个 ZCode/MCP 同时终止的情况。

每 5 秒写 `overlay-window-state.json`：进程、可见状态、透明度、边界、是否完全屏外、跟随器及隐藏原因。
日志增加进程开始/退出、异常、窗口销毁、应用退出、主动停止和 HTTP 宿主关停原因。
`status` / `whale_status` 区分 process-exited、hidden、offscreen、window-destroyed 和 stale 状态。
没有正常退出日志但 PID 已死时，只能确认非正常退出，不能凭空断言外部终止者。

源码修改不会热更新已安装副本。在插件市场“市场源”中刷新
`dev-deepseek-whale-widget`（源目录为本仓库根目录，即 `marketplace.json` 所在目录），
然后在“个人”中更新到当前清单版本，完全退出并重新启动 ZCode。

验收：连续切换 ZCode、浏览器、文件管理器等应用至少 50 次；其他窗口应正常遮挡桌宠，
切回 ZCode 后菜单、文字输入及鼠标穿透应正常。最小化应隐藏，恢复应显示。
持续运行至少 30 分钟并检查状态；主动停止后等待 30 秒不能自动复活，显式 start 才恢复。

可复现隔离验证（开发环境已有 Node/Electron 时）：
`node tests/manual-native-smoke.mjs <已有 desktop-runtime 绝对目录> 1800000`。
该脚本使用临时数据、独立端口和 profile，不读取真实凭据，结束后停止自己的进程并保留日志。
用 `tests/inspect-native-window.ps1 -Hwnd <日志中的 hwnd>` 只读检查 owner、topmost 和 Z 序；
预期 owner 是 ZCode、topmost=false，overlayRank 比 ownerRank 小 1，覆盖应用 rank 更小。
故障注入仅限隔离实例：终止其 overlay.json 和 host.json 记录的 PID，约 15 秒后应换 PID 恢复；
切勿终止真实应用或无关 Electron。测试目录写入 `finish` 文件可提前结束。

## 配置

| 环境变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | — | DeepSeek API key（优先） |
| `ZCODE_WHALE_PORT` | `3080` | HTTP 宿主端口（不要同时运行两个实例） |
| `DEEPSEEK_WHALE_MARGIN` | `0` | 浮层相对客户区内缩的 DIP（0 = 完全重合） |
| `DEEPSEEK_WHALE_FOLLOW_INTERVAL_MS` | `40` | 跟随探测间隔 |
| `DEEPSEEK_WHALE_DISABLE_AUTOSTART` | — | `1` 关闭 hook 自启 |
| `DEEPSEEK_WHALE_DEBUG_PORT` | — | 设置后开启 CDP 调试端口 |
| `DEEPSEEK_WHALE_DATA_DIR` | `~/.zcode/deepseek-whale-widget` | 数据/运行时目录 |
| `DEEPSEEK_WHALE_ELECTRON_ZIP` | — | 指定 Electron 缓存 zip |

API key 也可写进凭据文件。默认路径由 `lib/server.mjs` 决定：

```text
%ZCODE_CREDENTIALS_FILE%  或  $DSH_HOME\.zcode-whale-credentials.json
DSH_HOME 默认 %USERPROFILE%\.dsh  ⇒  %USERPROFILE%\.dsh\.zcode-whale-credentials.json
```

```json
{ "DEEPSEEK_API_KEY": "sk-...", "A6API_API_KEY": "sk-..." }
```

其它厂商的 key（如 `A6API_API_KEY`）同样只写在这个凭据文件里，
由「模型」面板里对应厂商模板的 `keyRef` 引用；模板下发的余额接口地址是内置默认值。

### A6API：余额是「账户余额」，不是令牌余额

**要点：`GET /api/usage/token/` 里的 `total_available` / `unlimited_quota` 是令牌（token）额度，
不是账户余额。** 令牌 `unlimited_quota=true` 也不代表账户无限。旧版本把它当账户余额显示，
所以 UI 一直是 `--`（或错误地声称无上限）——这是错的，v0.4.2-zcode.5 已修正。

A6 现在只认账户口径，两条路径（按优先级）：

1. **账户访问令牌 + 用户 ID（推荐，真正可用的账户余额路径）**
   在凭据文件里**成对**配置（只写在凭据文件，不进模型参数、不进源码）：

   ```json
   { "A6API_ACCOUNT_ACCESS_TOKEN": "<A6 控制台的访问令牌>",
     "A6API_ACCOUNT_USER_ID": "123" }
   ```

   实际落盘位置（同上）：`%ZCODE_CREDENTIALS_FILE%`，否则
   `%DSH_HOME%\.zcode-whale-credentials.json`（`DSH_HOME` 默认 `%USERPROFILE%\.dsh`
   ⇒ `%USERPROFILE%\.dsh\.zcode-whale-credentials.json`）。

   成对存在时请求：

   ```text
   GET https://api.a6api.com/api/user/self
   Authorization: Bearer <A6API_ACCOUNT_ACCESS_TOKEN>
   New-Api-User: <A6API_ACCOUNT_USER_ID>      ← 严格正整数
   → { "success": true, "data": { "quota": 3650000, "used_quota": ... } }
   ```

   账户余额 = `data.quota / 500000` = **$7.30**。这条路径**不需要 sk- 开头的 API key**。
   - ⚠️ **`sk-` 开头的 API key 不能当 access token**。`A6API_ACCOUNT_ACCESS_TOKEN` 必须填
     A6 控制台「个人设置 → 访问令牌」生成的 access token（New API 的 `ValidateAccessToken`
     只认 `access_token` 字段，对 `Bearer ` 前缀做一次剥离）。
   - 两者只配一个 → 明确报「账户查询凭据不完整：缺少 …」，**不发请求**；
     `A6API_ACCOUNT_USER_ID` 非正整数同样明确报错且不发请求。
   - 目的地仍走 `credentialMayGoTo` 同源校验；请求用 `redirect:'error'`，禁止重定向把凭据带到别的 origin。

2. **令牌用量端点里的 `data.user_quota`（次选，取决于站点开关）**

   没有配置上面那对凭据时，才用同一份 API key 请求：

   ```text
   GET https://api.a6api.com/api/usage/token/
   → { "code": true, "data": { "total_available": 3650000, "unlimited_quota": false,
                               "user_quota": { "total_available": 3650000 } } }
   ```

   只有 `data.user_quota.total_available` 被当作账户余额（÷ 500000 = USD）。
   该字段**仅在 A6 控制台的令牌设置开启「允许查询用户额度」时才返回**；
   缺失时返回 `ok:false` + `code: ACCOUNT_QUOTA_UNAVAILABLE`，错误文案明确提示
   「请在 A6 控制台的令牌设置中开启『允许查询用户额度』，或配置账户查询凭据」，
   **绝不回落到令牌 `total_available`，也不显示 0**。

`GET /v1/models` 仅用于“测试连通性”。这些地址由模板内置，不需要填写 Base URL。

⚠️ **待实站验证**：`data.user_quota` 的响应形状目前只按上述一种实现（没有抓到实站样本）；
`/api/user/self` 的 `Bearer` + `New-Api-User` 头格式已按上游源码（`ValidateAccessToken` /
`authHelper`）核对，但本机只有 `A6API_API_KEY`（真实响应里不含 `user_quota`，`/api/user/self`
返回 401），**尚无账户访问令牌 + UserID 做真实验证**——两条路径都只有本地 stub 测试通过。
因此当前上线环境下「真实账户余额」仍受「账户访问令牌 + 用户 ID 缺失」阻塞，
不能宣称已经显示真实账户余额。

（旧实现用的 `/v1/dashboard/billing/subscription` + `/usage` 在该站取不到正确余额，已废弃；
`openai_compat` 中转站模板仍沿用那一对端点。）

**不要把 key 写进插件源码、气泡模板或任何会被提交的文件。**

## 余额语义（重要）

`/dsh-whale/balance.json` 在 HTTP 出口做严格归一化（`lib/balance-normalize.mjs`）：

- 成功：`totalBalance` 必须是有限数值（数字或可无损转数值的字符串）；
- `null` / `undefined` / `""` / `"  "` / `NaN` / `Infinity` → `{ ok:false, code:"SHAPE" }`，
  **绝不**经 `Number()` 变成 `0`；
- 原始失败（`NO_KEY` / `BOTH_FAILED` / `HTTP` / `PARSE` / `SHAPE`）的 `code` 与
  `error` 文案原样保留。

理由：原前端用 `Number(balance)` 格式化为两位小数，`Number(null) === 0`
会让"读不到余额"显示成"余额 0"，并被本地记账当成"余额见底"。

## 仍未接入：真实会话 usage

每轮 token 消耗与今日已用目前**只有**原项目的余额差记账（`lib/accounting.mjs`）。
ZCode 本地确有真实 usage：

- `%USERPROFILE%\.zcode\cli\db\db.sqlite`（`turn_usage` / `model_usage`）
- `%USERPROFILE%\.zcode\cli\rollout\model-io-<sessionId>.jsonl`

本版本**没有接入**：这些表/文件的字段与生命周期在不同 ZCode 版本间未经核对，
读未经验证的数据库比"不显示"风险更高（会显示错误金额）。接入前需要先做
跨版本字段校验与只读降级策略。

## 验证

```powershell
node --check assets\whale-widget.js
node --check lib\index.js
node --check lib\server.mjs
node --test
node .\lib\overlay-cli.mjs setup
node .\lib\overlay-cli.mjs start
node .\lib\overlay-cli.mjs status
```

日志：`%USERPROFILE%\.zcode\deepseek-whale-widget\host.log` 与 `overlay-debug.log`。

### 与上游的差异（含本轮改动）

本移植在 `assets/whale-widget.js` 与 `lib/index.js` 上做过**最小适配**，不再是"字节不变"：

- 浮层坐标/视口适配、隐藏时暂停 `/dsh-whale/` 请求（见上文边界与已知风险）。
- 0.4.2-zcode.9：`settings.petBalance.modelId`（宿主默认/读/写三处成对）+ 设置面板
  「点击桌宠显示的余额厂商」一行；前端只替换**无显式 modelId 的通用 balance 模块**的取数，
  其余模块与 token 含义不变（详见上文同名小节）。
- 回归测试：`tests/pet-balance-widget.test.mjs`（vm 截取真实函数 + 最小桩）、
  `tests/pet-balance-host.test.mjs`（隔离 DSH_HOME / 凭据 / 端口，真实 HTTP 读写与重启持久化）。

## 边界与已知风险

- 只跟踪进程名为 `ZCode` 的最大可见窗口；可用 `DEEPSEEK_WHALE_TARGET_PROCESS` 覆盖。
- 只按「命令行包含本插件运行时目录」判定自己的进程，绝不按 `electron.exe` /
  `node.exe` 泛杀，也不碰 fox 的运行时。
- 不修改 `app.asar`，不写注册表自启动，不删除 `~/.dsh` 用户数据。
- 启动串行化用 `lib/start-lock.mjs`：`wx` 原子创建锁文件，只有持有者进程已死才
  回收（不按时间抢活锁），`tests/lock-contention.test.mjs` 用 5 个真实子进程验证
  临界区不重叠。
- 已有浮层实例只有在「端口、版本都一致且该端口宿主健康」时才复用；不一致时
  明确报错，不重写记录、不杀进程（`evaluateExistingOverlay`）。
- 跟随脚本失败（spawn error / exit 非 0）时先隐藏浮层，再按 1s/3s/8s 有界重试 3 次；
  用尽则退出，不会留下孤儿鲸鱼。
- 隐藏状态下桥接脚本暂停 `/dsh-whale/` 请求（原前端 `document.hidden` 不会变，
  60s 余额刷新与 1s 轮询本不会自停），恢复可见后按原参数重发。
- 透明窗口在个别 DPI 变化/多显示器切换场景可能停在旧帧；本实现用「跟随消息重放 +
  页面重载 + 周期出帧保险」兜底，未做窗口重建（风险已知）。
