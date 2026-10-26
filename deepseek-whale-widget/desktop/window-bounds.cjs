// 浮层窗口矩形计算（纯函数，可直接单测）。
//
// 坐标系约定：
//   - hostRect / workArea 传入的是 **DIP**（Electron BrowserWindow API 的单位）；
//   - 跟随脚本上报的是 **物理像素**，转换在调用方用 screen.screenToDipRect 完成。
const TASKBAR_REVEAL_INSET = 4
const MIN_HOST_SIZE = 24

function isFiniteRect(rect) {
  return !!rect && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(Number(rect[k])))
}

function normalizeRect(rect) {
  if (!isFiniteRect(rect)) return null
  return {
    x: Math.round(Number(rect.x)),
    y: Math.round(Number(rect.y)),
    width: Math.max(0, Math.round(Number(rect.width))),
    height: Math.max(0, Math.round(Number(rect.height))),
  }
}

// 浮层兜底矩形：工作区四周留 4 DIP。任务栏自动隐藏时 workArea 等于整屏，
// 精确铺满的置顶窗会被系统当全屏窗压制任务栏滑出热区，留一条不可见的缝。
function overlayWorkAreaBounds(workArea, inset) {
  const wa = workArea && typeof workArea === 'object' ? workArea : { x: 0, y: 0, width: 1, height: 1 }
  const raw = Number(inset)
  const n = Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : TASKBAR_REVEAL_INSET
  return {
    x: Math.round(Number(wa.x) || 0) + n,
    y: Math.round(Number(wa.y) || 0) + n,
    width: Math.max(1, Math.round(Number(wa.width) || 1) - n * 2),
    height: Math.max(1, Math.round(Number(wa.height) || 1) - n * 2),
  }
}

// 求交集（DIP）。任一维度不足 MIN_HOST_SIZE 时返回 null，调用方应隐藏浮层
// 而不是留一个 1px 的怪窗口。
function intersectRect(a, b) {
  const ra = normalizeRect(a)
  const rb = normalizeRect(b)
  if (!ra || !rb) return null
  const left = Math.max(ra.x, rb.x)
  const top = Math.max(ra.y, rb.y)
  const right = Math.min(ra.x + ra.width, rb.x + rb.width)
  const bottom = Math.min(ra.y + ra.height, rb.y + rb.height)
  const width = right - left
  const height = bottom - top
  if (width < MIN_HOST_SIZE || height < MIN_HOST_SIZE) return null
  return { x: left, y: top, width, height }
}

// 宿主的「客户区」矩形直接决定浮层窗口矩形：两者重合时页面 innerWidth /
// innerHeight 就等于 ZCode 主窗口内部区域，原项目前端（用 innerWidth 计算
// 鲸鱼尺寸与吸附边界）无需任何改写。
//
// hostClientRect 已在 DIP；workArea 用于把浮层钳进任务栏以外的区域（ZCode
// 被拖到屏幕边缘时浮层不压任务栏）。
function overlayBoundsForHost(hostClientRect, workArea, opts = {}) {
  const margin = Number.isFinite(Number(opts.margin)) ? Math.max(0, Math.round(Number(opts.margin))) : 0
  const host = normalizeRect(hostClientRect)
  if (!host) return null
  const inset = {
    x: host.x + margin,
    y: host.y + margin,
    width: Math.max(0, host.width - margin * 2),
    height: Math.max(0, host.height - margin * 2),
  }
  if (!workArea) return intersectRect(inset, inset)
  return intersectRect(inset, workArea)
}

// 物理像素矩形 → DIP。converter 由 Electron 的 screen.screenToDipRect 提供；
// 缺失或抛错时原样返回（无 DPI 缩放的环境两者相等）。
function physicalToDip(rect, converter) {
  const r = normalizeRect(rect)
  if (!r) return null
  if (typeof converter !== 'function') return r
  try {
    const dip = converter(r)
    return normalizeRect(dip) || r
  } catch (err) {
    return r
  }
}

// 判断两个矩形是否已经足够接近（避免每 40ms 都触发一次 setBounds）
function rectsClose(a, b, tolerance = 1) {
  const ra = normalizeRect(a)
  const rb = normalizeRect(b)
  if (!ra || !rb) return false
  return (
    Math.abs(ra.x - rb.x) <= tolerance &&
    Math.abs(ra.y - rb.y) <= tolerance &&
    Math.abs(ra.width - rb.width) <= tolerance &&
    Math.abs(ra.height - rb.height) <= tolerance
  )
}

module.exports = {
  TASKBAR_REVEAL_INSET,
  MIN_HOST_SIZE,
  overlayWorkAreaBounds,
  intersectRect,
  overlayBoundsForHost,
  physicalToDip,
  rectsClose,
}
