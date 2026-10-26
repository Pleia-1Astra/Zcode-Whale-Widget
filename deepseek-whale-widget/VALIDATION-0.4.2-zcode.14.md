# 0.4.2-zcode.14 修复及验证记录

日期：2026-10-25。修改源码与本地市场；未更新安装缓存。测试使用独立端口、profile、临时数据和无凭据环境。

## 原因与证据

1. .12 移除了前台限制，但 desktop/main.cjs 仍设置 alwaysOnTop 和 screen-saver 层级，导致桌宠覆盖其他应用。焦点、遮挡与隐藏是不同状态，不能只在焦点变化时强制隐藏或强制全局显示。
2. 消失报告调查时，真实数据目录记录的 overlay PID 14680 和 HTTP host PID 14540 都已不存在，3080 无监听；最后日志没有 hidden、quit 或 follower-exit。因此该次消失是进程已经退出，不是仍活着但透明或移出屏幕。现有日志不足以确认是外部终止还是进程崩溃。MCP 只启动一次，没有补救机制。
3. 历史日志存在升级后旧版 preload/follower 文件 ENOENT：运行进程仍依赖版本化插件缓存，更新删除旧缓存会破坏后续加载。改为不可变内容快照。
4. 实测另外发现最小化后主窗口尺寸变成 160×25，而 ZCode 常驻小窗为 250×64。原有“最大窗口”选择会改选小窗，将浮层定位到错误位置和大小。修复为用还原尺寸比较，并保留已识别的最小化/不可见主窗。

## 修复

- Win32 owned window + 非 topmost + NOACTIVATE/NOOWNERZORDER 跟随 ZCode 层级；其他应用正常遮挡桌宠，未遮挡区域不因失焦消失。
- 修正最小化主窗识别，保留原有显隐、交互、鼠标穿透和无焦点显示机制。
- 每 15 秒在活跃 MCP 连接中检查异常退出/HTTP 失联，串行启动、失败退避。主动停止持久化 disabled，不被恢复器重启。正常最小化隐藏不会被误判故障。
- runtime snapshot 防缓存被更新删除；补充窗口/进程生命周期日志与 5 秒状态快照。
- 延迟键盘释放在执行前复查新焦点，避免快速重开输入框时被旧定时器禁用。
- 停止命令检查 taskkill 结果和实际退出，失败保留记录；进程探测失败不再误认为 ZCode 已退出。

## 自动验证

- `node --test "./tests/*.test.mjs"`：106 项全部通过。完整回归包含余额、设置、HTTP/MCP、单实例、1000 次模拟焦点切换、100 次恢复和退避、主动停止竞争、缓存删除后资源保留、最小化主窗选择和键盘定时器竞争。
- Windows PowerShell Add-Type 编译完整跟随器 C#；ASCII 编码检查。
- 所有 lib/desktop JavaScript 语法与清单、package、市场版本一致性检查。

## 真实 Windows 隔离验证

以下为原生窗口与进程状态实测，不是只做条件表达式模拟：

- 初次隔离实例 temp/whale-native-94S5aC：overlay 15944 / 独立端口 57292，分别在 WPS PDF、Chrome 前台时运行；执行了 12 次实际系统切换快捷键（部分中间帧报告无 active，不能声称每次都识别了具体应用）。
- 同时终止隔离 overlay 和 host 后，恢复到 overlay 19288；日志显示恢复约 12 秒。其他应用前台时原生检查：owner=7079734（ZCode），topmost=false，overlayRank=89、ownerRank=90、foregroundRank=81，桌宠在其他应用下方、ZCode 紧上方。
- 对隔离实例显式 stop 后，超过 30 秒 overlay.json 仍不存在、原 PID 已退出且 preference.enabled=false；恢复器未复活它。
- 修正最小化识别后 temp/whale-native-18RxpG：overlay 11404 / 独立端口 44317。05:20:16Z 真实最小化 ZCode，状态为 shown=false、nativeVisible=false、opacity=0、reason=zcode-minimized，边界保留 1505×800；05:20:25Z 恢复后 shown=true、opacity=1，未改选 250×64 小窗。
- 同一实例切到 WPS 后原生检查 topmost=false、owner=7079734，overlayRank=407、ownerRank=408、foregroundRank=83；未升到其他应用上方。
- 只终止 HTTP host PID 13456（05:21:05Z），05:21:19Z 新 host 13428 已启动；overlay 11404 保持不变且继续 shown=true、offscreen=false。
- 测试使用本机已有 Electron 运行时，只读共享运行时；临时数据、日志、偏好独立，未覆盖真实余额、凭据或安装目录。

## 尚未证明的范围

- 当前模型收不到桌面图像，CUA 截图通道也返回 raster not visible；无法进行截图视觉验收或鼠标像素级菜单验收。以上结论依据可访问性、Win32 属性及状态日志。
- 没有完成 30 分钟以上长期压测，不能承诺所有外部终止或系统级故障永不复发。
- MCP 恢复器依赖至少一个活跃 MCP 连接；ZCode/MCP 整体终止、系统关机、进程主线程挂死不能据此保证自动恢复。
- 原生测试完成后追加的诊断字段 hostHwnd/overlayHwnd、owner-attached 日志及不可见主窗保留分支通过编译/自动测试；未单独制造宿主 IsWindowVisible=false 的原生场景。

## 安装后验收与复发定位

在市场刷新 dev-deepseek-whale-widget，更新到 .13 并完全重启 ZCode。保留原启用/停用选择，主动 stop 后需显式 start。

1. 连续切换 ZCode、浏览器、文件管理器等至少 50 次：覆盖桌宠区域的窗口必须盖住桌宠；未覆盖区域保持正常，切回后菜单、拖动、文字输入正常。
2. 最小化等待超过 3 秒再恢复，重复 10 次；不能移到常驻小窗。
3. 运行至少 30 分钟，期间切换应用、显示器/DPI、打开关闭菜单。主动停止等待 30 秒，不能自动复活。
4. 再次消失时先运行 `node lib/overlay-cli.mjs status`，不要先重启破坏证据。保留 `%USERPROFILE%\.zcode\deepseek-whale-widget` 的 overlay-window-state.json、overlay-debug.log、host.log、overlay.json（如存在）。不要公开 host.json 里的关停令牌或凭据文件。
5. diagnosis=hidden:*：查 reason 与窗口最小化/可见状态；offscreen：查 bounds 和显示器；window-destroyed：查 window-closed；process-exited-or-not-started：查 PID 与退出日志；window-state-stale：进程可能挂起，不把它当“隐藏”强制显示。shown 但看不到：检查其他窗口正常遮挡，不要立刻提升为全局 topmost。

开发环境复测：`node tests/manual-native-smoke.mjs <已有 desktop-runtime 绝对路径> 1800000`。只对它打印的临时目录内记录的 PID 做故障注入，不操作真实桌宠或其他 Electron。`tests/inspect-native-window.ps1 -Hwnd <窗口句柄>` 只读查看所属窗口与层级。
