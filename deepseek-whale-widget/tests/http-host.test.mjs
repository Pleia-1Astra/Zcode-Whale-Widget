// HTTP 宿主烟测：真实启动 lib/server.mjs，验证 26 条路由、素材、overlay 页面
// 与余额出口的失败语义（没有 key 时必须给出明确错误，而不是 0）。
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
    await new Promise((r) => setTimeout(r, 200))
  }
}

test('HTTP host serves 26 routes, assets, overlay page and explicit balance errors', async (t) => {
  const port = await freePort()
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-host-'))
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  env.ZCODE_WHALE_HOST = '127.0.0.1'
  env.ZCODE_WHALE_PORT = String(port)
  env.DSH_HOME = path.join(temp, 'dsh')
  env.DEEPSEEK_WHALE_DATA_DIR = temp
  env.ZCODE_CREDENTIALS_FILE = path.join(temp, 'no-credentials.json')

  const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  t.after(() => {
    try { child.kill() } catch (err) {}
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch (err) {}
  })

  const base = `http://127.0.0.1:${port}`
  const healthRes = await waitFor(`${base}/healthz`)
  const health = await healthRes.json()
  assert.equal(health.ok, true)
  assert.equal(health.plugin, 'deepseek-whale-widget')
  assert.equal(health.routes, 26, '原项目 26 条 /dsh-whale/* 路由必须全部注册')
  assert.equal(health.pid, child.pid)
  assert.match(health.version, /^0\.4\.2-zcode\.\d+$/)

  // widget.js（受保护文件）照常由原路由提供
  const widget = await fetch(`${base}/dsh-whale/widget.js`)
  assert.equal(widget.status, 200)
  const widgetText = await widget.text()
  assert.ok(widgetText.length > 500000, 'widget.js 应有完整内容')
  assert.match(widgetText, /dshwIsChatRoot/)

  // 素材：角色图与 GIF
  const image = await fetch(`${base}/dsh-whale/image.png`)
  assert.equal(image.status, 200)
  assert.match(String(image.headers.get('content-type')), /image\/png/)
  assert.ok((await image.arrayBuffer()).byteLength > 1000)

  const gif = await fetch(`${base}/dsh-whale/rua.gif`)
  assert.equal(gif.status, 200)
  assert.match(String(gif.headers.get('content-type')), /image\/gif/)

  // 普通页面不加载 overlay 桥接；overlay 模式才加载
  const plain = await (await fetch(`${base}/`)).text()
  assert.ok(plain.includes('/dsh-whale/widget.js'))
  assert.ok(!plain.includes('/overlay/bridge.js'), '普通浏览器页面不应加载浮层桥接')
  assert.ok(plain.includes('data-composer-input'), 'composer 标记必须存在（原前端初始化判据）')

  const overlayHtml = await (await fetch(`${base}/?overlay=1`)).text()
  assert.ok(overlayHtml.includes('/overlay/bridge.js'), 'overlay 模式必须加载桥接脚本')

  const bridge = await fetch(`${base}/overlay/bridge.js`)
  assert.equal(bridge.status, 200)
  assert.match(await bridge.text(), /whaleDesktop/)

  // 余额出口：没有 key 时必须给出明确错误码，且绝不出现 totalBalance: 0
  const balanceRes = await fetch(`${base}/dsh-whale/balance.json`)
  assert.equal(balanceRes.status, 200)
  const balance = await balanceRes.json()
  assert.equal(balance.ok, false)
  assert.equal(balance.code, 'NO_KEY')
  assert.ok(balance.error && balance.error.length > 0, '必须保留原始错误文案')
  assert.equal('totalBalance' in balance, false, '失败时不能下发 totalBalance（否则会被当 0）')
  assert.ok(balance.pluginVersion, '失败响应也应带插件版本')

  // 路由 404 与未知路径的边界
  const missing = await fetch(`${base}/dsh-whale/nope.json`)
  assert.equal(missing.status, 404)

  assert.equal(stderr.trim(), '', '宿主不应打印错误日志: ' + stderr)
})
