// 「点击桌宠显示的余额厂商」前端取数/刷新逻辑的隔离测试。
//
// 做法：从 assets/whale-widget.js 里**截取真实函数源码**，在 vm 沙箱里配最小桩（不是正则检查）。
// 覆盖：
//   ① 默认（空 / 内置 DeepSeek / 已删除 / 未知 id）→ 完全回落到 DS 原取数；
//   ② 两个厂商切换（USD 12.50 / CNY 0 显示 0，不伪装）；
//   ③ 无余额接口 / 读取失败（balance=null）→ —，不伪造 0；
//   ④ 仅无 modelId 的通用余额模块受影响；显式 modelId、赠金/充值模块不受影响；
//   ⑤ 点击刷新守卫：不重开已关闭气泡、旧回包不覆盖新选择、未配置不请求模型列表。
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

const FN_NAMES = [
  'fmt', 'apiTodayCur', 'apiFmtMoney', 'apiModelBalanceInfo', 'apiModelBalanceText', 'apiModelTodayText',
  'bubbleAmountText', 'bubbleIsModelMod', 'bubbleContentTokenMap', 'bubbleRowContentOf',
  'petBalanceSelectedId', 'petBalanceActiveModel', 'bubblePetBalanceText',
  'petBalanceVendorPending', 'petBalanceConfigUnconfirmed',
  'bubblePetBalanceTodayText', 'bubblePetBalanceTodayHint', 'petBalanceRefreshForClick',
  'petBalanceClickRefreshAllowed', 'petBalanceLegacyAmount', 'animateAmount', 'render',
  'petBalanceModelOptions', 'petBalanceResolveId', 'petBalancePatch',
  'petBalanceDisplaySettings', 'petBalanceDisplayPatch', 'petBalanceDisplayModules', 'petBalanceRefreshDisplay',
  'runApiModelAlerts',
]
const FUNCTIONS = FN_NAMES.map((n) => extractFunction(SOURCE, n)).join('\n')

function makeSandbox(overrides) {
  const renderCalls = []
  const loadCalls = []
  const sandbox = {
    usageSet: null,
    // usage-settings 是否已成功读到（源码 var usageSetConfirmed）。默认 true = 已确认，
    // 各用例按需改成 false 模拟「设置请求在途 / 失败、配置尚无法确认」。
    usageSetConfirmed: true,
    apiModels: [],
    apiModelsLoaded: true,
    // 模型列表刷新链路的状态（源码里是 var，跨 vm 需要显式初始化，否则 ++/赋值是 ReferenceError）
    apiModelsStale: false,
    apiModelsSeq: 0,
    apiModelsError: '',
    apiModelsLoading: false,
    apiModelsWaiters: [],
    apiTemplates: [],
    usagePanelOpen: false,
    renderBubblePal() {},
    rebuildUsageSubShell() {},
    runApiModelAlerts() {},
    shown: null,
    state: { balance: 123.45, currency: 'CNY' },
    bubbleScene: { kind: 'custom' },
    bubbleShown: true,
    bubbleLiveMods: [{ type: 'balance', tpl: '{balance_ds}' }],
    petClickRefreshSeq: 0,
    petClickRefreshAt: 0,
    costBubbleActive: false,
    bubbleRandomActive: false,
    bubbleRandomLines: null,
    amountEl: { textContent: '' },
    labelEl: { textContent: '' },
    animId: null,
    requestAnimationFrame() { return 1 },
    cancelAnimationFrame() {},
    setHint() {},
    apiModelById(id) {
      for (const m of sandbox.apiModels) if (m && m.id === id) return m
      return null
    },
    bubbleBonusText() { return 'BONUS' },
    bubbleRechargeText() { return 'RECHARGE' },
    // 模型模块的其它占位符（额度/订阅）不在本测试范围：给显式桩即可，避免整文件加载
    apiModelTodayText() { return 'TODAY' },
    apiQuotaPctText() { return 'Q%' },
    apiQuotaUsedText() { return 'QU' },
    apiQuotaLeftText() { return 'QL' },
    apiQuotaTotalText() { return 'QT' },
    apiQuotaResetText() { return 'QR' },
    bubblePlanWinOf() { return 'all' },
    apiPlanUsedText() { return 'P' },
    apiPlanLeftText() { return 'PL' },
    apiPlanResetText() { return 'PR' },
    bubbleContentText(m, autoTxt) {
      if (!m || !m.tpl) return autoTxt
      let s = String(m.tpl)
      const map = sandbox.bubbleContentTokenMap(m)
      for (const k of Object.keys(map)) s = s.split('{' + k + '}').join(String(map[k]))
      return s
    },
    bubbleRenderModules(mods) { renderCalls.push(mods) },
    loadApiModels(cb) { loadCalls.push(cb); return null },
    Math, Number, String, JSON, isFinite, Error, Date,
  }
  Object.assign(sandbox, overrides || {})
  vm.createContext(sandbox)
  // 设置行标签常量（源码里是 var，不在函数体内）：原样取出来注入，保证测的是真实文案
  const labelMatch = SOURCE.match(/var PET_BALANCE_LABEL = ('[^']*')/)
  assert.ok(labelMatch, '源码必须定义 PET_BALANCE_LABEL')
  vm.runInContext(
    'var B = { balance: 123.45, currency: "CNY" };\n' +
    'var PET_BALANCE_LABEL = ' + labelMatch[1] + ';\n' +
    // bubbleAmountText 依赖 fmt(state.currency)：把 state/fmt 暴露在同一上下文（沙箱里已有）
    FUNCTIONS,
    sandbox,
    { filename: 'whale-widget-functions.js' }
  )
  return { sandbox, renderCalls, loadCalls }
}

const MODEL_A = {
  id: 'vendor-a', name: 'Vendor A', currency: 'USD', balanceMode: 'api', hasBalanceApi: true, balance: 12.5, todayUsage: 1,
}
const MODEL_ZERO = {
  id: 'vendor-zero', name: 'Vendor Zero', currency: 'CNY', balanceMode: 'api', hasBalanceApi: true, balance: 0, todayUsage: 0,
}
const MODEL_NO_API = {
  id: 'vendor-noapi', name: 'Vendor NoAPI', currency: 'CNY', balanceMode: 'events', hasBalanceApi: false, balance: null, todayUsage: 2,
}
const MODEL_ERROR = {
  id: 'vendor-error', name: 'Vendor Error', currency: 'USD', balanceMode: 'api', hasBalanceApi: true, balance: null, error: 'HTTP 502',
}
// A6 实况：余额是美元口径，但「今日已用」来自本机会话事件（已按单价折算成人民币）
const MODEL_A6 = {
  id: 'vendor-a6', name: 'A6API', currency: 'USD', balanceMode: 'api', hasBalanceApi: true,
  balance: 7.3, todayUsage: 2, todayUsageCurrency: 'CNY',
}

test('未配置 / 内置 / 已删除 / 未知 id 都完全回落到 DeepSeek 原取数', () => {
  for (const sel of ['', '   ', 'deepseek', 'gone', 'some-template-only-id']) {
    const { sandbox } = makeSandbox({ usageSet: { petBalance: { modelId: sel } }, apiModels: [MODEL_A] })
    assert.equal(sandbox.bubblePetBalanceText(), '¥ 123.45', 'id=' + JSON.stringify(sel) + ' 必须回落到 DS')
    assert.equal(sandbox.petBalanceActiveModel(), null)
  }
  // usageSet 缺失（面板尚未加载）时同样回落
  const { sandbox } = makeSandbox({ usageSet: null, apiModels: [MODEL_A] })
  assert.equal(sandbox.bubblePetBalanceText(), '¥ 123.45')
})

test('两个已接入厂商切换：USD 12.50 / CNY 0（0 不被伪装）', () => {
  const { sandbox } = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A, MODEL_ZERO] })
  assert.equal(sandbox.bubblePetBalanceText(), '$ 12.50')

  sandbox.usageSet = { petBalance: { modelId: 'vendor-zero' } }
  assert.equal(sandbox.bubblePetBalanceText(), '¥ 0.00', '余额 0 必须显示 0，而不是 —')

  sandbox.usageSet = { petBalance: { modelId: 'vendor-a' } }
  assert.equal(sandbox.bubblePetBalanceText(), '$ 12.50', '切回来必须回到该厂商')
})

test('无余额接口 / 读取失败 / 字段缺失显示 —，绝不显示 0', () => {
  for (const m of [MODEL_NO_API, MODEL_ERROR, { id: 'vendor-null', name: 'Null', currency: 'USD', balance: null }]) {
    const { sandbox } = makeSandbox({ usageSet: { petBalance: { modelId: m.id } }, apiModels: [m] })
    assert.equal(sandbox.bubblePetBalanceText(), '—', m.id + ' 取不到数必须显示 —')
  }
})

test('只有无 modelId 的通用余额模块跟随选择；显式 modelId / 赠金 / 充值不变', () => {
  const { sandbox } = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A, MODEL_ZERO] })

  const generic = sandbox.bubbleContentTokenMap({ type: 'balance', tpl: '{balance_ds}' })
  assert.equal(generic.balance_ds, '$ 12.50')

  const explicit = sandbox.bubbleContentTokenMap({ type: 'balance', tpl: '{balance}', modelId: 'vendor-zero' })
  assert.equal(explicit.balance, '¥ 0.00', '显式 modelId 仍取它自己的余额')
  const explicitDs = sandbox.bubbleContentTokenMap({ type: 'balance', tpl: '{balance_ds}', modelId: 'vendor-zero' })
  assert.equal(explicitDs.balance_ds, '¥ 0.00')

  const bonus = sandbox.bubbleContentTokenMap({ type: 'bonus', tpl: '{bonus_ds}' })
  assert.equal(bonus.bonus_ds, 'BONUS', '赠金模块不受选择影响')
  const recharge = sandbox.bubbleContentTokenMap({ type: 'recharge', tpl: '{recharge_ds}' })
  assert.equal(recharge.recharge_ds, 'RECHARGE', '充值余额模块不受选择影响')

  // 显式 modelId='deepseek' 仍是 DS 主余额（不被选择改写）
  const explicitDs2 = sandbox.bubbleContentTokenMap({ type: 'balance', tpl: '{balance_ds}', modelId: 'deepseek' })
  assert.equal(explicitDs2.balance_ds, '¥ 123.45', '显式 DS 模块语义不变')

  // 无 tpl 时的自动内容（气泡默认渲染走这条）
  assert.equal(sandbox.bubbleRowContentOf({ type: 'balance' }).txt, '$ 12.50')
  assert.equal(sandbox.bubbleRowContentOf({ type: 'balance', modelId: 'vendor-zero' }).txt, '¥ 0.00')
  assert.equal(sandbox.bubbleRowContentOf({ type: 'balance', modelId: 'deepseek' }).txt, '¥ 123.45')
})

test('点击刷新：未配置不请求；回包只更新仍打开的自定义气泡（不重开/不重置序列）', () => {
  const off = makeSandbox({ usageSet: {}, apiModels: [MODEL_A] })
  off.sandbox.petBalanceRefreshForClick()
  assert.equal(off.loadCalls.length, 0, '未配置厂商时点击不应额外拉模型列表')

  const on = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A] })
  on.sandbox.petBalanceRefreshForClick()
  assert.equal(on.loadCalls.length, 1, '配置后点击应强制刷新模型列表')
  assert.equal(on.renderCalls.length, 0, '回包前不动界面')
  const mods = on.sandbox.bubbleLiveMods
  on.loadCalls[0]()
  assert.equal(on.renderCalls.length, 1, '回包后原地重绘内容')
  assert.equal(on.renderCalls[0], mods, '重绘同一份模块列表（不重建场景）')
})

test('点击刷新守卫：气泡已关闭不重开；旧回包/旧选择不覆盖新选择', () => {
  const closed = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A], bubbleShown: false })
  closed.sandbox.petBalanceRefreshForClick()
  closed.loadCalls[0]()
  assert.equal(closed.renderCalls.length, 0, '已关闭的气泡不能被回包重新渲染/重开')

  const stale = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A] })
  stale.sandbox.petBalanceRefreshForClick()
  stale.sandbox.usageSet = { petBalance: { modelId: 'vendor-zero' } }
  stale.loadCalls[0]() // 第 1 次请求的回包晚于选择变更
  assert.equal(stale.renderCalls.length, 0, '旧选择的回包不得更新界面')

  const superseded = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A] })
  superseded.sandbox.petBalanceRefreshForClick()
  superseded.sandbox.petBalanceRefreshForClick() // 第二次点击
  superseded.loadCalls[0]() // 旧回包
  superseded.loadCalls[1]() // 新回包
  assert.equal(superseded.renderCalls.length, 1, '只有最后一次请求的回包生效')
})

test('点击刷新不碰随机语句/系统气泡场景', () => {
  for (const kind of ['random', 'cost', 'alert', 'wait']) {
    const s = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A], bubbleScene: { kind } })
    s.sandbox.petBalanceRefreshForClick()
    if (kind === 'random') {
      s.loadCalls[0]()
      assert.equal(s.renderCalls.length, 0, '随机语句场景不重绘余额内容')
    } else {
      assert.equal(s.loadCalls.length, 0, kind + ' 系统气泡期间不额外请求模型列表')
    }
  }
  // 自定义气泡里含 random 模块：不整泡重绘（避免重新抽台词），但下一轮显示会用新余额
  const withRandom = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a' } },
    apiModels: [MODEL_A],
    bubbleLiveMods: [{ type: 'balance', tpl: '{balance_ds}' }, { type: 'random', lines: [{ t: 'x', w: 1 }] }],
  })
  withRandom.sandbox.petBalanceRefreshForClick()
  withRandom.loadCalls[0]()
  assert.equal(withRandom.renderCalls.length, 0, '含随机语句的自定义气泡不整泡重绘')
  assert.equal(withRandom.sandbox.petBalanceClickRefreshAllowed(withRandom.sandbox.bubbleLiveMods), false)
  assert.equal(withRandom.sandbox.petBalanceClickRefreshAllowed([{ type: 'balance' }]), true)
  assert.equal(withRandom.sandbox.petBalanceClickRefreshAllowed([]), false)
})

test('旧版余额内容同样跟随选择，DS 主状态与系统场景不变', () => {
  const { sandbox } = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A],
    bubbleScene: { kind: 'normal' },
  })
  sandbox.render()
  assert.equal(sandbox.amountEl.textContent, '$ 12.50')
  assert.equal(sandbox.labelEl.textContent, 'Vendor A 余额')
  assert.equal(sandbox.bubbleAmountText(), '¥ 123.45')
  assert.equal(sandbox.state.balance, 123.45)
  sandbox.animateAmount(123.45, 123.45, 'CNY', 0)
  assert.equal(sandbox.amountEl.textContent, '$ 12.50', 'DS 动画不能覆盖选中的余额')
  assert.equal(sandbox.shown, 123.45, 'DS 动画状态仍应照常更新')
  for (const kind of ['custom', 'random', 'alert', 'wait', 'cost']) {
    sandbox.bubbleScene = { kind }
    sandbox.costBubbleActive = kind === 'cost'
    sandbox.labelEl.textContent = 'keep this title'
    sandbox.render()
    assert.equal(sandbox.labelEl.textContent, 'keep this title', kind + ' 标题不能被余额选择覆盖')
    assert.equal(sandbox.petBalanceLegacyAmount('original'), 'original')
  }
  sandbox.costBubbleActive = false
  sandbox.bubbleScene = { kind: 'normal' }
  sandbox.apiModels = []
  sandbox.render()
  assert.equal(sandbox.amountEl.textContent, '¥ 123.45')
  assert.equal(sandbox.labelEl.textContent, 'DeepSeek 余额')
})

test('旧版余额内容异步刷新只更新仍打开的普通场景', () => {
  const s = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A],
    bubbleScene: { kind: 'normal' },
  })
  s.sandbox.petBalanceRefreshForClick()
  s.loadCalls[0]()
  assert.equal(s.sandbox.amountEl.textContent, '$ 12.50')
  assert.equal(s.renderCalls.length, 0)
  s.sandbox.bubbleShown = false
  s.sandbox.amountEl.textContent = 'closed'
  s.sandbox.petBalanceRefreshForClick()
  s.loadCalls[1]()
  assert.equal(s.sandbox.amountEl.textContent, 'closed')
})

test('连续点击限频：10 秒内复用已有请求，不会形成请求风暴', () => {
  const s = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [MODEL_A] })
  const forces = []
  s.sandbox.loadApiModels = (cb, force) => { forces.push(force); s.loadCalls.push(cb) }
  s.sandbox.petBalanceRefreshForClick()
  s.sandbox.petBalanceRefreshForClick()
  s.sandbox.petBalanceRefreshForClick()
  assert.deepEqual(forces, [true, false, false], '首次强制刷新，10 秒窗口内复用缓存')
})

test('标题和谷价仅改变余额卡显示，不改金额模块、原配置或系统内容', () => {
  const mods = [
    { type: 'text', text: 'DeepSeek 余额', color: '#abc' },
    { type: 'balance', tpl: '{balance_ds}' },
    { type: 'today', tpl: '今日已用 {expense_ds}' },
    { type: 'peak', row: 4 }, { type: 'nextpeak', row: 4 },
  ]
  const snapshot = JSON.stringify(mods)
  const { sandbox } = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a', title: '我的余额', showValley: false } }, apiModels: [MODEL_A] })
  const result = sandbox.petBalanceDisplayModules(mods, 'custom')
  assert.equal(result[0].text, '我的余额')
  assert.equal(result[0].color, '#abc')
  assert.equal(result.length, 3)
  assert.equal(result[1], mods[1])
  assert.equal(result[2], mods[2])
  assert.equal(sandbox.bubbleRowContentOf(result[1]).txt, '$ 12.50')
  assert.equal(JSON.stringify(mods), snapshot)
  for (const kind of ['wait', 'alert', 'cost', 'random']) assert.equal(sandbox.petBalanceDisplayModules(mods, kind), mods)
  assert.equal(sandbox.petBalanceDisplayModules([{ type: 'text', text: '其他内容' }], 'custom')[0].text, '其他内容')
  sandbox.usageSet.petBalance.showValley = true
  assert.equal(sandbox.petBalanceDisplayModules(mods, 'custom').length, mods.length)
  sandbox.usageSet.petBalance.title = ''
  assert.equal(sandbox.petBalanceDisplayModules(mods, 'custom'), mods)
})

test('标题按纯文本处理、无原标题时补标题，旧布局同样显示新名称', () => {
  const { sandbox } = makeSandbox({ usageSet: { petBalance: { title: '<b>自定义</b>', showValley: false } }, bubbleScene: { kind: 'normal' } })
  sandbox.render()
  assert.equal(sandbox.labelEl.textContent, '<b>自定义</b>')
  const mods = [{ type: 'balance' }, { type: 'peak' }]
  const result = sandbox.petBalanceDisplayModules(mods, 'custom')
  assert.equal(result[0].type, 'text')
  assert.equal(result[0].text, '<b>自定义</b>')
  assert.equal(result[1], mods[0])
  assert.equal(result.length, 2)
  assert.equal(mods.length, 2)
})

test('显示设置默认兼容，差异补丁不携带金额厂商键', () => {
  const { sandbox } = makeSandbox({})
  assert.equal(sandbox.petBalanceDisplaySettings().title, '')
  assert.equal(sandbox.petBalanceDisplaySettings().showValley, true)
  assert.equal(sandbox.petBalanceDisplayPatch({ title: '', showValley: true }, { title: '', showValley: true }), null)
  const patch = sandbox.petBalanceDisplayPatch({ title: '', showValley: true }, { title: '  钱包  ', showValley: false })
  assert.equal(patch.title, '钱包')
  assert.equal(patch.showValley, false)
  assert.equal('modelId' in patch, false)
  sandbox.usageSet = { petBalance: { title: 'x'.repeat(100) } }
  assert.equal(sandbox.petBalanceDisplaySettings().title.length, 80)
})

test('设置行标签就是用户指定的精确文案', () => {
  const { sandbox } = makeSandbox({})
  // PET_BALANCE_LABEL 是设置行的唯一文案来源（面板里那一行直接用它）
  assert.equal(sandbox.PET_BALANCE_LABEL, '点击桌宠显示的余额厂商')
  // 变量确实被用于设置面板的行标签（不是死常量）
  assert.ok(SOURCE.includes('row(PET_BALANCE_LABEL, card)'), '设置面板必须用该常量做行标签')
  assert.ok(SOURCE.includes('PET_BALANCE_LABEL = '), '常量必须在源码里定义')
})

test('设置选项只含已接入 models（排除内置/模板），并带无接口/无上限标注', () => {
  const { sandbox } = makeSandbox({})
  const opts = sandbox.petBalanceModelOptions([
    { id: 'deepseek', name: 'DeepSeek', builtin: true },
    MODEL_A,
    MODEL_NO_API,
    { id: 'vendor-unl', name: 'Unlimited', balanceMode: 'api', hasBalanceApi: true, unlimited: true },
    { id: '', name: 'blank-id', builtin: false },
    null,
  ])
  assert.deepEqual([...opts.map((o) => o.value)], ['', 'vendor-a', 'vendor-noapi', 'vendor-unl'])
  assert.equal(opts[0].label, '默认（DeepSeek）')
  assert.equal(opts[1].label, 'Vendor A')
  assert.match(opts[2].label, /（无余额接口）$/)
  assert.match(opts[3].label, /（额度无上限）$/)
})

test('保存的有效性判定：列表未加载时保留已保存值；加载后失效 id 回空；未改动不发键', () => {
  const { sandbox } = makeSandbox({})
  const models = [MODEL_A, MODEL_ZERO]
  // 列表未加载（apiModels 为空）：不能把已保存选择误清成默认
  assert.equal(sandbox.petBalanceResolveId('vendor-a', [], false), 'vendor-a')
  // 已加载：存在就保留，不存在（已删除/只有模板）就回默认
  assert.equal(sandbox.petBalanceResolveId('vendor-a', models, true), 'vendor-a')
  assert.equal(sandbox.petBalanceResolveId('deleted-id', models, true), '')
  assert.equal(sandbox.petBalanceResolveId('deepseek', models, true), '')
  assert.equal(sandbox.petBalanceResolveId('  ', models, true), '')
  // 保存补丁：只有真的改过才带 petBalance（跨 vm realm 用 JSON 比较）
  const norm = (v) => JSON.parse(JSON.stringify(v))
  assert.equal(sandbox.petBalancePatch('', ''), null, '未改过不写键（旧用户文件结构不变）')
  assert.equal(sandbox.petBalancePatch('vendor-a', 'vendor-a'), null)
  assert.deepEqual(norm(sandbox.petBalancePatch('', 'vendor-a')), { petBalance: { modelId: 'vendor-a' } })
  assert.deepEqual(norm(sandbox.petBalancePatch('vendor-a', '')), { petBalance: { modelId: '' } })
})

test('已删除厂商：面板显示默认、不碰则不改写磁盘、运行期也回默认', () => {
  // 磁盘上存着已删除的 id，模型列表已加载（不含它）：
  //   · 面板显示「默认」（petBalanceResolveId → ''）
  //   · 缓冲仍是原值 ⇒ 用户不碰这一行直接保存，不写盘（petBalancePatch → null）
  //   · 运行期取数本来就回落 DS（与"清成空"效果一致）
  const { sandbox } = makeSandbox({})
  const resolved = sandbox.petBalanceResolveId('deleted-id', [MODEL_A], true)
  assert.equal(resolved, '', '失效 id 在面板里显示为默认')
  assert.equal(sandbox.petBalancePatch('deleted-id', 'deleted-id'), null, '未动这一行就不写盘')
  sandbox.usageSet = { petBalance: { modelId: 'deleted-id' } }
  assert.equal(sandbox.bubblePetBalanceText(), '¥ 123.45', '失效 id 运行期回落到 DS')
  // 用户显式选「默认」才会写空值（change 事件把缓冲改为 ''）
  assert.equal(sandbox.petBalancePatch('deleted-id', '').petBalance.modelId, '')
})

test('面板显示值与取消回滚都用 resolve 后的值（失效 id 不会显示成空白）', () => {
  const { sandbox } = makeSandbox({})
  const models = [MODEL_A]
  // 打开面板：petFillOptions 用 resolve 显示；列表已加载且 id 失效 ⇒ ''
  assert.equal(sandbox.petBalanceResolveId('deleted-id', models, true), '')
  // 列表未加载 ⇒ 原样保留（显示「已保存：…（加载中）」，不回退成空白/默认）
  assert.equal(sandbox.petBalanceResolveId('deleted-id', [], false), 'deleted-id')
  // 取消回滚：快照里的有效 id 原样显示
  assert.equal(sandbox.petBalanceResolveId('vendor-a', models, true), 'vendor-a')
})

// —— 回归：api-models 整次刷新失败后，挂件不得继续显示旧 A6 数字，也不得回落成 DeepSeek ——
test('整次刷新失败：挂件显示 — 占位，不显示旧 A6 数字、不回落 DeepSeek', () => {
  const { sandbox } = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a' } },
    apiModels: [MODEL_A],
    bubbleScene: { kind: 'custom' },
  })
  assert.equal(sandbox.bubblePetBalanceText(), '$ 12.50', '失效前显示真实厂商余额')
  sandbox.apiModelsStale = true // 整次 api-models 刷新失败
  assert.equal(sandbox.bubblePetBalanceText(), '—', '失效态必须给占位，不能显示旧 12.50')
  assert.notEqual(sandbox.bubblePetBalanceText(), '¥ 123.45', '失效态不得回落成 DeepSeek 数字')
  // 更旧的 A6 快照残留在 apiModels 里也不能漏出来
  sandbox.apiModels = [Object.assign({}, MODEL_A, { balance: 3.33 })]
  assert.equal(sandbox.bubblePetBalanceText(), '—', '旧快照数值一律不可信')
  // 通用余额模块走同一条路径
  assert.equal(sandbox.bubbleContentTokenMap({ type: 'balance', tpl: '{balance_ds}' }).balance_ds, '—')
  assert.equal(sandbox.bubbleRowContentOf({ type: 'balance' }).txt, '—')
  // 旧版三行余额卡（normal 场景）同样给占位
  sandbox.bubbleScene = { kind: 'normal' }
  assert.equal(sandbox.petBalanceLegacyAmount('original'), '—')
})

test('恢复：下一次成功回包清掉失效标记后立刻显示新值', () => {
  const { sandbox } = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a' } },
    apiModels: [MODEL_A],
  })
  sandbox.apiModelsStale = true
  assert.equal(sandbox.bubblePetBalanceText(), '—')
  // 成功回包：整表替换 + stale=false（apiModelsFetch 的行为，这里直接模拟结果）
  sandbox.apiModels = [Object.assign({}, MODEL_A, { balance: 88.8 })]
  sandbox.apiModelsStale = false
  assert.equal(sandbox.bubblePetBalanceText(), '$ 88.80', '恢复后必须是新值')
})

test('显式厂商余额/今日用量模块在整次刷新失败时也不显示旧值', () => {
  const { sandbox } = makeSandbox({
    apiModels: [MODEL_A],
    bubbleScene: { kind: 'custom' },
  })
  sandbox.apiModelsStale = true
  const balance = sandbox.bubbleContentTokenMap({ type: 'balance', tpl: '{balance}', modelId: 'vendor-a' })
  const today = sandbox.bubbleContentTokenMap({ type: 'today', tpl: '{today}', modelId: 'vendor-a' })
  assert.equal(balance.balance, '—')
  assert.equal(balance.balance_ds, '—')
  assert.equal(balance.today, '—')
  assert.equal(balance.expense_ds, '—')
  assert.equal(today.today, '—')
  assert.equal(sandbox.bubbleRowContentOf({ type: 'balance', modelId: 'vendor-a' }).txt, '—')
  assert.equal(sandbox.bubbleRowContentOf({ type: 'today', modelId: 'vendor-a' }).txt, '今日已用 —')
})

test('失效态下未配置厂商仍走 DeepSeek 原取数（用户本来选的就是默认）', () => {
  const { sandbox } = makeSandbox({ usageSet: {}, apiModels: [MODEL_A] })
  sandbox.apiModelsStale = true
  assert.equal(sandbox.bubblePetBalanceText(), '¥ 123.45', '没选厂商时与旧版逐字一致')
})

test('api-models 失效时不基于旧余额触发厂商预警/预算提醒', () => {
  const { sandbox } = makeSandbox({ usageSet: { models: { 'vendor-a': { alert: { on: true, below: 50 }, budget: { on: true, amount: 10 } } } }, apiModels: [MODEL_A] })
  const popups = []
  sandbox.apiModelsStale = true
  sandbox.showUsagePopup = (...args) => popups.push(args)
  sandbox.apiAlertFired = {}
  sandbox.apiBudgetFired = {}
  sandbox.apiBudgetUnitWarned = {}
  sandbox.runApiModelAlerts()
  assert.equal(popups.length, 0)
  assert.deepEqual(sandbox.apiAlertFired, {})
})

test('A6 单项返回 null/错误：列表仍有效，显示 — 且不变成 0', () => {
  const { sandbox } = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-error' } },
    apiModels: [MODEL_ERROR],
  })
  sandbox.apiModelsStale = false
  assert.equal(sandbox.bubblePetBalanceText(), '—')
  assert.notEqual(sandbox.bubblePetBalanceText(), '$ 0.00')
})

test('首次加载就失败（列表为空）但已选厂商：显示 —，不回退 DeepSeek', () => {
  const { sandbox } = makeSandbox({ usageSet: { petBalance: { modelId: 'vendor-a' } }, apiModels: [] })
  sandbox.apiModelsLoaded = false
  sandbox.apiModelsStale = true
  assert.equal(sandbox.bubblePetBalanceText(), '—', '选了厂商就不能拿 DS 数字冒充')
  assert.equal(sandbox.petBalanceActiveModel(), null)
  // 未选厂商时仍与旧版逐字一致
  sandbox.usageSet = {}
  assert.equal(sandbox.bubblePetBalanceText(), '¥ 123.45')
  // 未失效时，已删除厂商仍按原约定回落到 DS（既有行为不变）
  sandbox.usageSet = { petBalance: { modelId: 'vendor-a' } }
  sandbox.apiModelsStale = false
  assert.equal(sandbox.bubblePetBalanceText(), '¥ 123.45')
})

// —— A6 美元余额 + 人民币「今日已用」：气泡 today 模块与旧三行卡都必须取该模型的值 ——
test('选中 A6（USD 余额 + CNY 事件金额）后今日已用取该模型；未选时仍走旧 state', () => {
  const hints = []
  const sel = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a6' } },
    apiModels: [MODEL_A6],
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
    bubbleScene: { kind: 'custom' },
    setHint(v) { hints.push(v) },
  })
  // 今日已用按宿主下发的 todayUsageCurrency（会话事件＝CNY）显示，不是模型币种 USD
  assert.equal(sel.sandbox.bubblePetBalanceTodayText(), '¥ 2.00')
  assert.equal(sel.sandbox.bubbleContentTokenMap({ type: 'today', tpl: '{expense_ds}' }).expense_ds, '¥ 2.00')
  assert.equal(sel.sandbox.bubbleRowContentOf({ type: 'today' }).txt, '今日已用 ¥ 2.00')
  // 余额仍是美元口径
  assert.equal(sel.sandbox.bubblePetBalanceText(), '$ 7.30')
  assert.equal(sel.sandbox.bubbleRowContentOf({ type: 'balance' }).txt, '$ 7.30')
  // 显式 modelId='deepseek' 的今日模块语义不变（仍取 DS state）
  assert.equal(sel.sandbox.bubbleContentTokenMap({ type: 'today', modelId: 'deepseek', tpl: '{expense_ds}' }).expense_ds, '¥ 9.99')
  // 旧三行卡（normal 场景）的今日已用同样换成该模型，而不是 DS 的 9.99
  sel.sandbox.bubbleScene = { kind: 'normal' }
  sel.sandbox.render()
  assert.equal(sel.sandbox.amountEl.textContent, '$ 7.30')
  assert.equal(hints[hints.length - 1], '今日已用 ¥ 2.00')

  // 未选厂商：与旧版逐字一致（含 usageLabel）
  const off = makeSandbox({
    usageSet: {},
    apiModels: [MODEL_A6],
    state: { balance: 1, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY', usageLabel: '本地估算' },
    bubbleScene: { kind: 'normal' },
    setHint(v) { hints.push(v) },
  })
  assert.equal(off.sandbox.bubblePetBalanceTodayText(), '¥ 9.99')
  assert.equal(off.sandbox.bubbleRowContentOf({ type: 'today' }).txt, '今日已用 ¥ 9.99')
  off.sandbox.render()
  assert.equal(off.sandbox.amountEl.textContent, '¥ 1.00')
  assert.equal(hints[hints.length - 1], '本地估算 ¥ 9.99')
})

// —— 失效态：选中厂商后今日已用也必须是 —，恢复回包后立刻回真实值 ——
test('选中厂商后 stale：气泡/旧卡今日已用都显示 —，恢复后重绘为新值', () => {
  const hints = []
  const s = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a6' } },
    apiModels: [MODEL_A6],
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
    bubbleScene: { kind: 'normal' },
    setHint(v) { hints.push(v) },
  })
  s.sandbox.apiModelsStale = true
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '—', '失效态不能拿旧今日已用冒充')
  assert.equal(s.sandbox.bubbleContentTokenMap({ type: 'today', tpl: '{expense_ds}' }).expense_ds, '—')
  assert.equal(s.sandbox.bubbleRowContentOf({ type: 'today' }).txt, '今日已用 —')
  assert.equal(s.sandbox.petBalanceLegacyAmount('original'), '—')
  s.sandbox.render()
  assert.equal(s.sandbox.amountEl.textContent, '—', '旧卡的余额与今日已用都必须给占位')
  assert.equal(hints[hints.length - 1], '今日已用 —')

  // 恢复：成功回包整表替换 + stale=false（apiModelsFetch 的行为，这里直接模拟结果）
  s.sandbox.apiModels = [Object.assign({}, MODEL_A6, { balance: 5, todayUsage: 3 })]
  s.sandbox.apiModelsStale = false
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '¥ 3.00')
  s.sandbox.render()
  assert.equal(s.sandbox.amountEl.textContent, '$ 5.00')
  assert.equal(hints[hints.length - 1], '今日已用 ¥ 3.00')
})

// —— 加载态：已选厂商但模型列表还没加载完成时，今日已用必须是占位，不能是 DeepSeek 的数字 ——
test('已选厂商但模型列表加载中：今日已用显示 — 占位，不显示 DeepSeek 数字', () => {
  const hints = []
  const s = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a6' } },
    apiModels: [],
    apiModelsLoaded: false, // 首次加载在途
    usageLabel: '本地估算',
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY', usageLabel: '本地估算' },
    bubbleScene: { kind: 'normal' },
    setHint(v) { hints.push(v) },
  })
  assert.equal(s.sandbox.petBalanceVendorPending(), true)
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '—', '加载态不能回落到 DeepSeek 的今日已用')
  assert.notEqual(s.sandbox.bubblePetBalanceTodayText(), '¥ 9.99')
  // 气泡模块与无 tpl 自动内容都走同一取数
  assert.equal(s.sandbox.bubbleContentTokenMap({ type: 'today', tpl: '{expense_ds}' }).expense_ds, '—')
  assert.equal(s.sandbox.bubbleRowContentOf({ type: 'today' }).txt, '今日已用 —')
  // 旧三行卡：hint 行同样给占位，且前缀不再沿用 DeepSeek 的「本地估算」
  s.sandbox.render()
  assert.equal(hints[hints.length - 1], '今日已用 —')
  assert.equal(s.sandbox.bubblePetBalanceTodayHint(), '今日已用 —')
  // 加载态既不 stale 也不算「有效厂商」：petBalanceActiveModel 仍为 null（余额取数路径未改动）
  assert.equal(s.sandbox.petBalanceActiveModel(), null)
})

test('加载完成后今日已用用该厂商自己的用量与币种（USD/CNY 各自正确）', () => {
  const s = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a' } },
    apiModels: [],
    apiModelsLoaded: false,
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
  })
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '—', '加载中先是占位')
  // 成功回包：整表替换 + loaded=true + stale=false（apiModelsFetch 的行为，这里直接模拟结果）
  s.sandbox.apiModels = [MODEL_A]
  s.sandbox.apiModelsLoaded = true
  s.sandbox.apiModelsStale = false
  assert.equal(s.sandbox.petBalanceVendorPending(), false)
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '$ 1.00', 'USD 厂商按 USD 显示自己的今日用量')
  assert.equal(s.sandbox.bubbleRowContentOf({ type: 'today' }).txt, '今日已用 $ 1.00')
  // 换成 CNY 厂商：币种不能沿用上一个厂商
  s.sandbox.apiModels = [MODEL_ZERO]
  s.sandbox.usageSet = { petBalance: { modelId: 'vendor-zero' } }
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '¥ 0.00', '0 用量显示 0，而不是 —')
})

test('加载完成后切换到不同厂商：今日已用与币种各自更新', () => {
  const a = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a' } },
    apiModels: [MODEL_A, MODEL_ZERO, MODEL_A6],
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
  })
  assert.equal(a.sandbox.bubblePetBalanceTodayText(), '$ 1.00')
  a.sandbox.usageSet = { petBalance: { modelId: 'vendor-zero' } }
  assert.equal(a.sandbox.bubblePetBalanceTodayText(), '¥ 0.00')
  a.sandbox.usageSet = { petBalance: { modelId: 'vendor-a6' } }
  assert.equal(a.sandbox.bubblePetBalanceTodayText(), '¥ 2.00', '事件金额按 CNY 显示，不按余额的 USD')
  a.sandbox.usageSet = { petBalance: { modelId: 'vendor-a' } }
  assert.equal(a.sandbox.bubblePetBalanceTodayText(), '$ 1.00', '切回来必须回到该厂商的今日用量')
  assert.equal(a.sandbox.bubblePetBalanceTodayHint(), '今日已用 $ 1.00')
})

test('配置为空 / deepseek / 内置 DeepSeek / 未知厂商仍按旧回退显示 DeepSeek 今日已用', () => {
  const BUILTIN = { id: 'deepseek', name: 'DeepSeek', builtin: true, currency: 'CNY', balance: 100, todayUsage: 1 }
  for (const sel of ['', '   ', 'deepseek', 'gone', 'some-template-only-id']) {
    const s = makeSandbox({
      // usageSetConfirmed=true = usage-settings 已成功返回（配置已确认），此处确认的是「没选有效厂商」
      usageSetConfirmed: true,
      usageSet: sel === '' ? {} : { petBalance: { modelId: sel } },
      apiModels: [BUILTIN, MODEL_A],
      apiModelsLoaded: true,
      state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY', usageLabel: '本地估算' },
    })
    assert.equal(s.sandbox.bubblePetBalanceTodayText(), '¥ 9.99', 'id=' + JSON.stringify(sel) + ' 必须沿用旧 state')
    assert.equal(s.sandbox.bubblePetBalanceTodayHint(), '本地估算 ¥ 9.99', '前缀沿用旧 usageLabel')
    assert.equal(s.sandbox.petBalanceVendorPending(), false)
    assert.equal(s.sandbox.petBalanceConfigUnconfirmed(), false, '配置已确认，不算未确认')
  }
  // 成功确认后配置确实为空（settings 已返回，但没有 petBalance 键 / modelId 为空）
  const empty = makeSandbox({
    usageSetConfirmed: true, usageSet: {}, apiModels: [MODEL_A], apiModelsLoaded: true,
    state: { balance: 1, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
  })
  assert.equal(empty.sandbox.bubblePetBalanceTodayText(), '¥ 9.99', '确认空配置 ⇒ 旧回退')
  const blankId = makeSandbox({
    usageSetConfirmed: true, usageSet: { petBalance: { modelId: '  ' } }, apiModels: [MODEL_A], apiModelsLoaded: false,
    state: { balance: 1, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
  })
  assert.equal(blankId.sandbox.bubblePetBalanceTodayText(), '¥ 9.99', '确认 modelId 为空 ⇒ 旧回退（即使列表还没回来）')
})

// —— 与上一条分开：usage-settings 请求尚未完成 / 无法确认时，不能当成「未配置」去回退 DeepSeek ——
test('设置请求 pending（配置未确认）：今日已用显示 — 占位，不当作未配置回退 DeepSeek', () => {
  const hints = []
  const s = makeSandbox({
    usageSetConfirmed: false, // usage-settings 还在途（源码 usageSet 仍是 null）
    usageSet: null,
    apiModels: [],
    apiModelsLoaded: false, // 模型列表同样未完成
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY', usageLabel: '本地估算' },
    bubbleScene: { kind: 'normal' },
    setHint(v) { hints.push(v) },
  })
  assert.equal(s.sandbox.petBalanceConfigUnconfirmed(), true)
  assert.equal(s.sandbox.petBalanceSelectedId(), '', '配置未确认时读不到选择，不能据此断定「没选厂商」')
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '—', '配置未确认必须占位，不能显示 DeepSeek 的 9.99')
  assert.notEqual(s.sandbox.bubblePetBalanceTodayText(), '¥ 9.99')
  // 气泡模块与自动内容走同一取数
  assert.equal(s.sandbox.bubbleContentTokenMap({ type: 'today', tpl: '{expense_ds}' }).expense_ds, '—')
  assert.equal(s.sandbox.bubbleRowContentOf({ type: 'today' }).txt, '今日已用 —')
  // 旧三行卡：中性前缀 + 占位
  assert.equal(s.sandbox.bubblePetBalanceTodayHint(), '今日已用 —')
  s.sandbox.render()
  assert.equal(hints[hints.length - 1], '今日已用 —')

  // 即使模型列表已经回来，只要配置仍未确认也不能用 DeepSeek 的数字
  const listReady = makeSandbox({
    usageSetConfirmed: false, usageSet: null, apiModels: [MODEL_A6], apiModelsLoaded: true,
    state: { balance: 1, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
  })
  assert.equal(listReady.sandbox.bubblePetBalanceTodayText(), '—', '配置未确认 ⇒ 仍占位')

  // 确认之后（成功返回、确实没选厂商）才恢复旧回退
  listReady.sandbox.usageSetConfirmed = true
  listReady.sandbox.usageSet = {}
  assert.equal(listReady.sandbox.bubblePetBalanceTodayText(), '¥ 9.99', '确认配置为空后才回退 DeepSeek')
})

test('设置请求失败（配置始终无法确认）：今日已用保持 — 占位而不是回退 DeepSeek', () => {
  const s = makeSandbox({
    usageSetConfirmed: false, usageSet: null, apiModels: [MODEL_A], apiModelsLoaded: true,
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
  })
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '—')
  assert.equal(s.sandbox.bubbleRowContentOf({ type: 'today' }).txt, '今日已用 —')
  // 之后设置请求成功（例如用量面板打开时补拉）⇒ 选定厂商照常显示自己的用量
  s.sandbox.usageSetConfirmed = true
  s.sandbox.usageSet = { petBalance: { modelId: 'vendor-a' } }
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '$ 1.00')
})

test('设置已确认选中厂商 + 模型列表未完成：继续占位，列表成功后显示该厂商用量与币种', () => {
  const s = makeSandbox({
    usageSetConfirmed: true,
    usageSet: { petBalance: { modelId: 'vendor-a' } },
    apiModels: [],
    apiModelsLoaded: false,
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
  })
  assert.equal(s.sandbox.petBalanceVendorPending(), true)
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '—', '厂商已知但数据未到 ⇒ 占位')
  assert.equal(s.sandbox.bubblePetBalanceTodayHint(), '今日已用 —')
  s.sandbox.apiModels = [MODEL_A]
  s.sandbox.apiModelsLoaded = true
  assert.equal(s.sandbox.petBalanceVendorPending(), false)
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '$ 1.00', '列表成功后显示该厂商自己的用量与币种')
  assert.equal(s.sandbox.bubblePetBalanceTodayHint(), '今日已用 $ 1.00')
})

test('刷新 stale 仍显示 —：加载态修复不影响失效占位', () => {
  const s = makeSandbox({
    usageSet: { petBalance: { modelId: 'vendor-a6' } },
    apiModels: [MODEL_A6],
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
  })
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '¥ 2.00')
  s.sandbox.apiModelsStale = true // 整次刷新失败（即使列表里还留着旧快照）
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '—', 'stale 仍是占位')
  assert.equal(s.sandbox.bubblePetBalanceTodayHint(), '今日已用 —')
  assert.equal(s.sandbox.bubbleRowContentOf({ type: 'today' }).txt, '今日已用 —')
  // 首次加载就失败（列表为空 + stale）
  s.sandbox.apiModels = []
  s.sandbox.apiModelsLoaded = false
  assert.equal(s.sandbox.bubblePetBalanceTodayText(), '—')
})

test('显式 modelId 的今日模块行为不变：加载中与 stale 都按原语义', () => {
  const s = makeSandbox({
    apiModels: [],
    apiModelsLoaded: false,
    usageSet: { petBalance: { modelId: 'vendor-a6' } },
    state: { balance: 123.45, currency: 'CNY', todayUsage: 9.99, todayUsageCurrency: 'CNY' },
  })
  // 显式 deepseek：始终取 DS state（与本轮修复无关）
  assert.equal(s.sandbox.bubbleContentTokenMap({ type: 'today', modelId: 'deepseek', tpl: '{expense_ds}' }).expense_ds, '¥ 9.99')
  assert.equal(s.sandbox.bubbleRowContentOf({ type: 'today', modelId: 'deepseek' }).txt, '今日已用 ¥ 9.99')
  // 显式厂商模型且列表未到：沿用旧语义（查不到 → '--'），不受选中厂商的占位影响
  assert.equal(s.sandbox.bubbleContentTokenMap({ type: 'today', modelId: 'vendor-a6', tpl: '{expense_ds}' }).expense_ds, '--')
  // 列表已到：显式厂商模块显示该模型自己的值
  s.sandbox.apiModels = [MODEL_A6]
  s.sandbox.apiModelsLoaded = true
  assert.equal(s.sandbox.bubbleContentTokenMap({ type: 'today', modelId: 'vendor-a6', tpl: '{expense_ds}' }).expense_ds, '¥ 2.00')
  // stale：显式厂商模块仍是 —
  s.sandbox.apiModelsStale = true
  assert.equal(s.sandbox.bubbleRowContentOf({ type: 'today', modelId: 'vendor-a6' }).txt, '今日已用 —')
})
