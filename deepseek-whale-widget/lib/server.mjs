// ZCode 兼容 HTTP 宿主。
//
// 复用原项目 lib/index.js 的 26 个 /dsh-whale/* 路由（字节不变）。本层只加：
// hidden-composer 页面、?overlay=1 桥接脚本、balance 归一化、healthz 版本标识、
// 令牌保护的 /shutdown。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { URL } from 'node:url'
import whalePlugin from './index.js'
import { normalizeBalancePayload } from './balance-normalize.mjs'
import { DEFAULT_HOST, DEFAULT_PORT, HOST_INFO_FILE, PLUGIN_NAME, ensureDataDir, pluginVersion } from './paths.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = path.join(ROOT, 'assets')
const DATA_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const HOST = process.env.ZCODE_WHALE_HOST || DEFAULT_HOST
const PORT = Number(process.env.ZCODE_WHALE_PORT || DEFAULT_PORT)
const VERSION = pluginVersion()
// 本实例的关停令牌：只有读到 host.json 的本机进程（管理器 / 浮层）能请求关停。
// 不带令牌的请求一律 403，避免任意页面 / 其他会话误杀宿主。
const SHUTDOWN_TOKEN = randomBytes(16).toString('hex')

const routes = []
const events = new EventEmitter()
const cleanup = []
const credentialsPath = process.env.ZCODE_CREDENTIALS_FILE || path.join(DATA_HOME, '.zcode-whale-credentials.json')

function readCredentials() {
  const out = {}
  if (process.env.DEEPSEEK_API_KEY) out.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    if (parsed && typeof parsed === 'object') Object.assign(out, parsed)
  } catch {}
  return out
}
function writeCredentials(values) {
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
  fs.writeFileSync(credentialsPath, JSON.stringify(values, null, 2), 'utf8')
}
const credentialService = {
  async resolve(name) { const value = readCredentials()[String(name || '')]; return value ? { value: String(value) } : null },
  async set(name, value) { const values = readCredentials(); values[String(name)] = String(value); writeCredentials(values) },
  async unset(name) { const values = readCredentials(); delete values[String(name)]; writeCredentials(values) },
  async deleteRecord(name) { return this.unset(name) },
}
const indexTransformers = []
const webServer = {
  register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } },
  tapIndex(fn) { indexTransformers.push(fn); return () => { const i = indexTransformers.indexOf(fn); if (i >= 0) indexTransformers.splice(i, 1) } },
}
const connection = {
  requestRejection(req) {
    const host = String(req.headers.host || '')
    return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') ? null : 403
  },
}
const ctx = {
  webServer, credentials: credentialService, connection,
  get(name) { return name === 'connection' ? connection : null },
  on(name, fn) { events.on(name, fn); return () => events.off(name, fn) },
  effect(fn) { cleanup.push(fn); return () => {} },
}
const root = {
  on(name, fn) { events.on(name, fn); return () => events.off(name, fn) },
  effect(fn) { cleanup.push(fn); return () => {} },
  inject(_services, fn) { fn(ctx) },
}
function findRoute(urlPath) { return routes.find(r => r.path === urlPath) }

// 原项目前端只在「识别到 composer」时才初始化（见 assets/whale-widget.js 的
// dshwIsChatRoot）。overlay 页面没有聊天界面，所以保留一个不可见但要能被
// querySelector 命中的标记。composer 本身不可见、不占布局、不接收输入。
function overlayIndex() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>DeepSeek Whale Widget</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
  #root{width:100%;height:100%}
  /* composer 标记：仅用于原前端的初始化判定，视觉与命中都不可见 */
  #whale-composer-marker{position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none}
</style></head>
<body>
<main id="root">
  <div id="whale-composer-marker" aria-hidden="true">
    <textarea aria-label="ZCode composer" tabindex="-1"></textarea>
    <div data-composer-input="true" role="textbox" aria-multiline="true" contenteditable="false"></div>
  </div>
</main>
<script defer src="/dsh-whale/widget.js"></script>
<script defer src="/overlay/bridge.js"></script>
</body></html>`
}

let baseIndexHtml = overlayIndex()
whalePlugin.apply(root)
// 原插件的 tapIndex 变换在原项目里是给 DSH 页面注入 widget.js；overlay 页面
// 已经自带 script 标签，变换会因去重直接返回原字符串，这里仍然跑一遍以保持
// 与真实宿主一致的行为。
for (const transform of indexTransformers) {
  try { baseIndexHtml = transform(baseIndexHtml) } catch {}
}

// 只对 overlay 模式追加桥接脚本。普通浏览器 / MCP 面板（iframe）不加载，
// 避免在非 Electron 环境下产生无意义的 IPC 调用。
function pageFor(overlayMode) {
  if (!overlayMode) return baseIndexHtml.replace('<script defer src="/overlay/bridge.js"></script>', '')
  return baseIndexHtml
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`)
  const overlayMode = parsed.searchParams.get('overlay') === '1'

  if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(pageFor(overlayMode))
    return
  }

  // 浮层桥接脚本：只在插件目录里，按请求读盘（改完刷新即生效）
  if (parsed.pathname === '/overlay/bridge.js') {
    try {
      const js = fs.readFileSync(path.join(ASSETS_DIR, 'overlay-bridge.js'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(js)
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('overlay bridge unavailable')
    }
    return
  }

  if (parsed.pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      plugin: PLUGIN_NAME,
      version: VERSION,
      routes: routes.length,
      pid: process.pid,
      overlay: true,
    })
    return
  }

  // 显式关停：只接受带本实例令牌的 POST（令牌写在 host.json，仅本机可读）。
  // 主窗退出 / CLI stop 用它收宿主；普通页面拿不到令牌。
  if (parsed.pathname === '/shutdown') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'use POST' })
      return
    }
    if (String(req.headers['x-whale-token'] || '') !== SHUTDOWN_TOKEN) {
      sendJson(res, 403, { ok: false, error: 'bad token' })
      return
    }
    sendJson(res, 200, { ok: true })
    setImmediate(() => shutdown('token-request'))
    return
  }

  if (parsed.pathname === '/dsh-whale/balance.json') {
    const route = findRoute(parsed.pathname)
    if (!route) {
      sendJson(res, 404, { ok: false, error: 'balance route unavailable' })
      return
    }
    // 复用原路由的完整逻辑，只接管它的 JSON 输出做归一化。
    const chunks = []
    const capture = {
      headersSent: false,
      writeHead() { this.headersSent = true; return this },
      write(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return true },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); return this },
    }
    try {
      await route.handler(req, capture)
      const raw = Buffer.concat(chunks).toString('utf8')
      let parsedPayload = null
      try { parsedPayload = JSON.parse(raw) } catch {
        sendJson(res, 200, { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' })
        return
      }
      const normalized = normalizeBalancePayload(parsedPayload)
      // 版本号以本插件清单为准（原文件里的 BUILD_VERSION 是上游版本号）
      sendJson(res, 200, { ...normalized, pluginVersion: VERSION })
    } catch (err) {
      sendJson(res, 200, { ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) })
    }
    return
  }

  const route = findRoute(parsed.pathname)
  if (route) {
    try {
      await route.handler(req, res)
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err?.message || err) })
    }
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
})

function writeHostInfo(port) {
  try {
    ensureDataDir()
    fs.writeFileSync(
      HOST_INFO_FILE,
      JSON.stringify(
        { pid: process.pid, host: HOST, port, version: VERSION, token: SHUTDOWN_TOKEN, startedAt: new Date().toISOString() },
        null,
        2
      ),
      'utf8'
    )
  } catch (err) {}
}

function clearHostInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(HOST_INFO_FILE, 'utf8'))
    if (Number(info.pid) === process.pid) fs.unlinkSync(HOST_INFO_FILE)
  } catch (err) {}
}

server.once('error', err => {
  // EADDRINUSE：端口上已有实例。管理器会在启动前先做健康检查，走到这里说明
  // 是竞态或者端口被别的程序占了 —— 只报告，不去杀任何进程。
  if (err?.code === 'EADDRINUSE') {
    console.error(`[${PLUGIN_NAME}] ${HOST}:${PORT} 已被占用（可能是另一个健康实例，也可能是其他程序）`)
    console.error(`[${PLUGIN_NAME}] 检测: http://${HOST}:${PORT}/healthz 应返回 plugin=${PLUGIN_NAME}`)
  } else {
    console.error(`[${PLUGIN_NAME}] HTTP host 启动失败:`, err)
  }
  process.exitCode = 1
})

server.listen(PORT, HOST, () => {
  writeHostInfo(PORT)
  console.log(`[${PLUGIN_NAME}] http://${HOST}:${PORT}`)
  console.log(`[${PLUGIN_NAME}] data: ${DATA_HOME}`)
  console.log(`[${PLUGIN_NAME}] routes: ${routes.length}`)
  console.log(`[${PLUGIN_NAME}] version: ${VERSION}`)
})

// 仅当端口确实属于本进程时才删掉 host.json（避免清掉别的实例的记录）
function shutdown(reason = 'unknown') {
  console.log(`[${PLUGIN_NAME}] shutdown reason=${reason} pid=${process.pid}`)
  clearHostInfo()
  try { for (const fn of cleanup) fn() } catch {}
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}
process.once('SIGINT', () => shutdown('SIGINT'))
process.once('SIGTERM', () => shutdown('SIGTERM'))
process.on('exit', (code) => console.log(`[${PLUGIN_NAME}] host-exit code=${code} pid=${process.pid}`))
process.on('uncaughtExceptionMonitor', (err) => console.error(`[${PLUGIN_NAME}] uncaught-exception`, err))
