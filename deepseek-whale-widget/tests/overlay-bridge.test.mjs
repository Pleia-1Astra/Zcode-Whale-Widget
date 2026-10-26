// overlay-bridge 的请求暂停逻辑测试（用最小 DOM/Electron 桩在 vm 里跑真实脚本）。
//
// 校验：浮层被隐藏时 /dsh-whale/ 请求被挂起、恢复可见后按原参数重发；
// 非 /dsh-whale/ 请求不受影响；暂停期间仍遵守调用方的取消与超时；
// 隐藏期间反复 tick 不产生请求；恢复可见时派发一次「重新可见」事件给挂件补刷。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BRIDGE = path.join(HERE, '..', 'assets', 'overlay-bridge.js')

// 与 assets/overlay-bridge.js / whale-widget.js 中的事件名必须一致
const VIEW_EVENT = 'dshwv:whale-view-visible'

function loadBridge(fetchImpl) {
  const source = fs.readFileSync(BRIDGE, 'utf8')
  const listeners = { doc: [], win: [] }
  let windowStateCb = null
  const calls = []
  const events = []

  const fakeDoc = {
    hidden: false,
    activeElement: null,
    addEventListener(type, fn) {
      listeners.doc.push({ type, fn })
    },
    querySelector() {
      return null
    },
    elementFromPoint() {
      return null
    },
    getElementById() {
      return null
    },
  }

  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type
      this.detail = init && init.detail
      this.bubbles = false
    }
  }

  const fakeWindow = {
    innerWidth: 1200,
    innerHeight: 800,
    CustomEvent: FakeCustomEvent,
    whaleDesktop: {
      isOverlay: true,
      setInteractive() {},
      setKeyboardFocus() {},
      dismissReplay() {},
      quit() {},
      onCursor() {},
      onWindowState(cb) {
        windowStateCb = cb
      },
    },
    addEventListener(type, fn) {
      listeners.win.push({ type, fn })
    },
    dispatchEvent(ev) {
      events.push(ev && ev.type)
      for (const l of listeners.win) {
        if (l.type === ev.type) l.fn(ev)
      }
      return true
    },
    getComputedStyle() {
      return { display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'none' }
    },
  }

  // 记录所有真实发出的请求
  fakeWindow.fetch = (input, init) => {
    calls.push({ input, init })
    if (fetchImpl) return fetchImpl(input, init)
    return Promise.resolve({ ok: true, json: async () => ({ ok: true }) })
  }

  const sandbox = {
    window: fakeWindow,
    document: fakeDoc,
    setTimeout,
    clearTimeout,
    Promise,
    Object,
    Number,
    String,
    Boolean,
    Date,
    Math,
    Array,
    JSON,
    console,
  }
  sandbox.globalThis = sandbox
  fakeWindow.document = fakeDoc
  vm.runInNewContext(source, sandbox, { filename: BRIDGE })

  assert.ok(fakeWindow.__deepseekWhaleOverlay, 'bridge 应挂载诊断对象')
  assert.equal(typeof windowStateCb, 'function', 'bridge 应订阅窗口状态')
  return { fakeWindow, windowStateCb, calls, events }
}

function flush() {
  return new Promise((r) => setTimeout(r, 10))
}

test('hiding the overlay defers /dsh-whale/ requests until visible again', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge()

  // 可见状态：请求直接发出
  const before = fakeWindow.fetch('/dsh-whale/size.json', { cache: 'no-store' })
  await before
  assert.equal(calls.length, 1)

  // 隐藏：/dsh-whale/ 请求挂起，非 /dsh-whale/ 照常
  windowStateCb({ visible: false })
  const paused = fakeWindow.fetch('/dsh-whale/balance.json')
  const other = fakeWindow.fetch('https://example.com/x.json')
  await other
  assert.equal(calls.length, 2, '非 /dsh-whale/ 请求不应被暂停')
  assert.equal(calls[1].input, 'https://example.com/x.json')

  // 稍等，确认暂停的请求确实没发出
  await flush()
  assert.equal(calls.length, 2)

  // 恢复：挂起的请求被重发
  windowStateCb({ visible: true })
  await paused
  assert.equal(calls.length, 3)
  assert.equal(calls[2].input, '/dsh-whale/balance.json')
})

test('paused requests reject on abort before visibility returns and are never replayed', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge()
  windowStateCb({ visible: false })
  const ctrl = new AbortController()
  let rejected = null
  const pending = fakeWindow.fetch('/dsh-whale/last-turn.json', { signal: ctrl.signal })
    .catch((err) => { rejected = err })
  ctrl.abort()
  await flush()
  assert.equal(rejected, ctrl.signal.reason, '取消必须在隐藏期间释放调用方，而不是等恢复可见')
  windowStateCb({ visible: true })
  await pending
  assert.equal(calls.length, 0, '取消的请求不得重新发出')
})

for (const inputKind of ['init', 'Request']) {
  test(`already aborted ${inputKind} signals reject without queueing`, async () => {
    const { fakeWindow, windowStateCb, calls } = loadBridge()
    windowStateCb({ visible: false })
    const ctrl = new AbortController()
    ctrl.abort(new Error('cancelled'))
    const input = inputKind === 'Request'
      ? new Request('http://localhost/dsh-whale/balance.json', { signal: ctrl.signal })
      : '/dsh-whale/balance.json'
    let rejected = null
    fakeWindow.fetch(input, inputKind === 'init' ? { signal: ctrl.signal } : undefined)
      .catch((err) => { rejected = err })
    await flush()
    assert.equal(rejected, ctrl.signal.reason)
    windowStateCb({ visible: true })
    assert.equal(calls.length, 0)
  })
}

test('resumed requests retain their signal and detach the queue abort listener', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge()
  windowStateCb({ visible: false })
  const ctrl = new AbortController()
  let adds = 0
  let removes = 0
  const add = ctrl.signal.addEventListener.bind(ctrl.signal)
  const remove = ctrl.signal.removeEventListener.bind(ctrl.signal)
  ctrl.signal.addEventListener = (...args) => { adds++; return add(...args) }
  ctrl.signal.removeEventListener = (...args) => { removes++; return remove(...args) }
  const opts = { cache: 'no-store', signal: ctrl.signal }
  const pending = fakeWindow.fetch('/dsh-whale/balance.json', opts)
  windowStateCb({ visible: true })
  await pending
  assert.equal(calls[0].init, opts)
  assert.equal(adds, 1)
  assert.equal(removes, 1)
  ctrl.abort()
  windowStateCb({ visible: false })
  windowStateCb({ visible: true })
  assert.equal(calls.length, 1)
})

test('a resumed stalled request still observes the original timeout signal', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge((_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  }))
  windowStateCb({ visible: false })
  const ctrl = new AbortController()
  const pending = fakeWindow.fetch('/dsh-whale/balance.json', { signal: ctrl.signal })
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  windowStateCb({ visible: true })
  assert.equal(calls.length, 1)
  ctrl.abort()
  await rejected
})

test('init signal overrides a Request signal, including explicit null', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge()
  const original = new AbortController()
  const override = new AbortController()
  const input = new Request('http://localhost/dsh-whale/balance.json', { signal: original.signal })
  windowStateCb({ visible: false })
  const pending = fakeWindow.fetch(input, { signal: override.signal })
  original.abort()
  windowStateCb({ visible: true })
  await pending
  assert.equal(calls[0].init.signal, override.signal)
  windowStateCb({ visible: false })
  const uncancelled = fakeWindow.fetch(input, { signal: null })
  windowStateCb({ visible: true })
  await uncancelled
  assert.equal(calls[1].init.signal, null)
})

test('balance timeout while paused releases busy and permits a later refresh', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge()
  const widgetSource = fs.readFileSync(path.join(HERE, '..', 'assets', 'whale-widget.js'), 'utf8')
  const start = widgetSource.indexOf('function refresh(manual) {')
  const end = widgetSource.indexOf('\nvar soundOn', start)
  const timers = new Map()
  let timerId = 0
  const sandbox = {
    busy: false, animDelayTimer: null, state: { balance: null },
    render() {}, balanceRetryLater() {}, AbortController,
    FETCH_TIMEOUT_MS: 25000, BALANCE_URL: '/dsh-whale/balance.json',
    fetch: (...args) => fakeWindow.fetch(...args),
    setTimeout(fn) { timers.set(++timerId, fn); return timerId },
    clearTimeout(id) { timers.delete(id) },
  }
  vm.createContext(sandbox)
  vm.runInContext(widgetSource.slice(start, end), sandbox)
  windowStateCb({ visible: false })
  sandbox.refresh(false)
  assert.equal(sandbox.busy, true)
  for (const fn of [...timers.values()]) fn()
  await flush()
  assert.equal(sandbox.busy, false, '实际 refresh 的 finally 必须被执行')
  assert.equal(timers.size, 0)
  windowStateCb({ visible: true })
  assert.equal(calls.length, 0, '不得复活已经超时的旧请求')
  sandbox.refresh(false)
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(sandbox.busy, false)
})

test('hide/show toggles are idempotent and keep queue order', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge()

  windowStateCb({ visible: false })
  windowStateCb({ visible: false })
  const a = fakeWindow.fetch('/dsh-whale/bubble.json')
  const b = fakeWindow.fetch('/dsh-whale/roles.json')
  windowStateCb({ visible: true })
  windowStateCb({ visible: true })
  await Promise.all([a, b])

  assert.deepEqual(
    calls.map((c) => c.input),
    ['/dsh-whale/bubble.json', '/dsh-whale/roles.json']
  )
})

test('blur does not override an explicitly hidden overlay', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge()
  windowStateCb({ visible: false })
  const pending = fakeWindow.fetch('/dsh-whale/balance.json')
  windowStateCb({ blur: true })
  await flush()
  assert.equal(calls.length, 0, 'blur must not resume a minimized or hidden overlay')
  windowStateCb({ visible: true })
  await pending
  assert.equal(calls.length, 1)
})

test('window-state blur triggers teardown without pausing forever', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge()
  windowStateCb({ blur: true })
  // blur 不等于隐藏：请求仍正常发出
  await fakeWindow.fetch('/dsh-whale/wait.json')
  assert.equal(calls.length, 1)
})

// ===== 隐藏期间不发请求 / 恢复可见立即补刷 =====

test('隐藏期间反复 tick 不产生任何 /dsh-whale/ 请求', async () => {
  const { fakeWindow, windowStateCb, calls } = loadBridge()
  windowStateCb({ visible: false })
  // 模拟 60 秒余额刷新 + 1 秒 last-turn/wait 轮询在隐藏期间持续触发：
  // 挂件已按可见性提前 return，桥接队列里也不应堆积任何东西。
  const parked = []
  for (let i = 0; i < 5; i++) parked.push(fakeWindow.fetch('/dsh-whale/last-turn.json'))
  await flush()
  assert.equal(calls.length, 0, '隐藏期间不应有真实请求')
  // 恢复后队列里没有积压 ⇒ 只补刷恢复时该发的那一发
  windowStateCb({ visible: true })
  await Promise.all(parked)
  assert.equal(calls.length, 5, '恢复后原有 5 个请求按序重发（不含额外补刷请求）')
  await fakeWindow.fetch('/dsh-whale/last-turn.json')
  assert.equal(calls.length, 6, '恢复后新的 tick 正常发出')
})

test('hidden → visible 派发一次 whale-view-visible 事件（触发挂件立即补刷）', async () => {
  const { windowStateCb, events } = loadBridge()
  windowStateCb({ visible: false })
  assert.equal(events.filter((e) => e === VIEW_EVENT).length, 0, '隐藏本身不派发')
  windowStateCb({ visible: true })
  assert.equal(events.filter((e) => e === VIEW_EVENT).length, 1, '恢复可见必须派发一次补刷事件')
})

test('重复的 visible 状态不重复派发补刷事件', () => {
  const { windowStateCb, events } = loadBridge()
  windowStateCb({ visible: true })
  windowStateCb({ visible: true })
  windowStateCb({ blur: true }) // blur 不等于隐藏，不应额外派发
  assert.equal(events.filter((e) => e === VIEW_EVENT).length, 0, '一直可见时不需要补刷')
  windowStateCb({ visible: false })
  windowStateCb({ visible: true })
  windowStateCb({ visible: true })
  assert.equal(events.filter((e) => e === VIEW_EVENT).length, 1, '每次真实恢复只补刷一次')
})

test('恢复可见补刷事件在挂起请求重发之后派发（顺序契约不变）', async () => {
  const { fakeWindow, windowStateCb, calls, events } = loadBridge()
  let eventSawCalls = -1
  fakeWindow.addEventListener(VIEW_EVENT, () => { eventSawCalls = calls.length })
  windowStateCb({ visible: false })
  const pending = fakeWindow.fetch('/dsh-whale/balance.json')
  windowStateCb({ visible: true })
  await pending
  assert.equal(calls.length, 1, '挂起的请求已被重发')
  assert.equal(eventSawCalls, 1, '挂件补刷时挂起队列已清空 ⇒ 不会与旧请求抢队列')
  void events
})

test('visible() 轻量读取跟随窗口状态（挂件每秒判定用，不做 DOM 探测）', () => {
  const { fakeWindow, windowStateCb } = loadBridge()
  const diag = fakeWindow.__deepseekWhaleOverlay
  assert.equal(typeof diag.visible, 'function', '桥接必须暴露轻量 visible()')
  assert.equal(diag.visible(), true, '初始可见')
  windowStateCb({ visible: false })
  assert.equal(diag.visible(), false, '隐藏后为 false')
  windowStateCb({ visible: true })
  assert.equal(diag.visible(), true, '恢复后为 true')
  // why() 仍然是原有形状（诊断用），visible 字段与 visible() 一致
  windowStateCb({ visible: false })
  assert.equal(diag.why().visible, false)
})
