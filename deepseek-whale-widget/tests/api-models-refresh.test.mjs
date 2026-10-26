// api-models 列表刷新链路的隔离回归测试（整体失败失效 / 请求代次 / 并发去重）。
//
// 背景（A6 旧值 bug）：apiModelsFetch 整次请求失败后，apiModels 里仍是上一次成功的快照，
// 挂件继续拿旧 A6 数字当当前值；并且失败后 apiModelsLoaded 仍为 true，
// loadApiModels(cb, false) 会直接复用缓存 ⇒ 下一次成功刷新被推迟到 60 秒轮询。
//
// 做法与 pet-balance-widget.test.mjs 一致：截取**真实函数源码**，在 vm 里配可控 fetch 桩。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WIDGET = path.join(HERE, '..', 'assets', 'whale-widget.js')
const SOURCE = fs.readFileSync(WIDGET, 'utf8')

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

const FN_NAMES = ['apiModelsFlushWaiters', 'apiModelsFailWaiters', 'apiModelsSuperseded', 'loadApiModels', 'apiModelsFetch', 'postApiModels']
// 短轮询（活跃门控 / 恢复可见时间门控）的 helper：与上面同一份真实源码
// dshwOverlayHidden 是 apiModelsViewHidden 依赖的浮层可见性判定（60s / 1s tick 也用同一份）。
const POLL_FN_NAMES = [
  'shouldPollApiModels', 'dshwOverlayHidden', 'apiModelsViewHidden', 'apiModelsPollActive',
  'apiModelsPollOnce', 'apiModelsPollTick',
]
const FUNCTIONS = FN_NAMES.concat(POLL_FN_NAMES).map((n) => extractFunction(SOURCE, n)).join('\n')
// 短轮询常量：从源码原样取值，避免测试里写死 15000 与实现漂移
function sourceNumber(name) {
  const m = SOURCE.match(new RegExp('var ' + name + ' = (\\d+)'))
  assert.ok(m, '源码必须定义常量 ' + name)
  return Number(m[1])
}
const POLL_MS = sourceNumber('API_MODELS_POLL_MS')
const POLL_MIN_GAP_MS = sourceNumber('API_MODELS_POLL_MIN_GAP_MS')
const POLL_FAIL_MS = sourceNumber('API_MODELS_POLL_FAIL_MS')

const A6_OLD = { id: 'vendor-a', name: 'A6', currency: 'CNY', balanceMode: 'api', hasBalanceApi: true, balance: 10, todayUsage: 1 }
const A6_NEW = { id: 'vendor-a', name: 'A6', currency: 'CNY', balanceMode: 'api', hasBalanceApi: true, balance: 20, todayUsage: 2 }
const A6_NULL = { id: 'vendor-a', name: 'A6', currency: 'CNY', balanceMode: 'api', hasBalanceApi: true, balance: null, error: 'HTTP 502' }

// 可控 fetch：每次调用返回一个「待定」Promise，测试用 resolve(n)/reject() 决定落地顺序
function makeFetchQueue() {
  const pending = []
  const fetch = (url, opts) => new Promise((resolve, reject) => {
    pending.push({ url, opts, resolve, reject })
  })
  return { fetch, pending }
}

function makeSandbox(opts) {
  const o = opts || {}
  const fq = makeFetchQueue()
  const timers = []
  const repaints = []
  const sandbox = {
    apiModels: o.models || [A6_OLD],
    apiModelsLoaded: o.loaded !== false,
    apiModelsStale: false,
    apiModelsSeq: 0,
    apiModelsError: '',
    apiModelsLoading: false,
    apiModelsWaiters: [],
    apiTemplates: [],
    usagePanelOpen: false,
    rebuildUsageSubShell() {},
    renderBubblePal() {},
    runApiModelAlerts() {},
    // 失败后必须把已开着的挂件刷新成占位（这里只记录调用，显示语义在 pet-balance-widget 测试里验）
    petBalanceRefreshDisplay() { repaints.push(1) },
    // 短轮询的活跃门控依赖这几个全局：默认「未选中 / 面板关 / 气泡不显示」= 完全不请求
    bubbleShown: !!o.bubbleShown,
    petBalanceSelectedId() { return String(o.petBalanceId || '') },
    // 页面可见性：document.hidden + 浮层桥接（window.__deepseekWhaleOverlay.why().visible）
    document: { hidden: !!o.hidden },
    window: o.overlay ? { __deepseekWhaleOverlay: { why() { return { visible: !!o.overlayVisible } } } } : {},
    fetch: fq.fetch,
    setTimeout(fn) { timers.push(fn); return timers.length },
    clearTimeout() {},
    JSON, Number, String, Array, Error, isFinite, Date,
    // AbortSignal 故意不提供：源码里 `typeof AbortSignal !== 'undefined'` 走跳过分支
  }
  vm.createContext(sandbox)
  vm.runInContext(
    'var apiModels = ' + JSON.stringify(o.models || [A6_OLD]) + ';\n' +
    'var apiModelsLoaded = ' + (o.loaded !== false) + ';\n' +
    'var apiModelsStale = false;\n' +
    'var apiModelsSeq = 0;\n' +
    'var apiModelsLoadingSeq = 0;\n' +
    'var apiModelsRetryAt = 0;\n' +
    'var apiModelsError = "";\n' +
    'var apiModelsLoading = false;\n' +
    'var apiModelsWaiters = [];\n' +
    'var apiTemplates = [];\n' +
    // 短轮询状态/常量：按源码原值注入，测的就是实现里那份数字
    'var apiModelsPollLastAt = 0;\n' +
    'var API_MODELS_POLL_MS = ' + POLL_MS + ';\n' +
    'var API_MODELS_POLL_MIN_GAP_MS = ' + POLL_MIN_GAP_MS + ';\n' +
    'var API_MODELS_POLL_FAIL_MS = ' + POLL_FAIL_MS + ';\n' +
    FUNCTIONS,
    sandbox,
    { filename: 'whale-widget-api-models.js' }
  )
  return { sandbox, fq, timers, repaints }
}

// 让所有挂起的 fetch 都按顺序落地：fn 决定每个回包内容
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
async function settleAll(fq, fn) {
  while (fq.pending.length) {
    const p = fq.pending.shift()
    try { fn(p) } catch (err) { p.reject(err) }
    await flush()
  }
}

function okResponse(payload) {
  return { ok: true, json: () => Promise.resolve(payload) }
}

test('成功回包整体替换列表：A6 旧值 → 新值', async () => {
  const { sandbox, fq } = makeSandbox()
  let seen = null
  sandbox.loadApiModels((r) => { seen = r }, true)
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW], templates: [] })))
  assert.equal(sandbox.apiModels[0].balance, 20, '下一次成功刷新必须取到新值')
  assert.equal(sandbox.apiModelsStale, false)
  assert.equal(sandbox.apiModelsLoading, false)
  assert.ok(seen && seen.ok, '等待者拿到成功回包')
  assert.equal(seen.stale, false)
})

// —— 厂商网站更新后，已打开挂件必须立刻刷新（不等 60 秒兜底轮询）——
test('GET 成功回包立即调用 petBalanceRefreshDisplay（已打开挂件马上显示新值）', async () => {
  const { sandbox, fq, repaints } = makeSandbox()
  sandbox.loadApiModels(null, true)
  assert.equal(repaints.length, 0, '回包前不重绘')
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW], templates: [] })))
  assert.equal(repaints.length, 1, '成功回包必须立刻刷新已打开的挂件')
  assert.equal(sandbox.apiModels[0].balance, 20)
})

test('已加载过的列表再刷新成功同样重绘（不是只在首次加载时）', async () => {
  const { sandbox, fq, repaints } = makeSandbox({ models: [A6_OLD], loaded: true })
  sandbox.loadApiModels(null, true) // force：绕过「已加载就复用缓存」
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW], templates: [] })))
  assert.equal(repaints.length, 1, 'wasLoaded=true 的增量刷新也必须重绘')
  assert.equal(sandbox.apiModels[0].balance, 20)
})

test('整次请求失败：标记失效、旧列表不再当当前值、允许立即重取', async () => {
  const { sandbox, fq, timers, repaints } = makeSandbox()
  sandbox.loadApiModels(null, true)
  // 3 次重试全部失败（tries=3 → 失败后退避重试到 0）
  for (let i = 0; i < 4 && fq.pending.length; i++) {
    const p = fq.pending.shift()
    p.reject(new Error('HTTP 502'))
    await flush()
    const t = timers.shift()
    if (t) t() // 触发退避重试
    await Promise.resolve()
  }
  assert.equal(sandbox.apiModelsStale, true, '整次失败后必须标记失效')
  assert.equal(sandbox.apiModelsLoading, false)
  assert.equal(sandbox.apiModelsError, '加载失败（点重试）')
  assert.ok(repaints.length >= 1, '失败后要立刻把挂件刷成占位，而不是等下一次 render')
  // 失败后 10 秒内：连点/重绘不得形成请求风暴
  sandbox.loadApiModels(null, false)
  assert.equal(fq.pending.length, 0, '失效态仍守 10 秒限频')
  // 超过 10 秒：非 force 调用也必须真的重新请求（旧实现会命中缓存一直返回旧值到 60 秒轮询）
  sandbox.apiModelsRetryAt = Date.now() - 11000
  sandbox.loadApiModels(null, false)
  assert.equal(fq.pending.length, 1, '失效态限频窗口过后 loadApiModels(cb, false) 必须发起新请求')
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW], templates: [] })))
  assert.equal(sandbox.apiModels[0].balance, 20)
  assert.equal(sandbox.apiModelsStale, false, '成功回包要清掉失效标记')
})

test('失效态 force 刷新不受 10 秒限频（手动重试立即生效）', async () => {
  const { sandbox, fq } = makeSandbox()
  sandbox.apiModelsStale = true
  sandbox.apiModelsRetryAt = Date.now() // 刚失败过
  sandbox.loadApiModels(null, true)
  assert.equal(fq.pending.length, 1, 'force 必须立即请求')
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW], templates: [] })))
  assert.equal(sandbox.apiModels[0].balance, 20)
})

test('首次列表加载失败同样受 10 秒限频保护', () => {
  const { sandbox, fq } = makeSandbox({ models: [], loaded: false })
  sandbox.apiModelsStale = true
  sandbox.apiModelsRetryAt = Date.now()
  sandbox.loadApiModels(null, false)
  assert.equal(fq.pending.length, 0, '首次失败后重绘不得重复发起模型余额请求')
})

test('200 但 ok=false / 缺 models 也按整次失败处理（不冒充成功）', async () => {
  const { sandbox, fq } = makeSandbox()
  sandbox.loadApiModels(null, true)
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: false, error: 'boom' })))
  assert.equal(sandbox.apiModelsStale, true)
  assert.equal(sandbox.apiModelsError, '加载失败（点重试）')
  assert.equal(sandbox.apiModels[0].balance, 10, '旧快照留在内存但已标记失效（显示层给 —）')
})

test('并发去重：在途请求期间重复触发只发一次请求，回调排队', async () => {
  const { sandbox, fq } = makeSandbox()
  let hits = 0
  sandbox.loadApiModels(() => { hits++ }, true)
  sandbox.loadApiModels(() => { hits++ }, true)
  sandbox.loadApiModels(() => { hits++ }, false)
  assert.equal(fq.pending.length, 1, '在途期间不得产生重复请求')
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW], templates: [] })))
  assert.equal(hits, 3, '三次触发的回调都要被唤醒')
  assert.equal(fq.pending.length, 0)
})

test('请求代次：慢的旧 GET 回包不能覆盖更新后的结果', async () => {
  const { sandbox, fq } = makeSandbox()
  sandbox.loadApiModels(null, true) // 旧请求
  // 模拟：期间有一次更新的列表写入（POST 保存模型返回新列表）
  sandbox.postApiModels({ action: 'save' }, () => {})
  assert.equal(fq.pending.length, 2)
  const oldGet = fq.pending[0]
  const post = fq.pending[1]
  post.resolve(okResponse({ ok: true, models: [A6_NEW] }))
  await flush()
  assert.equal(sandbox.apiModels[0].balance, 20)
  // 旧 GET 现在才落地（带旧值）：必须被丢弃
  oldGet.resolve(okResponse({ ok: true, models: [A6_OLD] }))
  await flush()
  assert.equal(sandbox.apiModels[0].balance, 20, '旧 GET 回包不得回滚新结果')
})

test('probe / set-key 这类不返回列表的 POST 不能作废在途 GET（避免刷新白跑）', async () => {
  const { sandbox, fq } = makeSandbox()
  sandbox.loadApiModels(null, true)
  sandbox.postApiModels({ action: 'probe', id: 'vendor-a' }, () => {})
  const get = fq.pending[0]
  const probe = fq.pending[1]
  probe.resolve(okResponse({ ok: true, detail: 'HTTP 200' })) // probe 的响应没有 models
  await flush()
  assert.equal(sandbox.apiModels[0].balance, 10, 'probe 不该改列表')
  get.resolve(okResponse({ ok: true, models: [A6_NEW], templates: [] }))
  await flush()
  assert.equal(sandbox.apiModels[0].balance, 20, '在途 GET 必须仍能落地（不被 probe 作废）')
})

test('请求代次：旧 GET 的失败也不能把新列表标记成失效', async () => {
  const { sandbox, fq } = makeSandbox()
  sandbox.loadApiModels(null, true)
  sandbox.postApiModels({ action: 'save' }, () => {})
  const oldGet = fq.pending[0]
  const post = fq.pending[1]
  post.resolve(okResponse({ ok: true, models: [A6_NEW] }))
  await flush()
  oldGet.reject(new Error('HTTP 502'))
  await flush()
  assert.equal(sandbox.apiModelsStale, false, '已被取代的旧请求失败不得影响当前结果')
  assert.equal(sandbox.apiModels[0].balance, 20)
})

test('被取代的旧 GET 不得把 loading 卡死（之后的刷新仍能发起）', async () => {
  const { sandbox, fq } = makeSandbox()
  sandbox.loadApiModels(null, true)
  sandbox.postApiModels({ action: 'save' }, () => {})
  const oldGet = fq.pending[0]
  const post = fq.pending[1]
  post.resolve(okResponse({ ok: true, models: [A6_NEW] }))
  await flush()
  oldGet.resolve(okResponse({ ok: true, models: [A6_OLD] })) // 旧回包迟到
  await flush()
  assert.equal(sandbox.apiModelsLoading, false, '取代后必须放行 loading，否则再也不会刷新')
  assert.equal(sandbox.apiModels[0].balance, 20, '迟到的旧回包仍不得回滚')
  const before = fq.pending.length
  sandbox.loadApiModels(null, true)
  assert.equal(fq.pending.length, before + 1, '后续刷新必须能真正发出请求')
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW], templates: [] })))
  assert.equal(sandbox.apiModels[0].balance, 20)
})

for (const outcome of ['resolve', 'reject']) {
  test(`迟到旧 GET ${outcome} 不释放新 GET 的 loading 或等待者`, async () => {
    const { sandbox, fq } = makeSandbox()
    sandbox.loadApiModels(null, true)
    const oldGet = fq.pending.shift()
    sandbox.postApiModels({ action: 'save' }, () => {})
    fq.pending.shift().resolve(okResponse({ ok: true, models: [A6_NEW] }))
    await flush()
    let callbacks = 0
    sandbox.loadApiModels(() => { callbacks++ }, true)
    const newGet = fq.pending.shift()
    if (outcome === 'resolve') oldGet.resolve(okResponse({ ok: true, models: [A6_OLD] }))
    else oldGet.reject(new Error('late failure'))
    await flush()
    assert.equal(sandbox.apiModelsLoading, true)
    assert.equal(callbacks, 0)
    sandbox.loadApiModels(null, true)
    assert.equal(fq.pending.length, 0, '旧请求不得解除单飞锁并引发重复请求')
    newGet.resolve(okResponse({ ok: true, models: [A6_NEW] }))
    await flush()
    assert.equal(callbacks, 1)
    assert.equal(sandbox.apiModelsLoading, false)
  })
}

test('POST 保存成功后，旧 GET 的退避定时器不得复活重试', async () => {
  const { sandbox, fq, timers } = makeSandbox()
  sandbox.loadApiModels(null, true)
  fq.pending.shift().reject(new Error('offline'))
  await flush()
  assert.equal(timers.length, 1)
  sandbox.postApiModels({ action: 'save' }, () => {})
  fq.pending.shift().resolve(okResponse({ ok: true, models: [A6_NEW] }))
  await flush()
  timers.shift()()
  assert.equal(fq.pending.length, 0, '被取代的重试不能递增代次、覆盖新列表')
  assert.equal(sandbox.apiModelsLoading, false)
  assert.equal(sandbox.apiModels[0].balance, 20)
})

test('POST 成功回包同样清掉失效标记（设置面板保存后恢复真值）', async () => {
  const { sandbox, fq, repaints } = makeSandbox({ models: [A6_OLD] })
  sandbox.apiModelsStale = true
  sandbox.postApiModels({ action: 'save' }, () => {})
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW] })))
  assert.equal(sandbox.apiModelsStale, false)
  assert.equal(sandbox.apiModelsLoaded, true)
  assert.equal(sandbox.apiModelsError, '')
  assert.equal(sandbox.apiModels[0].balance, 20)
  assert.ok(repaints.length >= 1, 'POST 新列表立即刷新挂件')
})

test('首次 GET 失败后 POST 带回列表会恢复 loaded 状态并唤醒等待者', async () => {
  const { sandbox, fq, repaints } = makeSandbox({ models: [], loaded: false })
  let result = null
  sandbox.apiModelsWaiters.push((value) => { result = value })
  sandbox.apiModelsStale = true
  sandbox.postApiModels({ action: 'save' }, () => {})
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW] })))
  assert.equal(sandbox.apiModelsLoaded, true)
  assert.equal(sandbox.apiModelsStale, false)
  assert.equal(sandbox.apiModels[0].balance, 20)
  assert.ok(result && result.ok, '等待者收到成功列表')
  assert.ok(repaints.length >= 1, '打开的挂件立即显示回来的新值')
})

test('首次整体失败也立即重绘挂件为不可用占位', () => {
  const { sandbox, repaints } = makeSandbox({ models: [], loaded: false })
  sandbox.apiModelsFailWaiters()
  assert.equal(sandbox.apiModelsStale, true)
  assert.ok(repaints.length >= 1, '冷启动失败后也必须立刻重绘，不能等下一次轮询')
})

test('单项余额为 null/错误时列表仍然有效（只有整次失败才失效）', async () => {
  const { sandbox, fq } = makeSandbox()
  sandbox.loadApiModels(null, true)
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NULL], templates: [] })))
  assert.equal(sandbox.apiModelsLoaded, true)
  assert.equal(sandbox.apiModelsStale, false, '单项空值不算整次失败')
  assert.equal(sandbox.apiModels[0].balance, null)
})

// ===== 短轮询（活跃门控 / 可见性 / 恢复可见时间门控）纯函数测试 =====
// 直接测 shouldPollApiModels（源码里的真实函数），参数逐个显式传入，不做 setInterval 黑盒。
const T0 = 1_000_000

test('短轮询常量就是 15 秒周期，且去重窗口小于周期', () => {
  assert.equal(POLL_MS, 15000, '短轮询周期应为 15000ms')
  assert.ok(POLL_MIN_GAP_MS > 0 && POLL_MIN_GAP_MS <= POLL_MS, '去重窗口必须 ≤ 周期')
  assert.equal(POLL_FAIL_MS, 10000, '失败限频沿用 10 秒')
})

test('shouldPollApiModels：活跃 + 可见 + 过了去重窗口才允许', () => {
  const { sandbox } = makeSandbox()
  const f = sandbox.shouldPollApiModels
  // 从未刷过（lastAt=0）：活跃且可见 ⇒ 允许
  assert.equal(f(T0, false, true, 0, POLL_MIN_GAP_MS, false, 0, POLL_FAIL_MS), true)
  // 刚刷过（窗口内）⇒ 跳过
  assert.equal(f(T0 + 1000, false, true, T0, POLL_MIN_GAP_MS, false, 0, POLL_FAIL_MS), false)
  // 窗口过后（15 秒 = 一个周期）⇒ 允许
  assert.equal(f(T0 + POLL_MS, false, true, T0, POLL_MIN_GAP_MS, false, 0, POLL_FAIL_MS), true)
})

test('shouldPollApiModels：无活跃条件或页面隐藏一律跳过', () => {
  const { sandbox } = makeSandbox()
  const f = sandbox.shouldPollApiModels
  assert.equal(f(T0, false, false, 0, POLL_MIN_GAP_MS, false, 0, POLL_FAIL_MS), false, '无活跃面不请求')
  assert.equal(f(T0, true, true, 0, POLL_MIN_GAP_MS, false, 0, POLL_FAIL_MS), false, 'hidden 不请求')
})

test('shouldPollApiModels：失效态仍守 10 秒失败限频，不因 force 绕过', () => {
  const { sandbox } = makeSandbox()
  const f = sandbox.shouldPollApiModels
  assert.equal(f(T0 + 5000, false, true, 0, POLL_MIN_GAP_MS, true, T0, POLL_FAIL_MS), false, '失败后 5 秒内不重试')
  assert.equal(f(T0 + 11000, false, true, 0, POLL_MIN_GAP_MS, true, T0, POLL_FAIL_MS), true, '超过 10 秒才允许重取')
  // 非失效态不受 retryAt 限制
  assert.equal(f(T0 + 1000, false, true, 0, POLL_MIN_GAP_MS, false, T0, POLL_FAIL_MS), true)
})

test('活跃门控：选中 A6 / 面板打开 / 气泡显示任一满足即活跃', () => {
  const sel = makeSandbox({ petBalanceId: 'vendor-a' })
  assert.equal(sel.sandbox.apiModelsPollActive(), true, '选中厂商 ⇒ 活跃')
  const panel = makeSandbox()
  panel.sandbox.usagePanelOpen = true
  assert.equal(panel.sandbox.apiModelsPollActive(), true, '用量面板打开 ⇒ 活跃')
  const bubble = makeSandbox({ bubbleShown: true })
  assert.equal(bubble.sandbox.apiModelsPollActive(), true, '气泡显示中 ⇒ 活跃')
  const idle = makeSandbox()
  assert.equal(idle.sandbox.apiModelsPollActive(), false, '都没有 ⇒ 不活跃（不请求）')
})

test('可见性：document.hidden 或透明浮层隐藏都算不可见', () => {
  const page = makeSandbox({ hidden: true })
  assert.equal(page.sandbox.apiModelsViewHidden(), true)
  const visible = makeSandbox()
  assert.equal(visible.sandbox.apiModelsViewHidden(), false)
  // 浮层：document.hidden 恒为 false，靠桥接的 visible 判定（隐藏时不新增排队请求）
  const overlayHidden = makeSandbox({ overlay: true, overlayVisible: false })
  assert.equal(overlayHidden.sandbox.apiModelsViewHidden(), true, '浮层隐藏 ⇒ 视为不可见')
  const overlayShown = makeSandbox({ overlay: true, overlayVisible: true })
  assert.equal(overlayShown.sandbox.apiModelsViewHidden(), false)
})

test('短轮询 tick：活跃可见才真的请求，且走 loadApiModels 单飞', async () => {
  const { sandbox, fq } = makeSandbox({ petBalanceId: 'vendor-a' })
  sandbox.apiModelsPollTick() // 首次：无 lastAt ⇒ 允许
  assert.equal(fq.pending.length, 1, '活跃可见时短轮询必须真的发请求')
  // 立即再来一次：被时间门控挡住，且即使放行也由 apiModelsLoading 去重
  sandbox.apiModelsPollTick()
  assert.equal(fq.pending.length, 1, '时间门控 + 单飞 ⇒ 不重复请求')
  sandbox.apiModelsPollLastAt = 0 // 强行放开时间门控，验证单飞兜底
  sandbox.apiModelsPollTick()
  assert.equal(fq.pending.length, 1, '在途期间 loadApiModels 单飞，不产生第二个请求')
  await settleAll(fq, (p) => p.resolve(okResponse({ ok: true, models: [A6_NEW], templates: [] })))
  assert.equal(sandbox.apiModels[0].balance, 20)
})

test('短轮询 tick：无活跃条件 / 页面隐藏时不发请求', () => {
  const idle = makeSandbox()
  idle.sandbox.apiModelsPollTick()
  assert.equal(idle.fq.pending.length, 0, '没有任何活跃面 ⇒ 一次也不请求')

  const hidden = makeSandbox({ petBalanceId: 'vendor-a', hidden: true })
  hidden.sandbox.apiModelsPollTick()
  assert.equal(hidden.fq.pending.length, 0, '页面隐藏 ⇒ 不请求')

  const overlayHidden = makeSandbox({ petBalanceId: 'vendor-a', overlay: true, overlayVisible: false })
  overlayHidden.sandbox.apiModelsPollTick()
  assert.equal(overlayHidden.fq.pending.length, 0, '透明浮层隐藏 ⇒ 不新增排队请求')
})

test('恢复可见补一次，但按时间门控不重复（与短轮询去重）', () => {
  const { sandbox, fq } = makeSandbox({ petBalanceId: 'vendor-a' })
  // 刚刷过（模拟切走前那次短轮询）：恢复可见不得立刻再发
  sandbox.apiModelsPollLastAt = Date.now()
  assert.equal(sandbox.apiModelsPollOnce(Date.now()), false, '去重窗口内恢复可见不重复请求')
  assert.equal(fq.pending.length, 0)
  // 窗口过后：恢复可见补一次
  sandbox.apiModelsPollLastAt = Date.now() - (POLL_MIN_GAP_MS + 1000)
  assert.equal(sandbox.apiModelsPollOnce(Date.now()), true, '过了门控窗口恢复可见要补一次')
  assert.equal(fq.pending.length, 1)
})

test('短轮询不绕过失败限频：失效态 + 刚失败 ⇒ 不请求，过了 10 秒才请求', async () => {
  const { sandbox, fq, timers } = makeSandbox({ petBalanceId: 'vendor-a' })
  // 模拟一次整体失败后的状态（与上面的失败用例同法：失败 + 触发退避重试，直到 tries 耗尽）
  sandbox.loadApiModels(null, true)
  for (let i = 0; i < 4 && fq.pending.length; i++) {
    const p = fq.pending.shift()
    p.reject(new Error('HTTP 502'))
    await flush()
    const t = timers.shift()
    if (t) t()
    await Promise.resolve()
  }
  assert.equal(sandbox.apiModelsStale, true)
  assert.equal(sandbox.apiModelsLoading, false)
  const before = fq.pending.length
  sandbox.apiModelsPollLastAt = 0 // 排除自身时间门控，只留失败限频
  sandbox.apiModelsPollTick()
  assert.equal(fq.pending.length, before, '失败后 10 秒内短轮询不得再发请求')
  sandbox.apiModelsRetryAt = Date.now() - 11000 // 限频窗口过后
  sandbox.apiModelsPollTick()
  assert.equal(fq.pending.length, before + 1, '限频窗口过后短轮询恢复请求')
})
