// 余额出口归一化（纯函数，便于单测）。
//
// 约束：totalBalance 只接受有限数值；null / 空串 / 非有限数一律报错，
// 绝不能经 Number() 变成 0（原前端会把它当成"余额见底"）。
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return null
    const n = Number(text)
    return Number.isFinite(n) ? n : null
  }
  // null / undefined / boolean / object 都不接受（Number(null) === 0 是主要陷阱）
  return null
}

const SHAPE_ERROR = '余额接口返回结构异常（totalBalance 为空或非数值）'

export function normalizeBalancePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'SHAPE', error: SHAPE_ERROR }
  }
  // 失败结果保留原始 code/error（调用方靠它区分"没配置 key"和"接口异常"）
  if (payload.ok === false) return payload

  const total = toFiniteNumber(payload.totalBalance)
  if (total === null) {
    const out = {
      ok: false,
      code: 'SHAPE',
      error: SHAPE_ERROR,
    }
    // 失败结果里仍然保留与错误无关的展示字段（版本号等），方便界面照常显示版号
    if (payload.version) out.version = payload.version
    if (payload.versionLabel) out.versionLabel = payload.versionLabel
    // 只带走不改变语义的失败上下文
    if (payload.error) out.upstreamError = String(payload.error).slice(0, 200)
    if (payload.code) out.upstreamCode = String(payload.code).slice(0, 40)
    return out
  }

  return { ...payload, ok: true, totalBalance: total }
}
