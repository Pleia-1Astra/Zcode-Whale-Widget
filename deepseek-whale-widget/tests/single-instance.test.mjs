// 单实例判定与宿主健康检查测试。
//
// 关键点：
//   - 只认「命令行包含本插件运行时 marker 目录」的 electron 进程；
//   - healthz 必须同时匹配 plugin 名（避免误接同端口的其他程序）；
//   - 启动锁在持有者已死时能被接管，在持有者存活时会被拒绝。
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 数据目录必须指向临时目录，避免污染真实的 ~/.zcode
const TEMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-test-'))
process.env.DEEPSEEK_WHALE_DATA_DIR = TEMP_DATA
process.env.ZCODE_WHALE_PORT = '0'

const manager = await import('../lib/overlay-manager.mjs')
const paths = await import('../lib/paths.mjs')

function startFakeHost(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('isOwnOverlayCommandLine matches only our runtime marker', () => {
  const marker = paths.OVERLAY_MARKER_DIR
  const ours = `"${marker}\\electron.exe" --user-data-dir=x "D:\\plugins\\deepseek-whale-widget\\desktop"`
  assert.equal(manager.isOwnOverlayCommandLine(ours, marker), true)
  // Windows 路径大小写与斜杠不敏感
  assert.equal(manager.isOwnOverlayCommandLine(ours.toUpperCase(), marker), true)
  assert.equal(manager.isOwnOverlayCommandLine(ours.replace(/\\/g, '/'), marker), true)
  // 其他 Electron 应用 / fox 的运行时绝不相交
  assert.equal(manager.isOwnOverlayCommandLine('C:\\Other\\electron.exe app', marker), false)
  assert.equal(
    manager.isOwnOverlayCommandLine('C:\\Users\\x\\.zcode\\whale\\desktop-runtime\\node_modules\\electron\\dist\\electron.exe', marker),
    false
  )
  assert.equal(manager.isOwnOverlayCommandLine('', marker), false)
})

test('probeHealth accepts only our plugin name', async () => {
  const good = await startFakeHost((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, plugin: paths.PLUGIN_NAME, version: paths.pluginVersion(), routes: 26 }))
  })
  try {
    const health = await manager.probeHealth({ port: good.port })
    assert.equal(health.ok, true)
    assert.equal(health.payload.routes, 26)
  } finally {
    good.server.close()
  }

  const other = await startFakeHost((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, plugin: 'some-other-plugin' }))
  })
  try {
    const health = await manager.probeHealth({ port: other.port })
    assert.equal(health.ok, false)
    assert.match(String(health.reason), /不是 deepseek-whale-widget/)
  } finally {
    other.server.close()
  }

  const bad = await startFakeHost((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('not json')
  })
  try {
    const health = await manager.probeHealth({ port: bad.port })
    assert.equal(health.ok, false)
  } finally {
    bad.server.close()
  }
})

test('waitForHealth retries until the host becomes ready', async () => {
  // 前两次探测返回 503，第三次才正常：模拟宿主冷启动
  let calls = 0
  const slow = await startFakeHost((req, res) => {
    calls++
    if (calls < 3) {
      res.writeHead(503)
      res.end('starting')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, plugin: paths.PLUGIN_NAME, version: paths.pluginVersion(), routes: 26 }))
  })
  try {
    const health = await manager.waitForHealth({ port: slow.port, timeoutMs: 5000, intervalMs: 50 })
    assert.equal(health.ok, true)
    assert.ok(calls >= 3)
  } finally {
    slow.server.close()
  }
})

test('waitForHealth times out with the last failure reason', async () => {
  const down = await startFakeHost((req, res) => {
    res.writeHead(500)
    res.end('nope')
  })
  try {
    const health = await manager.waitForHealth({ port: down.port, timeoutMs: 400, intervalMs: 80 })
    assert.equal(health.ok, false)
    assert.equal(health.status, 500)
  } finally {
    down.server.close()
  }
})

test('overlayStatus reports host unhealthy without inventing a running overlay', async () => {
  const status = await manager.overlayStatus({ port: 1 }) // 1 = 无监听
  assert.equal(status.hostHealth.ok, false)
  assert.equal(status.running, false)
  assert.equal(status.version, paths.pluginVersion())
})

test('start lock reclaims a stale owner and blocks a live one', async () => {
  fs.mkdirSync(TEMP_DATA, { recursive: true })
  const lockFile = paths.START_LOCK_FILE

  // 死 pid（Windows 上 999999 几乎必然不存在）
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, token: 'stale', at: Date.now() }), 'utf8')
  const res = await manager.withStartLock(async () => 'ran')
  assert.equal(res.ok, true)
  assert.equal(res.result, 'ran')
  assert.equal(fs.existsSync(lockFile), false, '锁应在解锁后删除')

  // 活 pid（当前进程）+ 新鲜时间戳 → 超时返回失败，不执行回调
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'live', at: Date.now() }), 'utf8')
  let called = false
  const blocked = await manager.withStartLock(async () => {
    called = true
  }, { waitMs: 300 })
  assert.equal(blocked.ok, false)
  assert.equal(called, false)
  fs.unlinkSync(lockFile)
})

test('automatic lifecycle cleanup preserves preference but explicit stop persists disabled', async () => {
  const preference = path.join(TEMP_DATA, 'overlay-preference.json')
  fs.writeFileSync(preference, JSON.stringify({ enabled: true }))
  await manager.stopOverlay({ automatic: true })
  assert.equal(JSON.parse(fs.readFileSync(preference, 'utf8')).enabled, true)
  await manager.stopOverlay()
  assert.equal(JSON.parse(fs.readFileSync(preference, 'utf8')).enabled, false)
})

test('runtimeInfo points at the isolated runtime dir and reports not installed', () => {
  const info = manager.runtimeInfo()
  assert.equal(path.resolve(info.runtimeDir), path.resolve(paths.RUNTIME_DIR))
  assert.ok(info.runtimeDir.startsWith(path.resolve(TEMP_DATA)))
  assert.equal(info.installed, false)
  assert.match(info.electronExe, /electron(\.exe)?$/)
})

test('evaluateExistingOverlay refuses mismatched port, version or unhealthy host', () => {
  const healthy = { ok: true }
  const version = paths.pluginVersion()

  // 端口不一致：明确失败，不能认领
  const wrongPort = manager.evaluateExistingOverlay({
    known: { pid: 123, port: 3999, version, host: '127.0.0.1' },
    pid: 123,
    port: 3080,
    version,
    health: healthy,
  })
  assert.equal(wrongPort.reuse, false)
  assert.match(wrongPort.error, /端口 3999/)

  // 版本不一致：明确失败
  const wrongVersion = manager.evaluateExistingOverlay({
    known: { pid: 123, port: 3080, version: '0.4.2-zcode.2' },
    pid: 123,
    port: 3080,
    version,
    health: healthy,
  })
  assert.equal(wrongVersion.reuse, false)
  assert.match(wrongVersion.error, /0\.4\.2-zcode\.2/)

  // 宿主不健康：明确失败
  const unhealthy = manager.evaluateExistingOverlay({
    known: { pid: 123, port: 3080, version },
    pid: 123,
    port: 3080,
    version,
    health: { ok: false, reason: 'boom' },
  })
  assert.equal(unhealthy.reuse, false)
  assert.match(unhealthy.error, /不健康/)

  // 全部一致且健康：复用，且保留实例原端口
  const ok = manager.evaluateExistingOverlay({
    known: { pid: 123, port: 3080, version, host: '127.0.0.1' },
    pid: 123,
    port: 3080,
    version,
    health: healthy,
  })
  assert.equal(ok.reuse, true)
  assert.equal(ok.port, 3080)
})

test('data dir is product scoped (never ~/.dsh or fox data dir)', () => {
  assert.equal(path.resolve(paths.DATA_DIR), path.resolve(TEMP_DATA))
  assert.ok(!/[\\/]\.dsh([\\/]|$)/.test(paths.DATA_DIR))
  assert.ok(!/[\\/]whale$/.test(paths.DATA_DIR))
})

test.after(() => {
  try {
    fs.rmSync(TEMP_DATA, { recursive: true, force: true })
  } catch (err) {}
})
