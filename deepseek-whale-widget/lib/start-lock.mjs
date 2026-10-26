// 跨进程启动锁。
//
// 约束：
//   - 用 `wx` 原子创建锁文件，绝不 writeFileSync 覆盖（覆盖会让两个进程同时进入临界区）。
//   - 只有「持有者进程已死」才可回收；活着的持有者即使锁很旧也不抢。
//   - 回收用 rename 抢占（原子），rename 后再校验内容，避免误删别人刚建的锁。
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { START_LOCK_FILE, ensureDataDir } from './paths.mjs'

// 仅用于「读不出 pid」的孤儿锁（open 成功但写内容前崩溃）：正常锁永远不看时间。
const ORPHAN_MAX_AGE_MS = 5000
const RETRY_MS = 120

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

// 返回 { owner } | { invalid: true } | null（文件不存在）
function readOwner(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed && Number.isInteger(Number(parsed.pid)) && Number(parsed.pid) > 0) {
      return { owner: { pid: Number(parsed.pid), token: String(parsed.token || ''), at: Number(parsed.at) || 0 } }
    }
  } catch (err) {}
  return { invalid: true, mtimeMs: statMtime(file) }
}

function statMtime(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch (err) {
    return 0
  }
}

function inspect(file) {
  const info = readOwner(file)
  if (!info) return { kind: 'free' }
  if (info.invalid) {
    // 有文件但读不出持有者：只可能是「刚创建还没写内容」或「写一半崩溃」。
    // 新创建的情况由 mtime 兜住（几毫秒内不会超过 ORPHAN_MAX_AGE_MS）。
    return Date.now() - (info.mtimeMs || 0) > ORPHAN_MAX_AGE_MS ? { kind: 'stale' } : { kind: 'held' }
  }
  if (isAlive(info.owner.pid)) return { kind: 'held', owner: info.owner }
  return { kind: 'stale', owner: info.owner }
}

function tryCreate(token) {
  let fd
  try {
    fd = fs.openSync(START_LOCK_FILE, 'wx')
  } catch (err) {
    if (err.code === 'EEXIST') return false
    throw err
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }))
  } finally {
    try {
      fs.closeSync(fd)
    } catch (err) {}
  }
  return true
}

// 回收一个判定为 stale 的锁。rename 保证只有一个竞争者能搬走它；搬走后再核对
// 内容是否仍是我们判定的那一个，不是就尽量放回去。
function reclaim(token, expected) {
  const moved = `${START_LOCK_FILE}.stale-${token}`
  try {
    fs.renameSync(START_LOCK_FILE, moved)
  } catch (err) {
    return false // 已被别人搬走 / 已释放
  }
  const info = readOwner(moved)
  const sameOwner = expected && info && info.owner && info.owner.token === expected.token
  const expectedInvalid = expected === null && info && info.invalid
  if (!sameOwner && !expectedInvalid) {
    // 误搬了别人刚建的新锁：放回去（路径空着时），失败就丢弃，让原持有者超时重试
    try {
      fs.renameSync(moved, START_LOCK_FILE)
    } catch (err) {
      try {
        fs.rmSync(moved, { force: true })
      } catch (e) {}
    }
    return false
  }
  try {
    fs.rmSync(moved, { force: true })
  } catch (err) {}
  return true
}

function release(token) {
  const info = readOwner(START_LOCK_FILE)
  if (!info || !info.owner || info.owner.token !== token) return
  try {
    fs.unlinkSync(START_LOCK_FILE)
  } catch (err) {}
}

export async function withStartLock(fn, opts = {}) {
  ensureDataDir()
  const waitMs = Number(opts.waitMs) || 12000
  const deadline = Date.now() + waitMs
  const token = randomBytes(8).toString('hex')

  for (;;) {
    if (tryCreate(token)) break
    const state = inspect(START_LOCK_FILE)
    if (state.kind === 'stale') {
      reclaim(token, state.kind === 'stale' && state.owner ? state.owner : null)
      continue
    }
    if (Date.now() >= deadline) {
      const holder = state.owner ? ` pid=${state.owner.pid}` : ''
      return { ok: false, error: `另一个启动流程持有锁（${START_LOCK_FILE}${holder}）` }
    }
    await sleep(RETRY_MS)
  }

  try {
    return { ok: true, result: await fn() }
  } finally {
    release(token)
  }
}
