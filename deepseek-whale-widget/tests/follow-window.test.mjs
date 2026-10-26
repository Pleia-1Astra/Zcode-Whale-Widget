import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../desktop/follow-window.ps1', import.meta.url), 'utf8')
const predicate = source.match(/\bbool show\s*=\s*([^;]+);/)
assert.ok(predicate, 'the follower must declare its visibility decision')
const visibility = new vm.Script(`(${predicate[1]})`)

test('minimized main windows are ranked by restored bounds and remain the tracked host', () => {
  assert.match(source, /if \(IsIconic\(h\)\)[\s\S]*GetWindowPlacement\(h, ref placement\)[\s\S]*r = placement.NormalPosition/)
  assert.match(source, /bool keepMinimized = .*IsIconic\(_targetHwnd\)/)
  assert.match(source, /if \(!keepMinimized &&/)
})

test('native stacking is host-owned, non-topmost and never activates or moves the host', () => {
  assert.match(source, /GWLP_HWNDPARENT/)
  assert.match(source, /HWND_NOTOPMOST/)
  assert.match(source, /SWP_KEEP_GEOMETRY_AND_FOCUS = 0x0013/)
  assert.match(source, /SWP_NOOWNERZORDER/)
  assert.match(source, /if \(show\) SyncOverlayOrder\(z\)/)
})

test('a missing host invalidates the signature so an identical returning window is reported', () => {
  const missing = source.match(/if \(z == IntPtr.Zero\)\s*\{([\s\S]*?)if \(missSince == 0\)/)
  assert.ok(missing, 'the follower must handle a missing window')
  const changed = source.match(/if \((!haveSig \|\|[\s\S]*?)\)\s*\{/)
  assert.ok(changed, 'the follower must emit changed states')
  const context = vm.createContext({
    haveSig: true,
    left: 10, lastL: 10, top: 20, lastT: 20,
    width: 1200, lastW: 1200, height: 800, lastH: 800,
    show: true, lastShow: true, minimized: false, lastMin: false,
    _targetPid: 42, lastPid: 42,
  })
  const shouldEmit = new vm.Script(`(${changed[1]})`)
  assert.equal(shouldEmit.runInContext(context), false)
  new vm.Script(missing[1]).runInContext(context)
  assert.equal(shouldEmit.runInContext(context), true)
})

const foregrounds = [
  { name: 'ZCode', fgIsTarget: true, fgIsOverlay: false },
  { name: 'overlay', fgIsTarget: false, fgIsOverlay: true },
  { name: 'another application', fgIsTarget: false, fgIsOverlay: false },
  { name: 'transient null foreground', fgIsTarget: false, fgIsOverlay: false, fgPid: 0 },
  { name: 'overlapping process identity', fgIsTarget: true, fgIsOverlay: true },
]
const states = [
  { name: 'visible host stays shown', minimized: false, visible: true, isCloaked: false, expected: true },
  { name: 'minimized host stays hidden', minimized: true, visible: true, isCloaked: false, expected: false },
  { name: 'invisible host stays hidden', minimized: false, visible: false, isCloaked: false, expected: false },
  { name: 'cloaked host stays hidden', minimized: false, visible: true, isCloaked: true, expected: false },
]

for (const foreground of foregrounds) {
  for (const state of states) {
    test(`${state.name} with ${foreground.name} in foreground`, () => {
      // The C# predicate uses boolean operators shared with JavaScript.
      assert.equal(visibility.runInNewContext({ ...foreground, ...state }), state.expected)
    })
  }
}
