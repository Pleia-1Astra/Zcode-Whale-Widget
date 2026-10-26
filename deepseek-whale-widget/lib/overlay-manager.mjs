// 浮层生命周期：运行时安装、宿主健康、单实例、启停。
//
// 硬约束：
//   - 只认命令行含 OVERLAY_MARKER_DIR 的 electron 进程，绝不按进程名泛杀。
//   - healthz 必须同时匹配 plugin 名与版本，否则不复用、也不抢端口。
//   - 启动串行化靠 withStartLock（wx 原子创建）；本文件内的 ensureHostLocked
//     不再取锁，避免嵌套死锁。
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import {
  DATA_DIR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DESKTOP_DIR,
  HOST_INFO_FILE,
  OVERLAY_INFO_FILE,
  OVERLAY_LOG_FILE,
  OVERLAY_MARKER_DIR,
  PLUGIN_NAME,
  RUNTIME_DIR,
  ensureDataDir,
  localUrl,
  overlayProfileDir,
  pluginVersion,
} from './paths.mjs'
import { withStartLock } from './start-lock.mjs'
import { overlayEnabled, setOverlayEnabled } from './overlay-recovery.mjs'
import { prepareRuntimeSnapshot } from './runtime-snapshot.mjs'

export { withStartLock }

const ELECTRON_DIST = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'dist')
const ELECTRON_PACKAGE_JSON = path.join(RUNTIME_DIR, 'node_modules', 'electron', 'package.json')
const RUNTIME_SENTINELS = ['icudtl.dat', 'v8_context_snapshot.bin']

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

// ---------- Electron 运行时 ----------
export function electronExePath() {
  if (process.platform === 'win32') return path.join(ELECTRON_DIST, 'electron.exe')
  if (process.platform === 'darwin') return path.join(ELECTRON_DIST, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  return path.join(ELECTRON_DIST, 'electron')
}

export function resolveElectronExe() {
  const p = electronExePath()
  try {
    return fs.statSync(p).isFile() ? p : null
  } catch (err) {
    return null
  }
}

// 只看可执行体会被「装了一半」的运行时骗过：dist 缺 icudtl.dat / v8 快照时
// Electron 每次启动都死在 ICU 上，桌面什么都不出现。用哨兵文件兜住。
export function isRuntimeInstalled() {
  if (!resolveElectronExe()) return false
  if (process.platform === 'darwin') {
    try {
      return fs.statSync(path.join(ELECTRON_DIST, 'Electron.app', 'Contents', 'Frameworks')).isDirectory()
    } catch (err) {
      return false
    }
  }
  for (const name of RUNTIME_SENTINELS) {
    try {
      if (!fs.statSync(path.join(ELECTRON_DIST, name)).isFile()) return false
    } catch (err) {
      return false
    }
  }
  return true
}

export function runtimeInfo() {
  let version = null
  try {
    version = JSON.parse(fs.readFileSync(ELECTRON_PACKAGE_JSON, 'utf8')).version || null
  } catch (err) {}
  return {
    runtimeDir: RUNTIME_DIR,
    electronExe: resolveElectronExe() || electronExePath(),
    markerDir: OVERLAY_MARKER_DIR,
    installed: isRuntimeInstalled(),
    version,
  }
}

// 在本机 Electron 下载缓存里找与目标版本匹配的 zip。ZCode 自带 Electron 运行时，
// 命中缓存时 setup 可直接离线安装，无需联网。
// 缓存布局：%LOCALAPPDATA%\electron\Cache\<sha256(url)>\electron-v<ver>-<platform>-<arch>.zip
export function findCachedElectronZip(version, opts = {}) {
  const wanted = String(version || '').trim()
  if (!wanted) return null
  const roots = (Array.isArray(opts.roots)
    ? opts.roots
    : [
        process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'electron', 'Cache') : null,
        path.join(os.homedir(), 'AppData', 'Local', 'electron', 'Cache'),
      ]).filter(Boolean)
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  const wantedName = new RegExp(`^electron-v${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-${platform}-${arch}\\.zip$`, 'i')
  const candidates = []
  for (const root of roots) {
    let dirs = []
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name))
    } catch (err) {
      continue
    }
    for (const dir of dirs) {
      let files = []
      try {
        files = fs.readdirSync(dir)
      } catch (err) {
        continue
      }
      for (const f of files) if (wantedName.test(f)) candidates.push(path.join(dir, f))
    }
  }
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile() && fs.statSync(c).size > 1024 * 1024) return c
    } catch (err) {}
  }
  return null
}

// 目标版本：显式环境变量 → 宿主 Electron（ZCode 自带 Node 的 process.versions.electron）
// → null。普通 Node 没有宿主 Electron，就不再从任意下载缓存里猜版本，避免装错。
export function detectTargetElectronVersion() {
  const envVersion = String(process.env.DEEPSEEK_WHALE_ELECTRON_VERSION || '').trim()
  if (envVersion) return envVersion
  try {
    const hostVersion = process.versions && process.versions.electron
    if (hostVersion) return hostVersion
  } catch (err) {}
  return null
}

const ELECTRON_RELEASES = 'https://github.com/electron/electron/releases/download'
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

function electronArchiveName(version) {
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
  const platform = process.platform === 'win32' ? 'win32' : process.platform
  return `electron-v${version}-${platform}-${arch}.zip`
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function fetchExpectedSha(fetchImpl, url, filename, timeoutMs) {
  let res
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  } catch (err) {
    throw new Error('下载 Electron SHA-256 清单失败: ' + String((err && err.message) || err))
  }
  if (!res || !res.ok) throw new Error(`下载 Electron SHA-256 清单失败: HTTP ${res ? res.status : '?'}`)
  const text = await res.text()
  const cols = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .find((parts) => parts.length >= 2 && parts[parts.length - 1].replace(/^\*/, '') === filename)
  if (!cols || !/^[a-f0-9]{64}$/i.test(cols[0])) throw new Error(`官方 SHA-256 清单中没有 ${filename}`)
  return cols[0]
}

// 从 Electron 官方 GitHub 下载 Windows x64 zip，并核对发行版 SHASUMS256.txt。
// 命中本地缓存时同样重新校验官方 SHA-256，绝不直接信任残留文件。
export async function downloadElectronZip(version, opts = {}) {
  const wanted = String(version || '').trim()
  if (!/^\d+\.\d+\.\d+$/.test(wanted)) throw new Error('Electron 版本号无效，需为完整的 x.y.z 版本')
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('自动下载目前仅支持 Windows x64；请手动提供匹配平台的 Electron zip')
  }
  const filename = electronArchiveName(wanted)
  const cacheDir = opts.cacheDir || path.join(DATA_DIR, 'electron-downloads')
  const zipPath = path.join(cacheDir, filename)
  const fetchImpl = opts.fetchImpl || fetch
  const timeoutMs = Number(opts.timeoutMs) || DOWNLOAD_TIMEOUT_MS
  const base = `${ELECTRON_RELEASES}/v${wanted}`
  const expected = await fetchExpectedSha(fetchImpl, `${base}/SHASUMS256.txt`, filename, timeoutMs)

  if (fs.existsSync(zipPath)) {
    let cached = null
    try {
      cached = await sha256File(zipPath)
    } catch (err) {
      cached = null
    }
    if (cached && cached.toLowerCase() === expected.toLowerCase()) return zipPath
    try { fs.rmSync(zipPath, { force: true }) } catch (err) {}
  }

  const archive = await fetchImpl(`${base}/${filename}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
  if (!archive || !archive.ok || !archive.body) {
    throw new Error(`下载 Electron 运行时失败: HTTP ${archive ? archive.status : '?'}`)
  }
  fs.mkdirSync(cacheDir, { recursive: true })
  const tempPath = `${zipPath}.part-${process.pid}-${Date.now()}`
  const handle = await fs.promises.open(tempPath, 'wx')
  const hash = createHash('sha256')
  try {
    for await (const chunk of archive.body) {
      const buf = Buffer.from(chunk)
      hash.update(buf)
      let offset = 0
      while (offset < buf.length) {
        const { bytesWritten } = await handle.write(buf, offset, buf.length - offset)
        offset += bytesWritten
      }
    }
    await handle.close()
    const actual = hash.digest('hex')
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`Electron 压缩包 SHA-256 校验失败（期望 ${expected}，实际 ${actual}）`)
    }
    fs.renameSync(tempPath, zipPath)
    return zipPath
  } catch (err) {
    try { await handle.close() } catch (closeErr) {}
    try { fs.rmSync(tempPath, { force: true }) } catch (removeErr) {}
    throw err
  }
}

function emptyDir(dir) {
  try {
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  } catch (err) {}
}

function psSingleQuote(value) {
  // PowerShell 单引号字符串里只有单引号需要翻倍转义；反斜杠是字面量，
  // 用 JSON.stringify 会保留双反斜杠 → 路径被当成 UNC/坏路径。
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  // Windows 10+ 自带 bsdtar（System32\tar.exe），解 250MB 的 Electron 包比
  // PowerShell 的 ZipFile 快一个数量级；解压到新的空目录，无需覆盖语义。
  if (process.platform === 'win32') {
    const tar = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { windowsHide: true, timeout: 300000, encoding: 'utf8' })
    if (tar.status === 0) return { ok: true, output: 'tar' }
    // tar 半途失败会留下不完整文件：先清空再走 PowerShell，避免与残留混装
    emptyDir(destDir)
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${psSingleQuote(zipPath)}, ${psSingleQuote(destDir)})`,
      ],
      { windowsHide: true, timeout: 300000, encoding: 'utf8' }
    )
    if (r.status !== 0) emptyDir(destDir)
    const out = String((r.stderr || '') + (r.stdout || '') + (tar.stderr || '')).slice(-1200)
    return { ok: r.status === 0, output: out }
  }
  const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { timeout: 300000, encoding: 'utf8' })
  if (r.status !== 0) emptyDir(destDir)
  return { ok: r.status === 0, output: String((r.stderr || '') + (r.stdout || '')).slice(-1200) }
}

function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true }) } catch (err) {}
}

function validateExtracted(dir) {
  const exeName = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? path.join('Electron.app', 'Contents', 'MacOS', 'Electron') : 'electron'
  const isFile = (p) => {
    try { return fs.statSync(p).isFile() } catch (err) { return false }
  }
  if (!isFile(path.join(dir, exeName))) return '解压后缺少 ' + exeName
  if (process.platform === 'darwin') return null
  for (const name of RUNTIME_SENTINELS) if (!isFile(path.join(dir, name))) return '解压后缺少 ' + name
  return null
}

// setup：优先离线（显式 zip / 本地缓存），否则从官方 GitHub 下载并校验 SHA-256。
// 安装用 staging + rename 提交，旧 runtime 先备份，失败回滚，绝不半装。
export async function setupRuntime(opts = {}) {
  ensureDataDir()
  if (isRuntimeInstalled() && !opts.force) {
    return { ok: true, alreadyInstalled: true, ...runtimeInfo() }
  }
  const version = opts.version || detectTargetElectronVersion()
  const runtime = () => runtimeInfo()
  if (!version) {
    return {
      ok: false,
      error: '无法自动确定 Electron 版本',
      hint: '请用 ZCode.exe（内置 Node）运行 setup，或设置 DEEPSEEK_WHALE_ELECTRON_VERSION 为 ZCode 所用的完整 Electron 版本号',
      runtime: runtime(),
    }
  }

  // 显式 zip 是用户信任的离线输入：必须存在且文件名匹配目标版本/架构，
  // 不匹配就明确失败，绝不悄悄联网下载。
  const explicitZip = opts.zip || process.env.DEEPSEEK_WHALE_ELECTRON_ZIP
  let zip = null
  if (explicitZip) {
    const resolved = path.resolve(String(explicitZip))
    let stat = null
    try { stat = fs.statSync(resolved) } catch (err) {}
    if (!stat || !stat.isFile()) {
      return { ok: false, step: 'zip', zip: resolved, error: `指定的 Electron zip 不存在: ${resolved}`, runtime: runtime() }
    }
    const expectedName = electronArchiveName(version)
    if (path.basename(resolved).toLowerCase() !== expectedName.toLowerCase()) {
      return {
        ok: false,
        step: 'zip',
        zip: resolved,
        error: `指定的 zip 文件名与目标版本/架构不匹配：需要 ${expectedName}，实际 ${path.basename(resolved)}`,
        hint: '请提供与目标 Electron 版本、平台和架构一致的官方 zip，或移除 DEEPSEEK_WHALE_ELECTRON_ZIP',
        runtime: runtime(),
      }
    }
    zip = resolved
  } else {
    zip = findCachedElectronZip(version)
  }

  if (!zip) {
    try {
      zip = await (opts.downloadElectronZip || downloadElectronZip)(version, opts.downloadOptions || {})
    } catch (err) {
      return {
        ok: false,
        step: 'download',
        error: String((err && err.message) || err),
        hint: '确保可访问 github.com，或用 DEEPSEEK_WHALE_ELECTRON_ZIP 指定官方且版本匹配的 zip',
        runtime: runtime(),
      }
    }
  }

  const stamp = Date.now()
  const staging = path.join(RUNTIME_DIR, '.staging-' + stamp)
  const pkgStaging = path.join(RUNTIME_DIR, '.staging-pkg-' + stamp)
  const targetPkgDir = path.join(RUNTIME_DIR, 'node_modules', 'electron')
  const backupPkgDir = path.join(RUNTIME_DIR, '.backup-electron-' + stamp)
  let movedOld = false
  let committed = false
  const describe = (err) => String((err && err.message) || err)
  // 提交后任何失败都要回到安装前状态：删掉新 target，再把 backup 换回来。
  // 回滚本身失败必须如实报告，不能吞掉（否则会出现「失败但装着新运行时」）。
  const rollback = () => {
    const problems = []
    if (committed) {
      try { fs.rmSync(targetPkgDir, { recursive: true, force: true }) } catch (err) { problems.push('删除新运行时失败: ' + describe(err)) }
      committed = false
    }
    if (movedOld) {
      try {
        if (!fs.existsSync(backupPkgDir)) problems.push('旧运行时备份已丢失: ' + backupPkgDir)
        else fs.renameSync(backupPkgDir, targetPkgDir)
        if (!problems.length) movedOld = false
      } catch (err) {
        problems.push('恢复旧运行时失败: ' + describe(err))
      }
    }
    return problems
  }
  try {
    rmrf(staging)
    fs.mkdirSync(staging, { recursive: true })
    const res = unzip(zip, staging)
    if (!res.ok) return { ok: false, step: 'unzip', error: res.output || '解压失败', zip }

    const invalid = validateExtracted(staging)
    if (invalid) return { ok: false, step: 'verify', error: invalid, zip }

    // 在 staging 里组装完整 electron 包（含 package.json），一次性 rename 提交
    const stagedDist = path.join(pkgStaging, 'dist')
    rmrf(pkgStaging)
    fs.mkdirSync(stagedDist, { recursive: true })
    fs.cpSync(staging, stagedDist, { recursive: true })
    fs.writeFileSync(
      path.join(pkgStaging, 'package.json'),
      JSON.stringify({ name: 'electron', version, private: true, description: 'Extracted by deepseek-whale-widget setup' }, null, 2),
      'utf8'
    )

    fs.mkdirSync(path.join(RUNTIME_DIR, 'node_modules'), { recursive: true })
    if (fs.existsSync(targetPkgDir)) {
      rmrf(backupPkgDir)
      fs.renameSync(targetPkgDir, backupPkgDir)
      movedOld = true
    }
    fs.renameSync(pkgStaging, targetPkgDir)
    committed = true
    fs.writeFileSync(
      path.join(RUNTIME_DIR, 'package.json'),
      JSON.stringify(
        {
          name: 'deepseek-whale-widget-desktop-runtime',
          version: '1.0.0',
          private: true,
          description: 'Electron runtime for the DeepSeek whale overlay (installed by setup).',
        },
        null,
        2
      ),
      'utf8'
    )

    if (!isRuntimeInstalled()) {
      const problems = rollback()
      return {
        ok: false,
        step: 'verify',
        zip,
        error: problems.length
          ? ['安装后哨兵校验失败', ...problems].join('；')
          : '安装后哨兵校验失败，已回滚到原有运行时',
        runtime: runtime(),
      }
    }
    committed = false
    if (movedOld) {
      rmrf(backupPkgDir)
      movedOld = false
    }
    return { ok: true, installed: true, version, zip, ...runtimeInfo() }
  } catch (err) {
    const problems = rollback()
    return {
      ok: false,
      step: 'setup',
      zip,
      error: [describe(err), ...problems].join('；'),
      runtime: runtime(),
    }
  } finally {
    rmrf(staging)
    rmrf(pkgStaging)
  }
}

// ---------- HTTP 宿主健康 ----------
export async function probeHealth(opts = {}) {
  const host = opts.host || process.env.ZCODE_WHALE_HOST || DEFAULT_HOST
  const port = Number(opts.port || process.env.ZCODE_WHALE_PORT || DEFAULT_PORT)
  const url = `${localUrl(host, port)}/healthz`
  const expectedVersion = pluginVersion()
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs || 900) })
    if (!res.ok) return { ok: false, port, host, status: res.status, reason: 'HTTP ' + res.status, versionMatches: false }
    const body = await res.json()
    const pluginMatches = !!body && body.ok === true && body.plugin === PLUGIN_NAME
    const reportedVersion = body && typeof body.version === 'string' ? body.version : null
    const versionMatches = !!(pluginMatches && reportedVersion && reportedVersion === expectedVersion)
    // 健康 = 插件名正确 **且** 版本一致：同端口上的旧版本实例会把请求接到
    // 不兼容的行为上（例如旧版没有余额归一化 / 没有 overlay 页面）。
    const ok = pluginMatches && versionMatches
    return {
      ok,
      pluginMatches,
      versionMatches,
      port,
      host,
      payload: body,
      version: reportedVersion,
      expectedVersion,
      reason: ok
        ? null
        : pluginMatches
          ? `端口 ${port} 上是 ${PLUGIN_NAME} ${reportedVersion || '(未知版本)'}，本插件是 ${expectedVersion}`
          : `端口 ${port} 上的服务不是 ${PLUGIN_NAME}（plugin=${String(body && body.plugin) || '?'}）`,
    }
  } catch (err) {
    return { ok: false, pluginMatches: false, port, host, reason: String((err && err.message) || err), versionMatches: false }
  }
}

// 健康等待 + 重试：宿主冷启动可能还在 require 大量模块，单次探测容易误判。
export async function waitForHealth(opts = {}) {
  const deadline = Date.now() + (Number(opts.timeoutMs) || 8000)
  const interval = Number(opts.intervalMs) || 250
  let last = null
  do {
    last = await probeHealth(opts)
    if (last.ok) return last
    await sleep(interval)
  } while (Date.now() < deadline)
  return last
}

// 启动宿主。调用方必须已持有启动锁并传 locked:true，或使用 ensureHostLocked。
// 已健康（同 plugin + 同版本）则复用；端口上是别的东西/旧版本则报错，绝不抢。
export async function ensureHostLocked(opts = {}) {
  const port = Number(opts.port || process.env.ZCODE_WHALE_PORT || DEFAULT_PORT)
  const host = opts.host || process.env.ZCODE_WHALE_HOST || DEFAULT_HOST
  const existing = await probeHealth({ host, port })
  if (existing.ok) return { running: true, reused: true, port, host, payload: existing.payload }
  // 有响应但不是我们（别的插件 / 旧版本）：不抢端口、不杀进程，把原因报上去
  if (existing.payload || existing.status) {
    return { running: false, port, host, error: existing.reason || '端口上的服务不匹配' }
  }

  ensureDataDir()
  const serverPath = path.join(prepareRuntimeSnapshot(), 'lib', 'server.mjs')
  const out = fs.openSync(path.join(DATA_DIR, 'host.log'), 'a')
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: { ...process.env, ZCODE_WHALE_HOST: host, ZCODE_WHALE_PORT: String(port) },
  })
  let spawnError = null
  child.on('error', (err) => { spawnError = err })
  child.unref()
  try { fs.closeSync(out) } catch (err) {}

  const health = await waitForHealth({ host, port, timeoutMs: opts.timeoutMs || 8000 })
  if (spawnError) {
    return { running: false, port, host, error: '宿主启动失败: ' + String(spawnError.message || spawnError) }
  }
  // 端口可能被别的进程抢先 bind：必须确认健康响应真的是我们的
  if (!health.ok) {
    return { running: false, port, host, error: '宿主健康检查失败: ' + String(health.reason || 'timeout'), pid: child.pid }
  }
  return { running: true, reused: false, port, host, pid: child.pid, payload: health.payload }
}

// 无锁调用入口：自己取锁。已被锁保护的路径（startOverlay）必须直接调
// ensureHostLocked，否则同一进程内会二次取锁 → 自锁超时。
export async function ensureHost(opts = {}) {
  if (opts.locked) return ensureHostLocked(opts)
  const lock = await withStartLock(() => ensureHostLocked(opts), opts)
  if (!lock.ok) return { running: false, port: Number(opts.port || DEFAULT_PORT), host: opts.host || DEFAULT_HOST, error: lock.error }
  return lock.result
}

// ---------- 单实例判定（命令行亲缘） ----------
export function isOwnOverlayCommandLine(commandLine, markerDir = OVERLAY_MARKER_DIR) {
  const cl = String(commandLine || '')
  const dir = String(markerDir || '')
  if (!cl || !dir) return false
  if (process.platform === 'win32') {
    const norm = (s) => s.toLowerCase().replace(/\//g, '\\')
    return norm(cl).indexOf(norm(dir)) !== -1
  }
  return cl.indexOf(dir) !== -1
}

export function listOverlayPids() {
  const pids = []
  try {
    if (process.platform === 'win32') {
      const r = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | " +
            "Where-Object { $_.CommandLine -and $_.CommandLine -notlike '*--type=*' } | " +
            'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 }
      )
      let rows = []
      try {
        const parsed = JSON.parse(String((r && r.stdout) || '') || '{}')
        rows = Array.isArray(parsed) ? parsed : parsed && parsed.ProcessId ? [parsed] : []
      } catch (err) {
        rows = [] // 枚举失败：宁可不识别，也不盲杀
      }
      for (const row of rows) {
        const n = Number(row && row.ProcessId)
        if (Number.isInteger(n) && n > 0 && isOwnOverlayCommandLine(row.CommandLine) && pids.indexOf(n) === -1) pids.push(n)
      }
    } else {
      const r = spawnSync('pgrep', ['-f', OVERLAY_MARKER_DIR], { encoding: 'utf8', timeout: 8000 })
      for (const line of String((r && r.stdout) || '').split(/\r?\n/)) {
        const n = Number(line.trim())
        if (Number.isInteger(n) && n > 0 && n !== process.pid && pids.indexOf(n) === -1) pids.push(n)
      }
    }
  } catch (err) {}
  return pids
}

function readOverlayInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(OVERLAY_INFO_FILE, 'utf8'))
    if (info && typeof info.pid === 'number') return info
  } catch (err) {}
  return null
}

function writeOverlayInfo(info) {
  try {
    ensureDataDir()
    fs.writeFileSync(OVERLAY_INFO_FILE, JSON.stringify(info, null, 2), 'utf8')
  } catch (err) {}
}

function clearOverlayInfo() {
  try { fs.unlinkSync(OVERLAY_INFO_FILE) } catch (err) {}
}

// 只杀本插件自己的浮层进程树（Electron 会派生渲染/GPU 子进程）。
// 调用前必须已经用 isOwnOverlayCommandLine / overlay.json 确认过亲缘。
function killOwnPidTree(pid) {
  try { fs.appendFileSync(OVERLAY_LOG_FILE, new Date().toISOString() + ' manager-stop pid=' + pid + '\n') } catch (err) {}
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 8000 })
      if (result.error || result.status !== 0) return false
    } else {
      process.kill(pid)
    }
    return true
  } catch (err) {
    return false
  }
}

// ---------- 状态 / 启动 / 停止 ----------
export async function overlayStatus(opts = {}) {
  const port = Number(opts.port || process.env.ZCODE_WHALE_PORT || DEFAULT_PORT)
  const info = readOverlayInfo()
  const ownPids = listOverlayPids()
  let pid = info && isProcessAlive(info.pid) && ownPids.indexOf(info.pid) !== -1 ? info.pid : null
  // overlay.json 丢了但进程还在（例如被别的副本启动）：按命令行亲缘认领
  if (!pid && ownPids.length) pid = ownPids[ownPids.length - 1]
  if (info && !pid) clearOverlayInfo()
  const health = await probeHealth({ host: opts.host || process.env.ZCODE_WHALE_HOST || DEFAULT_HOST, port })
  let windowState = null
  try { windowState = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'overlay-window-state.json'), 'utf8')) } catch (err) {}
  const diagnosis = !pid ? 'process-exited-or-not-started'
    : !windowState || windowState.pid !== pid ? 'window-state-unavailable'
      : Date.now() - Date.parse(windowState.at) > 20000 ? 'window-state-stale'
        : !windowState.window ? 'window-destroyed'
          : windowState.window.offscreen ? 'offscreen'
            : windowState.window.shown ? 'shown' : 'hidden:' + windowState.reason
  return {
    running: !!pid,
    diagnosis,
    windowState,
    enabled: overlayEnabled(),
    pid,
    pids: ownPids,
    port,
    host: opts.host || process.env.ZCODE_WHALE_HOST || DEFAULT_HOST,
    url: `${localUrl(opts.host || process.env.ZCODE_WHALE_HOST || DEFAULT_HOST, port)}/`,
    startedAt: info && pid ? info.startedAt || null : null,
    installed: isRuntimeInstalled(),
    runtime: runtimeInfo(),
    hostHealth: health.ok ? { ok: true, version: health.payload && health.payload.version, routes: health.payload && health.payload.routes } : { ok: false, reason: health.reason },
    version: pluginVersion(),
  }
}

function overlaySpawnEnv(port) {
  const env = { ...process.env }
  // 宿主把 Electron 当 node 用时会给子进程注入 ELECTRON_RUN_AS_NODE=1，
  // 浮层是真正的 GUI，继承该变量会以 node 模式启动并立刻退出。
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return {
    ...env,
    DEEPSEEK_WHALE_PORT: String(port),
    DEEPSEEK_WHALE_DATA_DIR: DATA_DIR,
    DEEPSEEK_WHALE_TARGET_PROCESS: process.env.DEEPSEEK_WHALE_TARGET_PROCESS || 'ZCode',
    DEEPSEEK_WHALE_FOLLOW_INTERVAL_MS: String(process.env.DEEPSEEK_WHALE_FOLLOW_INTERVAL_MS || 40),
    DEEPSEEK_WHALE_MARGIN: String(process.env.DEEPSEEK_WHALE_MARGIN || 0),
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  }
}

export async function waitOverlayExit(ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const live = listOverlayPids().filter((pid) => isProcessAlive(pid))
    if (!live.length) return true
    if (Date.now() >= deadline) return false
    await sleep(100)
  }
}

// 已有实例时的复用判定（纯函数，便于单测）。
// 规则：端口/版本必须与请求一致且宿主健康才 reuse；否则明确失败，
// 不重写记录、不杀进程。
export function evaluateExistingOverlay({ known, pid, port, version, health }) {
  const ownerPort = Number(known && known.port) || null
  const ownerVersion = known && known.version ? String(known.version) : null
  const ownerHost = known && known.host ? String(known.host) : null

  if (ownerPort !== null && ownerPort !== port) {
    return {
      reuse: false,
      error: `已有浮层实例运行在端口 ${ownerPort}（pid ${pid}），与请求的端口 ${port} 不一致；未复用也未改动该实例`,
    }
  }
  if (ownerVersion !== null && ownerVersion !== version) {
    return {
      reuse: false,
      error: `已有浮层实例版本 ${ownerVersion}，与当前插件 ${version} 不一致；未复用也未改动该实例`,
    }
  }
  if (!health || !health.ok) {
    return {
      reuse: false,
      error: `已有浮层实例（pid ${pid}）但端口 ${ownerPort || port} 宿主不健康: ${(health && health.reason) || '未知'}`,
    }
  }
  return { reuse: true, port: ownerPort || port, host: ownerHost }
}

// startOverlay：幂等。
export async function startOverlay(opts = {}) {
  const port = Number(opts.port || process.env.ZCODE_WHALE_PORT || DEFAULT_PORT)
  const host = opts.host || process.env.ZCODE_WHALE_HOST || DEFAULT_HOST
  const version = pluginVersion()

  const lock = await withStartLock(async () => {
    if (opts.automatic && !overlayEnabled()) return { running: false, skipped: true, reason: 'user disabled' }
    if (!opts.automatic) setOverlayEnabled(true)
    const live = listOverlayPids().filter((pid) => isProcessAlive(pid))
    if (live.length) {
      const info = readOverlayInfo()
      const known = info && live.indexOf(info.pid) !== -1 ? info : null
      const pid = known ? known.pid : live[live.length - 1]
      let health = await probeHealth({
        host: (known && known.host) || host,
        port: Number(known && known.port) || port,
      })
      if (!health.ok && !health.payload && !health.status && (!known || known.version === version) && (!known || Number(known.port) === port)) {
        await ensureHostLocked({ host, port, timeoutMs: opts.hostTimeoutMs || 8000 })
        health = await probeHealth({ host, port })
      }
      const verdict = evaluateExistingOverlay({ known, pid, port, version, health })
      if (!verdict.reuse) {
        return { running: false, started: false, pid, error: verdict.error }
      }
      if (!known) {
        // 记录丢失但进程确实是我们的：补记录（端口/版本已核对）
        writeOverlayInfo({
          pid,
          port: verdict.port,
          host: verdict.host || host,
          version,
          startedAt: new Date().toISOString(),
        })
      }
      return { running: true, started: false, reused: true, pid, port: verdict.port, deduped: 0 }
    }

    if (!isRuntimeInstalled()) {
      return {
        running: false,
        started: false,
        installed: false,
        error: '尚未安装 Electron 运行时',
        hint: '用 ZCode.exe 运行 node lib/overlay-cli.mjs setup；首次安装会从 Electron 官方 GitHub 下载匹配运行时',
      }
    }

    // 已持锁：直接调无锁版本，避免嵌套取锁
    const hostState = await ensureHostLocked({ host, port, timeoutMs: opts.hostTimeoutMs || 8000 })
    if (!hostState.running) {
      const stale = /本插件是/.test(String(hostState.error || ''))
      return {
        running: false,
        started: false,
        error: 'HTTP 宿主未就绪: ' + String(hostState.error || '未知原因'),
        hint: stale
          ? `端口 ${port} 上跑的是旧版本实例（多半来自旧插件副本）。请先重启 ZCode，或确认该实例属于本插件后手动结束它；本插件不会自动杀端口上的进程。`
          : null,
        host: hostState,
      }
    }

    const exe = resolveElectronExe()
    if (!exe) {
      return { running: false, started: false, installed: false, error: 'Electron 运行时缺少可执行体，请重跑 node lib/overlay-cli.mjs setup --force' }
    }

    // 旧实例可能还在释放 profile / GPU 文件锁
    await waitOverlayExit(3000)

    if (opts.automatic && !overlayEnabled()) return { running: false, skipped: true, reason: 'user disabled during startup' }
    let spawnError = null
    const child = spawn(exe, ['--user-data-dir=' + overlayProfileDir(port), path.join(prepareRuntimeSnapshot(), 'desktop')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: overlaySpawnEnv(port),
    })
    child.on('error', (err) => { spawnError = err })
    child.unref()

    writeOverlayInfo({ pid: child.pid, port, host, version: pluginVersion(), startedAt: new Date().toISOString() })

    // 健康等待 + 重试：Electron 冷启动（GPU 进程、透明窗合成）通常 1-3 秒。
    const deadline = Date.now() + (Number(opts.settleMs) || 6000)
    let alive = true
    while (Date.now() < deadline) {
      await sleep(250)
      if (spawnError) break
      alive = isProcessAlive(child.pid)
      if (alive) {
        // 进程活着且是我们的浮层命令行 → 认为启动成功
        const own = listOverlayPids()
        if (own.indexOf(child.pid) !== -1) break
      } else {
        break
      }
    }

    if (spawnError) {
      clearOverlayInfo()
      return { running: false, started: false, error: '浮层进程启动失败: ' + String(spawnError.message || spawnError) }
    }
    if (!isProcessAlive(child.pid)) {
      clearOverlayInfo()
      return { running: false, started: false, error: '浮层进程启动后立即退出（' + OVERLAY_LOG_FILE + ' 有日志）' }
    }
    return { running: true, started: true, pid: child.pid, port, host, hostReused: !!hostState.reused }
  }, { ...opts, waitMs: Math.max(Number(opts.waitMs) || 0, 25000) })

  // 启动锁获取失败（另一流程正在启动）时报出锁的原因，而不是返回 undefined
  if (!lock.ok) return { running: false, started: false, error: lock.error }
  return lock.result
}

export async function stopOverlay(opts = {}) {
  if (!opts._locked) {
    const locked = await withStartLock(() => stopOverlay({ ...opts, _locked: true }), { ...opts, waitMs: Math.max(Number(opts.waitMs) || 0, 10000) })
    if (!locked.ok) return { ok: false, error: locked.error }
    return locked.result
  }
  if (!opts.automatic) setOverlayEnabled(false)
  const info = readOverlayInfo()
  const pids = listOverlayPids().filter((pid) => isProcessAlive(pid))
  // overlay.json 里记录但命令行枚举没认出来的 pid：只在它确实是 electron 时
  // 才收（pid 复用会指向无关进程）。
  if (info && isProcessAlive(info.pid) && pids.indexOf(info.pid) === -1) {
    const cmd = readCommandLine(info.pid)
    if (cmd && isOwnOverlayCommandLine(cmd)) pids.push(info.pid)
  }
  if (!pids.length) {
    clearOverlayInfo()
    return { ok: false, error: '浮层未在运行' }
  }
  let killed = 0
  for (const pid of pids) if (killOwnPidTree(pid)) killed++
  // 等进程真的退出再返回：紧接着 start 会撞上未释放的 profile/GPU 锁
  const exited = await waitOverlayExit(3000)
  if (!exited) return { ok: false, killed, error: '浮层进程尚未退出，保留状态记录' }
  clearOverlayInfo()
  return killed ? { ok: true, killed } : { ok: false, error: '未能结束浮层进程' }
}

function readCommandLine(pid) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      )
      return String((r && r.stdout) || '').trim() || null
    }
    return null
  } catch (err) {
    return null
  }
}

// 停宿主：只通过 host.json 里的令牌请求 /shutdown（本机读文件才能拿到令牌）。
// 不按 pid 泛杀 —— 端口上可能是别人的服务。
export async function stopHost(opts = {}) {
  const host = opts.host || process.env.ZCODE_WHALE_HOST || DEFAULT_HOST
  const port = Number(opts.port || process.env.ZCODE_WHALE_PORT || DEFAULT_PORT)
  let info = null
  try {
    info = JSON.parse(fs.readFileSync(HOST_INFO_FILE, 'utf8'))
  } catch (err) {}
  if (!info || !info.token) return { ok: false, error: '没有 host.json（宿主不是本插件启动的）' }
  if (Number(info.port) !== port) return { ok: false, error: `host.json 端口 ${info.port} 与目标端口 ${port} 不一致` }
  try {
    const res = await fetch(`${localUrl(host, port)}/shutdown`, {
      method: 'POST',
      headers: { 'x-whale-token': String(info.token) },
      signal: AbortSignal.timeout(2500),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body.ok !== true) return { ok: false, error: '宿主拒绝了关停请求（token 不匹配）' }
    return { ok: true, pid: info.pid }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

// 会话结束清理。关键取舍：**只有当 ZCode 主进程已经不在了才清理**。
// 一个会话结束不代表用户关闭了 ZCode —— 同一台机器上常有多个会话/多个 MCP
// 连接共用同一个浮层实例，按 SessionEnd 无脑停会让其他会话的鲸鱼消失。
// 真正的「主窗退出」由跟随脚本上报 gone → 浮层自己退出（见 desktop/main.cjs），
// 这里负责同一时刻把本插件自己的宿主也收掉。
export async function cleanupOnSessionEnd() {
  const status = await overlayStatus()
  if (zcodeProcessRunning()) {
    return {
      ok: true,
      stopped: false,
      reason: status.running ? 'ZCode 仍在运行，保留浮层与宿主供其他会话使用' : 'ZCode 仍在运行，无需清理',
    }
  }
  const overlay = status.running ? await stopOverlay({ automatic: true }) : { ok: true, stopped: false }
  const host = await stopHost()
  return { ok: true, overlay, host }
}

// ZCode 主进程是否还在（只按进程名判断，不按窗口标题，也不做任何操作）
export function zcodeProcessRunning() {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', "Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id; exit 0"],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 }
      )
      if (r.error || r.status !== 0) return true
      return Number(String((r && r.stdout) || '').trim()) > 0
    }
    const r = spawnSync('pgrep', ['-x', 'ZCode'], { encoding: 'utf8', timeout: 5000 })
    if (r.error || (r.status !== 0 && r.status !== 1)) return true
    return Number(String((r && r.stdout) || '').trim().split(/\r?\n/)[0]) > 0
  } catch (err) {
    // 判断不了时保守保留浮层（宁可多留一个正被使用的实例，也不误杀）
    return true
  }
}

// 数据/运行时目录的稳定标识（给日志/诊断用，不含任何凭据）
export function productFingerprint() {
  return createHash('sha256').update(PLUGIN_NAME + '|' + DATA_DIR).digest('hex').slice(0, 12)
}
