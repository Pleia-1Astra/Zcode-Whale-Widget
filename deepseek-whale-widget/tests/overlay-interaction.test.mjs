import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createInteractionGuard } = require('../desktop/interaction-guard.cjs')
const bridgeSource = fs.readFileSync(new URL('../assets/overlay-bridge.js', import.meta.url), 'utf8')
const widgetSource = fs.readFileSync(new URL('../assets/whale-widget.js', import.meta.url), 'utf8')

function loadBridge() {
  let now = 10000
  let cursor, state
  let hit = false
  let fail = false
  const calls = []
  const listeners = {}
  const win = {
    whaleDesktop: {
      isOverlay: true,
      setInteractive(v) { if (fail) throw new Error('IPC unavailable'); calls.push(v) },
      onCursor(cb) { cursor = cb }, onWindowState(cb) { state = cb },
    },
    __dshWhaleHitTest: () => hit,
    addEventListener(type, cb) { listeners[type] = cb },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  }
  const doc = { querySelector: () => null, elementFromPoint: () => null, addEventListener() {} }
  vm.runInNewContext(bridgeSource, { window: win, document: doc, Date: class extends Date { static now() { return now } }, setTimeout })
  return { calls, state, listeners, win,
    hit(v) { hit = v }, fail(v) { fail = v },
    sample(ms = 200, extra = {}) { now += ms; cursor({ x: 50, y: 50, geometryEpoch: 0, ...extra }) },
  }
}

test('stationary cursor renews capture and repairs a lost request without pointer events', () => {
  const b = loadBridge()
  b.hit(true)
  b.sample(0, { interactive: false })
  assert.deepEqual(b.calls, [true])
  b.sample(200, { interactive: false })
  assert.deepEqual(b.calls, [true, true], 'lost IPC must be retried')
  b.sample(200, { interactive: true })
  assert.equal(b.calls.length, 2)
  b.sample(400, { interactive: true })
  assert.deepEqual(b.calls, [true, true, true], 'same-value request renews lease')
})

test('a throwing page bridge retries rather than caching an unsent value', () => {
  const b = loadBridge()
  b.hit(true); b.fail(true); b.sample()
  assert.equal(b.win.__deepseekWhaleOverlay.interactive(), false)
  b.fail(false); b.sample()
  assert.deepEqual(b.calls, [true])
})

test('geometry epoch, resize and hide clear stale alpha-hit hysteresis', () => {
  const b = loadBridge()
  b.hit(true); b.sample()
  b.hit(false); b.sample()
  assert.equal(b.calls.at(-1), true, 'same point initially retains edge hysteresis')
  b.sample(200, { geometryEpoch: 1 })
  assert.equal(b.calls.at(-1), false)
  b.hit(true); b.sample()
  b.listeners.resize()
  assert.equal(b.calls.at(-1), false)
  b.sample(); b.state({ visible: false })
  b.sample()
  assert.equal(b.calls.at(-1), false)
  b.state({ visible: true })
  assert.equal(b.calls.at(-1), false, 'show must wait for a fresh cursor position')
  b.sample()
  assert.equal(b.calls.at(-1), true)
})

test('alpha edge hysteresis expires even with a stationary pointer', () => {
  const b = loadBridge()
  b.hit(true); b.sample()
  b.hit(false); b.sample(200)
  assert.equal(b.calls.at(-1), true)
  b.sample(200)
  assert.equal(b.calls.at(-1), false, 'stale hit cannot capture a transparent point indefinitely')
})

test('native same-value failure stays unverified through renewal and expires safely', () => {
  const g = createInteractionGuard()
  g.request(true, 0); g.noteApplied(true, true, 0)
  g.request(true, 600)
  assert.equal(g.tick(1000).action, 'apply')
  g.noteApplied(true, false, 1000)
  assert.equal(g.request(true, 1100).action, 'skip')
  assert.equal(g.snapshot().verified, false)
  assert.equal(g.tick(1250).action, 'apply')
  g.noteApplied(true, false, 1250)
  assert.equal(g.tick(2600).want, false)
})

function loadHit() {
  let hidden = false
  let style = { display: 'block', visibility: 'visible', opacity: '1' }
  const sampled = []
  const sandbox = {
    window: { getComputedStyle: () => style }, root: {},
    img: { getBoundingClientRect: () => ({ left: 100, top: 200, width: 122, height: 122 }) },
    state: { flip: false }, hitReady: true, hitFailed: false,
    hitCanvas: { getContext: () => ({ getImageData(x, y) { sampled.push([x, y]); return { data: [0, 0, 0, x >= 300 ? 255 : 0] } } }) },
    dshwOverlayHidden: () => hidden,
    whaleRectHit: () => false,
  }
  const start = widgetSource.indexOf('function isWhaleHit(e) {')
  const end = widgetSource.indexOf('function onDocPointerDown(e)', start)
  vm.runInNewContext(widgetSource.slice(start, end), sandbox)
  return { sandbox, sampled, hit: sandbox.window.__dshWhaleHitTest,
    hide(v) { hidden = v }, style(v) { style = v },
  }
}

test('exported real alpha hit-test respects scale, transparency, flip and boundaries', () => {
  const b = loadHit()
  assert.equal(b.hit(110, 210), false)
  assert.equal(b.hit(200, 210), true)
  assert.deepEqual(b.sampled.at(-1), [500, 49])
  b.sandbox.state.flip = true
  assert.equal(b.hit(110, 210), true)
  assert.deepEqual(b.sampled.at(-1), [560, 49])
  assert.equal(b.hit(100, 210), true)
  assert.deepEqual(b.sampled.at(-1), [609, 49], 'flipped first pixel must not read column 610')
  assert.equal(b.hit(222, 210), false)
  assert.equal(b.hit(NaN, 210), false)
  assert.equal(b.hit(99, 210), false)
})

test('exported hit-test cannot acquire a hidden, transparent or loading whale', () => {
  const b = loadHit()
  b.hide(true); assert.equal(b.hit(200, 210), false)
  b.hide(false); b.style({ display: 'none', visibility: 'visible', opacity: '1' })
  assert.equal(b.hit(200, 210), false)
  b.style({ display: 'block', visibility: 'visible', opacity: '0' })
  assert.equal(b.hit(200, 210), false)
  b.style({ display: 'block', visibility: 'visible', opacity: '1' })
  b.sandbox.hitReady = false
  assert.equal(b.hit(200, 210), false)
})
