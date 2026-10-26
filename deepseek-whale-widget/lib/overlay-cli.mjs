#!/usr/bin/env node
// 手动诊断/兜底命令。
//
//   node lib/overlay-cli.mjs setup         复用本机缓存或从官方 GitHub 下载 Electron 运行时（校验 SHA-256）
//   node lib/overlay-cli.mjs setup --force 强制重装运行时
//   node lib/overlay-cli.mjs setup --zip=<electron-vX.Y.Z-win32-x64.zip>  离线 zip（文件名须匹配目标版本/架构）
//   node lib/overlay-cli.mjs start         启动 HTTP 宿主 + 浮层（幂等）
//   node lib/overlay-cli.mjs status        查看浮层/宿主状态
//   node lib/overlay-cli.mjs stop          停止浮层（只停本插件自己的进程）
import fs from 'node:fs'
import path from 'node:path'
import {
  cleanupOnSessionEnd,
  detectTargetElectronVersion,
  overlayStatus,
  probeHealth,
  runtimeInfo,
  setupRuntime,
  startOverlay,
  stopHost,
  stopOverlay,
} from './overlay-manager.mjs'
import { DATA_DIR, OVERLAY_LOG_FILE, START_LOCK_FILE, pluginVersion } from './paths.mjs'

const args = process.argv.slice(2)
const command = String(args[0] || 'status').toLowerCase()
const flags = new Set(args.slice(1).filter((a) => a.startsWith('--')))
const flagValues = new Map(
  args
    .slice(1)
    .filter((a) => a.startsWith('--') && a.includes('='))
    .map((a) => {
      const i = a.indexOf('=')
      return [a.slice(2, i), a.slice(i + 1)]
    })
)

function print(label, value) {
  process.stdout.write(`${label}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

function recentLog(file, bytes = 4000) {
  try {
    const st = fs.statSync(file)
    const start = Math.max(0, st.size - bytes)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch (err) {
    return null
  }
}

async function main() {
  if (command === 'setup') {
    print('dataDir', DATA_DIR)
    const zip = flagValues.get('zip') || flagValues.get('zip-path')
    const version = flagValues.get('version')
    print('targetVersion', version || detectTargetElectronVersion())
    if (zip) print('zip', path.resolve(zip))
    const res = await setupRuntime({ force: flags.has('--force'), zip, version })
    print('result', res)
    if (!res.ok) process.exitCode = 1
    return
  }

  if (command === 'start') {
    const res = await startOverlay({ settleMs: 6000 })
    print('result', res)
    if (!res.running) {
      const log = recentLog(path.join(DATA_DIR, 'host.log'), 2000)
      if (log) print('hostLogTail', log)
      process.exitCode = 1
    }
    return
  }

  if (command === 'status') {
    const res = await overlayStatus()
    print('pluginVersion', pluginVersion())
    print('runtime', runtimeInfo())
    print('status', res)
    print('singleInstanceLock', { file: START_LOCK_FILE, present: fs.existsSync(START_LOCK_FILE) })
    print('overlayLog', OVERLAY_LOG_FILE)
    const log = recentLog(OVERLAY_LOG_FILE, 1500)
    if (log) print('overlayLogTail', log)
    return
  }

  if (command === 'stop') {
    const res = await stopOverlay()
    print('result', res)
    if (!res.ok) process.exitCode = 1
    return
  }

  if (command === 'stop-host') {
    // 仅用于排查/卸载：只通过 host.json 的令牌关停，不会杀端口上的其他进程
    print('result', await stopHost())
    return
  }

  if (command === 'health') {
    print('health', await probeHealth())
    return
  }

  if (command === 'session-end') {
    // SessionEnd hook 入口：只清本插件的浮层
    const res = await cleanupOnSessionEnd()
    print('result', res)
    return
  }

  process.stderr.write(
    [
      '用法: node lib/overlay-cli.mjs <command>',
      '',
      '  setup [--force] [--zip=<file>] [--version=<x.y.z>]',
      '                   复用本机缓存或从官方 GitHub 下载 Electron 运行时（SHA-256 校验）；',
      '                   离线 zip 的文件名必须匹配目标版本与平台架构',
      '  start            启动 HTTP 宿主 + 透明浮层（幂等，已有实例则复用）',
      '  status           查看浮层 / 宿主 / 运行时状态',
      '  stop             停止本插件自己的浮层进程',
      '  stop-host        通过 host.json 令牌关停本插件的 HTTP 宿主（排查用）',
      '  health           只探测 HTTP 宿主健康',
      '  session-end      会话结束清理（hooks 用）',
      '',
    ].join('\n')
  )
  process.exitCode = command === 'help' || command === '--help' ? 0 : 1
}

main().catch((err) => {
  process.stderr.write('命令失败: ' + String((err && err.stack) || err) + '\n')
  process.exitCode = 1
})
