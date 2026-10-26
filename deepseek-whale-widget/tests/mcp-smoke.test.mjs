// MCP server 烟测：通过 stdio 走一遍 initialize / tools/list / resources/read，
// 校验：
//   - serverInfo 的 name/version 与插件清单一致；
//   - CSP 放在 MCP Apps 规范位置 `_meta.ui.csp`（不是错误的 `zcode/csp`）；
//   - 未知方法返回 JSON-RPC 错误而不是崩溃。
//
// 关闭自动启动（DEEPSEEK_WHALE_DISABLE_AUTOSTART=1），避免测试拉起真实浮层。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MCP = path.join(PLUGIN_ROOT, 'lib', 'mcp-server.mjs')

function pluginVersion() {
  return JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.zcode-plugin', 'plugin.json'), 'utf8')).version
}

// 极简 stdio JSON-RPC 客户端
function createClient(child) {
  let buf = ''
  const waiters = new Map()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const w = waiters.get(msg.id)
      if (w) {
        waiters.delete(msg.id)
        w(msg)
      }
    }
  })
  let next = 0
  return {
    request(method, params) {
      const id = ++next
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id)
          reject(new Error('timeout waiting for ' + method))
        }, 15000)
        waiters.set(id, (msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
  }
}

test('MCP handshake exposes correct version, ui.csp and tools', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mcp-'))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE // MCP 用普通 node 启动即可
  env.DEEPSEEK_WHALE_DISABLE_AUTOSTART = '1'
  env.DEEPSEEK_WHALE_DATA_DIR = temp
  env.ZCODE_WHALE_PORT = '1' // 不可用端口：只验证协议层，不去真的开宿主
  env.DSH_HOME = path.join(temp, 'dsh')
  env.ZCODE_CREDENTIALS_FILE = path.join(temp, 'none.json')

  const child = spawn(process.execPath, [MCP], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  t.after(() => {
    try { child.kill() } catch (err) {}
    try { fs.rmSync(temp, { recursive: true, force: true }) } catch (err) {}
  })

  const client = createClient(child)

  const init = await client.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  })
  assert.equal(init.jsonrpc, '2.0')
  assert.ok(init.result, 'initialize 必须有 result: ' + JSON.stringify(init))
  const expectedVersion = pluginVersion()
  assert.equal(init.result.serverInfo.name, 'deepseek-whale-widget')
  assert.equal(init.result.serverInfo.version, expectedVersion)

  // CSP 必须挂在规范位置 ui.csp
  assert.ok(init.result._meta, 'initialize 应带 _meta')
  assert.ok(init.result._meta.ui, 'initialize._meta.ui 必须存在')
  assert.ok(init.result._meta.ui.csp, 'CSP 必须在 _meta.ui.csp')
  const csp = init.result._meta.ui.csp
  assert.deepEqual(csp.connectDomains, ['http://127.0.0.1:1'])
  assert.deepEqual(csp.resourceDomains, ['http://127.0.0.1:1'])
  assert.deepEqual(csp.frameDomains, ['http://127.0.0.1:1'])
  // 旧实现的错误键名必须消失
  assert.equal(init.result._meta['zcode/csp'], undefined)

  const tools = await client.request('tools/list', {})
  const names = tools.result.tools.map((t2) => t2.name).sort()
  assert.deepEqual(names, ['whale_overlay_start', 'whale_overlay_stop', 'whale_status', 'whale_url'])
  for (const tool of tools.result.tools) {
    assert.ok(tool._meta?.ui?.resourceUri, tool.name + ' 应带 resourceUri')
    assert.ok(tool._meta?.ui?.csp?.connectDomains, tool.name + ' 应带 ui.csp')
  }

  const resources = await client.request('resources/list', {})
  assert.equal(resources.result.resources.length, 1)
  assert.equal(resources.result.resources[0].uri, 'ui://deepseek-whale-widget/whale-panel')
  assert.ok(resources.result.resources[0]._meta?.ui?.csp, '资源级也要带 ui.csp')

  const read = await client.request('resources/read', { uri: 'ui://deepseek-whale-widget/whale-panel' })
  assert.equal(read.result.contents.length, 1)
  const content = read.result.contents[0]
  assert.equal(content.mimeType, 'text/html;profile=mcp-app')
  assert.match(content.text, /iframe/)
  assert.ok(content._meta?.ui?.csp?.frameDomains, '资源内容级也要带 ui.csp')

  // 未知方法：必须返回结构化错误，进程不能崩
  const unknown = await client.request('no/such/method', {})
  assert.equal(unknown.error.code, -32601)

  // 自动启动被关闭时不应报错
  assert.ok(!/overlay auto-start failed/.test(stderr), 'autostart 被关闭时不应尝试启动: ' + stderr)
})
