// Electron 运行时安装/下载测试（全程离线，用注入的 fetchImpl 与本地小 zip）。
//
// 关注点：
//   - downloadElectronZip 走官方 GitHub URL，并以 SHASUMS256.txt 校验 SHA-256；
//   - 清单缺失/哈希不符/HTTP 失败/中途失败都要报错且不留下半截文件；
//   - 缓存命中前必须重新校验，脏缓存会被丢弃重下；
//   - 显式 zip 是用户信任输入，但文件名必须匹配目标版本/架构，不匹配绝不静默联网；
//   - setup 幂等，且任何失败都不破坏已存在的旧 runtime；
//   - 提交后（rename 成功）再出错也必须删掉新 target 并恢复备份，没有备份时也要清干净；
//   - 解压缺 tar 时回退 PowerShell，且路径含单引号仍能正确转义。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const TEMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-install-'))
process.env.DEEPSEEK_WHALE_DATA_DIR = TEMP_DATA
delete process.env.DEEPSEEK_WHALE_ELECTRON_ZIP
delete process.env.DEEPSEEK_WHALE_ELECTRON_VERSION

const manager = await import('../lib/overlay-manager.mjs')
const paths = await import('../lib/paths.mjs')

const VERSION = '30.0.0'
const SENTINELS = ['icudtl.dat', 'v8_context_snapshot.bin']
const CAN_DOWNLOAD = process.platform === 'win32' && process.arch === 'x64'
const ARCH = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch
const OTHER_ARCH = ARCH === 'arm64' ? 'x64' : 'arm64'
const PLATFORM = process.platform === 'win32' ? 'win32' : process.platform
const ZIP_NAME = `electron-v${VERSION}-${PLATFORM}-${ARCH}.zip`

const work = path.join(TEMP_DATA, 'fixtures')
fs.mkdirSync(work, { recursive: true })

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

// 用 PowerShell 造一个合法小 zip（内容只需含哨兵与可执行体，不需要真 Electron）
function makeZip(dirName, contents, zipPath) {
  const src = path.join(work, dirName)
  fs.mkdirSync(src, { recursive: true })
  fs.mkdirSync(path.dirname(zipPath), { recursive: true })
  for (const [name, body] of Object.entries(contents)) {
    fs.writeFileSync(path.join(src, name), body)
  }
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Compress-Archive -Path ${psQuote(path.join(src, '*'))} -DestinationPath ${psQuote(zipPath)} -Force`],
    { windowsHide: true, encoding: 'utf8' }
  )
  assert.equal(r.status, 0, 'Compress-Archive 失败: ' + String(r.stderr || r.stdout))
  return zipPath
}

const fullContents = { 'electron.exe': 'exe', 'icudtl.dat': 'icu', 'v8_context_snapshot.bin': 'v8', 'resources.pak': 'pak' }
const goodZip = makeZip('good', fullContents, path.join(work, ZIP_NAME))
const badZip = makeZip('bad-name', fullContents, path.join(work, 'wrong-name.zip'))
// 文件名必须匹配目标版本/架构，否则 setup 会在 zip 校验阶段就拒绝
const missingSentinelZip = makeZip('missing', { 'electron.exe': 'exe' }, path.join(work, 'nopartial', ZIP_NAME))
// 内容可区分的「升级包」：用来验证失败回滚后留下的是旧运行时而不是新的
const upgradeZip = makeZip('upgrade', { ...fullContents, 'electron.exe': 'new-exe' }, path.join(work, 'upgrade', ZIP_NAME))

const RUNTIME_DIR = paths.RUNTIME_DIR
const targetPkgDir = path.join(RUNTIME_DIR, 'node_modules', 'electron')
const runtimePkgJson = path.join(RUNTIME_DIR, 'package.json')

// 故障注入：让 RUNTIME_DIR/package.json 变成目录 → 提交后写它必然 EISDIR
function placePackageJsonAsDir() {
  fs.rmSync(runtimePkgJson, { recursive: true, force: true })
  fs.mkdirSync(runtimePkgJson, { recursive: true })
}

function leftovers(prefix) {
  try {
    return fs.readdirSync(RUNTIME_DIR).filter((n) => n.startsWith(prefix))
  } catch (err) {
    return []
  }
}

// 让 tar 不可用（换成 where.exe 的副本：参数未知，必定非 0 退出），
// 从而逼 unzip 走 PowerShell 回退分支。
function makeFakeTar() {
  const fakeBin = path.join(TEMP_DATA, 'fakebin-tar')
  fs.mkdirSync(fakeBin, { recursive: true })
  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe'), path.join(fakeBin, 'tar.exe'))
  return fakeBin
}

async function withBrokenTar(fn) {
  const fakeBin = makeFakeTar()
  const originalPath = process.env.PATH
  process.env.PATH = fakeBin + path.delimiter + originalPath
  try {
    const probe = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true })
    assert.notEqual(probe.status, 0, '伪装 tar 未生效（仍能运行），无法验证 PowerShell 回退')
    return await fn()
  } finally {
    process.env.PATH = originalPath
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function bytesResponse(buf, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return Buffer.from(buf).toString('utf8') },
    body: (async function* () { yield Buffer.from(buf) })(),
  }
}

function shasumsResponse(filename, hash) {
  return {
    ok: true,
    status: 200,
    async text() { return `${hash}  ${filename}\n${'0'.repeat(64)}  some-other.zip\n` },
  }
}

function newCacheDir(tag) {
  return path.join(TEMP_DATA, 'cache-' + tag + '-' + Date.now())
}

function partFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.includes('.part-'))
  } catch (err) {
    return []
  }
}

test('detectTargetElectronVersion never guesses from caches (env -> host -> null)', () => {
  const env = process.env.DEEPSEEK_WHALE_ELECTRON_VERSION
  delete process.env.DEEPSEEK_WHALE_ELECTRON_VERSION
  try {
    assert.equal(manager.detectTargetElectronVersion(), process.versions.electron || null)
  } finally {
    if (env === undefined) delete process.env.DEEPSEEK_WHALE_ELECTRON_VERSION
    else process.env.DEEPSEEK_WHALE_ELECTRON_VERSION = env
  }
  process.env.DEEPSEEK_WHALE_ELECTRON_VERSION = '31.2.3'
  try {
    assert.equal(manager.detectTargetElectronVersion(), '31.2.3')
  } finally {
    delete process.env.DEEPSEEK_WHALE_ELECTRON_VERSION
  }
})

test('downloadElectronZip uses official URL and verifies SHA-256', { skip: !CAN_DOWNLOAD }, async () => {
  const payload = Buffer.from('fake electron archive bytes')
  const payloadHash = sha256(payload)
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(String(url))
    if (String(url).endsWith('/SHASUMS256.txt')) return shasumsResponse(ZIP_NAME, payloadHash)
    return bytesResponse(payload)
  }
  const cacheDir = newCacheDir('ok')
  const zip = await manager.downloadElectronZip(VERSION, { fetchImpl, cacheDir, timeoutMs: 5000 })
  assert.equal(zip, path.join(cacheDir, ZIP_NAME))
  assert.equal(fs.readFileSync(zip).toString('utf8'), payload.toString('utf8'))
  assert.equal(urls[0], `https://github.com/electron/electron/releases/download/v${VERSION}/SHASUMS256.txt`)
  assert.equal(urls[1], `https://github.com/electron/electron/releases/download/v${VERSION}/${ZIP_NAME}`)
})

test('downloadElectronZip rejects invalid version and non-Windows-x64 defaults', async () => {
  await assert.rejects(() => manager.downloadElectronZip('30', { fetchImpl: async () => { throw new Error('不应联网') } }), /版本号无效/)
  await assert.rejects(() => manager.downloadElectronZip('', { fetchImpl: async () => { throw new Error('不应联网') } }), /版本号无效/)
})

test('downloadElectronZip fails when SHASUMS256 lacks the target file', { skip: !CAN_DOWNLOAD }, async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/SHASUMS256.txt')) {
      return { ok: true, status: 200, async text() { return `${'a'.repeat(64)}  electron-v${VERSION}-linux-x64.zip\n` } }
    }
    return bytesResponse(Buffer.from('x'))
  }
  await assert.rejects(() => manager.downloadElectronZip(VERSION, { fetchImpl, cacheDir: newCacheDir('nosums') }), /没有 .*\.zip/)
})

test('downloadElectronZip fails on SHASUMS HTTP error', { skip: !CAN_DOWNLOAD }, async () => {
  const fetchImpl = async () => ({ ok: false, status: 404, async text() { return 'not found' } })
  await assert.rejects(() => manager.downloadElectronZip(VERSION, { fetchImpl, cacheDir: newCacheDir('sums404') }), /HTTP 404/)
})

test('downloadElectronZip fails on archive HTTP error without leaving files', { skip: !CAN_DOWNLOAD }, async () => {
  const cacheDir = newCacheDir('arc404')
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/SHASUMS256.txt')) return shasumsResponse(ZIP_NAME, 'a'.repeat(64))
    return { ok: false, status: 502, async text() { return 'bad gateway' }, body: null }
  }
  await assert.rejects(() => manager.downloadElectronZip(VERSION, { fetchImpl, cacheDir }), /HTTP 502/)
  assert.deepEqual(partFiles(cacheDir), [])
  assert.equal(fs.existsSync(path.join(cacheDir, ZIP_NAME)), false)
})

test('downloadElectronZip rejects wrong SHA-256 and cleans the partial file', { skip: !CAN_DOWNLOAD }, async () => {
  const cacheDir = newCacheDir('badsha')
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/SHASUMS256.txt')) return shasumsResponse(ZIP_NAME, 'b'.repeat(64))
    return bytesResponse(Buffer.from('tampered payload'))
  }
  await assert.rejects(() => manager.downloadElectronZip(VERSION, { fetchImpl, cacheDir }), /SHA-256 校验失败/)
  assert.deepEqual(partFiles(cacheDir), [])
  assert.equal(fs.existsSync(path.join(cacheDir, ZIP_NAME)), false)
})

test('downloadElectronZip cleans up when the stream dies midway', { skip: !CAN_DOWNLOAD }, async () => {
  const payload = Buffer.from('first-chunk')
  const cacheDir = newCacheDir('streamfail')
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/SHASUMS256.txt')) return shasumsResponse(ZIP_NAME, sha256(payload))
    return {
      ok: true,
      status: 200,
      async text() { return '' },
      body: (async function* () { yield payload; throw new Error('连接中断') })(),
    }
  }
  await assert.rejects(() => manager.downloadElectronZip(VERSION, { fetchImpl, cacheDir }), /连接中断/)
  assert.deepEqual(partFiles(cacheDir), [])
  assert.equal(fs.existsSync(path.join(cacheDir, ZIP_NAME)), false)
})

test('downloadElectronZip re-validates cached archives instead of trusting them', { skip: !CAN_DOWNLOAD }, async () => {
  const payload = Buffer.from('real archive payload')
  const hash = sha256(payload)
  const cacheDir = newCacheDir('cache')
  let archiveHits = 0
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/SHASUMS256.txt')) return shasumsResponse(ZIP_NAME, hash)
    archiveHits++
    return bytesResponse(payload)
  }

  // 先放一个损坏的缓存：必须被丢弃并重新下载
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(path.join(cacheDir, ZIP_NAME), 'corrupt cached archive')
  const first = await manager.downloadElectronZip(VERSION, { fetchImpl, cacheDir })
  assert.equal(archiveHits, 1)
  assert.equal(sha256(fs.readFileSync(first)), hash)

  // 缓存内容正确：只校验，不再下载
  const second = await manager.downloadElectronZip(VERSION, { fetchImpl, cacheDir })
  assert.equal(second, first)
  assert.equal(archiveHits, 1)
})

test('explicit zip must match the target filename; mismatches never fall back to network', async () => {
  let downloadCalls = 0
  const downloadElectronZip = async () => {
    downloadCalls++
    throw new Error('不应下载')
  }

  const wrongName = await manager.setupRuntime({ version: VERSION, zip: badZip, downloadElectronZip })
  assert.equal(wrongName.ok, false)
  assert.equal(wrongName.step, 'zip')
  assert.match(String(wrongName.error), /不匹配/)

  const missing = await manager.setupRuntime({ version: VERSION, zip: path.join(work, 'nope', ZIP_NAME), downloadElectronZip })
  assert.equal(missing.ok, false)
  assert.equal(missing.step, 'zip')
  assert.match(String(missing.error), /不存在/)

  assert.equal(downloadCalls, 0)
  assert.equal(manager.isRuntimeInstalled(), false)
})

test('setup installs from an explicit zip and is idempotent', async () => {
  const res = await manager.setupRuntime({ version: VERSION, zip: goodZip })
  assert.equal(res.ok, true)
  assert.equal(res.installed, true)
  assert.equal(manager.isRuntimeInstalled(), true)
  assert.equal(manager.runtimeInfo().version, VERSION)
  for (const name of SENTINELS) {
    assert.ok(fs.existsSync(path.join(paths.OVERLAY_MARKER_DIR, name)))
  }
  assert.ok(fs.existsSync(path.join(paths.OVERLAY_MARKER_DIR, 'electron.exe')))

  const again = await manager.setupRuntime({ version: VERSION, zip: goodZip })
  assert.equal(again.ok, true)
  assert.equal(again.alreadyInstalled, true)
})

test('failed force reinstall keeps the previous runtime intact and cleans staging', async () => {
  const before = fs.readFileSync(path.join(paths.OVERLAY_MARKER_DIR, 'electron.exe'), 'utf8')
  assert.equal(before, 'exe')
  const runtimeDir = paths.RUNTIME_DIR

  const noSentinel = await manager.setupRuntime({ version: VERSION, zip: missingSentinelZip, force: true })
  assert.equal(noSentinel.ok, false)
  assert.equal(noSentinel.step, 'verify')
  assert.equal(manager.isRuntimeInstalled(), true)
  assert.equal(fs.readFileSync(path.join(paths.OVERLAY_MARKER_DIR, 'electron.exe'), 'utf8'), 'exe')
  assert.deepEqual(fs.readdirSync(runtimeDir).filter((n) => n.startsWith('.staging')), [])
  assert.deepEqual(fs.readdirSync(runtimeDir).filter((n) => n.startsWith('.backup-electron-')), [])
})

test('corrupted zip fails cleanly and leaves the installed runtime untouched', async () => {
  const corrupt = path.join(work, 'corrupt', ZIP_NAME)
  fs.mkdirSync(path.dirname(corrupt), { recursive: true })
  fs.writeFileSync(corrupt, 'this is not a zip at all')
  const res = await manager.setupRuntime({ version: VERSION, zip: corrupt, force: true })
  assert.equal(res.ok, false)
  assert.equal(res.step, 'unzip')
  assert.equal(manager.isRuntimeInstalled(), true)
  assert.deepEqual(fs.readdirSync(paths.RUNTIME_DIR).filter((n) => n.startsWith('.staging')), [])
})

test('setup injects its downloader and fails honestly when download throws', async () => {
  const fresh = path.join(TEMP_DATA, 'fresh-runtime-' + Date.now())
  const managerUrl = new URL('../lib/overlay-manager.mjs', import.meta.url).href
  const pathsUrl = new URL('../lib/paths.mjs', import.meta.url).href
  // 独立进程验证：空数据目录 + 注入下载器
  const script = `
    const fs = await import('node:fs')
    const path = await import('node:path')
    process.env.DEEPSEEK_WHALE_DATA_DIR = ${JSON.stringify(fresh)}
    const m = await import(${JSON.stringify(managerUrl)})
    const p = await import(${JSON.stringify(pathsUrl)})
    const downloadElectronZip = async () => ${JSON.stringify(goodZip)}
    const okRes = await m.setupRuntime({ version: ${JSON.stringify(VERSION)}, downloadElectronZip })
    const failRes = await m.setupRuntime({
      version: ${JSON.stringify(VERSION)},
      force: true,
      downloadElectronZip: async () => { throw new Error('模拟网络失败') },
    })
    const sentinels = ${JSON.stringify(SENTINELS)}.every((n) => fs.existsSync(path.join(p.OVERLAY_MARKER_DIR, n)))
    process.stdout.write(JSON.stringify({
      okRes: { ok: okRes.ok, installed: okRes.installed, version: okRes.version },
      failRes: { ok: failRes.ok, step: failRes.step, error: failRes.error },
      installedAfterFail: m.isRuntimeInstalled(),
      sentinels,
    }))
  `
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.okRes.ok, true)
  assert.equal(out.okRes.installed, true)
  assert.equal(out.okRes.version, VERSION)
  assert.equal(out.failRes.ok, false)
  assert.equal(out.failRes.step, 'download')
  assert.match(String(out.failRes.error), /模拟网络失败/)
  assert.equal(out.installedAfterFail, true)
  assert.equal(out.sentinels, true)
})

test('post-commit failure restores the backup and leaves no new runtime', async () => {
  const before = fs.readFileSync(path.join(paths.OVERLAY_MARKER_DIR, 'electron.exe'), 'utf8')
  assert.equal(before, 'exe')

  // 故障注入：RUNTIME_DIR/package.json 变成目录 → rename 提交成功后写它必然失败
  placePackageJsonAsDir()
  const res = await manager.setupRuntime({ version: VERSION, zip: upgradeZip, force: true })
  assert.equal(res.ok, false, '提交后失败必须报失败')
  assert.equal(res.step, 'setup')
  assert.match(String(res.error), /EISDIR|EPERM|EACCES|EBUSY|illegal operation/)
  // 旧运行时（内容 'exe'）必须原样回来，绝不能留下半装的新运行时（'new-exe'）
  assert.equal(manager.isRuntimeInstalled(), true)
  assert.equal(fs.readFileSync(path.join(paths.OVERLAY_MARKER_DIR, 'electron.exe'), 'utf8'), 'exe')
  assert.deepEqual(leftovers('.backup-electron-'), [])
  assert.deepEqual(leftovers('.staging'), [])

  // 清掉占位目录，重装一次让 runtime 回到完整状态
  fs.rmSync(runtimePkgJson, { recursive: true, force: true })
  const restored = await manager.setupRuntime({ version: VERSION, zip: goodZip, force: true })
  assert.equal(restored.ok, true)
  assert.equal(manager.runtimeInfo().version, VERSION)
})

test('post-commit failure without a previous runtime leaves no partial install', async () => {
  // 模拟「没有旧运行时可回滚」：直接删掉已装 target
  fs.rmSync(targetPkgDir, { recursive: true, force: true })
  assert.equal(manager.isRuntimeInstalled(), false)

  placePackageJsonAsDir()
  const res = await manager.setupRuntime({ version: VERSION, zip: goodZip })
  fs.rmSync(runtimePkgJson, { recursive: true, force: true })

  assert.equal(res.ok, false)
  assert.equal(res.step, 'setup')
  assert.match(String(res.error), /EISDIR|EPERM|EACCES|EBUSY|illegal operation/)
  // 没有旧运行时：新 target 必须被删掉，不能留半装
  assert.equal(fs.existsSync(targetPkgDir), false)
  assert.equal(manager.isRuntimeInstalled(), false)
  assert.deepEqual(leftovers('.backup-electron-'), [])
  assert.deepEqual(leftovers('.staging'), [])

  // 还原到一个可用状态供后续测试使用
  const restored = await manager.setupRuntime({ version: VERSION, zip: goodZip })
  assert.equal(restored.ok, true)
})

test('findCachedElectronZip matches version and arch exactly under custom roots', () => {
  const rootA = path.join(TEMP_DATA, 'cache-root-a')
  const rootB = path.join(TEMP_DATA, 'cache-root-b')
  const dirA = path.join(rootA, 'sha-a')
  const dirB = path.join(rootB, 'sha-b')
  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })
  const big = Buffer.alloc(1024 * 1024 + 16, 7)

  // 版本不符、架构不符、以及一个正确文件名但体积过小（未下载完）的残片
  fs.writeFileSync(path.join(dirA, `electron-v9.9.9-${PLATFORM}-${ARCH}.zip`), big)
  fs.writeFileSync(path.join(dirA, `electron-v${VERSION}-${PLATFORM}-${OTHER_ARCH}.zip`), big)
  fs.writeFileSync(path.join(dirA, ZIP_NAME), 'tiny')

  assert.equal(manager.findCachedElectronZip(VERSION, { roots: [rootA] }), null)

  const exact = path.join(dirB, ZIP_NAME)
  fs.writeFileSync(exact, big)
  fs.writeFileSync(path.join(dirB, `electron-v${VERSION}-${PLATFORM}-${ARCH}.txt`), big)

  const found = manager.findCachedElectronZip(VERSION, { roots: [rootA, rootB, path.join(TEMP_DATA, 'no-such-root')] })
  assert.equal(found, exact)
  assert.equal(manager.findCachedElectronZip('', { roots: [rootB] }), null)
})

test('unzip falls back to PowerShell when tar is unusable', { skip: process.platform !== 'win32' }, async () => {
  await withBrokenTar(async () => {
    const res = await manager.setupRuntime({ version: VERSION, zip: goodZip, force: true })
    assert.equal(res.ok, true, String(res.error))
    assert.equal(manager.isRuntimeInstalled(), true)
    assert.equal(fs.readFileSync(path.join(paths.OVERLAY_MARKER_DIR, 'electron.exe'), 'utf8'), 'exe')
  })
})

test('PowerShell fallback survives paths containing a single quote', { skip: process.platform !== 'win32' }, async () => {
  const quotedDir = path.join(work, "quo'te dir")
  const quotedZip = makeZip('quoted', fullContents, path.join(quotedDir, ZIP_NAME))
  await withBrokenTar(async () => {
    const res = await manager.setupRuntime({ version: VERSION, zip: quotedZip, force: true })
    assert.equal(res.ok, true, String(res.error))
    assert.equal(manager.isRuntimeInstalled(), true)
  })
})

test.after(() => {
  try {
    fs.rmSync(TEMP_DATA, { recursive: true, force: true })
  } catch (err) {}
})
