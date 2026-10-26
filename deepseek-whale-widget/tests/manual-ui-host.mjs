// 隔离宿主启动器（**手工/浏览器验收用**，不参与 `node --test`：文件名不带 .test）。
//
// 用途：用一个临时数据目录 + 空凭据 + 空闲端口启动 lib/server.mjs，页面只加载源码目录里的
// assets/whale-widget.js（不启动 Electron、不写用户 ~/.dsh、不动正在运行的 3080 宿主），
// 并在 $DSH_HOME/.dshw-api.json 里准备两个**不含任何密钥**的 fixture 厂商，
// 方便在「提示与音效设置 → 点击桌宠显示的余额厂商」里切换。
//
// 这两个 fixture 厂商都选「无余额接口」的模板（硅基流动 / 火山方舟）⇒ 宿主不会向任何真实厂商
// 发请求，余额保持 null（UI 显示 —），只用于验证选项来源、保存/取消、切换与失效回退。
//
// 用法：
//   node tests/manual-ui-host.mjs            # 启动并打印 URL，Ctrl+C 退出
//   node tests/manual-ui-host.mjs --port 3999
// 环境变量：FIXTURE_HOME 可指定工作目录（默认 %TEMP%/whale-ui-fixture）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const SERVER = path.join(PLUGIN_ROOT, 'lib', 'server.mjs')

const argPort = (() => {
  const i = process.argv.indexOf('--port')
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1])
  return 0
})()

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

const root = process.env.FIXTURE_HOME || path.join(os.tmpdir(), 'whale-ui-fixture')
const dsh = path.join(root, 'dsh')
fs.mkdirSync(dsh, { recursive: true })
const credFile = path.join(root, 'credentials.json')
if (!fs.existsSync(credFile)) fs.writeFileSync(credFile, '{}', 'utf8')
// 两个已接入厂商（无余额接口的模板 ⇒ 完全离线）
const apiFile = path.join(dsh, '.dshw-api.json')
const FIXTURE_MODELS = [
  { id: 'fixture-vendor-a', name: 'Fixture Vendor A（无接口）', provider: 'siliconflow_cn', currency: 'CNY' },
  { id: 'fixture-vendor-b', name: 'Fixture Vendor B（无接口）', provider: 'volcengine_ark', currency: 'CNY' },
]
if (!fs.existsSync(apiFile) || String(process.env.FIXTURE_RESET || '') === '1') {
  fs.writeFileSync(apiFile, JSON.stringify({ version: 1, models: FIXTURE_MODELS, usage: {} }, null, 2), 'utf8')
}
// 实际下发的 fixture 厂商（文件可能被手工改过；打印真实值，方便按名字验收）
let fixtureIds = []
try {
  const reg = JSON.parse(fs.readFileSync(apiFile, 'utf8'))
  fixtureIds = (reg.models || []).map((m) => m.id + ' / ' + (m.name || '')).filter(Boolean)
} catch (err) {}

const port = argPort || (await freePort())
const env = { ...process.env }
for (const k of ['DEEPSEEK_API_KEY', 'A6API_API_KEY', 'A6API_ACCOUNT_ACCESS_TOKEN', 'A6API_ACCOUNT_USER_ID']) delete env[k]
env.ZCODE_WHALE_HOST = '127.0.0.1'
env.ZCODE_WHALE_PORT = String(port)
env.DSH_HOME = dsh
env.DEEPSEEK_WHALE_DATA_DIR = path.join(root, 'data')
env.ZCODE_CREDENTIALS_FILE = credFile

const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
const base = `http://127.0.0.1:${port}`

try {
  await waitFor(`${base}/healthz`)
} catch (err) {
  console.error(String(err && err.message || err))
  try { child.kill() } catch {}
  process.exit(1)
}

console.log('')
console.log('=== 隔离宿主已就绪（源码目录 + 临时数据，不请求真实厂商） ===')
console.log('页面      : ' + base + '/?overlay=1')
console.log('普通页面  : ' + base + '/')
console.log('健康检查  : ' + base + '/healthz')
console.log('模型列表  : ' + base + '/dsh-whale/api-models.json')
console.log('用量设置  : ' + base + '/dsh-whale/usage-settings.json')
console.log('数据目录  : ' + root)
console.log('fixture   : ' + apiFile)
console.log('已接入厂商: ' + (fixtureIds.length ? fixtureIds.join(' | ') : '（fixture 文件为空）'))
console.log('')
console.log('验收路径：点击鲸鱼 → 菜单 → 「提示与音效设置」→ 底部一行「点击桌宠显示的余额厂商」')
console.log('  · 下拉应只有「默认（DeepSeek）」+ 上面的 fixture 厂商（均标注「无余额接口」）')
console.log('  · 选 A → 取消 → 重新打开应仍是「默认」且 usage-settings.json 未变')
console.log('  · 选 A → 保存 → 重新打开/刷新页面仍是 A；GET 后 settings.petBalance.modelId === "fixture-vendor-a"')
console.log('  · 直接编辑 ' + apiFile + ' 删掉 A，再刷新 → 该行回「默认（DeepSeek）」')
console.log('  · 两个 fixture 无余额接口 ⇒ 点击桌宠时余额显示 —（不是 0）')
console.log('')
console.log('Ctrl+C 结束（只关这个临时进程）')

const shutdown = () => {
  try { child.kill() } catch {}
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
child.on('exit', (code) => {
  console.log('[fixture] host exited: ' + code)
  process.exit(code || 0)
})
