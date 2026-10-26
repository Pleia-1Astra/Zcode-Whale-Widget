// a6api.com 余额接入测试。
// 验证方式：真实启动 lib/server.mjs（隔离 DSH_HOME / 凭据文件 / 端口）+ 本地 stub 上游，
// 所有断言都走宿主公开路由（/dsh-whale/api-models.json），不 mock 任何插件内部函数。
//
// 口径（重要）：用户要的是**账户实际余额**。
//   GET /api/usage/token/ 返回两类额度：
//     ① 令牌额度：data.total_available / data.unlimited_quota —— 不是账户余额，
//        令牌 unlimited_quota=true 也不代表账户无限；
//     ② 账户额度：data.user_quota.total_available —— 才是账户余额（原始 quota 单位），
//        ÷ 500000（A6 /api/status 的 quota_per_unit）= USD。
//   缺失 ② 时返回 ok:false + code ACCOUNT_QUOTA_UNAVAILABLE，绝不回落成 0 / 无限。
//   user_quota 形状仅按上述已知一种兼容（待实站验证），顶层平铺不被接受。
//
// 为什么余额成功路径要把 URL 指向本地 stub：
//   模板里的端点写死为 https://api.a6api.com/...（写死是刻意的 —— `{base}` 展开出的地址
//   在凭据目的地白名单里算「自定义地址」，会被 DEST_NOT_ALLOWED 拦掉）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(PLUGIN_ROOT, 'lib', 'server.mjs')
const INDEX_JS = path.join(PLUGIN_ROOT, 'lib', 'index.js')

// 测试用凭据：只写进临时凭据文件，绝不进源码 / 仓库
const TEST_KEY = 'sk-test-a6api-not-a-real-key'

// A6 的 quota_per_unit（来自 /api/status）；3650000 / 500000 = 7.3 USD
const QUOTA_PER_UNIT = 500000
const ACCOUNT_QUOTA = 3650000
// A6 /api/status 还会带 usd_exchange_rate。插件**不再**用它做人民币换算：
// A6 余额一律按站点原始美元口径（quota ÷ quota_per_unit）显示，
// 所以这个字段存不存在都不应改变结果（见文件末尾的美元口径回归用例）。
const A6_USD_RATE = 7.3

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(800) })
      if (res.ok) return res
    } catch (err) {}
    if (Date.now() >= deadline) throw new Error('host did not start: ' + url)
    await new Promise((r) => setTimeout(r, 200))
  }
}

// 本地 stub 上游：/api/usage/token/（a6api 余额）+ New API 老账单端点（openai_compat 用例）。
// mode: account | accountUnlimitedToken | accountZero | accountNull | accountBlank |
//       tokenOnly | tokenOnlyUnlimited | topUserQuota | bizError | http401 | http500
function startStub() {
  const state = {
    mode: 'account',
    accountQuota: ACCOUNT_QUOTA,
    // 账户查询路径（/api/user/self）：
    acct: 'ok',     // ok | zero | http401 | bizError | redirect302
    redirectTo: '',
    selfSeen: [],   // { path, authorization, userHeader }
    logSeen: [],    // { path, authorization } —— /api/log/token（用户 ID 自动识别）
    logMode: 'ok',  // ok | empty | http401
    logUserId: 29954,
    // /api/status：站点仍会下发 quota_per_unit + usd_exchange_rate；
    // 插件只用 quota_per_unit（美元口径），汇率字段仅用于验证「即使变了也不影响结果」
    statusSeen: [],
    statusMode: 'ok',       // ok | http500 | noRate
    quotaPerUnit: QUOTA_PER_UNIT,
    usdExchangeRate: A6_USD_RATE,
    usageSeen: [],  // { path, authorization } —— CC Switch 式 /v1/usage
    usageBody: { balance: 4.87130933, remaining: 4.87130933, unit: 'USD', isValid: true },
    tokenQuota: 20, // 令牌额度故意与账户额度不同：防止误用令牌字段
    total: 100,
    used: 2500,     // 美分 → 25 USD
    seen: [],       // { path, authorization }
  }
  const tokenBody = () => {
    const withUq = (v) => ({
      code: true,
      message: 'ok',
      data: {
        object: 'token_usage',
        total_granted: state.tokenQuota,
        total_used: 0,
        total_available: state.tokenQuota, // 令牌额度（绝不能被当账户余额）
        unlimited_quota: state.mode === 'accountUnlimitedToken',
        user_quota: { total_available: v },
      },
    })
    switch (state.mode) {
      case 'account':
      case 'accountUnlimitedToken': return withUq(state.accountQuota)
      case 'accountZero': return withUq(0)
      case 'accountNull': return withUq(null)
      case 'accountBlank': return withUq('   ')
      // 未经实站验证的替代形状：user_quota 在顶层 —— 必须不被接受
      case 'topUserQuota':
        return { code: true, message: 'ok', data: { total_available: state.tokenQuota }, user_quota: { total_available: state.accountQuota } }
      case 'bizError': return { success: false, message: '该令牌未开启「允许查询用户额度」' }
      default: // tokenOnly | tokenOnlyUnlimited：只有令牌额度，没有 user_quota
        return {
          code: true,
          message: 'ok',
          data: {
            object: 'token_usage',
            total_granted: state.tokenQuota,
            total_used: 0,
            total_available: state.tokenQuota,
            unlimited_quota: state.mode === 'tokenOnlyUnlimited',
          },
        }
    }
  }
  const server = http.createServer((req, res) => {
    state.seen.push({ path: req.url, authorization: String(req.headers.authorization || '') })
    const url = String(req.url)
    // CC Switch 式余额端点：GET /v1/usage → { balance, remaining, unit, … }
    if (url.indexOf('/v1/usage') >= 0) {
      state.usageSeen.push({ path: url, authorization: String(req.headers.authorization || '') })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(state.usageBody))
      return
    }
    // A6 的 /api/status：插件只取 quota_per_unit；usd_exchange_rate 仍然下发，
    // 用于验证「站点汇率怎么变都不影响美元余额」
    if (url.indexOf('/api/status') >= 0) {
      state.statusSeen.push({ path: url })
      if (state.statusMode === 'http500') {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end('{"success":false}')
        return
      }
      const data = { quota_per_unit: state.quotaPerUnit, quota_display_type: 'USD' }
      if (state.statusMode !== 'noRate') data.usd_exchange_rate = state.usdExchangeRate
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, data }))
      return
    }
    // A6 调用日志：GET /api/log/token → data[].user_id（用于自动识别账户 ID）
    if (url.indexOf('/api/log/token') >= 0) {
      state.logSeen.push({ path: url, authorization: String(req.headers.authorization || '') })
      if (state.logMode === 'http401') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"message":"Token not provided","success":false}')
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        success: true,
        message: '',
        data: state.logMode === 'empty' ? [] : [{ id: 1, user_id: state.logUserId, quota: 24, model_name: 'stub' }],
      }))
      return
    }
    // 账户查询：GET /api/user/self（New API 的 access token + New-Api-User 头）
    if (url.indexOf('/api/user/self') >= 0) {
      state.selfSeen.push({
        path: url,
        authorization: String(req.headers.authorization || ''),
        userHeader: String(req.headers['new-api-user'] || ''),
      })
      if (state.acct === 'http401') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"success":false,"message":"无权进行此操作，access token 无效"}')
        return
      }
      if (state.acct === 'redirect302') {
        // 302 到另一个地址：客户端必须用 redirect:'error' 拒绝，绝不把凭据带过去
        res.writeHead(302, { Location: state.redirectTo || 'http://127.0.0.1:1/evil' })
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (state.acct === 'bizError') {
        res.end('{"success":false,"message":"无权进行此操作，用户已被封禁"}')
        return
      }
      res.end(JSON.stringify({
        success: true,
        message: '',
        data: { id: 42, username: 'stub-user', quota: state.acct === 'zero' ? 0 : state.accountQuota, used_quota: 123 },
      }))
      return
    }
    if (state.mode === 'http401') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"invalid api key","type":"invalid_request_error"}}')
      return
    }
    if (state.mode === 'http500') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end('{"error":"boom"}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const url2 = String(req.url)
    if (url2.indexOf('/api/usage/token') >= 0) {
      res.end(JSON.stringify(tokenBody()))
      return
    }
    if (url2.indexOf('/subscription') >= 0) {
      res.end(JSON.stringify({ object: 'billing_subscription', hard_limit_usd: state.total, soft_limit_usd: state.total }))
      return
    }
    res.end(JSON.stringify({ object: 'list', total_usage: state.used }))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` }))
  })
}

// 启动隔离宿主（临时 DSH_HOME / 凭据文件 / 端口），返回句柄
async function startHost(t, stub, creds) {
  const port = await freePort()
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-a6api-'))
  const credFile = path.join(temp, 'credentials.json')
  fs.writeFileSync(credFile, JSON.stringify(creds || { A6API_API_KEY: TEST_KEY }), 'utf8')
  const dshHome = path.join(temp, 'dsh')
  fs.mkdirSync(dshHome, { recursive: true })

  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.A6API_API_KEY
  delete env.CUSTOM_API_KEY
  env.ZCODE_WHALE_HOST = '127.0.0.1'
  env.ZCODE_WHALE_PORT = String(port)
  env.DSH_HOME = dshHome
  env.DEEPSEEK_WHALE_DATA_DIR = temp
  env.ZCODE_CREDENTIALS_FILE = credFile

  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  t.after(() => {
    try { child.kill() } catch (err) {}
    try { stub.server.close() } catch (err) {}
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch (err) {}
  })

  const base = `http://127.0.0.1:${port}`
  await waitFor(`${base}/healthz`)
  return { base, credFile, stderr: () => stderr }
}

test('a6api reports ACCOUNT balance from data.user_quota only', async (t) => {
  const stub = await startStub()
  const host = await startHost(t, stub)
  const base = host.base

  const listModels = async () => {
    const res = await fetch(`${base}/dsh-whale/api-models.json`)
    assert.equal(res.status, 200)
    return res.json()
  }

  // —— ① 模板存在且字段正确（令牌额度不再当余额） ——
  const payload0 = await listModels()
  assert.equal(payload0.ok, true)
  const tpl = payload0.templates.find((x) => x.id === 'a6api')
  assert.ok(tpl, '必须存在 id=a6api 的独立模板')
  assert.equal(tpl.name, 'A6API')
  assert.equal(tpl.currency, 'USD', 'A6 默认按美元展示（quota ÷ quota_per_unit，不做汇率换算）')
  assert.equal(tpl.keyRef, 'A6API_API_KEY')
  assert.equal(tpl.hasBalance, true)
  assert.equal(tpl.noBalanceApi, false)
  assert.equal(tpl.needsBaseUrl, false)
  assert.equal(tpl.probeUrl, 'https://api.a6api.com/v1/models')
  assert.ok(Array.isArray(tpl.matchIds) && tpl.matchIds.includes('a6api'))
  assert.equal(tpl.balance.url, 'https://api.a6api.com/api/usage/token/')
  assert.equal(tpl.balance.auth, 'Bearer {key}')
  assert.equal(tpl.balance.json.scale, 0.000002, 'scale 必须是 1/500000（quota_per_unit）')
  assert.equal(tpl.balance.json.accountQuota, 'data.user_quota.total_available')
  assert.equal(tpl.balance.json.remaining, undefined, '令牌字段不得再被当成账户余额')
  assert.equal(tpl.balance.json.unlimited, undefined, '令牌 unlimited 标记不再参与账户余额')
  assert.equal(tpl.balance.usage, undefined, 'a6api 不使用 billing 的第二段 usage 端点')

  const source = fs.readFileSync(INDEX_JS, 'utf8')
  const a6Start = source.indexOf('  a6api: {')
  assert.ok(a6Start > 0, '源码里必须有 a6api 模板定义')
  const a6Block = source.slice(a6Start, source.indexOf('  custom: {', a6Start))
  assert.equal(/dashboard\/billing/.test(a6Block), false, 'a6api 模板不得再引用 billing 端点')

  // 既有模板不受影响
  const compat = payload0.templates.find((x) => x.id === 'openai_compat')
  assert.ok(compat, 'openai_compat 模板必须仍然存在')
  assert.equal(compat.balance.url, '{base}/v1/dashboard/billing/subscription')
  assert.equal(compat.balance.usage.url, '{base}/v1/dashboard/billing/usage')
  assert.equal(compat.balance.usage.json.scale, 0.01)

  // 凭据不落源码
  assert.ok(source.includes("keyRef: 'A6API_API_KEY'"))
  assert.equal(source.includes(TEST_KEY), false, '测试凭据绝不能出现在源码里')
  assert.equal(/sk-[A-Za-z0-9_-]{8,}/.test(source), false, '源码里不允许出现形如 sk-… 的密钥字面量')

  // —— ② 保存模型：provider=a6api，只覆盖 url（auth/json 沿用模板） ——
  const saveRes = await fetch(`${base}/dsh-whale/api-models.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: {
        provider: 'a6api',
        name: 'A6API',
        currency: 'CNY', // 即使用户存成 CNY，实际输出也必须是 USD
        allowCustomHost: true,
        balance: { url: `${stub.base}/api/usage/token/` },
      },
    }),
  })
  assert.equal(saveRes.status, 200)
  const saved = await saveRes.json()
  assert.equal(saved.ok, true, '模板必须能通过现有保存逻辑落盘: ' + JSON.stringify(saved))
  const modelId = saved.id
  assert.ok(modelId)

  const pick = async () => {
    const list = await listModels()
    const m = list.models.find((x) => x.id === modelId)
    assert.ok(m, '刚保存的 a6api 模型必须出现在模型列表里')
    return m
  }

  // —— ③ 账户额度存在：3650000 / 500000 = 7.3 USD（提交 CNY 也不影响口径） ——
  stub.state.mode = 'account'
  stub.state.seen.length = 0
  stub.state.statusSeen.length = 0
  const okModel = await pick()
  assert.equal(okModel.error, null, '成功路径不应该带错误: ' + String(okModel.error))
  assert.equal(okModel.balance, 7.3, '3650000/500000 = 7.3 USD（不做汇率换算）')
  assert.equal(okModel.currency, 'USD', 'A6 一律按美元口径输出')
  assert.equal(okModel.unlimited, false)
  assert.equal(okModel.balanceMode, 'api')
  assert.equal(okModel.hasBalanceApi, true)
  const tokenHit = stub.state.seen.find((s) => s.path.includes('/api/usage/token'))
  assert.ok(tokenHit, '必须请求 /api/usage/token/ 端点')
  assert.equal(tokenHit.authorization, 'Bearer ' + TEST_KEY)
  // status 可能在更早的列表加载里已经取过并被短 TTL 缓存，这里只要求「取过」，不要求本轮重新取
  assert.equal(stub.state.seen.some((s) => s.path.includes('dashboard/billing')), false,
    'a6api 不得访问 billing 端点')

  // —— ④ 令牌 unlimited_quota=true 但账户额度存在：仍显示折算后余额，不声称无限 ——
  stub.state.mode = 'accountUnlimitedToken'
  const unlTokenModel = await pick()
  assert.equal(unlTokenModel.error, null, '有账户额度时令牌 unlimited 不影响结果: ' + String(unlTokenModel.error))
  assert.equal(unlTokenModel.balance, 7.3, '令牌 unlimited=true 不能掩盖真实账户余额')
  assert.equal(unlTokenModel.unlimited, false, '绝不能因令牌 unlimited 而声称账户无上限')
  assert.equal(unlTokenModel.currency, 'USD')

  // —— ⑤ 账户额度为 0 是合法余额（保留 0，不当成读不到） ——
  stub.state.mode = 'accountZero'
  const zeroModel = await pick()
  assert.equal(zeroModel.error, null, 'user_quota.total_available=0 是合法结果: ' + String(zeroModel.error))
  assert.equal(zeroModel.balance, 0)
  assert.equal(zeroModel.unlimited, false)

  // —— ⑥ 账户额度为 null / 空白：明确报账户额度不可用，绝不变 0 ——
  for (const mode of ['accountNull', 'accountBlank']) {
    stub.state.mode = mode
    const m = await pick()
    assert.equal(m.balance, null, mode + '：不能下发余额（否则前端显示 0）')
    assert.ok(m.error && m.error.length > 0, mode + '：必须带错误文案')
    assert.match(String(m.error), /账户余额/, mode + '：错误必须明确指向账户余额')
    assert.match(String(m.error), /系统访问令牌/, mode + '：错误必须给出真实可用的入口指引')
    assert.equal(m.unlimited, false)
  }

  // —— ⑦ 只有令牌额度 / 令牌无限（无 user_quota）：明确账户额度不可用，绝不显示令牌额度或无限 ——
  for (const mode of ['tokenOnly', 'tokenOnlyUnlimited']) {
    stub.state.mode = mode
    const m = await pick()
    assert.equal(m.balance, null, mode + '：禁止把令牌 total_available 当账户余额')
    assert.notEqual(m.balance, 0)
    assert.equal(m.unlimited, false, mode + '：不能对 A6 声称无限账户')
    assert.ok(m.error && m.error.length > 0, mode + '：必须带错误文案')
    assert.match(String(m.error), /账户余额/, mode + '：必须是账户额度不可用错误')
    assert.match(String(m.error), /系统访问令牌|账户查询凭据/, mode + '：必须给出可操作指引')
  }

  // —— ⑧ 未经验证的替代形状（user_quota 在顶层）不被接受 ——
  stub.state.mode = 'topUserQuota'
  const topModel = await pick()
  assert.equal(topModel.balance, null, '只兼容已知 shape（data.user_quota.total_available）')
  assert.match(String(topModel.error || ''), /账户余额/)

  // —— ⑨ 上游 HTTP 200 里的业务错误：失败，不显示 0 ——
  stub.state.mode = 'bizError'
  const bizModel = await pick()
  assert.equal(bizModel.balance, null)
  assert.ok(bizModel.error && bizModel.error.length > 0)
  assert.match(String(bizModel.error), /业务错误|允许查询用户额度/)
  assert.notEqual(bizModel.balance, 0)

  // —— ⑩ 上游 HTTP 500 / 401：报错，绝不显示 0 ——
  stub.state.mode = 'http500'
  const failModel = await pick()
  assert.equal(failModel.balance, null)
  assert.match(String(failModel.error), /HTTP 500/)

  stub.state.mode = 'http401'
  const badModel = await pick()
  assert.equal(badModel.balance, null)
  assert.match(String(badModel.error || ''), /HTTP 401/)

  // —— ⑪ 没有 A6API_API_KEY：NO_KEY，不发请求，不显示 0 ——
  fs.writeFileSync(host.credFile, JSON.stringify({}), 'utf8')
  stub.state.mode = 'account'
  stub.state.seen.length = 0
  const noKeyModel = await pick()
  assert.equal(noKeyModel.balance, null)
  assert.equal(noKeyModel.hasKey, false)
  assert.match(String(noKeyModel.error || ''), /A6API_API_KEY/)
  assert.equal(stub.state.seen.length, 0, '没有 key 时不应向上游发请求')

  assert.equal(host.stderr().trim(), '', '宿主不应打印错误日志: ' + host.stderr())
})

// A6 账户查询凭据路径（access token + 数字用户 ID）：GET <同源>/api/user/self
// 这条路径不需要 sk- API key，拿到的 data.quota 就是账户额度本身。
test('a6api account credentials path: /api/user/self (Bearer + New-Api-User)', async (t) => {
  const stub = await startStub()
  const ACCT_TOKEN = 'stub-access-token-not-real'
  const ACCT_UID = '42'
  const host = await startHost(t, stub, {
    A6API_ACCOUNT_ACCESS_TOKEN: ACCT_TOKEN,
    A6API_ACCOUNT_USER_ID: ACCT_UID,
    // 故意不给 A6API_API_KEY：账户路径不应依赖 sk key
  })
  const base = host.base
  const listModels = async () => (await fetch(`${base}/dsh-whale/api-models.json`)).json()

  const saveRes = await fetch(`${base}/dsh-whale/api-models.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: {
        provider: 'a6api', name: 'A6API', currency: 'CNY', allowCustomHost: true,
        balance: { url: `${stub.base}/api/usage/token/` },
      },
    }),
  })
  assert.equal(saveRes.status, 200)
  const saved = await saveRes.json()
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const modelId = saved.id
  const pick = async () => {
    const m = (await listModels()).models.find((x) => x.id === modelId)
    assert.ok(m)
    return m
  }

  // —— ① account 成功（无 sk key）：3650000 / 500000 = 7.3 USD ——
  stub.state.acct = 'ok'
  stub.state.seen.length = 0
  stub.state.selfSeen.length = 0
  const okM = await pick()
  assert.equal(okM.error, null, '账户凭据路径应当成功: ' + String(okM.error))
  assert.equal(okM.balance, 7.3)
  assert.equal(okM.currency, 'USD')
  assert.equal(okM.hasKey, true, '账户凭据对也算有凭据')
  assert.equal(okM.hasKeySource, 'account')
  const hit = stub.state.selfSeen.find((s) => s.path.indexOf('/api/user/self') >= 0)
  assert.ok(hit, '必须请求 /api/user/self')
  assert.equal(hit.authorization, 'Bearer ' + ACCT_TOKEN)
  assert.equal(hit.userHeader, ACCT_UID, 'New-Api-User 必须是数字 ID')
  assert.equal(stub.state.seen.some((s) => s.path.includes('/api/usage/token')), false,
    '账户凭据路径不应再打令牌用量端点')

  // —— ② 账户额度 0 合法 ——
  stub.state.acct = 'zero'
  const zeroM = await pick()
  assert.equal(zeroM.error, null, 'quota=0 是合法余额: ' + String(zeroM.error))
  assert.equal(zeroM.balance, 0)
  assert.equal(zeroM.unlimited, false)

  // —— ③ 账户接口 401：失败，不显示 0 ——
  stub.state.acct = 'http401'
  const authM = await pick()
  assert.equal(authM.balance, null)
  assert.match(String(authM.error || ''), /401/)

  // —— ④ 账户接口业务错误（success:false）：失败并带原文 ——
  stub.state.acct = 'bizError'
  const bizM = await pick()
  assert.equal(bizM.balance, null)
  assert.match(String(bizM.error || ''), /业务错误|封禁/)

  // —— ⑤ 只填访问令牌（缺 User ID）：用 sk 令牌的 /api/log/token 自动识别账户 ID ——
  stub.state.acct = 'ok'
  stub.state.logMode = 'ok'
  stub.state.logUserId = 29954
  fs.writeFileSync(host.credFile, JSON.stringify({
    A6API_ACCOUNT_ACCESS_TOKEN: ACCT_TOKEN,
    A6API_API_KEY: TEST_KEY,
  }), 'utf8')
  stub.state.seen.length = 0
  stub.state.selfSeen.length = 0
  stub.state.logSeen.length = 0
  const autoM = await pick()
  assert.equal(autoM.error, null, '只有访问令牌时应能自动识别用户 ID: ' + String(autoM.error))
  assert.equal(autoM.balance, 7.3)
  const autoHit = stub.state.selfSeen.find((s) => s.path.indexOf('/api/user/self') >= 0)
  assert.ok(autoHit, '识别出 ID 后必须请求 /api/user/self')
  assert.equal(autoHit.userHeader, '29954', 'New-Api-User 必须用识别出的账户 ID')
  const logHit = stub.state.logSeen.find((s) => s.path.indexOf('/api/log/token') >= 0)
  assert.ok(logHit, '必须用 sk 令牌读调用日志来识别账户 ID')
  assert.equal(logHit.authorization, 'Bearer ' + TEST_KEY)

  // —— ⑤b 访问令牌 + sk 令牌，但日志为空/不可读：明确点名缺 User ID ——
  for (const logMode of ['empty', 'http401']) {
    stub.state.logMode = logMode
    fs.writeFileSync(host.credFile, JSON.stringify({
      A6API_ACCOUNT_ACCESS_TOKEN: ACCT_TOKEN,
      A6API_API_KEY: TEST_KEY,
    }), 'utf8')
    stub.state.seen.length = 0
    const noIdM = await pick()
    assert.equal(noIdM.balance, null, logMode + '：识别不到 ID 时不能显示余额')
    assert.match(String(noIdM.error || ''), /A6API_ACCOUNT_USER_ID/, logMode + '：必须点名缺失的 User ID')
    assert.equal(stub.state.seen.some((s) => s.path.includes('/api/user/self')), false,
      logMode + '：没有 ID 不得请求 /api/user/self')
  }
  stub.state.logMode = 'ok'

  // —— ⑤c 只有访问令牌、没有 sk 令牌：无法自动识别，点名缺失 User ID 且零请求 ——
  fs.writeFileSync(host.credFile, JSON.stringify({ A6API_ACCOUNT_ACCESS_TOKEN: ACCT_TOKEN }), 'utf8')
  stub.state.seen.length = 0
  const halfM = await pick()
  assert.equal(halfM.balance, null, '识别不到 ID 时不能显示余额')
  assert.match(String(halfM.error || ''), /A6API_ACCOUNT_USER_ID/, '必须点名缺失的 User ID')
  assert.equal(stub.state.seen.length, 0, '无法识别 ID 时不应发任何请求')

  // —— ⑥ User ID 非正整数：报错且不发请求 ——
  fs.writeFileSync(host.credFile, JSON.stringify({
    A6API_ACCOUNT_ACCESS_TOKEN: ACCT_TOKEN, A6API_ACCOUNT_USER_ID: 'abc',
  }), 'utf8')
  stub.state.seen.length = 0
  const badIdM = await pick()
  assert.equal(badIdM.balance, null)
  assert.match(String(badIdM.error || ''), /正整数/)
  assert.equal(stub.state.seen.length, 0, 'ID 非法不应发请求')

  // —— ⑦ 只配了 User ID（缺 access token）：明确缺失字段，不发请求 ——
  fs.writeFileSync(host.credFile, JSON.stringify({ A6API_ACCOUNT_USER_ID: ACCT_UID }), 'utf8')
  stub.state.seen.length = 0
  const half2 = await pick()
  assert.equal(half2.balance, null)
  assert.match(String(half2.error || ''), /A6API_ACCOUNT_ACCESS_TOKEN/)
  assert.equal(stub.state.seen.length, 0)
})


// A6 安全边界 / 旧配置回退：
//   ① 账户凭据也可用于「测试连通性」，且探活必须验证**账户余额可读**（/v1/models 200 不算）；
//   ② 早期模型条目写死的旧 billing url 必须被忽略（回退模板），不请求 billing、不出数字余额；
//   ③ 账户凭据的目的地校验：自定义地址未放行 / 302 重定向 → 零请求。
test('a6api probe + legacy billing override + account credential destination guards', async (t) => {
  const stub = await startStub()
  let evilHits = 0
  const evil = http.createServer((req, res) => { evilHits++; res.end('{}') })
  await new Promise((r) => evil.listen(0, '127.0.0.1', r))
  const evilBase = `http://127.0.0.1:${evil.address().port}`
  t.after(() => { try { evil.close() } catch (err) {} })

  const ACCT_TOKEN = 'stub-access-token-not-real'
  const ACCT_UID = '42'
  const host = await startHost(t, stub, {
    A6API_ACCOUNT_ACCESS_TOKEN: ACCT_TOKEN,
    A6API_ACCOUNT_USER_ID: ACCT_UID,
  })
  const base = host.base
  const listModels = async () => (await fetch(`${base}/dsh-whale/api-models.json`)).json()
  const save = async (model) => {
    const res = await fetch(`${base}/dsh-whale/api-models.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }),
    })
    const j = await res.json()
    assert.equal(j.ok, true, JSON.stringify(j))
    return j.id
  }
  const probe = async (id) => {
    const res = await fetch(`${base}/dsh-whale/api-models.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'probe', id }),
    })
    return res.json()
  }
  // 删掉模型，避免列出全部模型时其它条目的（合法）请求干扰「零请求」断言
  const del = async (id) => {
    await fetch(`${base}/dsh-whale/api-models.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'delete', id }),
    })
  }

  // —— ① 探活走账户余额（无 sk key）：成功，且不打 /v1/models ——
  const idOk = await save({ provider: 'a6api', name: 'a6-probe', currency: 'CNY', allowCustomHost: true, balance: { url: `${stub.base}/api/usage/token/` } })
  stub.state.acct = 'ok'
  stub.state.seen.length = 0
  stub.state.selfSeen.length = 0
  const pr = await probe(idOk)
  assert.equal(pr.ok, true, '账户凭据可用时必须能测通: ' + JSON.stringify(pr))
  assert.match(String(pr.detail || ''), /账户余额.*7\.3 USD/)
  assert.equal(stub.state.seen.some((s) => s.path.includes('/v1/models')), false, 'A6 探活不应以 /v1/models 冒充余额可读')

  // —— ② 令牌只有额度/无限（无 user_quota）：探活必须失败 ——
  fs.writeFileSync(host.credFile, JSON.stringify({ A6API_API_KEY: TEST_KEY }), 'utf8')
  stub.state.mode = 'tokenOnlyUnlimited'
  stub.state.seen.length = 0
  const prBad = await probe(idOk)
  assert.equal(prBad.ok, false, '余额不可读时探活必须失败: ' + JSON.stringify(prBad))
  assert.match(String(prBad.error || ''), /账户余额/)
  assert.equal(stub.state.seen.some((s) => s.path.includes('/v1/models')), false)

  // —— ③ 旧 billing override：忽略 url 覆盖，回退模板；无凭据 → 零请求、无数字余额 ——
  fs.writeFileSync(host.credFile, JSON.stringify({}), 'utf8')
  stub.state.seen.length = 0
  const idLegacy = await save({
    provider: 'a6api', name: 'a6-legacy', currency: 'USD', allowCustomHost: false,
    balance: {
      url: 'https://api.a6api.com/v1/dashboard/billing/subscription',
      json: { total: 'hard_limit_usd' },
      usage: { url: 'https://api.a6api.com/v1/dashboard/billing/usage', json: { used: 'total_usage', scale: 0.01 } },
    },
  })
  const legacyM = (await listModels()).models.find((m) => m.id === idLegacy)
  assert.ok(legacyM)
  assert.equal(legacyM.balanceDesc.url, 'https://api.a6api.com/api/usage/token/', '旧 billing 覆盖必须被忽略，回退模板')
  assert.equal(legacyM.balanceDesc.usage, undefined, '不得保留旧 usage 段')
  assert.equal(legacyM.balanceDesc.json.total, undefined, '不得保留旧 total 字段路径')
  assert.equal(legacyM.balance, null, '没有可信来源时绝不给出数字账户余额')
  assert.ok(legacyM.error && legacyM.error.length > 0)
  assert.equal(stub.state.seen.length, 0, '无凭据时零请求')

  // —— ④ 账户凭据打到自定义地址但未放行 allowCustomHost：零请求 ——
  await del(idOk)   // 它允许自定义地址，留着会正常发请求，干扰「零请求」断言
  await del(idLegacy)
  fs.writeFileSync(host.credFile, JSON.stringify({ A6API_ACCOUNT_ACCESS_TOKEN: ACCT_TOKEN, A6API_ACCOUNT_USER_ID: ACCT_UID }), 'utf8')
  const idNoHost = await save({ provider: 'a6api', name: 'a6-no-host', currency: 'USD', allowCustomHost: false, balance: { url: `${stub.base}/api/usage/token/` } })
  stub.state.seen.length = 0
  stub.state.selfSeen.length = 0
  const noHostM = (await listModels()).models.find((m) => m.id === idNoHost)
  assert.equal(noHostM.balance, null)
  assert.match(String(noHostM.error || ''), /自定义地址|内置端点|拒绝/)
  assert.equal(stub.state.seen.length, 0, '未放行自定义地址时不得发请求')
  assert.equal(evilHits, 0)

  // —— ⑤ 302 重定向：必须拒绝（redirect:'error'），目标服务器零请求 ——
  await del(idNoHost)
  stub.state.acct = 'redirect302'
  stub.state.redirectTo = `${evilBase}/steal`
  stub.state.seen.length = 0
  stub.state.selfSeen.length = 0
  const idRedir = await save({ provider: 'a6api', name: 'a6-redirect', currency: 'USD', allowCustomHost: true, balance: { url: `${stub.base}/api/usage/token/` } })
  const redirM = (await listModels()).models.find((m) => m.id === idRedir)
  assert.equal(redirM.balance, null, '重定向响应不得当成余额')
  assert.ok(redirM.error && redirM.error.length > 0)
  assert.equal(evilHits, 0, '重定向目标必须零请求（凭据不能泄漏）')
})

test('openai_compat generic parse still yields total - used', async (t) => {
  const stub = await startStub()
  const port = await freePort()
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-compat-'))
  const credFile = path.join(temp, 'credentials.json')
  fs.writeFileSync(credFile, JSON.stringify({ CUSTOM_API_KEY: TEST_KEY }), 'utf8')
  const dshHome = path.join(temp, 'dsh')
  fs.mkdirSync(dshHome, { recursive: true })

  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.A6API_API_KEY
  delete env.CUSTOM_API_KEY
  env.ZCODE_WHALE_HOST = '127.0.0.1'
  env.ZCODE_WHALE_PORT = String(port)
  env.DSH_HOME = dshHome
  env.DEEPSEEK_WHALE_DATA_DIR = temp
  env.ZCODE_CREDENTIALS_FILE = credFile

  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  t.after(() => {
    try { child.kill() } catch (err) {}
    try { stub.server.close() } catch (err) {}
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch (err) {}
  })

  const base = `http://127.0.0.1:${port}`
  await waitFor(`${base}/healthz`)

  const saveRes = await fetch(`${base}/dsh-whale/api-models.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: {
        provider: 'openai_compat',
        name: 'stub-compat',
        keyRef: 'CUSTOM_API_KEY',
        baseUrl: stub.base,
        allowCustomHost: true,
      },
    }),
  })
  assert.equal(saveRes.status, 200)
  const saved = await saveRes.json()
  assert.equal(saved.ok, true, JSON.stringify(saved))

  const list = await (await fetch(`${base}/dsh-whale/api-models.json`)).json()
  const m = list.models.find((x) => x.id === saved.id)
  assert.ok(m)
  assert.equal(m.error, null, '通用解析路径应当成功: ' + String(m.error))
  assert.equal(m.balance, 75, 'total(100) - used(2500*0.01) = 75')
  assert.equal(m.currency, 'USD')
  assert.equal(stderr.trim(), '', '宿主不应打印错误日志: ' + stderr)
})

// A6 美元口径回归：接口没有现成的人民币字段，插件只认 quota / quota_per_unit（美元），
// 不再乘 /api/status 的 usd_exchange_rate。所以：
//   ① 模板默认 USD，即使用户把模型币种存成 CNY，实际输出也必须是 USD；
//   ② quota_per_unit 仍实时读 /api/status（站点改了配额就跟着变）；
//   ③ status 里没有汇率 / 整个 HTTP 500 都不影响余额（这条链路不再依赖汇率）。
test('a6api always reports USD from quota/quota_per_unit (no exchange-rate math)', async (t) => {
  const stub = await startStub()
  const ACCT_TOKEN = 'stub-access-token-not-real'
  const host = await startHost(t, stub, {
    A6API_ACCOUNT_ACCESS_TOKEN: ACCT_TOKEN,
    A6API_ACCOUNT_USER_ID: '42',
  })
  const base = host.base
  const listModels = async () => (await fetch(`${base}/dsh-whale/api-models.json`)).json()

  const saveRes = await fetch(`${base}/dsh-whale/api-models.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: {
      provider: 'a6api', name: 'A6USD', currency: 'CNY', allowCustomHost: true,
      balance: { url: `${stub.base}/api/usage/token/` },
    } }),
  })
  const saved = await saveRes.json()
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const pick = async () => {
    const m = (await listModels()).models.find((x) => x.id === saved.id)
    assert.ok(m)
    return m
  }

  stub.state.acct = 'ok'

  // 每次换一个 baseUrl 路径，等于换掉 status 缓存键 —— 这样验证的是「真的按接口值算」，
  // 而不是被前一次的短 TTL 缓存挡住（缓存只用于同一轮列表刷新，不是用来固定口径的）。
  const saveAt = async (tag, currency) => {
    const r = await fetch(`${base}/dsh-whale/api-models.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: {
        id: saved.id, provider: 'a6api', name: 'A6-' + tag, currency, allowCustomHost: true,
        baseUrl: `${stub.base}/${tag}`,
      } }),
    })
    assert.equal((await r.json()).ok, true)
    return pick()
  }

  // —— ① 提交币种 CNY：输出仍是美元 7.3（不乘 7.3 的汇率） ——
  stub.state.usdExchangeRate = 7.3
  stub.state.quotaPerUnit = 500000
  stub.state.statusMode = 'ok'
  const m1 = await saveAt('rate73', 'CNY')
  assert.equal(m1.error, null, '美元路径应当成功: ' + String(m1.error))
  assert.equal(m1.balance, 7.3, 'quota/500000 = 7.3 USD（不是 53.29 CNY）')
  assert.equal(m1.currency, 'USD')

  // —— ② 站点换汇率：结果必须不变（证明不再用汇率） ——
  stub.state.usdExchangeRate = 7.1
  const m2 = await saveAt('rate71', 'CNY')
  assert.equal(m2.error, null, '换汇率后仍应成功: ' + String(m2.error))
  assert.equal(m2.balance, 7.3, '汇率不再参与计算；实际 ' + m2.balance)
  assert.equal(m2.currency, 'USD')

  // —— ③ quota_per_unit 仍读接口：改成 1000000 → 3.65 USD ——
  stub.state.usdExchangeRate = 7.3
  stub.state.quotaPerUnit = 1000000
  const m3 = await saveAt('qpu1m', 'CNY')
  assert.equal(m3.error, null, '换 quota_per_unit 后仍应成功: ' + String(m3.error))
  assert.ok(Math.abs(m3.balance - (3650000 / 1000000)) < 1e-9,
    'quota_per_unit 必须取自 /api/status；实际 ' + m3.balance)
  assert.equal(m3.currency, 'USD')

  // —— ④ status 里没有汇率：不影响（美元口径不需要汇率） ——
  stub.state.quotaPerUnit = 500000
  stub.state.statusMode = 'noRate'
  const m4 = await saveAt('norate', 'CNY')
  assert.equal(m4.error, null, '缺汇率不应报错: ' + String(m4.error))
  assert.equal(m4.balance, 7.3, '缺汇率也必须给出美元余额')
  assert.equal(m4.currency, 'USD')

  // —— ⑤ status 整个不可用（HTTP 500）：同样不影响 ——
  stub.state.statusMode = 'http500'
  const m5 = await saveAt('status500', 'CNY')
  assert.equal(m5.error, null, 'status 500 不应让余额失败: ' + String(m5.error))
  assert.equal(m5.balance, 7.3, 'status 不可用时回落到 quota_per_unit=500000 的美元结果')
  assert.equal(m5.currency, 'USD')

  // —— ⑥ 显式选美元：结果一致 ——
  stub.state.statusMode = 'ok'
  const m6 = await saveAt('usd', 'USD')
  assert.equal(m6.error, null, '美元路径应当成功: ' + String(m6.error))
  assert.equal(m6.balance, 7.3)
  assert.equal(m6.currency, 'USD')

  assert.equal(host.stderr().trim(), '', '宿主不应打印错误日志: ' + host.stderr())
})

// 逐模型「今日已用」的余额差基准：口径（币种）一变，旧基准必须作废。
// 否则把模型从 CNY 改成 USD 的那一次刷新，会把「90 CNY → 75 USD」当成花了 15 美元。
// 全程走隔离宿主 + 本地 stub（无真实账户请求），币种切换 = 用同一个 id 重存模型。
test('apiRecordBalance resets the baseline when the model currency changes', async (t) => {
  const stub = await startStub()
  const host = await startHost(t, stub, { CUSTOM_API_KEY: TEST_KEY })
  const base = host.base
  const listModels = async () => (await fetch(`${base}/dsh-whale/api-models.json`)).json()

  stub.state.total = 100
  stub.state.used = 1000 // 100 - 1000*0.01 = 90
  const saveRes = await fetch(`${base}/dsh-whale/api-models.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: {
      provider: 'openai_compat', name: 'currency-switch', keyRef: 'CUSTOM_API_KEY',
      baseUrl: stub.base, allowCustomHost: true, currency: 'CNY',
    } }),
  })
  const saved = await saveRes.json()
  assert.equal(saved.ok, true, JSON.stringify(saved))
  const pick = async () => {
    const m = (await listModels()).models.find((x) => x.id === saved.id)
    assert.ok(m)
    return m
  }

  // —— ① 首次观测：只建立基准，今日已用 0 CNY ——
  const m1 = await pick()
  assert.equal(m1.error, null, String(m1.error))
  assert.equal(m1.balance, 90)
  assert.equal(m1.currency, 'CNY')
  assert.equal(m1.todayUsage, 0, '首次观测没有差值')
  assert.equal(m1.todayUsageCurrency, 'CNY')

  // —— ② 切到 USD 且余额下降：跨币种差值必须丢弃，今日已用仍是 0 ——
  // 先让上游余额降到 75，再改币种 ⇒ 这次刷新是 USD 口径下的第一次观测，
  // 「90 CNY → 75 USD」不能记成花了 15 美元。保存接口的响应里就带最新模型列表。
  stub.state.used = 2500 // 100 - 25 = 75
  const upd = await fetch(`${base}/dsh-whale/api-models.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: {
      id: saved.id, provider: 'openai_compat', name: 'currency-switch', keyRef: 'CUSTOM_API_KEY',
      baseUrl: stub.base, allowCustomHost: true, currency: 'USD',
    } }),
  })
  const updBody = await upd.json()
  assert.equal(updBody.ok, true, JSON.stringify(updBody))
  const switched = updBody.models.find((x) => x.id === saved.id)
  assert.ok(switched)
  assert.equal(switched.balance, 75)
  assert.equal(switched.currency, 'USD')
  assert.equal(switched.todayUsage, 0, '币种变化时以新余额重建基准（不能记成 90-75=15）')
  assert.equal(switched.todayUsageCurrency, 'USD')
  const m2 = await pick()
  assert.equal(m2.error, null, String(m2.error))
  assert.equal(m2.balance, 75)
  assert.equal(m2.currency, 'USD')
  assert.equal(m2.todayUsage, 0, '同一币种重复观测不应凭空产生差值')
  assert.equal(m2.todayUsageCurrency, 'USD')

  // —— ③ 同币种内继续下降：差值照常累计 ——
  stub.state.used = 3000 // 100 - 30 = 70
  const m3 = await pick()
  assert.equal(m3.balance, 70)
  assert.equal(m3.todayUsage, 5, '同币种 75 → 70 应记 5')
  assert.equal(m3.todayUsageCurrency, 'USD')
  assert.equal(m3.usageSource, 'balance')

  assert.equal(host.stderr().trim(), '', '宿主不应打印错误日志: ' + host.stderr())
})

// CC Switch 式中转站（绿萝 zdxjl / kk-vibe）：GET {base}/v1/usage → remaining / balance。
// 这两站在 CC Switch 里就是用同一个 usage_script 取 remaining，插件这边等价成一条余额模板。
test('ccswitch_usage template reads remaining/balance from {base}/v1/usage', async (t) => {
  const stub = await startStub()
  const host = await startHost(t, stub, { CUSTOM_API_KEY: TEST_KEY })
  const base = host.base

  const listModels = async () => (await fetch(`${base}/dsh-whale/api-models.json`)).json()

  // —— ① 模板存在，字段口径正确 ——
  const tplList = await listModels()
  const tpl = tplList.templates.find((x) => x.id === 'ccswitch_usage')
  assert.ok(tpl, '必须存在 id=ccswitch_usage 的模板')
  assert.equal(tpl.needsBaseUrl, true, '各站域名不同 ⇒ 必须填 Base URL')
  assert.equal(tpl.balance.url, '{base}/v1/usage')
  assert.equal(tpl.balance.auth, 'Bearer {key}')
  assert.ok(Array.isArray(tpl.balance.json.remaining), 'remaining 必须是候选路径列表（各站写法不一）')
  assert.ok(tpl.balance.json.remaining.includes('remaining'))
  assert.ok(tpl.balance.json.remaining.includes('balance'))

  // —— ② 保存 + 取余额：实测形态 balance/remaining 同为 4.87130933 ——
  const saveRes = await fetch(`${base}/dsh-whale/api-models.json`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: {
        provider: 'ccswitch_usage', name: '绿萝中转站', currency: 'USD',
        baseUrl: stub.base, allowCustomHost: true,
      },
    }),
  })
  assert.equal(saveRes.status, 200)
  const saved = await saveRes.json()
  assert.equal(saved.ok, true, JSON.stringify(saved))

  const pick = async () => {
    const list = await listModels()
    const m = list.models.find((x) => x.id === saved.id)
    assert.ok(m, '刚保存的模型必须出现在列表里')
    return m
  }

  stub.state.usageSeen.length = 0
  const m = await pick()
  assert.equal(m.error, null, '应能读到 /v1/usage 的余额: ' + String(m.error))
  assert.equal(m.balance, 4.87130933)
  assert.equal(m.currency, 'USD')
  const hit = stub.state.usageSeen.find((s) => s.path.indexOf('/v1/usage') >= 0)
  assert.ok(hit, '必须请求 {base}/v1/usage')
  assert.equal(hit.authorization, 'Bearer ' + TEST_KEY)
  assert.equal(m.balanceMode, 'api')
  assert.equal(m.hasBalanceApi, true)

  // —— ③ 只有 balance 没有 remaining（部分站点的写法）：同样能取到 ——
  stub.state.usageBody = { balance: 12.5, unit: 'USD' }
  const balOnly = await pick()
  assert.equal(balOnly.error, null, '只给 balance 也应成功: ' + String(balOnly.error))
  assert.equal(balOnly.balance, 12.5)

  // —— ④ 余额为 0 是合法值（不能当成读不到） ——
  stub.state.usageBody = { balance: 0, remaining: 0, unit: 'USD' }
  const zero = await pick()
  assert.equal(zero.error, null, '0 是合法余额: ' + String(zero.error))
  assert.equal(zero.balance, 0)

  // —— ⑤ 两个字段都没有：明确报找不到字段，绝不下发 0 ——
  stub.state.usageBody = { unit: 'USD', isValid: true }
  const missing = await pick()
  assert.equal(missing.balance, null, '没有余额字段时不能显示 0')
  assert.ok(missing.error && missing.error.length > 0)

  assert.equal(host.stderr().trim(), '', '宿主不应打印错误日志: ' + host.stderr())
})
