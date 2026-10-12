/**
 * boot-panel — 开机画面面板（注入到 <head>，早于外壳模块渲染）
 * dsh-plugin-wallpaper-engine-Yun 合体功能（源自独立插件 dsh-plugin-wallpaper-engine-Yun v1）。
 *
 * 原理：开机时把应用外壳（#root）临时藏起来（opacity:0）——
 *       页面底下壁纸引擎挂着的活壁纸层立刻成为铺满全窗口的"开机画面"，
 *       壁纸就绪后停留 holdMs（或等点击），然后外壳淡入、画面淡出 = 无缝揭幕。
 *
 * 纪律：
 *  ① 绝不卡人：maxWaitMs 到点无条件进入；壁纸永远不来也有深色底兜底。
 *  ② 零侵入：只读壁纸引擎的公开信号（body[data-we-wallpaper] / [data-we-adapter]）。
 *  ③ 互斥：检测到 dsh-boot-2077 在场（全局标记）时主动让位，不叠两层开机画面。
 *  ④ 声音：默认壁纸音乐作开机 BGM；配置为 mute 时用原型级拦截静音（含 new Audio()
 *     出来的非 DOM 音频与场景壁纸的 audio），退场还原并恢复播放。
 *
 * 配置由宿主注入 __BSHW_YUN_CFG__（字段见 lib/index.js 的 boot inject）。
 */
(function () {
  'use strict'

  var cfg = globalThis.__BSHW_YUN_CFG__
  if (cfg === null || typeof cfg !== 'object') return   // 宿主没注入 ⇒ 什么都不做
  if (globalThis.__BSHW_YUN__) return                   // 只装一次
  // 与 dsh-boot-2077 互斥：2077 的面板先跑时（它的全局已存在），本插件让位。
  if (globalThis.__BOOT_2077__ || globalThis.__BOOT_2077_CFG__) {
    try { console.info('boot-panel: 检测到 dsh-boot-2077 在场，本次开机画面让位') } catch (e) { /* 忽略 */ }
    return
  }
  globalThis.__BSHW_YUN__ = true

  function clampNum(v, min, max, dflt) {
    return typeof v === 'number' && v >= min && v <= max ? v : dflt
  }

  var HOLD = clampNum(cfg.holdMs, 0, 60000, 5000)
  var FADE = clampNum(cfg.fadeMs, 0, 5000, 1200)
  var MAX_WAIT = clampNum(cfg.maxWaitMs, 3000, 120000, 15000)
  var DIM = clampNum(cfg.dim, 0, 60, 25)
  var WORDMARK = typeof cfg.wordmark === 'string' ? cfg.wordmark.slice(0, 60) : ''
  var CLICK_ONLY = cfg.enterMode === 'click'
  var MUTE = cfg.mute === true
  var START_AT = Date.now()

  /** 防刷新重播：只在"应用启动那一次页面加载"上出现。 */
  if (cfg.replayOnRefresh !== true && typeof cfg.hostStartedAt === 'number' && cfg.hostStartedAt > 0) {
    if (START_AT - cfg.hostStartedAt > 20000) return
  }

  var state = { entered: false, wallpaperReady: false, audioLocked: false }
  var ourMedia = []
  var pausedByUs = []
  var origPlay = null
  var readyTimer = null

  /* -------------------------------------------------------------- 黑匣子 */

  function report(ev, detail) {
    try {
      var payload = { ev: ev, detail: detail === undefined ? null : detail, t: Math.round(Date.now() - START_AT) }
      if (typeof cfg.route === 'string' && cfg.route !== '') {
        var s = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        globalThis.fetch(cfg.route + '/status.json?report=' + s, { cache: 'no-store', keepalive: true }).catch(function () {})
      } else if (ev !== 'start') {
        // 合体版没有独立诊断路由：关键节点退回 console（排查时开 devtools 可见）。
        console.debug('[boot-panel]', ev, payload)
      }
    } catch (e) { /* 诊断不许影响主路径 */ }
  }

  report('start', {
    bodyNull: document.body === null,
    wallpaperAlready: wallpaperVisible(),
    hostAgeMs: typeof cfg.hostStartedAt === 'number' ? Math.round(START_AT - cfg.hostStartedAt) : -1,
    enterMode: cfg.enterMode, hold: HOLD, mute: MUTE,
  })

  /** 壁纸引擎的公开信号：body 上的 data-we-wallpaper / data-we-adapter 属性（激活时挂上）。 */
  function wallpaperVisible() {
    try {
      return document.body !== null &&
        (document.body.hasAttribute('data-we-wallpaper') ||
          document.body.hasAttribute('data-we-adapter'))
    } catch (e) { return false }
  }

  /* -------------------------------------------------------------- 外壳隐藏 */

  function installShellHider() {
    try {
      var style = document.createElement('style')
      // 只动 opacity：外壳照常渲染、照常加载，只是"不可见"；揭幕时淡入。
      // 选择器失配（DSH 未来改结构）⇒ 规则不生效 ⇒ 退化为"外壳可见"，绝不白屏。
      style.textContent = [
        'html[data-bshw="1"] #root{opacity:0 !important;pointer-events:none !important}',
        'html[data-bshw="1"] #root{transition:opacity ' + FADE + 'ms ease}',
        'html[data-bshw="0"] #root{transition:opacity ' + FADE + 'ms ease}',
      ].join('\n')
      ;(document.head || document.documentElement).appendChild(style)
      document.documentElement.setAttribute('data-bshw', '1')
      report('shell-hidden', { root: document.getElementById('root') !== null })
    } catch (e) {
      report('shell-hide-failed', { message: String((e && e.message) || e) })
    }
  }

  /* -------------------------------------------------------------- 声音策略 */

  function startSuppress() {
    if (!MUTE) return
    try {
      var all = document.querySelectorAll('video,audio')
      for (var i = 0; i < all.length; i += 1) {
        var el = all[i]
        if (ourMedia.indexOf(el) >= 0) continue
        if (!el.paused) { try { el.pause(); pausedByUs.push(el) } catch (e) { /* 忽略 */ } }
      }
    } catch (e) { /* 尽力而为 */ }
    if (origPlay !== null) return
    try {
      var proto = HTMLMediaElement.prototype
      origPlay = proto.play
      var orig = origPlay
      proto.play = function () {
        if (ourMedia.indexOf(this) >= 0) return orig.apply(this, arguments)
        try { this.pause() } catch (e) { /* 忽略 */ }
        if (pausedByUs.indexOf(this) < 0) pausedByUs.push(this)
        var rejected = Promise.reject(new Error('boot-panel: boot sound policy'))
        rejected.catch(function () {})
        return rejected
      }
      report('suppress-on', {})
    } catch (e) { /* 环境不支持则不压制（壁纸声照响），不致命 */ }
  }

  function stopSuppress() {
    if (origPlay !== null) {
      try { HTMLMediaElement.prototype.play = origPlay } catch (e) { /* 忽略 */ }
      origPlay = null
    }
    for (var i = 0; i < pausedByUs.length; i += 1) {
      try { var p = pausedByUs[i].play(); if (p && typeof p.catch === 'function') p.catch(function () {}) } catch (e) { /* 忽略 */ }
    }
    if (pausedByUs.length > 0) report('resumed-foreign', { count: pausedByUs.length })
    pausedByUs = []
  }

  /* -------------------------------------------------------------- 画面 */

  var nodes = {}

  function part(tag, cls, text) {
    var el = document.createElement(tag)
    if (cls) el.className = cls
    if (text !== undefined) el.textContent = text
    return el
  }

  function build() {
    var css = [
      // 覆盖层：透明为主（壁纸透过它可见）；壁纸没就绪时深色底兜底（.bshw-bg 单独一层，就绪后淡出）。
      '.bshw{position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483645;display:block;',
      'transition:opacity ' + FADE + 'ms ease;opacity:1}',
      '.bshw[data-leaving="1"]{opacity:0}',
      '.bshw-bg{position:absolute;inset:0;',
      'background:#000000;',
      'transition:opacity 800ms ease;opacity:1}',
      '.bshw[data-ready="1"] .bshw-bg{opacity:0}',
      // 压暗层：给文字可读性；DIM=0 时不显示。
      '.bshw-dim{position:absolute;inset:0;pointer-events:none;background:rgba(0,0,0,' + (DIM / 100) + ')}',
      '.bshw[data-ready="1"] .bshw-dim{opacity:.5;transition:opacity 800ms ease}',
      '.bshw-ui{position:absolute;left:0;right:0;bottom:8%;display:flex;flex-direction:column;align-items:center;gap:10px;',
      'color:#eaf4f8;font:13px/1.6 system-ui,"Microsoft YaHei",sans-serif;',
      'text-shadow:0 1px 4px rgba(0,0,0,.65);pointer-events:none}',
      '.bshw-wordmark{font-size:22px;font-weight:600;letter-spacing:.35em;opacity:.9}',
      '.bshw-wordmark:empty{display:none}',
      '.bshw-hint{font-size:12px;opacity:.55}',
      // 媒体包装层：离场动画作用在它身上（自选视频在内；跟随模式下它是空的）。
      '.bshw-media{position:absolute;inset:0}',
      // ── 离场动画（揭幕）五种：全部只动 transform / opacity / clip-path（合成器友好）──
      '@keyframes bshw-x-iris{from{clip-path:circle(140% at 50% 50%)}to{clip-path:circle(0% at 50% 50%)}}',
      '.bshw[data-exit="iris"]{animation:bshw-x-iris var(--bshw-exit,900ms) cubic-bezier(.7,0,.3,1) forwards}',
      '@keyframes bshw-x-wipe{from{clip-path:inset(0 0 0 0)}to{clip-path:inset(0 0 0 100%)}}',
      '.bshw[data-exit="wipe"]{animation:bshw-x-wipe var(--bshw-exit,900ms) cubic-bezier(.65,0,.35,1) forwards}',
      '@keyframes bshw-x-blinds{from{transform:scaleY(1)}to{transform:scaleY(0)}}',
      '.bshw[data-exit="blinds"] .bshw-media{-webkit-mask-image:repeating-linear-gradient(to bottom,#000 0 7%,transparent 7% 14%);',
      'mask-image:repeating-linear-gradient(to bottom,#000 0 7%,transparent 7% 14%);',
      'transform-origin:center;animation:bshw-x-blinds var(--bshw-exit,900ms) steps(8,end) forwards}',
      '.bshw[data-exit="blinds"]{background:rgba(0,0,0,.45)}',
      '@keyframes bshw-x-glitch{0%{transform:translate(0,0) skewX(0deg);opacity:1}',
      '20%{transform:translate(-3%,1%) skewX(4deg);opacity:1}',
      '40%{transform:translate(3%,-1%) skewX(-5deg);opacity:.9}',
      '55%{transform:translate(-2%,0%) skewX(3deg);opacity:.75}',
      '70%{transform:translate(2%,1%) skewX(-3deg);opacity:.55}',
      '85%{transform:translate(-1%,0%) skewX(2deg);opacity:.25}',
      '100%{transform:translate(1%,0%) skewX(0deg);opacity:0}}',
      '.bshw[data-exit="glitch"] .bshw-media{animation:bshw-x-glitch var(--bshw-exit,900ms) steps(7,end) forwards}',
      '.bshw[data-exit] .bshw-dim,.bshw[data-exit] .bshw-ui{opacity:0 !important;transition:opacity 200ms ease}',
    ].join('\n')
    var style = document.createElement('style')
    style.textContent = css
    ;(document.head || document.documentElement).appendChild(style)

    var root = part('div', 'bshw')
    root.setAttribute('data-ready', '0')
    var bg = part('div', 'bshw-bg')
    var dim = part('div', 'bshw-dim')
    var ui = part('div', 'bshw-ui')
    var wm = part('div', 'bshw-wordmark', WORDMARK)
    var hint = part('div', 'bshw-hint', CLICK_ONLY ? '点击进入' : '壁纸就绪后短暂停留 · 点击可提前进入')
    ui.appendChild(wm)
    ui.appendChild(hint)
    root.appendChild(bg)
    root.appendChild(part('div', 'bshw-media'))   // 媒体包装层（离场动画的作用对象）
    root.appendChild(dim)
    root.appendChild(ui)

    var parent = document.body || document.documentElement
    parent.appendChild(root)
    nodes = { root: root, hint: hint }
    report('build', { parent: parent.tagName })
    return nodes
  }

  /* -------------------------------------------------------------- 自选开机音乐 */

  /** 独立于壁纸声音压制：选了就播（它是"我们的"元素，原型拦截放行）。
   *  自动播放被策略拒绝 ⇒ 置 audioLocked：第一下点击解锁音乐（不进界面），再点才进。 */
  function startAudio() {
    if (!AUDIO_URL) return
    try {
      var el = document.createElement('audio')
      el.src = AUDIO_URL
      el.loop = true
      el.preload = 'auto'
      el.volume = AUDIO_VOL
      // 加载/解码失败（404、坏文件）：明确报错，不误导成"需要点击解锁"。
      el.addEventListener('error', function () {
        report('audio-error', { src: String(AUDIO_URL).slice(0, 120) })
        if (state.audioLocked) {
          state.audioLocked = false
          if (nodes.hint) nodes.hint.textContent = '播完自动进入 · 点击可提前进'
        }
      })
      ourMedia.push(el)
      nodes.audio = el
      var p = el.play()
      if (p && typeof p.catch === 'function') {
        p.catch(function () {
          state.audioLocked = true
          if (nodes.hint) nodes.hint.textContent = '点击开启音乐 · 再点进入'
          report('audio-locked', {})
        })
      }
      report('audio-start', { file: String(AUDIO_URL).split('/').pop() })
    } catch (e) { /* 音乐是配角，失败不影响主流程 */ }
  }

  /** 退出时音乐与画面一起淡出（每帧只动 volume，纯合成开销）。 */
  function fadeAudio() {
    var el = nodes.audio
    if (!el) return
    var steps = 12
    var i = 0
    var timer = globalThis.setInterval(function () {
      i += 1
      try { el.volume = Math.max(0, el.volume * 0.6) } catch (e) { /* 忽略 */ }
      if (i >= steps) { globalThis.clearInterval(timer); try { el.pause() } catch (e) { /* 忽略 */ } }
    }, Math.max(25, (EXIT === 'dissolve' ? FADE : EXIT_MS) / steps))
  }

  /* -------------------------------------------------------------- 进入 */

  function enter(reason) {
    if (state.entered) return
    state.entered = true
    report('enter', { reason: reason || 'unspecified', wallpaperReady: state.wallpaperReady, exit: EXIT })
    try { document.documentElement.setAttribute('data-bshw', '0') } catch (e) { /* 忽略 */ }  // 外壳淡入
    fadeAudio()
    var removeAfter = FADE + 60
    if (nodes.root) {
      if (EXIT === 'dissolve') {
        nodes.root.setAttribute('data-leaving', '1')   // 经典溶解
      } else {
        // 机械感离场：动画打在覆盖层/媒体包装层上（CSS 里定义），到点强拆。
        nodes.root.style.setProperty('--bshw-exit', EXIT_MS + 'ms')
        nodes.root.setAttribute('data-exit', EXIT)
        removeAfter = EXIT_MS + 80
      }
    }
    globalThis.setTimeout(function () {
      stopSuppress()
      if (readyTimer !== null) { globalThis.clearInterval(readyTimer); readyTimer = null }
      if (nodes.audio) { try { nodes.audio.pause() } catch (e) { /* 忽略 */ } }
      if (nodes.root && nodes.root.parentNode) nodes.root.parentNode.removeChild(nodes.root)
      try { globalThis.__BSHW_YUN_STATE__ = 'done' } catch (e) { /* 忽略 */ }
    }, removeAfter)
  }

  /* -------------------------------------------------------------- 手势 */

  function bind() {
    var onGesture = function (event, key) {
      if (state.entered) return
      // 音乐被自动播放策略拦住时：第一下点击解锁音乐（人已在场，必然放行），再点才进。
      if (state.audioLocked) {
        state.audioLocked = false
        if (nodes.audio) {
          var p = nodes.audio.play()
          if (p && typeof p.catch === 'function') p.catch(function () {})
        }
        if (nodes.hint) nodes.hint.textContent = '音乐已开启 · 点击进入'
        report('audio-unlocked', {})
        return
      }
      report('gesture', key ? { key: key } : {})
      enter(key ? 'gesture-' + key : 'gesture')
    }
    try {
      globalThis.addEventListener('pointerdown', function (e) { onGesture(e) }, true)
      globalThis.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') onGesture(event, event.key)
      })
    } catch (e) { /* 绑定失败不致命 */ }
  }

  /* -------------------------------------------------------------- 启动流程 */

  /** 自选开机壁纸：只存 id，直链在开机时从库存现场解析（永不过期，还带场景视频的最新探测结果）。 */
  var WP_ID = typeof cfg.wallpaperId === 'string' && cfg.wallpaperId !== '' ? cfg.wallpaperId : ''
  /** 离场动画（揭幕方式）：dissolve / iris / blinds / wipe / glitch。 */
  var EXIT = ['iris', 'blinds', 'wipe', 'glitch'].indexOf(cfg.exit) >= 0 ? cfg.exit : 'dissolve'
  var EXIT_MS = 900
  /** 起播缓冲（毫秒）—— v2 语义：**等待上限**。自适应揭幕会在
   *  [ADAPTIVE_MIN_MS, DELAY] 窗口内一旦实测帧 pacing 连续平稳就提前揭幕；
   *  测不到帧数据时维持固定上限行为（= v1 现状）。0 = 立即揭幕（关闭自适应）。 */
  var DELAY = clampNum(cfg.delayMs, 0, 10000, 1500)
  var delayDone = DELAY <= 0
  var revealStarted = false
  /** 自适应下限：无论机器多快，深色底至少挡这么久（覆盖起播最初期的风暴核心）。 */
  var ADAPTIVE_MIN_MS = 600
  /** 自选开机音乐：独立于壁纸声音压制 —— 选了就播（自动播放被拒则等一次手势解锁）。 */
  var AUDIO_URL = typeof cfg.audio === 'string' && cfg.audio !== '' ? cfg.audio : ''
  var AUDIO_VOL = clampNum(cfg.audioVolume, 0, 100, 80) / 100

  function noteFallback(text) {
    report('custom-fallback', { text: text })
    if (nodes.hint) nodes.hint.textContent = text
  }

  /** 自选模式：读壁纸库存 → 找到该 id → 取可直连视频流 → 播放；任何一步失败回落图层模式。 */
  function startCustomMode() {
    report('custom-mode', { id: WP_ID })
    if (nodes.hint) nodes.hint.textContent = '正在解析自选壁纸…'
    var resolved = false
    fetch('/wallpaper-engine/inventory', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)) })
      .then(function (data) {
        if (state.entered) return
        var list = (data && Array.isArray(data.wallpapers)) ? data.wallpapers : []
        var w = null
        for (var i = 0; i < list.length; i += 1) {
          if (String(list[i].id) === WP_ID) { w = list[i]; break }
        }
        var url = w ? (w.media || w.sceneVideo || '') : ''
        if (!url) {
          noteFallback(w ? '该壁纸没有直连视频流 · 已回落为跟随当前壁纸' : '壁纸库里找不到自选壁纸 · 已回落为跟随当前壁纸')
          startLayerMode()
          return
        }
        resolved = true
        startMediaMode(url)
      })
      .catch(function (e) {
        if (state.entered) return
        noteFallback('读取壁纸库失败 · 已回落为跟随当前壁纸')
        startLayerMode()
      })
    // 库存请求石沉大海的兜底：6 秒没解析出来就先回落图层模式（不干等）。
    globalThis.setTimeout(function () {
      if (!resolved && !state.entered && !state.wallpaperReady && !nodes.video) {
        noteFallback('壁纸库解析超时 · 已回落为跟随当前壁纸')
        startLayerMode()
      }
    }, 6000)
  }

  /** 揭幕（真正把深色底淡掉 + 起停留计时）—— 必须同时满足：壁纸就绪 && 起播缓冲结束。
   *  缓冲期内壁纸的起播卡顿被深色底**盖住**，揭幕时渲染已进入稳定期 ⇒ 观感连贯。 */
  function tryReveal() {
    if (revealStarted || !state.wallpaperReady || !delayDone || state.entered) return
    revealStarted = true
    if (nodes.root) nodes.root.setAttribute('data-ready', '1')   // 深色底淡出 → 揭幕
    report('wallpaper-ready', { at: Math.round(Date.now() - START_AT), delay: DELAY })
    if (!CLICK_ONLY) {
      globalThis.setTimeout(function () {
        if (state.entered) return
        enter('hold-done')
      }, HOLD)
    }
  }

  function onWallpaperReady() {
    if (state.wallpaperReady || state.entered) return
    state.wallpaperReady = true
    tryReveal()
    // 壁纸先就绪、缓冲还没到：等缓冲到点再揭（start() 里的定时器会调 tryReveal）。
  }

  /** 跟随当前壁纸模式：等壁纸引擎的活壁纸层挂上（每 200ms 轮询 + 最迟等待）。 */
  function startLayerMode() {
    if (wallpaperVisible()) { onWallpaperReady(); return }
    var tries = 0
    readyTimer = globalThis.setInterval(function () {
      tries += 1
      if (state.wallpaperReady || state.entered) { globalThis.clearInterval(readyTimer); readyTimer = null; return }
      if (wallpaperVisible()) { onWallpaperReady(); return }
      if (tries * 200 >= MAX_WAIT) {
        globalThis.clearInterval(readyTimer); readyTimer = null
        report('max-wait', { waitedMs: tries * 200 })
        if (!CLICK_ONLY) enter('max-wait')   // click 模式不自动进
      }
    }, 200)
  }

  /** 自选壁纸模式：直连播放该壁纸的视频流（视频壁纸 media / 场景壁纸内嵌 MP4）。
   *  失败（解码/文件被移走）⇒ 回落到「跟随当前壁纸」模式，绝不黑屏卡死。 */
  function startMediaMode(mediaUrl) {
    // 起播缓冲：风暴期创建/起播必丢帧 —— 步进等待（150ms 一查），
    // 自适应揭幕一旦把 delayDone 置真就立即动手，不必等满上限。
    if (!delayDone) {
      globalThis.setTimeout(function () {
        if (!state.entered) startMediaMode(mediaUrl)
      }, 150)
      return
    }
    var video = document.createElement('video')
    video.autoplay = true
    video.playsInline = true
    video.preload = 'auto'
    video.setAttribute('playsinline', '')
    video.muted = MUTE          // 静音策略：mute=开机全程无声；let-play=这段视频自带的声音就是开机 BGM
    video.src = mediaUrl
    video.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;background:#000'
    var mediaWrap = nodes.root.querySelector('.bshw-media')
    ;(mediaWrap || nodes.root).appendChild(video)
    nodes.video = video
    ourMedia.push(video)        // 放行名单（原型压制不拦自己的）
    report('media-mode', { src: String(mediaUrl).slice(0, 160) })

    var settled = false
    var revealed = false
    var reveal = function () {
      if (revealed || state.entered) return
      if (video.readyState < 2) return
      revealed = true
      onWallpaperReady()        // 复用同一条揭幕 + 停留计时路径
    }
    video.addEventListener('loadeddata', reveal)
    video.addEventListener('canplay', reveal)
    video.addEventListener('timeupdate', reveal)
    video.addEventListener('ended', function () { if (!state.entered) enter('media-ended') })
    video.addEventListener('error', function () {
      report('media-error', { code: video.error ? video.error.code : null, message: video.error ? video.error.message : null })
      try { if (video.parentNode) video.parentNode.removeChild(video) } catch (e) { /* 忽略 */ }
      nodes.video = null
      // 回落：跟随当前壁纸模式（壁纸层通常此时也快挂好了）
      if (nodes.hint) nodes.hint.textContent = '自选视频不可用 · 已回落为跟随当前壁纸'
      startLayerMode()
    })

    var p = video.play()
    if (p && typeof p.catch === 'function') {
      p.catch(function () {
        // 带声播放被策略拒绝且非静音配置 ⇒ 退回静音重试（静音自动播放一律放行）
        if (!video.muted) {
          video.muted = true
          var retry = video.play()
          if (retry && typeof retry.catch === 'function') retry.catch(function () { /* 8 秒兜底在等 */ })
        }
      })
    }

    // 兜底：8 秒还没画面 ⇒ 回落跟随当前壁纸模式（不是直接进界面，让壁纸层接管）
    globalThis.setTimeout(function () {
      if (settled || revealed || state.entered || state.wallpaperReady) return
      report('media-timeout', {})
      try { if (video.parentNode) video.parentNode.removeChild(video) } catch (e) { /* 忽略 */ }
      nodes.video = null
      if (nodes.hint) nodes.hint.textContent = '自选视频加载超时 · 已回落为跟随当前壁纸'
      startLayerMode()
    }, 8000)
  }

  /** 自适应揭幕：在 [ADAPTIVE_MIN_MS, DELAY] 窗口内实测帧 pacing ——
   *  连续 5 帧平稳（视频帧间隔 ≤50ms / 主线程 rAF 间隔 ≤26ms）即提前揭幕，
   *  深色底只挡"真正的风暴期"。测不到数据（无视频/rVFC 不可用）⇒ 维持固定上限
   *  行为（= 现状）。纯观察（只读帧时间戳），零侵入。
   *  · 视频元素可用 ⇒ requestVideoFrameCallback（真实呈现节奏，最准）
   *  · 否则 ⇒ requestAnimationFrame（主线程节奏代理，同样反映开机风暴） */
  function armAdaptiveReveal() {
    if (DELAY <= ADAPTIVE_MIN_MS) return
    var lastT = null
    var streak = 0
    var via = ''
    var target = null
    var rafId = 0
    var rvfcId = null
    var stopped = false
    var stop = function () {
      if (stopped) return
      stopped = true
      try { if (rafId) globalThis.cancelAnimationFrame(rafId) } catch (e) { /* 忽略 */ }
      try {
        if (rvfcId != null && target && typeof target.cancelVideoFrameCallback === 'function') {
          target.cancelVideoFrameCallback(rvfcId)
        }
      } catch (e) { /* 忽略 */ }
    }
    var measure = function (t) {
      if (stopped) return
      if (state.entered || revealStarted || Date.now() - START_AT >= DELAY) { stop(); return }
      if (lastT !== null) {
        var gap = t - lastT
        var good = gap > 0 && gap <= (via === 'rvfc' ? 50 : 26)
        streak = good ? streak + 1 : 0
        if (Date.now() - START_AT >= ADAPTIVE_MIN_MS && streak >= 5) {
          stop()
          delayDone = true
          report('adaptive-reveal', { via: via, at: Math.round(Date.now() - START_AT), gap: Math.round(gap) })
          tryReveal()
          return
        }
      }
      lastT = t
      if (via === 'rAF') rafId = globalThis.requestAnimationFrame(measure)
    }
    var acquire = function () {
      try {
        var ours = nodes.video
        if (ours && !ours.paused && ours.readyState >= 2) { target = ours; return true }
        var all = document.querySelectorAll('video')
        for (var i = 0; i < all.length; i += 1) {
          if (all[i].closest && all[i].closest('.bshw')) continue
          if (!all[i].paused && all[i].readyState >= 2) { target = all[i]; return true }
        }
      } catch (e) { /* 忽略 */ }
      return false
    }
    // 给壁纸挂载留 300ms；到点还没有可测目标（场景/WebGL 壁纸）⇒ 退回 rAF 主线程探测。
    globalThis.setTimeout(function () {
      if (stopped || state.entered || revealStarted) return
      if (acquire() && target && typeof target.requestVideoFrameCallback === 'function') {
        via = 'rvfc'
        var cb = function (t) {
          rvfcId = target.requestVideoFrameCallback(cb)
          measure(t)
        }
        rvfcId = target.requestVideoFrameCallback(cb)
      } else {
        via = 'rAF'
        target = null
        rafId = globalThis.requestAnimationFrame(measure)
      }
    }, 300)
  }

  function start() {
    build()
    installShellHider()
    startSuppress()
    bind()
    startAudio()   // 自选开机音乐：与画面同步起播
    try { globalThis.__BSHW_YUN_STATE__ = 'playing' } catch (e) { /* 忽略 */ }

    // 二选一：自选壁纸现场解析模式 / 跟随当前壁纸模式。
    if (WP_ID) startCustomMode()
    else startLayerMode()

    // 起播缓冲到点：放行揭幕/起播（自选模式的延后起播在 startMediaMode 里自等）。
    if (!delayDone) {
      armAdaptiveReveal()   // 自适应：帧率稳了就提前揭幕，不必等满上限
      globalThis.setTimeout(function () {
        delayDone = true
        tryReveal()
        report('delay-done', { delay: DELAY })
      }, DELAY)
    }

    // 绝对保险丝：无论何种模式（含点击进入），启动 65 秒后强制进入 ——
    // 保证原型拦截/遮罩/外壳隐藏一定被拆除，页面永远不会被开机画面"焊死"。
    globalThis.setTimeout(function () {
      if (!state.entered) enter('safety-fuse')
    }, MAX_WAIT + 65000)
  }

  start()
})()
