// 余额出口归一化测试：核心是「绝不把空值/非数值当成 0」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBalancePayload, toFiniteNumber } from '../lib/balance-normalize.mjs'

test('toFiniteNumber rejects null, empty and non-finite values', () => {
  assert.equal(toFiniteNumber(null), null)
  assert.equal(toFiniteNumber(undefined), null)
  assert.equal(toFiniteNumber(''), null)
  assert.equal(toFiniteNumber('   '), null)
  assert.equal(toFiniteNumber(NaN), null)
  assert.equal(toFiniteNumber(Infinity), null)
  assert.equal(toFiniteNumber('-Infinity'), null)
  assert.equal(toFiniteNumber({}), null)
  assert.equal(toFiniteNumber([]), null)
  assert.equal(toFiniteNumber(true), null)
})

test('toFiniteNumber accepts real numbers and numeric strings', () => {
  assert.equal(toFiniteNumber(0), 0)
  assert.equal(toFiniteNumber(12.5), 12.5)
  assert.equal(toFiniteNumber('12.50'), 12.5)
  assert.equal(toFiniteNumber(' 0 '), 0)
})

test('null totalBalance becomes an explicit SHAPE error, never 0', () => {
  const out = normalizeBalancePayload({ ok: true, totalBalance: null, currency: 'CNY' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'SHAPE')
  assert.match(out.error, /totalBalance/)
  // 关键回归：不能再出现 Number(null) === 0 的路径
  assert.notEqual(out.totalBalance, 0)
  assert.equal('totalBalance' in out, false)
})

test('empty-string totalBalance becomes SHAPE', () => {
  const out = normalizeBalancePayload({ ok: true, totalBalance: '' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'SHAPE')
})

test('non-finite totalBalance becomes SHAPE', () => {
  for (const bad of [NaN, Infinity, -Infinity, 'abc', 'NaN', {}]) {
    const out = normalizeBalancePayload({ ok: true, totalBalance: bad })
    assert.equal(out.ok, false, `expected failure for ${String(bad)}`)
    assert.equal(out.code, 'SHAPE')
  }
})

test('zero is a legitimate balance and must be preserved', () => {
  const out = normalizeBalancePayload({ ok: true, totalBalance: 0, currency: 'CNY' })
  assert.equal(out.ok, true)
  assert.equal(out.totalBalance, 0)
  assert.equal(out.currency, 'CNY')
})

test('numeric string balance is coerced to a number', () => {
  const out = normalizeBalancePayload({ ok: true, totalBalance: '18.75' })
  assert.equal(out.ok, true)
  assert.equal(out.totalBalance, 18.75)
  assert.equal(typeof out.totalBalance, 'number')
})

test('original failure codes and messages are preserved', () => {
  const noKey = normalizeBalancePayload({ ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' })
  assert.deepEqual(noKey, { ok: false, code: 'NO_KEY', error: '未配置 DEEPSEEK_API_KEY' })

  const http = normalizeBalancePayload({ ok: false, code: 'HTTP', transient: true, error: '余额接口请求失败: HTTP 502' })
  assert.equal(http.code, 'HTTP')
  assert.equal(http.transient, true)
})

test('structural error keeps upstream diagnostics without inventing a balance', () => {
  const out = normalizeBalancePayload({ ok: true, totalBalance: null, error: 'wallet empty', code: 'UPSTREAM' })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'SHAPE')
  assert.equal(out.upstreamError, 'wallet empty')
  assert.equal(out.upstreamCode, 'UPSTREAM')
})

test('non-object payloads are rejected', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const out = normalizeBalancePayload(bad)
    assert.equal(out.ok, false)
    assert.equal(out.code, 'SHAPE')
  }
})

test('successful payload fields other than totalBalance pass through', () => {
  const out = normalizeBalancePayload({
    ok: true,
    totalBalance: 3.5,
    bonusBalance: null,
    rechargeBalance: null,
    currency: 'CNY',
    balanceSource: 'apikey',
  })
  assert.equal(out.ok, true)
  assert.equal(out.totalBalance, 3.5)
  assert.equal(out.bonusBalance, null) // 分量取不到保持 null，界面显示 —
  assert.equal(out.balanceSource, 'apikey')
})
