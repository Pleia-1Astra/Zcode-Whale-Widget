// 桌面浮层的 preload：把主进程能力以最小面暴露给页面。
//
// 只暴露「鼠标接管 / 键盘焦点 / 光标修正 / 点击重放 / 窗口状态 / 退出」，
// 不向页面开放任何 Node 权限（contextIsolation + nodeIntegration:false）。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whaleDesktop', {
  isOverlay: true,
  // 默认整窗鼠标穿透；指针落到鲸鱼/菜单/面板上时临时接管。
  setInteractive: (value) => ipcRenderer.send('deepseek-whale:interactive', !!value),
  // 浮层默认不可激活（不抢 ZCode 前台），菜单里的文本框需要键盘时临时打开。
  setKeyboardFocus: (value) => ipcRenderer.send('deepseek-whale:keyboard-focus', !!value),
  // 点在浮层 UI 之外：页面收起菜单并交还穿透后，请主进程把这次点击重放给 ZCode。
  dismissReplay: () => ipcRenderer.send('deepseek-whale:dismiss-replay'),
  quit: () => ipcRenderer.send('deepseek-whale:quit'),
  // 主进程低频轮询的真实光标位置（页面坐标），用于指针事件流中断时兜底。
  onCursor: (callback) => {
    ipcRenderer.on('deepseek-whale:cursor', (_event, pt) => {
      try {
        callback(pt)
      } catch (err) {}
    })
  },
  // 显隐/重现状态：隐藏期间页面必须放弃接管，否则会吃掉落到 ZCode 的点击。
  onWindowState: (callback) => {
    ipcRenderer.on('deepseek-whale:window-state', (_event, state) => {
      try {
        callback(state)
      } catch (err) {}
    })
  },
})
