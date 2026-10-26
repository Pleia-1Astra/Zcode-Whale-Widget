---
description: 打开 / 诊断 DeepSeek 小鲸鱼桌面悬浮挂件
---

桌面悬浮挂件会在会话开始时自动拉起（SessionStart hook + MCP 初始化双通道），
正常情况下不需要手动操作。新装插件后第一次需要安装 Electron 运行时：

```powershell
# 先切换到插件源码或安装目录，替换为本机 ZCode.exe 路径
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-runtime.ps1 -ZCodeExe "C:\path\to\ZCode.exe"
```

先在插件配置中为 `zcode_exe` 选择本机 ZCode.exe。setup 无匹配缓存时从 Electron 官方 GitHub 下载并验证 SHA-256；离线安装可设置 `DEEPSEEK_WHALE_ELECTRON_ZIP` 指向版本匹配的官方 zip。

手动兜底命令（都在插件根目录执行，需已有 Node；普通用户可直接调用 MCP 状态/启动工具）：

```powershell
node .\lib\overlay-cli.mjs start      # 启动 HTTP 宿主 + 透明浮层（幂等）
node .\lib\overlay-cli.mjs status     # 查看浮层/宿主/运行时状态
node .\lib\overlay-cli.mjs stop       # 停止本插件自己的浮层
node .\lib\overlay-cli.mjs health     # 只探测 HTTP 宿主
```

诊断地址：

- `http://127.0.0.1:3080/healthz` — 宿主健康（plugin/version/routes）
- `http://127.0.0.1:3080/?overlay=1` — 浮层加载的页面（含鼠标穿透桥接）

侧栏 MCP 面板仍然可用：打开 **+** 菜单 → **DeepSeek 小鲸鱼**。

日志：

- `%USERPROFILE%\.zcode\deepseek-whale-widget\host.log`
- `%USERPROFILE%\.zcode\deepseek-whale-widget\overlay-debug.log`

不要重复手动启动多个 `server.mjs`；`start` 会先做健康检查并复用已有实例。
