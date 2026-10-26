// Opt-in desktop test: isolated data/profile/port, shared read-only Electron runtime.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = process.argv[2]
if (!runtime || !fs.existsSync(path.join(runtime, 'node_modules/electron/dist/electron.exe'))) throw new Error('Pass an existing Electron runtime directory')
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-native-'))
fs.symlinkSync(path.resolve(runtime), path.join(data, 'desktop-runtime'), 'junction')
const socket = net.createServer()
await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve))
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const env = { ...process.env, DEEPSEEK_WHALE_DATA_DIR: data, ZCODE_WHALE_PORT: String(port), DSH_HOME: path.join(data, 'dsh'), ZCODE_CREDENTIALS_FILE: path.join(data, 'no-credentials.json') }
delete env.DEEPSEEK_API_KEY
delete env.DEEPSEEK_WHALE_DISABLE_AUTOSTART
const mcp = spawn(process.execPath, [path.join(root, 'lib/mcp-server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
mcp.stdout.on('data', () => {})
mcp.stderr.on('data', (value) => process.stdout.write(value))
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n')
console.log(JSON.stringify({ data, port, mcpPid: mcp.pid }))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  const deadline = Date.now() + (Number(process.argv[3]) || 240000)
  while (Date.now() < deadline && !fs.existsSync(path.join(data, 'finish'))) {
    await sleep(5000)
    try { console.log(fs.readFileSync(path.join(data, 'overlay-window-state.json'), 'utf8')) } catch {}
  }
} finally {
  process.env.DEEPSEEK_WHALE_DATA_DIR = data
  process.env.ZCODE_WHALE_PORT = String(port)
  const manager = await import('../lib/overlay-manager.mjs')
  await manager.stopOverlay()
  await manager.stopHost()
  mcp.stdin.end()
  mcp.kill()
  // Keep logs for diagnosis; only remove the junction, never the shared runtime.
  fs.unlinkSync(path.join(data, 'desktop-runtime'))
  console.log('Test stopped; evidence retained at ' + data)
}
