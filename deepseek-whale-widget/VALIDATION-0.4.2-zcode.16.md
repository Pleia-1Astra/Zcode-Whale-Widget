# 新电脑安装与提交范围验证

版本：0.4.2-zcode.16。验证日期：2026-10-26。

## 仓库范围

仓库根为 `marketplace.json` 所在目录。包含市场清单、根 README、忽略/行尾规则及完整 `deepseek-whale-widget/` 源码包。没有将上级工作区的抓取文件、调试脚本、会话记录或机器配置复制到此范围。

必要插件文件包括 `.zcode-plugin/`、`lib/`、`desktop/`、`assets/`、`hooks/`、`skills/`、`commands/`、`scripts/setup-runtime.ps1`、`package.json`、许可证和文档；测试一并保留。两个零字节命令残留已删除。

`.gitignore` 对凭据、环境文件、私钥、日志、依赖、构建产物、Electron 下载包/运行时、快照、profile、host.json 等作防御性排除。使用独立临时 Git 元数据和当前源目录作为 work-tree 验证候选清单及 `check-ignore`；没有初始化或改写源项目历史。

文本候选扫描覆盖私钥头、GitHub token、AWS access key、sk- key 和常见凭据字面量。两条候选均经复核为假凭据：README 的访问令牌占位说明，以及 a6api 测试的明确假 key。未发现真实密钥。PNG 无文本/EXIF 块；MP3 标签的敏感模式扫描无命中。扫描不能代替日后的暂存区人工审查。

## 实现

- `zcode_exe` 不再默认指向开发机绝对路径；每台电脑需在插件配置中选择自己的 ZCode.exe。
- 删除本版 ZCode 不支持的 `SessionEnd` hook 声明，仅保留 SessionStart；没有误用每轮响应结束的 Stop 代替会话结束。主窗口退出由跟随器关闭浮层；HTTP 宿主不承诺自动退出，可通过 stop-host 手动关闭。仓库布局测试断言 hook 事件集合。
- `scripts/setup-runtime.ps1` 使用 ZCode 内置 Node，等待子进程、传播退出码、临时设置后恢复 `ELECTRON_RUN_AS_NODE` 与控制台编码。
- setup 目标版本仅来自明确版本参数/环境变量或宿主 Electron，不再从任意缓存猜版本。
- 本地缓存或显式 zip 可用于离线安装；显式 zip 不存在或文件名不匹配时失败，不擅自联网。
- 无匹配输入时下载官方 Electron Windows x64 发行包并按官方 `SHASUMS256.txt` 校验；下载临时文件失败清理，已有下载缓存重新核对摘要。
- 解压、哨兵校验和 staged 包提交；提交后错误恢复原 runtime，无旧 runtime 时不留下部分安装。PowerShell 解压回退支持含空格、单引号的路径。

## 真实执行结果

### 自动化与静态验证

在 Windows x64、Node 24.22.1 上，从复制到临时目录的干净仓库布局运行：

```powershell
# 在 deepseek-whale-widget 目录运行
node --test
```

结果：**201 通过 / 0 失败 / 0 跳过，退出码 0**。其中安装器测试 19 项，覆盖官方下载/校验、错误清理、版本/架构精确匹配、显式 zip、解压回退、重复安装、提交后失败回滚；另有仓库布局完整性与 PowerShell 包装器失败退出码测试。

### 干净数据目录安装

1. 复制仓库到新的临时目录；为 USERPROFILE、LOCALAPPDATA、APPDATA、ZCODE_HOME、DSH_HOME、插件数据、凭据路径分别设置隔离目录，不继承真实服务凭据。
2. ZCode.exe 以 Node 模式输出宿主 Electron **41.0.3**。
3. 直接自动下载在当前网络上失败：Node/Electron fetch 连接超时，安装返回 `step: download`。**没有宣称真实自动在线安装通过**。官方清单曾可访问，但连接不稳定。
4. 使用 PowerShell 下载同版本官方压缩包，核对官方 SHA-256：`93346b31dfcd779c4c4cdfdfb2e3f9642e7a9888e388a8971ff3e95dbf948887`（仅适用于 Electron 41.0.3 Windows x64）。该包保留在仓库外，不分发入库。
5. 通过 `DEEPSEEK_WHALE_ELECTRON_ZIP` 指定上述已校验包，执行源码包的 setup-runtime.ps1。返回 `ok: true`、`installed: true`，退出码 0。安装后的 Electron 可执行文件运行成功并报告 41.0.3。
6. 第二次 setup 返回 `alreadyInstalled: true`，退出码 0。指定不存在的 zip 时独立 PowerShell 进程退出码为 1，没有残留已安装 runtime。

### 原生冒烟

使用新装 runtime、临时数据/profile、独立端口和不存在的凭据路径执行 `tests/manual-native-smoke.mjs`，运行 30 秒。MCP 初始化后 HTTP 宿主及浮层启动成功；持续窗口心跳显示 `nativeVisible: true`、`opacity: 1`、`offscreen: false`，Win32 跟随器提供主窗口矩形。结束时脚本停止自己的浮层与宿主并移除 runtime junction。

这属于当前电脑上的隔离安装/原生进程状态验证，不是完整新电脑或 Windows VM 验收，不是肉眼 GUI 检查或长时交互压测。未在 ZCode UI 中代用户更新已安装插件；真实服务余额未使用私人凭据验证。

## 仍需外部条件

Windows 10/11 x64、交互式桌面、支持清单能力的 ZCode、PowerShell/.NET、可用本地端口。新电脑需指定本机 ZCode.exe。自动下载需能访问 GitHub 及发行下载域名；受限网络可按 README 的离线安装流程手动下载并核对摘要。余额功能另需服务商凭据和接口网络。

未声称支持 macOS/Linux/ARM64；最低 ZCode 版本和跨版本兼容性未完成验证。

## GitHub 状态

便携 Git 和 GitHub CLI 已从官方源下载并校验，工具位于仓库外。首次连接曾因网络及未认证而暂停；之后 GitHub CLI 已完成认证，账号具有目标仓库推送权限。只读远程引用检查及独立目录克隆确认目标仓库为空，没有现有分支、标签或提交，GitHub 默认分支名为 `main`。发布流程在独立克隆中复核源码、测试和暂存区，再创建首个提交并非强制推送；实际推送结果与提交编号以发布后的 Git 记录为准。未覆盖远程历史或使用强制推送。
