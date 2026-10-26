// 原生接管只能在调用成功后记账；渲染断流时租约到期必须恢复穿透。
const LEASE_MS = 1500
const REASSERT_MS = 1000
const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 2000

function createInteractionGuard() {
  let desired = false
  let applied = false
  let verified = false
  let leaseUntil = 0
  let appliedAt = 0
  let retryAt = 0
  let failures = 0

  function tick(now) {
    let reason = ''
    if (desired && now >= leaseUntil) {
      desired = false
      leaseUntil = 0
      retryAt = 0
      reason = 'lease-expired'
    }
    if (now < retryAt) return { action: 'skip' }
    if (desired !== applied) reason = reason || 'mismatch'
    else if (!verified) reason = 'unverified'
    else if (now - appliedAt >= REASSERT_MS) reason = 'reassert'
    else return { action: 'skip' }
    return { action: 'apply', want: desired, reason }
  }

  function force(now) {
    tick(now)
    return { action: 'apply', want: desired, reason: 'forced' }
  }

  function request(want, now) {
    if (!!want !== desired) retryAt = 0
    desired = !!want
    leaseUntil = desired ? now + LEASE_MS : 0
    return tick(now)
  }

  function noteApplied(want, ok, now) {
    verified = ok
    if (ok) {
      applied = !!want
      appliedAt = now
      retryAt = 0
      failures = 0
    } else {
      failures++
      retryAt = now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * Math.pow(2, Math.min(failures - 1, 8)))
    }
  }

  function reset() {
    desired = false
    leaseUntil = 0
    verified = false
    retryAt = 0
  }

  function snapshot() {
    return { desired, applied, verified, leaseUntil, appliedAt, retryAt, failures }
  }

  return { tick, force, request, noteApplied, reset, snapshot }
}

module.exports = { createInteractionGuard, LEASE_MS, REASSERT_MS, RETRY_BASE_MS, RETRY_MAX_MS }
