import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const source = fs.readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8')
const followerSource = fs.readFileSync(new URL('../desktop/follow-window.ps1', import.meta.url), 'utf8')
const followerVisibility = new vm.Script(`(${followerSource.match(/\bbool show\s*=\s*([^;]+);/)[1]})`)

function loadOverlay() {
  const ipc = new EventEmitter()
  const app = new EventEmitter()
  let quits = 0
  Object.assign(app, {
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then() {} }),
    quit() { quits++ },
  })
  class Window extends EventEmitter {
    constructor(options) {
      super()
      this.options = options
      this.visible = false
      this.focused = false
      this.opacity = 0
      this.focusable = false
      this.ignored = true
      this.bounds = { x: 0, y: 0, width: 1200, height: 800 }
      this.messages = []
      this.webContents = new EventEmitter()
      Object.assign(this.webContents, {
        setWindowOpenHandler() {},
        invalidate() {},
        send: (channel, state) => this.messages.push({ channel, state }),
      })
    }
    loadURL() {}
    isDestroyed() { return false }
    isVisible() { return this.visible }
    isFocused() { return this.focused }
    showInactive() { this.visible = true }
    setOpacity(value) { this.opacity = value }
    setIgnoreMouseEvents(value) { this.ignored = value }
    setFocusable(value) { this.focusable = value }
    focus() { this.focused = true }
    setAlwaysOnTop(value) { this.topmost = value }
    setVisibleOnAllWorkspaces() {}
    getBounds() { return this.bounds }
    setBounds(bounds) { this.bounds = bounds }
  }
  const timers = []
  const sandbox = {
    require(name) {
      if (name === 'electron') return {
        app, BrowserWindow: Window, ipcMain: ipc,
        screen: {
          getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }),
          screenToDipRect: (_window, rect) => rect,
        },
        shell: {},
      }
      if (name === 'node:child_process') return { spawn() { throw new Error('unexpected spawn') } }
      if (name === 'node:path') return path
      if (name === 'node:os') return { homedir: () => '/test-home' }
      if (name === 'node:fs') return { readFileSync() { throw new Error('no running host') } }
      if (name === './window-bounds.cjs') return {
        overlayBoundsForHost: (rect) => rect,
        physicalToDip: (rect) => rect,
        rectsClose: () => true,
      }
      throw new Error('unexpected module: ' + name)
    },
    __dirname: '/overlay',
    process: { env: { DEEPSEEK_WHALE_OVERLAY_LOG: '0' }, platform: 'linux' },
    setInterval() { return { unref() {} } },
    setTimeout(callback) { timers.push(callback); return { unref() {} } },
    clearInterval() {},
  }
  vm.runInNewContext(source + '\ncreateWindow(); pageReady = true; globalThis.overlay = win; globalThis.follow = applyFollowerMessage;', sandbox)
  const message = { x: 0, y: 0, w: 1200, h: 800, show: true }
  sandbox.follow(message)
  return { window: sandbox.overlay, follow: sandbox.follow, ipc, timers, quits: () => quits, message }
}

test('renderer navigation releases obsolete input capture before the new page loads', () => {
  const { window, ipc } = loadOverlay()
  ipc.emit('deepseek-whale:interactive', {}, true)
  ipc.emit('deepseek-whale:keyboard-focus', {}, true)
  window.webContents.emit('did-start-loading')
  assert.equal(window.ignored, true)
  assert.equal(window.focusable, false)
  window.webContents.emit('did-finish-load')
  assert.equal(window.messages.at(-1).state.visible, true)
  ipc.emit('deepseek-whale:interactive', {}, true)
  ipc.emit('deepseek-whale:keyboard-focus', {}, true)
  assert.equal(window.ignored, false)
  assert.equal(window.focusable, true)
})

test('renderer crash immediately releases input and hidden reload resends visibility', () => {
  const { window, ipc, follow } = loadOverlay()
  ipc.emit('deepseek-whale:interactive', {}, true)
  ipc.emit('deepseek-whale:keyboard-focus', {}, true)
  window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(window.ignored, true)
  assert.equal(window.focusable, false)
  follow({ hide: true })
  window.messages.length = 0
  window.webContents.emit('did-finish-load')
  assert.equal(window.messages.at(-1).state.visible, false)
  assert.equal(window.opacity, 0)
})

test('follower z-order failure does not hide a valid host state', () => {
  assert.match(followerSource, /if \(show\) SyncOverlayOrder\(z\)/)
  assert.doesNotMatch(followerSource, /if \(show\) show = SyncOverlayOrder\(z\)/)
})

test('overlay starts non-topmost and does not raise itself across other apps', () => {
  const { window, follow, message } = loadOverlay()
  assert.equal(window.options.alwaysOnTop, false)
  assert.equal(window.topmost, false)
  for (let i = 0; i < 100; i++) follow(message)
  assert.equal(window.topmost, false)
})

test('overlay blur preserves visibility and mouse interactions', () => {
  const { window, ipc } = loadOverlay()
  ipc.emit('deepseek-whale:interactive', {}, true)
  window.emit('blur')
  assert.equal(window.opacity, 1)
  assert.equal(window.ignored, false)
  ipc.emit('deepseek-whale:interactive', {}, false)
  assert.equal(window.ignored, true)
  assert.equal(window.opacity, 1)
})

test('keyboard blur releases focus without hiding or stealing foreground back', () => {
  const { window, ipc, timers } = loadOverlay()
  ipc.emit('deepseek-whale:keyboard-focus', {}, true)
  assert.equal(window.focusable, true)
  window.focused = false
  window.emit('blur')
  assert.equal(window.messages.at(-1).state.blur, true)
  assert.equal(window.opacity, 1)
  ipc.emit('deepseek-whale:keyboard-focus', {}, false)
  for (const callback of timers) callback()
  assert.equal(window.focusable, false)
  assert.equal(window.focused, false)
  assert.equal(window.opacity, 1)
})

test('a delayed keyboard release does not disable a newly focused text input', () => {
  const { window, ipc, timers } = loadOverlay()
  ipc.emit('deepseek-whale:keyboard-focus', {}, true)
  window.focused = false
  ipc.emit('deepseek-whale:keyboard-focus', {}, false)
  ipc.emit('deepseek-whale:keyboard-focus', {}, true)
  for (const callback of timers.splice(0)) callback()
  assert.equal(window.focusable, true)
})

test('minimize and restore preserve the existing hide/show behavior', () => {
  const { window, follow, message, ipc } = loadOverlay()
  ipc.emit('deepseek-whale:keyboard-focus', {}, true)
  follow({ show: false, minimized: true, x: -32000, y: -32000 })
  assert.equal(window.opacity, 0)
  assert.equal(window.ignored, true)
  assert.equal(window.focusable, false)
  follow(message)
  assert.equal(window.opacity, 1)
  assert.equal(window.ignored, true)
})

test('1000 switches across multiple apps and null foreground keep the overlay visible and interactive', () => {
  const { window, follow, message, ipc, timers, quits } = loadOverlay()
  const foregrounds = [
    { fgPid: 42, fgIsTarget: true, fgIsOverlay: false },
    { fgPid: 100, fgIsTarget: false, fgIsOverlay: false },
    { fgPid: 200, fgIsTarget: false, fgIsOverlay: false },
    { fgPid: 300, fgIsTarget: false, fgIsOverlay: false },
    { fgPid: 0, fgIsTarget: false, fgIsOverlay: false },
    { fgPid: 99, fgIsTarget: false, fgIsOverlay: true },
  ]
  for (let i = 0; i < 1000; i++) {
    const foreground = foregrounds[i % foregrounds.length]
    const show = followerVisibility.runInNewContext({
      ...foreground, minimized: false, visible: true, isCloaked: false,
    })
    follow({ ...message, show })
    ipc.emit('deepseek-whale:interactive', {}, true)
    ipc.emit('deepseek-whale:keyboard-focus', {}, true)
    window.focused = false
    window.emit('blur')
    ipc.emit('deepseek-whale:keyboard-focus', {}, false)
    for (const callback of timers.splice(0)) callback()
    assert.equal(window.opacity, 1, `switch ${i}: foreground pid ${foreground.fgPid}`)
    assert.equal(window.focusable, false)
    assert.equal(window.focused, false)
    ipc.emit('deepseek-whale:interactive', {}, false)
    assert.equal(window.ignored, true)
  }
  assert.equal(quits(), 0)
  assert.ok(window.messages.filter((m) => typeof m.state.visible === 'boolean').every((m) => m.state.visible))
})

test('explicit host hide and restore release input capture without stealing focus', () => {
  const { window, follow, message, ipc } = loadOverlay()
  ipc.emit('deepseek-whale:interactive', {}, true)
  ipc.emit('deepseek-whale:keyboard-focus', {}, true)
  // Windows has already moved focus to the other application.
  window.focused = false
  for (let i = 0; i < 3; i++) {
    follow({ ...message, show: false })
    assert.equal(window.opacity, 0)
    assert.equal(window.ignored, true)
    assert.equal(window.focusable, false)
    assert.equal(window.messages.at(-1).state.visible, false)
    ipc.emit('deepseek-whale:interactive', {}, true)
    ipc.emit('deepseek-whale:keyboard-focus', {}, true)
    assert.equal(window.ignored, true)
    assert.equal(window.focusable, false)
    assert.equal(window.focused, false)
    follow(message)
    assert.equal(window.opacity, 1)
    assert.equal(window.ignored, true)
    assert.equal(window.focused, false)
    assert.equal(window.messages.at(-1).state.visible, true)
  }
})

test('minimization stays hidden across app switches and restoring in background shows the overlay', () => {
  const { window, follow, message } = loadOverlay()
  for (let i = 0; i < 30; i++) {
    const show = followerVisibility.runInNewContext({
      fgIsTarget: false, fgIsOverlay: false, minimized: true, visible: true, isCloaked: false,
    })
    follow({ ...message, show, minimized: true, x: -32000, y: -32000 })
    assert.equal(window.opacity, 0)
    assert.equal(window.ignored, true)
  }
  const show = followerVisibility.runInNewContext({
    fgIsTarget: false, fgIsOverlay: false, minimized: false, visible: true, isCloaked: false,
  })
  follow({ ...message, show, minimized: false })
  assert.equal(window.opacity, 1)
})

test('a temporarily missing host recovers at identical bounds', () => {
  const { window, follow, message } = loadOverlay()
  follow({ hide: true })
  assert.equal(window.opacity, 0)
  follow(message)
  assert.equal(window.opacity, 1)
})

test('an explicit quit cannot be undone by a late follower show message', async () => {
  const { window, follow, message, ipc, quits } = loadOverlay()
  follow({ hide: true })
  ipc.emit('deepseek-whale:quit')
  follow(message)
  assert.equal(window.opacity, 0)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(quits(), 1)
})

for (const kind of ['explicit quit', 'host exit']) {
  test(`${kind} still quits the overlay`, async () => {
    const { ipc, follow, quits } = loadOverlay()
    if (kind === 'explicit quit') ipc.emit('deepseek-whale:quit')
    else follow({ gone: true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(quits(), 1)
  })
}
