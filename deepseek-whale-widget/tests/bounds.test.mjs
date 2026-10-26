// 浮层窗口矩形计算测试（desktop/window-bounds.cjs 是 CommonJS）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  overlayWorkAreaBounds,
  intersectRect,
  overlayBoundsForHost,
  physicalToDip,
  rectsClose,
  TASKBAR_REVEAL_INSET,
  MIN_HOST_SIZE,
} = require('../desktop/window-bounds.cjs')

test('overlayWorkAreaBounds leaves the taskbar reveal inset', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1080 }
  const b = overlayWorkAreaBounds(wa)
  assert.equal(b.x, TASKBAR_REVEAL_INSET)
  assert.equal(b.y, TASKBAR_REVEAL_INSET)
  assert.equal(b.width, 1920 - TASKBAR_REVEAL_INSET * 2)
  assert.equal(b.height, 1080 - TASKBAR_REVEAL_INSET * 2)
})

test('overlayWorkAreaBounds keeps negative monitor coordinates', () => {
  const b = overlayWorkAreaBounds({ x: -1920, y: -200, width: 1920, height: 1080 })
  assert.equal(b.x, -1920 + TASKBAR_REVEAL_INSET)
  assert.equal(b.y, -200 + TASKBAR_REVEAL_INSET)
})

test('overlayWorkAreaBounds tolerates garbage input', () => {
  const b = overlayWorkAreaBounds(null)
  assert.ok(b.width >= 1 && b.height >= 1)
})

test('intersectRect clips to the overlay window and rejects tiny results', () => {
  const host = { x: 100, y: 100, width: 800, height: 600 }
  const overlay = { x: 0, y: 0, width: 1000, height: 800 }
  assert.deepEqual(intersectRect(host, overlay), { x: 100, y: 100, width: 800, height: 600 })

  // 完全在浮层窗口之外
  assert.equal(intersectRect({ x: 2000, y: 2000, width: 400, height: 400 }, overlay), null)

  // 相交但太窄（< MIN_HOST_SIZE）：返回 null，调用方隐藏浮层
  assert.equal(
    intersectRect({ x: 995, y: 0, width: 400, height: 400 }, overlay),
    null
  )
  assert.ok(MIN_HOST_SIZE > 0)
})

test('overlayBoundsForHost mirrors the ZCode client area exactly (margin 0)', () => {
  const host = { x: 120, y: 80, width: 1280, height: 860 }
  assert.deepEqual(overlayBoundsForHost(host, null, { margin: 0 }), host)
})

test('overlayBoundsForHost applies a margin and clamps into the work area', () => {
  const host = { x: 100, y: 100, width: 1000, height: 700 }
  const work = { x: 0, y: 0, width: 1920, height: 1080 }
  const b = overlayBoundsForHost(host, work, { margin: 16 })
  assert.deepEqual(b, { x: 116, y: 116, width: 968, height: 668 })

  // 宿主被拖到屏幕外一部分：结果被钳进工作区
  const clipped = overlayBoundsForHost({ x: 1800, y: 1000, width: 400, height: 400 }, work, { margin: 0 })
  assert.deepEqual(clipped, { x: 1800, y: 1000, width: 120, height: 80 })
})

test('overlayBoundsForHost returns null for degenerate hosts', () => {
  assert.equal(overlayBoundsForHost(null), null)
  assert.equal(overlayBoundsForHost({ x: 0, y: 0, width: 0, height: 0 }, null), null)
})

test('physicalToDip uses the converter and falls back safely', () => {
  const rect = { x: 100, y: 200, width: 1280, height: 720 }
  assert.deepEqual(
    physicalToDip(rect, (r) => ({ x: r.x / 2, y: r.y / 2, width: r.width / 2, height: r.height / 2 })),
    { x: 50, y: 100, width: 640, height: 360 }
  )
  // 没有转换器 = 无缩放环境
  assert.deepEqual(physicalToDip(rect, null), rect)
  // 转换器抛错时退回原值，不能崩掉跟随循环
  assert.deepEqual(
    physicalToDip(rect, () => {
      throw new Error('boom')
    }),
    rect
  )
  assert.equal(physicalToDip({ x: NaN, y: 0, width: 10, height: 10 }), null)
})

test('rectsClose suppresses redundant setBounds calls', () => {
  const a = { x: 10, y: 10, width: 100, height: 100 }
  assert.equal(rectsClose(a, { x: 11, y: 10, width: 100, height: 100 }), true)
  assert.equal(rectsClose(a, { x: 40, y: 10, width: 100, height: 100 }), false)
})
