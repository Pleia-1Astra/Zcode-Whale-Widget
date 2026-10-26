// MCP server：ZCode 侧入口。
//
// 约束：宿主启动统一走 overlay-manager 的 ensureHost（含跨进程锁与版本校验），
// 本文件不再自己 spawn；MCP 断开不停浮层（可能被其他会话共用）；
// CSP 放在 MCP Apps 规范位置 _meta.ui.csp。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import {
  ensureHost,
  overlayStatus,
  probeHealth,
  startOverlay,
  stopOverlay,
  zcodeProcessRunning,
} from './overlay-manager.mjs'
import { DEFAULT_HOST, DEFAULT_PORT, PLUGIN_NAME, pluginVersion } from './paths.mjs'
import { createOverlayRecovery, overlayEnabled } from './overlay-recovery.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESOURCE_URI = 'ui://deepseek-whale-widget/whale-panel'
const PORT = Number(process.env.ZCODE_WHALE_PORT || DEFAULT_PORT)
const HOST = process.env.ZCODE_WHALE_HOST || DEFAULT_HOST
const LOCAL_URL = `http://${HOST}:${PORT}`
const VERSION = pluginVersion()

let autoStartPromise = null
let recoveryTimer = null
const recoveryTick = createOverlayRecovery({
  enabled: () => process.env.DEEPSEEK_WHALE_DISABLE_AUTOSTART !== '1' && overlayEnabled(),
  hostAlive: zcodeProcessRunning,
  status: () => overlayStatus({ host: HOST, port: PORT }),
  start: () => startOverlay({ automatic: true, settleMs: 6000 }),
  report: (result) => process.stderr.write(`[${PLUGIN_NAME}] recovery: ${JSON.stringify(result)}\n`),
})

function rpcResult(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}
function rpcError(id, code, message, data) {
  const error = { code, message }
  if (data !== undefined) error.data = data
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error }) + '\n')
}

// 确保宿主可用并**已确认健康**（plugin + version 都匹配）才返回 ok。
// 复用 overlay-manager：启动锁、端口占用判定、健康等待都在那里。
async function ensureServer() {
  const hostState = await ensureHost({ host: HOST, port: PORT, timeoutMs: 8000 })
  if (!hostState.running) return { ok: false, reused: false, error: hostState.error || '宿主未就绪' }
  const verify = await probeHealth({ host: HOST, port: PORT, timeoutMs: 1200 })
  if (!verify.ok) return { ok: false, reused: !!hostState.reused, error: verify.reason || '宿主健康校验失败' }
  return { ok: true, reused: !!hostState.reused, payload: verify.payload }
}

// 自动启动：只在第一次需要时触发，失败不抛（握手不能因为桌面层失败而挂掉）。
// DEEPSEEK_WHALE_DISABLE_AUTOSTART=1 时跳过（测试 / 用户显式关闭）。
function autoStartOverlay() {
  if (String(process.env.DEEPSEEK_WHALE_DISABLE_AUTOSTART || '') === '1') {
    return Promise.resolve({ running: false, skipped: true, reason: 'autostart disabled' })
  }
  if (autoStartPromise) return autoStartPromise
  autoStartPromise = startOverlay({ automatic: true, settleMs: 6000 })
    .then((res) => {
      process.stderr.write(`[${PLUGIN_NAME}] overlay auto-start: ${JSON.stringify(res)}\n`)
      return res
    })
    .catch((err) => {
      process.stderr.write(`[${PLUGIN_NAME}] overlay auto-start failed: ${String((err && err.message) || err)}\n`)
      return { running: false, error: String((err && err.message) || err) }
    })
  return autoStartPromise
}

function panelHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DeepSeek 小鲸鱼余额挂件</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}iframe{display:block;width:100%;height:100%;min-height:620px;border:0;background:transparent}</style></head>
<body><iframe title="DeepSeek 小鲸鱼余额挂件" src="${LOCAL_URL}/" allow="autoplay"></iframe></body></html>`
}

// MCP Apps 规范位置：`_meta.ui.csp`。旧实现写成 `_meta['zcode/csp']` 是错的
// 键名，宿主读不到 → 沙箱里 iframe/fetch 被 CSP 拦掉。
function uiCsp() {
  return {
    connectDomains: [LOCAL_URL],
    resourceDomains: [LOCAL_URL],
    frameDomains: [LOCAL_URL],
    baseUriDomains: [LOCAL_URL],
  }
}
function toolMeta() {
  return { ui: { resourceUri: RESOURCE_URI, showInline: true, prefersBorder: false, csp: uiCsp() } }
}
function resourceMeta() {
  return { ui: { resourceUri: RESOURCE_URI, csp: uiCsp(), prefersBorder: false } }
}
const resources = [
  {
    uri: RESOURCE_URI,
    name: 'DeepSeek Whale Widget',
    description: '原项目兼容面板；桌面悬浮显示由独立透明 Overlay 提供',
    mimeType: 'text/html;profile=mcp-app',
    _meta: resourceMeta(),
  },
]

function textResult(text) {
  return { content: [{ type: 'text', text }], _meta: toolMeta() }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (!msg || msg.jsonrpc !== '2.0') return

  if (msg.method === 'initialize') {
    // 握手不能被桌面层拖慢：只做一次短探测就回包，宿主启动与浮层自启放到后台。
    // （旧实现在 initialize 里 await ensureServer，端口不通时会卡 8 秒握手超时。）
    const quick = await probeHealth({ host: HOST, port: PORT, timeoutMs: 700 })
    rpcResult(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {}, resources: { subscribe: true, listChanged: false } },
      serverInfo: { name: PLUGIN_NAME, version: VERSION },
      instructions:
        '桌面悬浮鲸鱼由独立透明 Overlay 进程提供。若未出现，运行 node lib/overlay-cli.mjs setup（一次性）再 start。',
      _meta: {
        ui: { csp: uiCsp() },
        host: quick.ok ? { ok: true, reused: true, payload: quick.payload } : { ok: false, reason: quick.reason || null, pending: true },
      },
    })
    if (!recoveryTimer && process.env.DEEPSEEK_WHALE_DISABLE_AUTOSTART !== '1') {
      recoveryTimer = setInterval(() => { void recoveryTick() }, 15000)
      recoveryTimer.unref()
    }
    // 后台：先把宿主拉起来，再自启浮层（都幂等）
    void ensureServer()
      .then((status) => (status.ok ? autoStartOverlay() : status))
      .catch((err) => {
        process.stderr.write(`[${PLUGIN_NAME}] background start failed: ${String((err && err.message) || err)}\n`)
      })
    return
  }

  if (msg.method === 'notifications/initialized') return

  if (msg.method === 'resources/list') {
    rpcResult(msg.id, { resources })
    return
  }

  if (msg.method === 'resources/read') {
    if (msg.params?.uri !== RESOURCE_URI) return rpcError(msg.id, -32602, 'Unknown resource URI')
    // 面板 HTML 是静态的（iframe 指向宿主），不要在这里等宿主 —— 否则宿主不可用
    // 时 resources/read 会卡到超时，侧栏面板直接白屏。
    rpcResult(msg.id, {
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: 'text/html;profile=mcp-app',
          text: panelHtml(),
          _meta: resourceMeta(),
        },
      ],
    })
    return
  }

  if (msg.method === 'resources/subscribe') {
    if (msg.params?.uri !== RESOURCE_URI) return rpcError(msg.id, -32602, 'Unknown resource URI')
    rpcResult(msg.id, {})
    return
  }

  if (msg.method === 'tools/list') {
    rpcResult(msg.id, {
      tools: [
        {
          name: 'whale_status',
          description: '读取鲸鱼挂件状态：宿主健康、浮层进程、运行时是否就绪。',
          inputSchema: { type: 'object', properties: {} },
          _meta: toolMeta(),
        },
        {
          name: 'whale_url',
          description: '返回鲸鱼挂件页面地址。',
          inputSchema: { type: 'object', properties: {} },
          _meta: toolMeta(),
        },
        {
          name: 'whale_overlay_start',
          description: '启动桌面透明浮层（幂等；已有实例则复用）。',
          inputSchema: { type: 'object', properties: {} },
          _meta: toolMeta(),
        },
        {
          name: 'whale_overlay_stop',
          description: '停止本插件自己的桌面浮层进程（不会影响其他 Electron 应用）。',
          inputSchema: { type: 'object', properties: {} },
          _meta: toolMeta(),
        },
      ],
    })
    return
  }

  if (msg.method === 'tools/call') {
    const name = msg.params?.name
    try {
      if (name === 'whale_url') {
        rpcResult(msg.id, textResult(`${LOCAL_URL}/`))
        return
      }
      if (name === 'whale_status') {
        const host = await ensureServer()
        const status = await overlayStatus()
        rpcResult(
          msg.id,
          textResult(
            JSON.stringify({
              ok: status.hostHealth.ok,
              url: `${LOCAL_URL}/`,
              version: VERSION,
              hostStart: host.ok ? { ok: true, reused: host.reused } : { ok: false, error: host.error },
              overlay: { running: status.running, pid: status.pid, pids: status.pids, enabled: status.enabled, diagnosis: status.diagnosis, windowState: status.windowState },
              host: status.hostHealth,
              runtime: { installed: status.installed, version: status.runtime.version },
            })
          )
        )
        return
      }
      if (name === 'whale_overlay_start') {
        const host = await ensureServer()
        if (!host.ok) {
          rpcResult(msg.id, textResult(JSON.stringify({ running: false, error: host.error || '宿主未就绪' })))
          return
        }
        const res = await startOverlay({ settleMs: 6000 })
        rpcResult(msg.id, textResult(JSON.stringify(res)))
        return
      }
      if (name === 'whale_overlay_stop') {
        const res = await stopOverlay()
        rpcResult(msg.id, textResult(JSON.stringify(res)))
        return
      }
      rpcError(msg.id, -32601, 'Unknown tool')
    } catch (err) {
      rpcError(msg.id, -32001, String((err && err.message) || err))
    }
    return
  }

  if (msg.id !== undefined) rpcError(msg.id, -32601, `Unsupported method: ${msg.method}`)
})

// MCP 断开：**不**停浮层（可能被其他会话使用）。只报告退出。
// readline 持有 stdin 引用，接口会一直存活到宿主关闭管道。
rl.on('close', () => {
  if (recoveryTimer) clearInterval(recoveryTimer)
  process.stderr.write(`[${PLUGIN_NAME}] MCP stdio closed; overlay left running\n`)
})
