// DeepSeek 小鲸鱼桌面浮层主进程。
//
// 必须遵守的约束：
//   - 窗口矩形始终等于 ZCode 客户区（页面 innerWidth/innerHeight 才是聊天区尺寸，
//     原前端才能不改）。
//   - 默认鼠标穿透；只有页面明确请求时才临时接管。
//   - 隐藏用透明度（不 hide），隐藏时必须同时交还键盘焦点与可激活态。
//   - 跟随脚本失败不得留下孤儿鲸鱼：先隐藏，再有界重试，用尽则退出。
const { app, BrowserWindow, ipcMain, screen, shell } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { overlayBoundsForHost, physicalToDip, rectsClose } = require('./window-bounds.cjs')

const PORT = Number(process.env.DEEPSEEK_WHALE_PORT) || 3080
const TARGET_URL = 'http://127.0.0.1:' + PORT + '/?overlay=1'
const MARGIN = Math.max(0, Number(process.env.DEEPSEEK_WHALE_MARGIN) || 0)
const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')
const DATA_DIR = process.env.DEEPSEEK_WHALE_DATA_DIR || path.join(ZCODE_HOME, 'deepseek-whale-widget')
const DEBUG_LOG = process.env.DEEPSEEK_WHALE_OVERLAY_LOG === '0'
  ? null
  : path.join(DATA_DIR, 'overlay-debug.log')

function log(...parts) {
  if (!DEBUG_LOG) return
  try {
    fs.appendFileSync(DEBUG_LOG, new Date().toISOString() + ' ' + parts.join(' ') + '\n')
  } catch (err) {}
}

// 透明置顶窗被全屏应用覆盖后，Chromium 的原生遮挡计算可能让画面停在旧帧；
// 关掉它（代价只是被覆盖期间照常出帧）。以下开关都必须在 app ready 前设置。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

const DEBUG_PORT = Number(process.env.DEEPSEEK_WHALE_DEBUG_PORT) || 0
if (DEBUG_PORT > 0) app.commandLine.appendSwitch('remote-debugging-port', String(DEBUG_PORT))

let win = null
let follower = null
let pageReady = false
let overlayShown = false
let interactive = false
let keyboardFocus = false
let lastFollowerMsg = null
let lastHostRect = null
let quitting = false
let visibilityReason = 'starting'
const STATE_FILE = path.join(DATA_DIR, 'overlay-window-state.json')
function recordWindowState(event) {
  try {
    const bounds = win && !win.isDestroyed() ? win.getBounds() : null
    const displays = typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : null
    const offscreen = bounds && displays ? !displays.some(({ bounds: d }) => bounds.x < d.x + d.width && bounds.x + bounds.width > d.x && bounds.y < d.y + d.height && bounds.y + bounds.height > d.y) : null
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      pid: process.pid, at: new Date().toISOString(), event, quitting, reason: visibilityReason,
      window: win && !win.isDestroyed() ? { shown: overlayShown, nativeVisible: win.isVisible(), opacity: win.getOpacity(), bounds, offscreen, focused: win.isFocused() } : null,
      followerPid: follower && follower.pid, lastFollowerMsg,
    }))
  } catch (err) {}
}
log('process-start', 'pid=' + process.pid, 'root=' + __dirname)
if (typeof process.on === 'function') {
  process.on('exit', (code) => { log('process-exit', code); recordWindowState('process-exit:' + code) })
  process.on('uncaughtExceptionMonitor', (err) => log('uncaught-exception', String(err && err.stack || err)))
}
const stateTimer = setInterval(() => recordWindowState('heartbeat'), 5000)
if (stateTimer.unref) stateTimer.unref()

const FOLLOW_INTERVAL_DEFAULT = 40
function clampFollowInterval(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return FOLLOW_INTERVAL_DEFAULT
  return Math.min(2000, Math.max(16, Math.round(n)))
}
let followIntervalMs = clampFollowInterval(process.env.DEEPSEEK_WHALE_FOLLOW_INTERVAL_MS || FOLLOW_INTERVAL_DEFAULT)

function followerCommand(cmd) {
  const child = follower
  if (!child || !child.stdin || child.stdin.destroyed) return
  try {
    child.stdin.write(cmd + '\n')
  } catch (err) {}
}

function kickPresentation(reason) {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.invalidate()
    log('kick', reason)
  } catch (err) {}
}

// ---------- 窗口 ----------
function createWindow() {
  // 兜底初始矩形用主显示器工作区（跟随消息到达后立即改成 ZCode 客户区）。
  const wa = screen.getPrimaryDisplay().workArea
  win = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: Math.max(1, wa.width),
    height: Math.max(1, wa.height),
    transparent: true,
    frame: false,
    // 必须保持 resizable:true —— Electron 对 resizable:false 的窗口会把
    // min/max 锁在创建尺寸，之后 setBounds 改尺寸会被拒绝，页面视口不再跟随。
    resizable: true,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Windows 上 toolbar 型窗口创建即带 WS_EX_TOOLWINDOW：被宿主 Chromium 的
    // 「完全不透明遮挡源」判定直接排除，避免 ZCode 因遮挡停止出帧。
    ...(process.platform === 'win32' ? { type: 'toolbar' } : {}),
    // 不可激活：点挂件不把前台从 ZCode 抢走。需要键盘时由页面请求临时打开。
    focusable: false,
    show: false,
    alwaysOnTop: false,
    title: 'DeepSeek Whale Widget',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  try {
    win.setAlwaysOnTop(false)
    win.setIgnoreMouseEvents(true, { forward: true })
    win.setOpacity(0)
    win.showInactive()
  } catch (err) {}
  log('window-created', JSON.stringify(win.getBounds()))

  win.loadURL(TARGET_URL)

  // 外链一律交给系统浏览器；主窗口自身禁止导航离开挂件页面。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (/^https?:\/\//i.test(url) && url !== TARGET_URL) shell.openExternal(url).catch(() => {})
  })

  function releasePageInput() {
    pageReady = false
    releaseKeyboardFocusNow()
    applyInteractive(false, true)
  }
  win.webContents.on('did-start-loading', releasePageInput)
  win.webContents.on('did-finish-load', () => {
    pageReady = true
    log('page-ready')
    // 页面加载完成前到达的跟随消息会因为 pageReady=false 被丢弃；加载完补一次。
    if (lastFollowerMsg) applyFollowerMessage(lastFollowerMsg)
    else sendWindowState()
  })

  win.webContents.on('did-fail-load', () => {
    pageReady = false
    // 宿主可能还在启动（健康等待）。2 秒后重试，不留下空白窗口。
    setTimeout(() => {
      if (win && !win.isDestroyed() && !quitting) {
        try {
          win.loadURL(TARGET_URL)
        } catch (err) {}
      }
    }, 2000)
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    log('render-gone', JSON.stringify(details || {}))
    releasePageInput()
    setTimeout(() => {
      if (win && !win.isDestroyed() && !quitting) {
        try {
          win.webContents.reload()
        } catch (err) {}
      }
    }, 1500)
  })

  if (DEBUG_LOG) {
    win.webContents.on('console-message', (...args) => {
      try {
        const d = args[0]
        if (d && typeof d === 'object' && 'message' in d) log('page-l' + d.level, String(d.message).slice(0, 300))
        else log('page-l' + args[1], String(args[2]).slice(0, 300))
      } catch (err) {}
    })
  }

  win.on('closed', () => {
    log('window-closed', 'quitting=' + quitting)
    win = null
    recordWindowState('window-closed')
  })
  win.on('blur', () => {
    if (!keyboardFocus) return
    try {
      if (win && !win.isDestroyed()) win.webContents.send('deepseek-whale:window-state', { blur: true })
    } catch (err) {}
  })

  if (process.platform === 'win32') startFollower()
}

// 渲染进程"假活"兜底：窗口与进程都正常、但页面已经死了时，桌面只剩一块
// 透明层。主进程侧定时让页面吐一个值，连续失败就重载。
let beatTimer = null
let beatFails = 0
function startHeartbeat() {
  if (beatTimer) return
  beatTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return
    const wc = win.webContents
    if (!wc || wc.isDestroyed() || wc.isLoading()) return
    try {
      const v = await Promise.race([
        wc.executeJavaScript('1+1'),
        new Promise((_res, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
      ])
      if (Number(v) !== 2) throw new Error('bad:' + String(v))
      beatFails = 0
    } catch (err) {
      beatFails++
      log('page-beat-fail', beatFails, String((err && err.message) || err))
      if (beatFails < 2) return
      beatFails = 0
      log('page-reload', 'heartbeat')
      try {
        wc.reload()
      } catch (e) {}
    }
  }, 30000)
  if (beatTimer.unref) beatTimer.unref()
}

// ---------- 跟随 ZCode 主窗口 ----------
function startFollower() {
  let hwnd = ''
  try {
    hwnd = win.getNativeWindowHandle().readBigUInt64LE(0).toString()
  } catch (err) {
    log('hwnd-failed', String((err && err.message) || err))
    onFollowerFailed('hwnd-failed')
    return
  }
  const child = spawn(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'follow-window.ps1'),
      '-OverlayHwnd', hwnd,
      '-IntervalMs', String(followIntervalMs),
      '-OverlayPid', String(process.pid),
    ],
    // stdin 保持管道：跟随脚本用它接收 replay-click / handback / toolwindow
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  follower = child
  followerHealthySince = 0
  if (child.stdin) child.stdin.on('error', () => {})
  log('follower-started', 'interval=' + followIntervalMs + 'ms hwnd=' + hwnd)

  let buf = ''
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg = null
      try {
        msg = JSON.parse(line)
      } catch (err) {
        log('follower-bad-line', line.slice(0, 120))
        continue
      }
      lastFollowerMsg = msg
      if (!followerHealthySince) followerHealthySince = Date.now()
      if (Date.now() - followerHealthySince >= 3000) followerRetries = 0
      applyFollowerMessage(msg)
    }
  })
  child.stderr.on('data', (chunk) => log('follower-stderr', chunk.toString('utf8').slice(0, 300)))

  child.on('error', (err) => {
    if (follower !== child) return
    follower = null
    log('follower-spawn-failed', String((err && err.message) || err))
    onFollowerFailed('spawn-error')
  })

  child.on('exit', (code, signal) => {
    if (follower !== child) return
    follower = null
    log('follower-exit', code === null ? 'signal:' + signal : String(code))
    if (quitting) return
    // exit 0：ZCode 进程已退出（gone）或浮层窗口已销毁 → 一起退出
    if (code === 0) {
      quitOverlay('follower-host-gone')
      return
    }
    onFollowerFailed(code === null ? 'signal:' + signal : 'exit-' + code)
  })
}

// 跟随脚本异常：先隐藏浮层（不能把一块不知道宿主在哪的透明窗留在屏幕上），
// 然后有界重试；用尽次数就退出，避免永久孤儿进程。
const FOLLOWER_MAX_RETRIES = 3
const FOLLOWER_RETRY_DELAYS_MS = [1000, 3000, 8000]
let followerRetries = 0
let followerHealthySince = 0
let followerRetryTimer = null

function onFollowerFailed(reason) {
  hideOverlay('follower-failed:' + reason)
  if (followerRetryTimer) return
  if (followerRetries >= FOLLOWER_MAX_RETRIES) {
    log('follower-retries-exhausted', reason)
    quitOverlay('follower-dead')
    return
  }
  const delay = FOLLOWER_RETRY_DELAYS_MS[Math.min(followerRetries, FOLLOWER_RETRY_DELAYS_MS.length - 1)]
  followerRetries++
  log('follower-retry', `#${followerRetries} in ${delay}ms (${reason})`)
  followerRetryTimer = setTimeout(() => {
    followerRetryTimer = null
    if (quitting || !win || win.isDestroyed()) return
    if (follower) return
    startFollower()
  }, delay)
  if (followerRetryTimer.unref) followerRetryTimer.unref()
}

function followerDipRect(msg) {
  const rect = { x: msg.x, y: msg.y, width: msg.w, height: msg.h }
  if (!Number.isFinite(rect.x) || rect.x < -10000 || rect.y < -10000) return null
  if (!(rect.width > 0 && rect.height > 0)) return null
  return physicalToDip(rect, (r) => screen.screenToDipRect(null, r))
}

// 隐藏：先交还键盘/前台，再设透明与穿透。
// 关键：只把 keyboardFocus=false 而不 setFocusable(false)，窗口会保持可激活，
// 下次菜单输入时状态机认为「已经是 false」而跳过恢复 → 输入失效；同时可激活的
// 透明窗在隐藏期间还可能抢前台。因此这里必须真正拆掉可激活态。
function releaseKeyboardFocusNow() {
  if (!win || win.isDestroyed()) return
  const wasKeyboard = keyboardFocus
  keyboardFocus = false
  if (!wasKeyboard) return
  try {
    const wasFocused = win.isFocused()
    if (wasFocused) followerCommand('handback')
    win.setFocusable(false)
    followerCommand('toolwindow')
  } catch (err) {
    log('hide-focus-release-failed', String((err && err.message) || err))
  }
}

function hideOverlay(reason) {
  visibilityReason = reason
  if (!win || win.isDestroyed()) return
  if (overlayShown) {
    overlayShown = false
    interactive = false
    try {
      // 顺序：先交还焦点/前台（此时窗口仍可见，handback 才有意义），再隐身
      releaseKeyboardFocusNow()
      win.setIgnoreMouseEvents(true)
      win.setOpacity(0)
    } catch (err) {}
    log('hidden', reason)
  }
  sendWindowState()
}

function showOverlay() {
  if (!win || win.isDestroyed()) return
  if (!pageReady) return // 页面未就绪前显示只会是一帧空透明画面
  try {
    if (!win.isVisible()) {
      // 窗口生命周期里唯一一次真正的 show 过渡（实测无输入问题）
      win.showInactive()
      log('shown')
    } else if (!overlayShown) {
      log('reshown')
    }
    overlayShown = true
    visibilityReason = 'host-visible'
    win.setOpacity(1)
    win.setIgnoreMouseEvents(!interactive, { forward: !interactive })
    kickPresentation('show')
  } catch (err) {}
  sendWindowState()
}

function sendWindowState() {
  if (!win || win.isDestroyed()) return
  recordWindowState('visibility')
  try {
    win.webContents.send('deepseek-whale:window-state', { visible: overlayShown })
  } catch (err) {}
}

// 把 ZCode 客户区矩形应用到浮层窗口。
function applyHostRect(dipRect) {
  if (!win || win.isDestroyed()) return
  if (!dipRect) {
    hideOverlay('window-missing')
    return
  }
  lastHostRect = dipRect
  const bounds = overlayBoundsForHost(dipRect, null, { margin: MARGIN })
  if (!bounds) {
    hideOverlay('host-too-small')
    return
  }
  const current = win.getBounds()
  if (!rectsClose(current, bounds, 1)) {
    try {
      win.setBounds(bounds)
      log('bounds', JSON.stringify(bounds))
    } catch (err) {
      log('bounds-failed', String((err && err.message) || err))
    }
  }
  showOverlay()
}

function applyFollowerMessage(msg) {
  if (quitting || !win || win.isDestroyed()) return
  if (!msg || typeof msg !== 'object') return
  if (msg.gone) {
    log('zcode-gone')
    quitOverlay('zcode-gone')
    return
  }
  if (msg.hide || msg.show === false) {
    hideOverlay(msg.minimized ? 'zcode-minimized' : 'zcode-not-visible')
    // 最小化时窗口矩形是哨兵值（-32000），不能用来定位；恢复时会收到新的 show 消息。
    return
  }
  const rect = followerDipRect(msg)
  if (!rect) {
    hideOverlay('window-missing')
    return
  }
  applyHostRect(rect)
}

// ---------- 鼠标接管 / 键盘焦点 ----------
function applyInteractive(next, force) {
  if (!win || win.isDestroyed()) return
  if (!overlayShown && next) return
  const want = !!next
  if (want === interactive && !force) return
  interactive = want
  try {
    if (want) win.setIgnoreMouseEvents(false)
    else win.setIgnoreMouseEvents(true, { forward: true })
  } catch (err) {}
  log('interactive', String(want))
}

ipcMain.on('deepseek-whale:interactive', (_event, value) => applyInteractive(value))

ipcMain.on('deepseek-whale:keyboard-focus', (_event, value) => {
  if (!win || win.isDestroyed()) return
  const want = !!value
  if (want && !overlayShown) return
  if (want === keyboardFocus) return
  keyboardFocus = want
  try {
    if (want) {
      win.setFocusable(true)
      win.focus()
      // setFocusable(true) 会重写扩展样式，可能冲掉 WS_EX_TOOLWINDOW
      followerCommand('toolwindow')
    } else {
      // 顺序不能反：先把前台还给 ZCode，再拆可激活态。setFocusable(false)
      // 会让 Windows 立刻把前台丢给 explorer。
      const wasFocused = win.isFocused()
      if (wasFocused) followerCommand('handback')
      setTimeout(() => {
        try {
          if (!win || win.isDestroyed() || keyboardFocus) return
          win.setFocusable(false)
          followerCommand('toolwindow')
        } catch (err) {}
      }, 120)
    }
  } catch (err) {
    log('keyboard-focus-failed', String((err && err.message) || err))
  }
  log('keyboard-focus', String(want))
})

// 点击落在浮层 UI 之外：收起菜单后把这次点击原位置重放给 ZCode
ipcMain.on('deepseek-whale:dismiss-replay', () => {
  if (!win || win.isDestroyed()) return
  if (interactive) applyInteractive(false)
  followerCommand('replay-click')
  log('dismiss-replay')
})

ipcMain.on('deepseek-whale:quit', () => {
  try { fs.writeFileSync(path.join(DATA_DIR, 'overlay-preference.json'), JSON.stringify({ enabled: false })) } catch (err) {}
  quitOverlay('ipc')
})

// 指针位置低频兜底：穿透时 forward 的 pointermove 与接管时的真实事件在个别
// 场景会断流（原生下拉、窗口显隐、焦点切换），断了就再也点不到鲸鱼。
setInterval(() => {
  if (!overlayShown || !win || win.isDestroyed()) return
  try {
    const p = screen.getCursorScreenPoint()
    const b = win.getContentBounds()
    win.webContents.send('deepseek-whale:cursor', { x: Math.round(p.x - b.x), y: Math.round(p.y - b.y) })
  } catch (err) {}
}, 200)

// 周期出帧保险（画面冻结自愈）
setInterval(() => {
  if (!overlayShown || !win || win.isDestroyed()) return
  kickPresentation('periodic')
}, 60000)

// ---------- 生命周期 ----------
// 主窗退出时把**本插件自己的**宿主一起收掉：读 host.json 的令牌打 /shutdown。
// 只有本机读得到令牌，端口上若是别人的服务会拿到 403 —— 绝不按 pid 泛杀。
function stopOwnHost() {
  return new Promise((resolve) => {
    let info = null
    try {
      info = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'host.json'), 'utf8'))
    } catch (err) {}
    if (!info || typeof info.token !== 'string' || !info.port) return resolve(false)
    const done = (v) => resolve(v)
    setTimeout(() => done(false), 2000)
    fetch(`http://127.0.0.1:${info.port}/shutdown`, {
      method: 'POST',
      headers: { 'x-whale-token': info.token },
      signal: AbortSignal.timeout(1500),
    })
      .then((res) => res.json())
      .then((body) => done(!!(body && body.ok)))
      .catch(() => done(false))
  })
}

function quitOverlay(reason) {
  if (quitting) return
  quitting = true
  log('quit', reason)
  try {
    if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true)
  } catch (err) {}
  stopOwnHost()
    .then((ok) => log('host-stop', ok ? 'ok' : 'failed'))
    .finally(() => app.quit())
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 已有实例：本进程直接退出，不碰任何窗口。
  log('single-instance-rejected')
  app.quit()
} else {
  app.on('second-instance', () => {
    log('second-instance')
  })

  app.whenReady().then(() => {
    createWindow()
    startHeartbeat()

    screen.on('display-metrics-changed', () => {
      // DPI 缩放变化后透明窗的交换链可能整体死掉（画面停旧帧）；重建窗口最可靠。
      setTimeout(() => {
        if (lastFollowerMsg) applyFollowerMessage(lastFollowerMsg)
        if (win && !win.isDestroyed()) {
          try {
            win.webContents.reload()
          } catch (err) {}
        }
      }, 500)
    })
    screen.on('display-added', () => {
      setTimeout(() => {
        if (lastFollowerMsg) applyFollowerMessage(lastFollowerMsg)
      }, 500)
    })
    screen.on('display-removed', () => {
      setTimeout(() => {
        if (lastFollowerMsg) applyFollowerMessage(lastFollowerMsg)
      }, 700)
    })
  })

  app.on('window-all-closed', () => {
    log('window-all-closed')
    if (!quitting) app.quit()
  })

  app.on('before-quit', () => {
    log('before-quit')
    quitting = true
    recordWindowState('before-quit')
    if (follower) {
      try {
        follower.kill()
      } catch (err) {}
      follower = null
    }
    if (beatTimer) {
      clearInterval(beatTimer)
      beatTimer = null
    }
  })
}
