// 透明浮层「隐藏时不轮询 / 恢复可见立即补刷」的回归测试。
//
// 背景：浮层靠透明度隐藏，document.hidden 一直是 false。旧实现里 60 秒余额刷新与
// 1 秒 last-turn / wait 轮询在隐藏期间照发 ⇒ 请求全堆进 overlay-bridge 的挂起队列，
// 隐藏几小时后恢复可见时队列一次性涌出，表现为卡死 / 恢复迟滞。
//
// 做法与 api-models-refresh.test.mjs 一致：从真实源码里截取函数，在 vm 沙箱里配桩，
// 并检查真实的 setInterval 绑定确实指向这两个受门控的 tick。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET = path.join(HERE, '..', 'assets', 'whale-widget.js')
const BRIDGE = path.join(HERE, '..', 'assets', 'overlay-bridge.js')
const SOURCE = fs.readFileSync(WIDGET, 'utf8')
const BRIDGE_SOURCE = fs.readFileSync(BRIDGE, 'utf8')

const VIEW_EVENT = 'dshwv:whale-view-visible'

function skipString(src, i) {
  const q = src[i]
  i++
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === q) return i
    i++
  }
  return i
}

function extractFunction(src, name) {
  const marker = 'function ' + name + '('
  const start = src.indexOf(marker)
  assert.ok(start >= 0, '找不到函数 ' + name)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === "'" || c === '"' || c === '`') { i = skipString(src, i); continue }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i); if (i < 0) break; i++; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('函数体未闭合: ' + name)
}

const FN_NAMES = [
  'dshwOverlayHidden', 'dshwBalanceRefreshTick', 'dshwTurnPollTick', 'dshwUsageRefreshTick',
  'dshwResumeVisible',
]
const FUNCTIONS = FN_NAMES.map((n) => extractFunction(SOURCE, n)).join('\n')

function makeSandbox(opts) {
  const o = opts || {}
  const hits = { refresh: 0, loadApiModels: 0, pollLastTurn: 0, pollWaitState: 0, renderUsagePanel: 0 }
  const winListeners = []
  const whyCalls = { n: 0 }
  let overlayObj = null
  if (o.overlay) {
    overlayObj = {}
    // 真实桥接两种读取方式都提供：
    //   visible() —— 每秒轮询该走的轻量路径（不做 DOM 探测）
    //   why()     —— 诊断接口（含 elementFromPoint 等，不能每秒调用）
    if (o.fastPath !== false) overlayObj.visible = () => !!o.overlayVisible
    overlayObj.why = () => { whyCalls.n++; return { visible: !!o.overlayVisible } }
  }
  const sandbox = {
    window: overlayObj ? { __deepseekWhaleOverlay: overlayObj } : {},
    refresh() { hits.refresh++ },
    loadApiModels() { hits.loadApiModels++ },
    pollLastTurn() { hits.pollLastTurn++ },
    pollWaitState() { hits.pollWaitState++ },
    // 用量子界面自动重绘：与源码同名，门控变量按 opts 注入
    renderUsagePanel() { hits.renderUsagePanel++ },
    usagePanelOpen: !!o.usagePanelOpen,
    usageHover: !!o.usageHover,
    usageBusyUntil: Number(o.usageBusyUntil) || 0,
    Date, Number, String, Boolean,
  }
  sandbox.window.addEventListener = (type, fn) => { winListeners.push({ type, fn }) }
  vm.createContext(sandbox)
  vm.runInContext(
    'var apiModelsPollLastAt = 0;\n' +
    'var WHALE_VIEW_EVENT = ' + JSON.stringify(VIEW_EVENT) + ';\n' +
    FUNCTIONS + '\n' +
    // 与源码尾部完全相同的绑定方式
    'window.addEventListener(WHALE_VIEW_EVENT, dshwResumeVisible);\n',
    sandbox,
    { filename: 'whale-widget-overlay-tick.js' }
  )
  return { sandbox, hits, winListeners, whyCalls }
}

test('两个周期 tick 的真实 setInterval 绑定都走受门控的包装函数', () => {
  assert.match(SOURCE, /setInterval\(dshwBalanceRefreshTick,\s*REFRESH_MS\)/,
    '60 秒余额刷新必须绑定受门控的 dshwBalanceRefreshTick')
  assert.doesNotMatch(SOURCE, /setInterval\(function\s*\(\)\s*\{\s*refresh\(false\)/,
    '不得回退成裸 refresh 的 60 秒 interval')
  assert.match(SOURCE, /setInterval\(dshwTurnPollTick,\s*1000\)/,
    '1 秒 last-turn / wait 轮询必须绑定受门控的 dshwTurnPollTick')
  assert.doesNotMatch(SOURCE, /setInterval\(function\s*\(\)\s*\{\s*pollLastTurn\(\)/,
    '不得回退成裸 pollLastTurn 的 1 秒 interval')
})

test('用量子界面 10 秒重绘的真实 setInterval 绑定也走受门控的 dshwUsageRefreshTick', () => {
  assert.match(SOURCE, /usageRefreshTimer = setInterval\(dshwUsageRefreshTick,\s*10000\)/,
    '用量子界面重绘必须绑定受门控的 dshwUsageRefreshTick')
  assert.doesNotMatch(SOURCE, /setInterval\(function\s*\(\)\s*\{\s*if \(!usagePanelOpen\) return/,
    '不得回退成裸内联的用量重绘 interval')
})

test('恢复可见事件名与桥接派发的事件名一致', () => {
  assert.match(BRIDGE_SOURCE, /'dshwv:whale-view-visible'/, '桥接必须派发同名事件')
  assert.match(SOURCE, new RegExp('WHALE_VIEW_EVENT = \'dshwv:whale-view-visible\''),
    '挂件侧的常量必须与桥接一致')
  assert.match(BRIDGE_SOURCE, /if \(!wasVisible\) notifyVisible\(\)/,
    '桥接只在「隐藏 → 可见」转换时通知')
})

test('60 秒余额 tick：普通页面照常刷新，浮层隐藏时一次都不发', () => {
  // 普通页面（无桥接诊断对象）
  const page = makeSandbox()
  assert.equal(page.sandbox.dshwBalanceRefreshTick(), true)
  assert.equal(page.hits.refresh, 1)
  assert.equal(page.hits.loadApiModels, 1)
  assert.equal(page.hits.pollLastTurn, 0, '余额 tick 不碰 last-turn')

  // 普通页面 document.hidden：由浏览器节流，语义不变（这里不额外拦截）
  // 浮层隐藏：不发任何请求
  const hidden = makeSandbox({ overlay: true, overlayVisible: false })
  assert.equal(hidden.sandbox.dshwBalanceRefreshTick(), false)
  assert.equal(hidden.hits.refresh, 0, '浮层隐藏 ⇒ 不刷余额')
  assert.equal(hidden.hits.loadApiModels, 0, '浮层隐藏 ⇒ 不刷模型列表')

  // 浮层可见：照常
  const shown = makeSandbox({ overlay: true, overlayVisible: true })
  assert.equal(shown.sandbox.dshwBalanceRefreshTick(), true)
  assert.equal(shown.hits.refresh, 1)
})

test('1 秒 last-turn / wait tick：浮层隐藏时一次都不发', () => {
  const page = makeSandbox()
  assert.equal(page.sandbox.dshwTurnPollTick(), true)
  assert.equal(page.hits.pollLastTurn, 1)
  assert.equal(page.hits.pollWaitState, 1)
  assert.equal(page.hits.refresh, 0, 'last-turn tick 不碰余额')

  const hidden = makeSandbox({ overlay: true, overlayVisible: false })
  assert.equal(hidden.sandbox.dshwTurnPollTick(), false)
  assert.equal(hidden.hits.pollLastTurn, 0, '浮层隐藏 ⇒ 不轮询 last-turn')
  assert.equal(hidden.hits.pollWaitState, 0, '浮层隐藏 ⇒ 不轮询 wait')

  const shown = makeSandbox({ overlay: true, overlayVisible: true })
  assert.equal(shown.sandbox.dshwTurnPollTick(), true)
  assert.equal(shown.hits.pollLastTurn, 1)
})

test('恢复可见事件立即补刷两条链路（不等 60 秒 / 1 秒下一 tick）', () => {
  const { sandbox, hits, winListeners } = makeSandbox({ overlay: true, overlayVisible: true })
  // 先记下基线：不依赖任何周期定时器，只验证事件带来的增量
  const before = { ...hits }
  void sandbox

  // 恢复：桥接派发事件 → 监听器立刻补刷
  const listener = winListeners.find((l) => l.type === VIEW_EVENT)
  assert.equal(typeof listener.fn, 'function', '必须订阅恢复可见事件')
  listener.fn()

  assert.equal(hits.refresh, before.refresh + 1, '恢复可见必须立刻补刷余额')
  assert.equal(hits.loadApiModels, before.loadApiModels + 1, '恢复可见必须立刻补刷模型列表')
  assert.equal(hits.pollLastTurn, before.pollLastTurn + 1, '恢复可见必须立刻补一次 last-turn')
  assert.equal(hits.pollWaitState, before.pollWaitState + 1, '恢复可见必须立刻补一次 wait')
})

test('隐藏时收到恢复事件也不发请求（事件早于 visible 状态更新也不会破门）', () => {
  const { hits, winListeners } = makeSandbox({ overlay: true, overlayVisible: false, usagePanelOpen: true })
  const listener = winListeners.find((l) => l.type === VIEW_EVENT)
  listener.fn()
  assert.equal(hits.refresh, 0, '仍然不可见 ⇒ 补刷也必须被门控挡住')
  assert.equal(hits.pollLastTurn, 0)
  assert.equal(hits.renderUsagePanel, 0, '仍然不可见 ⇒ 用量面板也不补重绘')
})

// ===== 用量子界面 10 秒自动重绘（usageRefreshTimer）=====

test('用量重绘 tick：浮层隐藏时一次都不重绘', () => {
  // 普通页面：面板开着就重绘（与旧内联实现一致）
  const page = makeSandbox({ usagePanelOpen: true })
  assert.equal(page.sandbox.dshwUsageRefreshTick(), true)
  assert.equal(page.hits.renderUsagePanel, 1)

  // 浮层隐藏：即使面板开着也不重绘
  const hidden = makeSandbox({ overlay: true, overlayVisible: false, usagePanelOpen: true })
  assert.equal(hidden.sandbox.dshwUsageRefreshTick(), false)
  assert.equal(hidden.hits.renderUsagePanel, 0, '浮层隐藏 ⇒ 不重绘用量面板')

  // 浮层可见：照常
  const shown = makeSandbox({ overlay: true, overlayVisible: true, usagePanelOpen: true })
  assert.equal(shown.sandbox.dshwUsageRefreshTick(), true)
  assert.equal(shown.hits.renderUsagePanel, 1)
})

test('用量重绘 tick 保留原有门控：面板未开 / 悬停 / 刚滚动都不重绘', () => {
  const closed = makeSandbox({ usagePanelOpen: false })
  assert.equal(closed.sandbox.dshwUsageRefreshTick(), false, '面板没开不重绘')
  assert.equal(closed.hits.renderUsagePanel, 0)

  const hover = makeSandbox({ usagePanelOpen: true, usageHover: true })
  assert.equal(hover.sandbox.dshwUsageRefreshTick(), false, '鼠标停在面板上不重绘')
  assert.equal(hover.hits.renderUsagePanel, 0)

  const busy = makeSandbox({ usagePanelOpen: true, usageBusyUntil: Date.now() + 2000 })
  assert.equal(busy.sandbox.dshwUsageRefreshTick(), false, '刚滚动过不重绘')
  assert.equal(busy.hits.renderUsagePanel, 0)

  // busy 窗口已过：恢复重绘
  const busyOver = makeSandbox({ usagePanelOpen: true, usageBusyUntil: Date.now() - 1 })
  assert.equal(busyOver.sandbox.dshwUsageRefreshTick(), true)
  assert.equal(busyOver.hits.renderUsagePanel, 1)
})

test('恢复可见时用量面板开着就立即补一次重绘（不等 10 秒下一 tick）', () => {
  const { hits, winListeners } = makeSandbox({ overlay: true, overlayVisible: true, usagePanelOpen: true })
  const before = hits.renderUsagePanel
  winListeners.find((l) => l.type === VIEW_EVENT).fn()
  assert.equal(hits.renderUsagePanel, before + 1, '恢复可见必须立刻补一次用量重绘')
})

test('恢复可见但面板未开 / 正在悬停时不强行重绘（不打乱交互）', () => {
  const closed = makeSandbox({ overlay: true, overlayVisible: true, usagePanelOpen: false })
  closed.winListeners.find((l) => l.type === VIEW_EVENT).fn()
  assert.equal(closed.hits.renderUsagePanel, 0, '面板没开 ⇒ 恢复可见也不重绘')

  const hover = makeSandbox({ overlay: true, overlayVisible: true, usagePanelOpen: true, usageHover: true })
  hover.winListeners.find((l) => l.type === VIEW_EVENT).fn()
  assert.equal(hover.hits.renderUsagePanel, 0, '用户正悬停 ⇒ 恢复可见不打断')

  const busy = makeSandbox({
    overlay: true, overlayVisible: true, usagePanelOpen: true, usageBusyUntil: Date.now() + 2000,
  })
  busy.winListeners.find((l) => l.type === VIEW_EVENT).fn()
  assert.equal(busy.hits.renderUsagePanel, 0, '刚滚动过 ⇒ 恢复可见不打断')
})

test('每秒可见性判定走桥接的轻量 visible()，不跑 why() 的 DOM 探测', () => {
  const fast = makeSandbox({ overlay: true, overlayVisible: true })
  fast.sandbox.dshwTurnPollTick()
  assert.equal(fast.whyCalls.n, 0, '有 visible() 时绝不能每秒调 why()（里面有 elementFromPoint）')

  // 兼容旧桥接：没有 visible() 时退回 why().visible，行为一致
  const legacy = makeSandbox({ overlay: true, overlayVisible: false, fastPath: false })
  assert.equal(legacy.sandbox.dshwTurnPollTick(), false, '旧桥接仍能判定隐藏')
  assert.equal(legacy.hits.pollLastTurn, 0)
  assert.ok(legacy.whyCalls.n >= 1)
})
