import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR, ensureDataDir } from './paths.mjs'

const preferenceFile = path.join(DATA_DIR, 'overlay-preference.json')

export function overlayEnabled() {
  try { return JSON.parse(fs.readFileSync(preferenceFile, 'utf8')).enabled !== false } catch { return true }
}

export function setOverlayEnabled(enabled) {
  ensureDataDir()
  fs.writeFileSync(preferenceFile, JSON.stringify({ enabled: !!enabled }), 'utf8')
}

export function createOverlayRecovery({ enabled, hostAlive, status, start, now = Date.now, report = () => {} }) {
  let busy = false
  let failures = 0
  let retryAt = 0
  return async function tick() {
    if (busy || now() < retryAt || !enabled()) return
    busy = true
    try {
      if (!hostAlive()) return
      const current = await status()
      if (current.running && current.hostHealth?.ok !== false) { failures = 0; return }
      // Recheck after asynchronous probes: a user stop must win over recovery.
      if (!enabled()) return
      const result = await start()
      failures = result.running ? 0 : failures + 1
      retryAt = now() + Math.min(300000, 15000 * 2 ** Math.min(failures, 5))
      report(result)
    } catch (err) {
      failures++
      retryAt = now() + Math.min(300000, 15000 * 2 ** Math.min(failures, 5))
      report({ running: false, error: String(err.message || err) })
    } finally { busy = false }
  }
}
