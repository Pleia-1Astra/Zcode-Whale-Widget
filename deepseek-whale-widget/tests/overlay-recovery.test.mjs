import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-recovery-'))
process.env.DEEPSEEK_WHALE_DATA_DIR = temp
const { createOverlayRecovery, overlayEnabled, setOverlayEnabled } = await import('../lib/overlay-recovery.mjs')
const { prepareRuntimeSnapshot } = await import('../lib/runtime-snapshot.mjs')

test('recovery survives repeated process and host failures without duplicate starts', async () => {
  let running = false
  let healthy = false
  let starts = 0
  let time = 0
  const tick = createOverlayRecovery({
    enabled: () => true, hostAlive: () => true,
    status: async () => ({ running, hostHealth: { ok: healthy } }),
    start: async () => { starts++; running = true; healthy = true; return { running: true } },
    now: () => time,
  })
  for (let i = 0; i < 100; i++) {
    time += 1000000
    running = false
    await Promise.all([tick(), tick(), tick()])
    assert.equal(starts, i + 1)
  }
  healthy = false
  time += 1000000
  await tick()
  assert.equal(starts, 101)
  await tick()
  assert.equal(starts, 101)
})

test('active hiding and minimize never trigger process recovery; explicit stop is persistent', async () => {
  let starts = 0
  setOverlayEnabled(false)
  const deps = {
    enabled: overlayEnabled, hostAlive: () => true,
    status: async () => ({ running: false }), start: async () => { starts++; return { running: true } },
  }
  await createOverlayRecovery(deps)()
  assert.equal(starts, 0)
  assert.equal(overlayEnabled(), false)
  setOverlayEnabled(true)
  await createOverlayRecovery({ ...deps, status: async () => ({ running: true, diagnosis: 'hidden:zcode-minimized' }) })()
  assert.equal(starts, 0)
  await createOverlayRecovery({ ...deps, hostAlive: () => false })()
  assert.equal(starts, 0)
})

test('stop racing an asynchronous probe wins over automatic start', async () => {
  let enabled = true
  let starts = 0
  const tick = createOverlayRecovery({
    enabled: () => enabled, hostAlive: () => true,
    status: async () => { enabled = false; return { running: false } },
    start: async () => { starts++; return { running: true } },
  })
  await tick()
  assert.equal(starts, 0)
})

test('failed restarts back off and permit a later recovery', async () => {
  let time = 0
  let starts = 0
  const tick = createOverlayRecovery({
    enabled: () => true, hostAlive: () => true, now: () => time,
    status: async () => ({ running: false }),
    start: async () => { starts++; return { running: starts > 1 } },
  })
  await tick()
  await tick()
  assert.equal(starts, 1)
  time = 30001
  await tick()
  assert.equal(starts, 2)
})

test('runtime snapshot survives deletion of launching cache, including preload and assets', () => {
  const root = path.join(temp, 'fake-cache')
  for (const file of ['package.json', '.zcode-plugin/plugin.json', 'desktop/main.cjs', 'desktop/preload.cjs', 'desktop/follow-window.ps1', 'lib/server.mjs', 'assets/whale-widget.js']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), file)
  }
  const snapshot = prepareRuntimeSnapshot(root, temp)
  assert.equal(prepareRuntimeSnapshot(root, temp), snapshot)
  fs.rmSync(root, { recursive: true })
  assert.equal(fs.readFileSync(path.join(snapshot, 'desktop/preload.cjs'), 'utf8'), 'desktop/preload.cjs')
  assert.ok(fs.existsSync(path.join(snapshot, 'assets/whale-widget.js')))
})

test.after(() => fs.rmSync(temp, { recursive: true, force: true }))
