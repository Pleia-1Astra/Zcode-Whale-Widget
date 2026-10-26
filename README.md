# ZCode Whale Widget

在 Windows 的 ZCode 主窗口右下角显示透明小鲸鱼余额挂件，同时提供 MCP App 面板。

## 仓库与安装入口

本仓库根目录是 **marketplace.json 所在目录**，不是插件子目录。

```text
marketplace.json
README.md
deepseek-whale-widget/
  .zcode-plugin/plugin.json
  scripts/setup-runtime.ps1
  lib/ desktop/ assets/ hooks/ skills/ commands/ tests/
```

完整的首次安装、运行时下载、凭据配置和排障说明见 [插件 README](deepseek-whale-widget/README.md#新电脑安装)。

1. 克隆本仓库，或从 GitHub 下载源码 ZIP 后解压。普通使用不需要 Git、Node 或 npm。
2. 打开 ZCode **插件市场 → 添加 → 添加插件市场**，填写本仓库根目录的绝对路径。
3. 在 **个人 → dev-deepseek-whale-widget** 中安装 `deepseek-whale-widget`；在 **设置 → 插件** 中保持启用并为 `zcode_exe` 选择本机的 `ZCode.exe`。
4. 在插件子目录运行一次：

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-runtime.ps1 -ZCodeExe "C:\path\to\ZCode.exe"
   ```

   替换 ZCode 路径。脚本用 ZCode 内置 Node 探测 Electron 版本，优先使用匹配缓存；没有缓存时下载官方运行时并按 SHA-256 校验。不修改系统环境变量或 ZCode 安装文件。
5. 完全退出并重启 ZCode，新建任务选择鲸鱼插件技能，发送“检查余额挂件状态并显示挂件”。预期：运行时已安装、HTTP 宿主健康，小鲸鱼随 ZCode 主窗口移动。余额需另配自己的服务凭据；没有凭据时不会伪造余额。

完整插件 ID：`deepseek-whale-widget@dev-deepseek-whale-widget`。源码更新后先在市场源刷新该市场，再在个人页更新插件；源码修改不会热更新已安装副本。

## 无法由仓库代替的前置条件

- Windows 10/11 x64、交互式桌面和已安装的 ZCode。ZCode 必须支持本插件使用的 MCP、process hook、userConfig、MCP App 功能；最低支持版本尚未跨版本验证。
- Windows PowerShell/.NET 可运行窗口跟随脚本，默认本地端口 `3080` 可用；不需要管理员权限。
- 首次自动下载需可访问 GitHub 发行资源及重定向下载域名；也可手工提供官方匹配 Electron zip 离线安装。只下载本插件独立 Electron 运行时，不分发 ZCode 本体。
- 查询余额需要用户自行提供相应服务商凭据并能访问其接口。凭据永不包含在仓库中。
- macOS/Linux/Windows ARM64 尚未验证，不承诺桌面跟随支持。

## 开发验证与提交范围

开发测试使用 Node 22 或更新版本，在 `deepseek-whale-widget` 目录运行 `node --test`。运行时没有 npm 包依赖，无需 `npm install`。

仓库包含市场清单、插件源码、所需静态素材、安装脚本、测试、许可证和安装说明。不包含用户配置、凭据、API 响应、余额账本、Electron 压缩包/运行时、构建产物或本地调试抓取文件。`.gitignore` 只是第一道防线，提交前仍需检查暂存区。

许可证范围与素材声明见 [LICENSE](deepseek-whale-widget/LICENSE) 和 [PROVENANCE](deepseek-whale-widget/PROVENANCE.md)。美术/音效素材不按 MIT 重新授权。
