// 浮层专用页面桥接（独立文件；不内联进 assets/whale-widget.js）。
// 仅在 ?overlay=1 且存在 window.whaleDesktop 时加载。负责：鼠标穿透/接管、
// 键盘焦点按需接管、菜单外点击重放、隐藏时暂停 /dsh-whale/ 请求，
// 并在浮层重新显示时派发 window 事件通知挂件**立刻补刷**（不等 60s / 1s 下一 tick）。
(function () {
  var bridge = typeof window !== 'undefined' ? window.whaleDesktop : null
  if (!bridge || !bridge.isOverlay) return

  // 与 assets/whale-widget.js 里的 WHALE_VIEW_EVENT 同名（两处必须一致）。
  var OVERLAY_VISIBILITY_EVENT = 'dshwv:whale-view-visible'

  var doc = document
  var lastPointer = null
  var lastHitPoint = null
  var interactive = false
  var lastInteractiveOnAt = 0
  var keyboardFocus = false
  var visible = true

  // 所有会「需要整窗接管」的挂件 UI：菜单/各类面板/遮罩/下拉/编辑器。
  // 打开期间必须整窗接管，否则点在外面的那一下就到不了页面（关不掉）。
  var MODAL_SELECTORS = [
    '.dshwv-menu',
    '.dshwv-rolelist',
    '.dshwv-audiolist',
    '.dshwv-slotlist',
    '.dshwv-custmenu',
    '.dshwv-qedit',
    '.dshwv-usagepanel',
    '.dshwv-tplhelp',
    '.dshwv-cropmask',
    '.dshwv-confirmmask',
    '.dshwv-audiomask',
    '.dshwv-snapmask',
    '.dshwv-bubmask',
    '.dshwv-framemask',
    '.dshwv-usage-mask',
    '.dshwv-resmask',
    '.dshwv-gifmask',
  ]
  var TEXTUAL_TYPES = { text: 1, number: 1, search: 1, password: 1, url: 1, tel: 1, email: 1 }

  function isWidgetNode(node) {
    try {
      if (!node || node === doc || node === doc.body || node === doc.documentElement) return false
      var el = node.nodeType === 1 ? node : node.parentElement
      if (!el || !el.closest) return false
      return !!el.closest('[class*="dshwv-"]')
    } catch (err) {
      return false
    }
  }

  function modalOpen() {
    for (var i = 0; i < MODAL_SELECTORS.length; i++) {
      var el = doc.querySelector(MODAL_SELECTORS[i])
      if (!el) continue
      // 菜单/面板关闭态靠 pointer-events:none + opacity:0 隐藏；用可见性判定。
      try {
        var cs = window.getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        // 菜单的「关闭」靠 pointer-events:none（会继承），其余面板直接不渲染/display:none
        if (cs.pointerEvents === 'none' && !/\bdshwv-menu-open\b/.test(el.className || '')) continue
        if (Number(cs.opacity) === 0) continue
        return true
      } catch (err) {}
    }
    return false
  }

  function dragging() {
    try {
      return !!doc.querySelector('.dshwv-dragging')
    } catch (err) {
      return false
    }
  }

  function menuBtnHot() {
    try {
      var btn = doc.querySelector('.dshwv-menu-btn')
      if (!btn) return false
      var cs = window.getComputedStyle(btn)
      if (cs.visibility === 'hidden' || cs.display === 'none') return false
      if (!lastPointer) return false
      var b = btn.getBoundingClientRect()
      return lastPointer.x >= b.left && lastPointer.x <= b.right && lastPointer.y >= b.top && lastPointer.y <= b.bottom
    } catch (err) {
      return false
    }
  }

  function setInteractive(v, force) {
    if (!bridge || typeof bridge.setInteractive !== 'function') return
    if (!visible && v) return
    var want = !!v
    if (want === interactive && !force) return
    // 去抖：指针擦过鲸鱼透明边缘时接管/穿透会来回抖动；关闭方向至少保持 120ms，
    // 但「收起 UI / 失焦」这类刻意转换必须立刻生效。
    if (!force && !want && interactive && Date.now() - lastInteractiveOnAt < 120) return
    if (want) lastInteractiveOnAt = Date.now()
    interactive = want
    try {
      bridge.setInteractive(want)
    } catch (err) {}
  }

  function shouldInteract() {
    if (!visible) return false
    if (dragging()) return true
    if (modalOpen()) return true
    if (menuBtnHot()) return true
    if (!lastPointer) return false
    // 元素命中优先：挂件 UI 都有 dshwv- 前缀；透明区命中 body →
    // 交给 alpha 命中图（不能整块矩形都接管，否则鲸鱼周围的透明边距会挡输入）。
    var node = null
    try {
      node = doc.elementFromPoint(lastPointer.x, lastPointer.y)
    } catch (err) {}
    if (isWidgetNode(node) && !isTransparentSpacer(node)) return true
    var hit = false
    try {
      hit = !!window.__dshWhaleHitTest && window.__dshWhaleHitTest(lastPointer.x, lastPointer.y)
    } catch (err) {
      hit = false
    }
    if (hit) {
      lastHitPoint = { x: lastPointer.x, y: lastPointer.y }
      return true
    }
    // 空间迟滞：刚离开鲸鱼边缘 8px 内保持接管，避免边缘闪
    if (lastHitPoint) {
      var dx = lastPointer.x - lastHitPoint.x
      var dy = lastPointer.y - lastHitPoint.y
      if (dx * dx + dy * dy < 64) return true
    }
    lastHitPoint = null
    return false
  }

  // .dshwv-root 本身是 pointer-events:none 的定位容器，它的矩形覆盖整个角色盒；
  // 命中它不代表在鲸鱼身上（透明边距要穿透）。其余 dshwv- 元素都算真实 UI。
  function isTransparentSpacer(node) {
    try {
      var el = node
      while (el && el !== doc.body) {
        var cls = String(el.className || '')
        if (cls.indexOf('dshwv-root') !== -1 || cls.indexOf('dshwv-body') !== -1) return true
        if (cls.indexOf('dshwv-img') !== -1) return false
        el = el.parentElement
      }
      return false
    } catch (err) {
      return false
    }
  }

  function sync() {
    setInteractive(shouldInteract())
  }

  function track(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return
    lastPointer = { x: x, y: y }
    sync()
  }

  doc.addEventListener('pointermove', function (e) {
    track(e.clientX, e.clientY)
  }, true)

  // 注意挂在 **window 捕获阶段**：原前端的 onDocPointerDown 挂在 document 捕获阶段
  // 且先注册，它会在 pointerdown 里同步 closeMenu()。如果我们也挂 document，
  // 轮到时 modalOpen() 已经变 false，就没法判断「这一下点击本来是给浮层 UI 收菜单
  // 的、需要重放给 ZCode」。window 捕获早于 document 捕获，这里读到的仍是被
  // 点击前的状态。
  window.addEventListener('pointerdown', function (e) {
    track(e.clientX, e.clientY)
    setKeyboardFocus(isTextualControl(e.target))
    // 浮层 UI（菜单/面板）开着 → 窗口整窗接管 → 点在 UI 之外时，这一次点击
    // 本来会落到 ZCode。先收起菜单（页面自己会做），再请主进程在原位置重放。
    if (modalOpen() && !isWidgetNode(e.target) && typeof bridge.dismissReplay === 'function') {
      setTimeout(function () {
        try {
          bridge.dismissReplay()
        } catch (err) {}
      }, 0)
    }
  }, true)
  doc.addEventListener('pointerup', sync, true)
  window.addEventListener('resize', sync)

  if (typeof bridge.onCursor === 'function') {
    try {
      bridge.onCursor(function (pt) {
        if (pt) track(pt.x, pt.y)
      })
    } catch (err) {}
  }

  if (typeof bridge.onWindowState === 'function') {
    try {
      bridge.onWindowState(function (state) {
        var wasVisible = visible
        if (state && typeof state.visible === 'boolean') visible = state.visible
        if (state && state.blur) teardown()
        if (!visible) {
          setInteractive(false, true)
          pauseWhaleRequests()
        } else {
          resumeWhaleRequests()
          sync()
          // 只在「隐藏 → 可见」的那次转换里通知挂件补刷：隐藏期间 60s 余额刷新与
          // 1s last-turn/wait 轮询都已跳过，这里让它们立刻各走一次，而不是干等下一 tick。
          if (!wasVisible) notifyVisible()
        }
      })
    } catch (err) {}
  }

  // 通知挂件「浮层重新可见」：只派发自定义事件，不直接调用挂件内部函数
  // （挂件可能尚未初始化，事件名与 whale-widget.js 的 WHALE_VIEW_EVENT 一致）。
  function notifyVisible() {
    try {
      var ev = null
      if (typeof window.CustomEvent === 'function') {
        ev = new window.CustomEvent(OVERLAY_VISIBILITY_EVENT)
      } else if (typeof doc.createEvent === 'function') {
        ev = doc.createEvent('Event')
        ev.initEvent(OVERLAY_VISIBILITY_EVENT, false, false)
      }
      if (ev) window.dispatchEvent(ev)
    } catch (err) {}
  }

  // ---------- 隐藏时暂停 /dsh-whale/ 请求 ----------
  // 浮层用透明度隐藏，页面 document.hidden 仍是 false，原前端的 60s 余额刷新与
  // 1s 轮询不会自己停。这里包一层 fetch：隐藏期间针对 /dsh-whale/ 的请求先挂起，
  // 暂停期间也必须响应取消；恢复时保留原信号，不能复活已超时的请求。
  var originalFetch = typeof window.fetch === 'function' ? window.fetch : null
  var pausedRequests = []
  var requestsPaused = false

  function isWhaleRequest(input) {
    var url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : ''
    return url.indexOf('/dsh-whale/') !== -1
  }

  function pauseWhaleRequests() {
    requestsPaused = true
  }

  function resumeWhaleRequests() {
    if (!requestsPaused) return
    requestsPaused = false
    var queued = pausedRequests
    pausedRequests = []
    for (var i = 0; i < queued.length; i++) {
      var item = queued[i]
      item.cleanup()
      if (item.signal && item.signal.aborted) {
        item.abort()
        continue
      }
      try {
        originalFetch.call(window, item.input, item.init).then(item.resolve, item.reject)
      } catch (err) {
        item.reject(err)
      }
    }
  }

  if (originalFetch) {
    window.fetch = function (input, init) {
      if (!requestsPaused || !isWhaleRequest(input)) return originalFetch.apply(window, arguments)
      return new Promise(function (resolve, reject) {
        var signal = init && init.signal !== undefined ? init.signal : input && input.signal
        var item = {
          input: input,
          init: init,
          signal: signal,
          resolve: resolve,
          reject: reject,
          cleanup: function () {
            if (signal) signal.removeEventListener('abort', item.abort)
          },
          abort: function () {
            var index = pausedRequests.indexOf(item)
            if (index !== -1) pausedRequests.splice(index, 1)
            item.cleanup()
            var reason = signal.reason
            if (reason === undefined) {
              reason = new Error('The operation was aborted')
              reason.name = 'AbortError'
            }
            reject(reason)
          },
        }
        if (signal && signal.aborted) { item.abort(); return }
        if (signal) signal.addEventListener('abort', item.abort, { once: true })
        pausedRequests.push(item)
      })
    }
  }

  // ---------- 键盘焦点 ----------
  function isTextualControl(node) {
    try {
      if (!node || !node.tagName) return false
      if (node.tagName === 'TEXTAREA' || node.tagName === 'SELECT') return true
      if (node.tagName !== 'INPUT') return Boolean(node.isContentEditable)
      return !!TEXTUAL_TYPES[String(node.type || 'text').toLowerCase()]
    } catch (err) {
      return false
    }
  }

  function setKeyboardFocus(v) {
    if (!bridge || typeof bridge.setKeyboardFocus !== 'function') return
    var want = !!v
    if (want === keyboardFocus) return
    keyboardFocus = want
    try {
      bridge.setKeyboardFocus(want)
    } catch (err) {}
  }

  function anyPanelOpen() {
    try {
      return Boolean(
        doc.querySelector('.dshwv-menu-open') ||
        doc.querySelector('.dshwv-rolelist') ||
        doc.querySelector('.dshwv-audiolist') ||
        doc.querySelector('.dshwv-usagepanel') ||
        doc.querySelector('.dshwv-qedit') ||
        doc.querySelector('.dshwv-custmenu')
      )
    } catch (err) {
      return false
    }
  }

  // 焦点：只在文本控件获得焦点时申请，面板全关且焦点离开文本控件后释放。
  doc.addEventListener('focusin', function (e) {
    if (isTextualControl(e.target)) setKeyboardFocus(true)
  }, true)
  doc.addEventListener('focusout', function () {
    setTimeout(function () {
      if (anyPanelOpen()) return
      var active = doc.activeElement
      if (isTextualControl(active)) return
      setKeyboardFocus(false)
    }, 160)
  }, true)

  function teardown() {
    setKeyboardFocus(false)
    setInteractive(false, true)
  }

  // 暴露给其他脚本（测试/诊断）用，不改变任何现有行为。
  window.__deepseekWhaleOverlay = {
    isOverlay: true,
    track: track,
    interactive: function () {
      return interactive
    },
    // 轻量可见性读取（不做任何 DOM 探测）：供挂件的 60s / 1s 轮询每秒判断用，
    // 避免每秒都跑 why() 里的 elementFromPoint + 选择器扫描。
    visible: function () {
      return visible
    },
    // 诊断：返回当前判定输入与结论（不含任何用户数据）
    why: function () {
      var el = null
      if (lastPointer) {
        try {
          el = doc.elementFromPoint(lastPointer.x, lastPointer.y)
        } catch (err) {}
      }
      return {
        pointer: lastPointer,
        visible: visible,
        dragging: dragging(),
        modalOpen: modalOpen(),
        menuBtnHot: menuBtnHot(),
        hitNode: el ? String(el.tagName || '') + '.' + String(el.className || '') : null,
        lastHitPoint: lastHitPoint,
        shouldInteract: shouldInteract(),
        interactive: interactive,
      }
    },
  }
})()
