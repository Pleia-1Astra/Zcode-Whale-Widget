#!/usr/bin/env node
// SessionStart hook 入口：幂等启动 HTTP 宿主 + 桌面浮层。
//
// hook 有时间预算（hooks.json 里 25s），所以这里：
//   - 先做健康探测，已就绪就直接返回；
//   - 运行时不存在的首次安装由 startOverlay 自动从本机缓存解压（约 2-5 秒）；
//   - 任何失败都只写 stderr 并 exit 0（绝不因为桌面层失败而干扰会话）。
import { isRuntimeInstalled, probeHealth, startOverlay } from './overlay-manager.mjs'
import { DEFAULT_HOST, DEFAULT_PORT, PLUGIN_NAME } from './paths.mjs'

const DISABLED = String(process.env.DEEPSEEK_WHALE_DISABLE_AUTOSTART || '') === '1'

async function main() {
  if (DISABLED) {
    process.stderr.write(`[${PLUGIN_NAME}] autostart disabled by DEEPSEEK_WHALE_DISABLE_AUTOSTART=1\n`)
    return
  }
  // 运行时安装是**显式 CLI 步骤**（node lib/overlay-cli.mjs setup）：hook 有时间
  // 预算，解压 150MB Electron 不该塞进 SessionStart。只提示，不在这里解压。
  if (!isRuntimeInstalled()) {
    process.stderr.write(
      `[${PLUGIN_NAME}] Electron 运行时未安装；运行 node lib/overlay-cli.mjs setup 后浮层才会出现（本次跳过）\n`
    )
    return
  }
  // 先探一次宿主（可能已由别的会话拉起），仅为日志准确性
  const health = await probeHealth({
    host: process.env.ZCODE_WHALE_HOST || DEFAULT_HOST,
    port: process.env.ZCODE_WHALE_PORT || DEFAULT_PORT,
  })
  const res = await startOverlay({ settleMs: 4000, automatic: true })
  if (res.running) {
    process.stderr.write(
      `[${PLUGIN_NAME}] overlay ${res.started ? 'started' : 'reused'} pid=${res.pid || '?'} host=${health.ok ? 'reused' : 'started'}\n`
    )
  } else {
    process.stderr.write(`[${PLUGIN_NAME}] overlay not started: ${res.error || 'unknown'}\n`)
  }
}

main()
  .catch((err) => {
    process.stderr.write(`[${PLUGIN_NAME}] autostart failed: ${String((err && err.message) || err)}\n`)
  })
  .finally(() => {
    // hook 进程必须干净退出（否则会被当成失败）
    process.exit(0)
  })
