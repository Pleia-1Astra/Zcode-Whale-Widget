// 「点击桌宠显示的余额厂商」宿主侧持久化测试（隔离 DSH_HOME / 凭据 / 端口，不联网）。
//
// 覆盖：
//   ① 未配置时 GET 下发默认 { petBalance: { modelId: '', title: '', showValley: true } }（旧用户行为不变）；
//   ② PUT 保存后重读 / 重启宿主仍然保留（真实落盘 + 读回分支成对）；
//   ③ 只保存别的设置时不会凭空写 petBalance（未配置用户文件保持原样）；
//   ④ 非字符串 / 超长 / 空白的 modelId 规范化为安全字符串（不做存在性判断，交给前端按实际模型列表回落）；
//   ⑤ 选项来源 = /dsh-whale/api-models.json 的 models（实际已接入），templates 里的未添加模板不算。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(PLUGIN_ROOT, 'lib', 'server.mjs')

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
    await new Promise((r) => setTimeout(r, 150))
  }
}

function makeHome() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pet-'))
  const dsh = path.join(temp, 'dsh')
  fs.mkdirSync(dsh, { recursive: true })
  const credFile = path.join(temp, 'credentials.json')
  fs.writeFileSync(credFile, '{}', 'utf8')
  // 两个"已接入"的模型（都无余额接口 ⇒ 完全离线、无真实厂商请求）。
  // 模板 a6api / openrouter 等只存在于 templates，不应出现在 models 里。
  fs.writeFileSync(path.join(dsh, '.dshw-api.json'), JSON.stringify({
    version: 1,
    models: [
      { id: 'pet-a', name: 'Pet A', provider: 'siliconflow_cn', currency: 'CNY' },
      { id: 'pet-b', name: 'Pet B', provider: 'volcengine_ark', currency: 'CNY' },
    ],
    usage: {},
  }, null, 2), 'utf8')
  return { temp, dsh, credFile }
}

async function startHost(t, home) {
  const port = await freePort()
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  delete env.A6API_API_KEY
  delete env.A6API_ACCOUNT_ACCESS_TOKEN
  delete env.A6API_ACCOUNT_USER_ID
  env.ZCODE_WHALE_HOST = '127.0.0.1'
  env.ZCODE_WHALE_PORT = String(port)
  env.DSH_HOME = home.dsh
  env.DEEPSEEK_WHALE_DATA_DIR = home.temp
  env.ZCODE_CREDENTIALS_FILE = home.credFile
  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  t.after(() => { try { child.kill() } catch (err) {} })
  const base = `http://127.0.0.1:${port}`
  await waitFor(`${base}/healthz`)
  return { base, child, stderr: () => stderr }
}

async function getSettings(base) {
  const res = await fetch(`${base}/dsh-whale/usage-settings.json`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  return body.settings
}

async function putSettings(base, patch) {
  const res = await fetch(`${base}/dsh-whale/usage-settings.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  assert.equal(body.ok, true)
  return body.settings
}

test('petBalance: 默认空、保存后重读/重启保留、只存字符串且不污染其他设置', async (t) => {
  const home = makeHome()
  t.after(() => { try { fs.rmSync(home.temp, { recursive: true, force: true }) } catch (err) {} })
  let host = await startHost(t, home)
  let base = host.base

  // ① 默认：空 = 默认 DeepSeek
  let settings = await getSettings(base)
  assert.deepEqual(settings.petBalance, { modelId: '', title: '', showValley: true })

  // ② 只改音效类设置：不写 petBalance（未配置用户文件保持原样）
  settings = await putSettings(base, { wait: { charClose: true } })
  assert.deepEqual(settings.petBalance, { modelId: '', title: '', showValley: true })
  const rawLedger = JSON.parse(fs.readFileSync(path.join(home.dsh, '.dshw-usage.json'), 'utf8'))
  assert.equal('petBalance' in (rawLedger.settings || {}), false, '未改该项时不应写这个键')

  // ③ 保存有效 id → 立即读回
  settings = await putSettings(base, { petBalance: { modelId: 'pet-b', title: '', showValley: true } })
  assert.deepEqual(settings.petBalance, { modelId: 'pet-b', title: '', showValley: true })
  assert.deepEqual((await getSettings(base)).petBalance, { modelId: 'pet-b', title: '', showValley: true }, '重读必须保留')

  // ④ 重启宿主后仍然保留（真实落盘）
  try { host.child.kill() } catch (err) {}
  await new Promise((r) => setTimeout(r, 300))
  host = await startHost(t, home)
  base = host.base
  assert.deepEqual((await getSettings(base)).petBalance, { modelId: 'pet-b', title: '', showValley: true }, '重启后必须保留')

  // ⑤ 清空 = 回默认 DeepSeek
  settings = await putSettings(base, { petBalance: { modelId: '', title: '', showValley: true } })
  assert.deepEqual(settings.petBalance, { modelId: '', title: '', showValley: true })

  // ⑥ 非字符串 / 超长 / 前后空白：规范化（不因存储被前端当非法值渲染）
  settings = await putSettings(base, { petBalance: { modelId: '  pet-a  ' } })
  assert.deepEqual(settings.petBalance, { modelId: 'pet-a', title: '', showValley: true })
  settings = await putSettings(base, { petBalance: { modelId: 12345 } })
  assert.deepEqual(settings.petBalance, { modelId: '', title: '', showValley: true }, '非字符串按空处理，绝不变成 "12345"')
  settings = await putSettings(base, { petBalance: { modelId: 'x'.repeat(400) } })
  assert.equal(settings.petBalance.modelId.length, 120, '超长 id 截断存储')

  // ⑦ 不影响既有设置（读回其它键仍在）
  settings = await putSettings(base, { wait: { charClose: true } })
  assert.equal(settings.wait.charClose, true)
  assert.equal(settings.subagent.mute, true)
  assert.ok(settings.events && settings.events.turnCost, 'events 结构仍然完整')

  assert.equal(host.stderr().trim(), '', '宿主不应打印错误日志: ' + host.stderr())
})

test('标题/谷价独立补丁保存并跨重启保留，不清空已选余额厂商', async (t) => {
  const home = makeHome()
  t.after(() => { try { fs.rmSync(home.temp, { recursive: true, force: true }) } catch {} })
  let host = await startHost(t, home)
  await putSettings(host.base, { petBalance: { modelId: 'pet-a' } })
  let settings = await putSettings(host.base, { petBalance: { title: '  我的钱包  ', showValley: false } })
  assert.deepEqual(settings.petBalance, { modelId: 'pet-a', title: '我的钱包', showValley: false })
  settings = await putSettings(host.base, { petBalance: { modelId: 'pet-b' } })
  assert.deepEqual(settings.petBalance, { modelId: 'pet-b', title: '我的钱包', showValley: false })
  host.child.kill()
  await new Promise((r) => setTimeout(r, 300))
  host = await startHost(t, home)
  assert.deepEqual((await getSettings(host.base)).petBalance, { modelId: 'pet-b', title: '我的钱包', showValley: false })
  settings = await putSettings(host.base, { petBalance: { showValley: true } })
  assert.deepEqual(settings.petBalance, { modelId: 'pet-b', title: '我的钱包', showValley: true })
  settings = await putSettings(host.base, { petBalance: { title: 'x'.repeat(200), showValley: 'false' } })
  assert.equal(settings.petBalance.title.length, 80)
  assert.equal(settings.petBalance.showValley, true)
  settings = await putSettings(host.base, { petBalance: { title: '' } })
  assert.equal(settings.petBalance.title, '')
  assert.equal(settings.petBalance.modelId, 'pet-b')
})

test('选项来源：api-models.json 的 models 只含实际已接入厂商，模板不算', async (t) => {
  const home = makeHome()
  t.after(() => { try { fs.rmSync(home.temp, { recursive: true, force: true }) } catch (err) {} })
  const host = await startHost(t, home)
  const payload = await (await fetch(`${host.base}/dsh-whale/api-models.json`)).json()
  assert.equal(payload.ok, true)
  const ids = payload.models.map((m) => m.id)
  assert.ok(ids.includes('deepseek'), '内置 DeepSeek 仍在内置位')
  assert.ok(ids.includes('pet-a') && ids.includes('pet-b'), '实际已接入的两个模型必须在列表里')
  const tplIds = payload.templates.map((x) => x.id)
  assert.ok(tplIds.length > ids.length, '模板数量远多于实际接入模型（前端选项必须按 models 而非 templates）')
  for (const onlyTemplate of ['a6api', 'openrouter', 'openai_compat']) {
    if (tplIds.includes(onlyTemplate)) assert.equal(ids.includes(onlyTemplate), false, onlyTemplate + ' 只有模板、未接入，不应出现在 models')
  }
  // 这两个模型无余额接口 ⇒ 前端标注「无余额接口」，余额为 null 而不是 0
  for (const id of ['pet-a', 'pet-b']) {
    const m = payload.models.find((x) => x.id === id)
    assert.equal(m.balance, null, id + ' 无余额接口时 balance 必须是 null（不得是 0）')
    assert.equal(m.hasBalanceApi, false)
    assert.equal(m.balanceMode, 'events')
  }
  assert.equal(host.stderr().trim(), '')
})
