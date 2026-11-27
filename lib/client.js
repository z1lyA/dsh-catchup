/**
 * dsh-catchup — client half.
 *
 * A right-column panel for the CURRENT session: "I just switched to this one,
 * where did I leave off, and is anything waiting on me?"
 *
 * No model call, no RPC for the attached session. Every value is read from
 * projections DSH already folds on the host and pushes to the browser:
 *  - `session/control` baseline: turnOutline / todos / sessionStats / tokenUsage
 *  - `session/list` summary block: title / userQuestions / goal / modelSelection
 *  - `useSessionStatus()`: running / pendingInteraction / completionUnread
 *
 * Styling lives in one prefix-scoped stylesheet (`dsh-catchup-*`), derived from
 * currentColor with color-mix so it follows the host theme without reading it.
 * The design source of truth is design/catchup.html.
 */
window.__ModuleLoader__.load({
  id: 'dsh-catchup',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'catchup'
    const ID = 'dsh-catchup' // tab type id, also the slot key
    const KIND = 'catchup' // what ctx.sidebarRight.openTab() names
    const STYLE_ID = 'dsh-catchup-style'

    const ZH = {
      tab: '接上',
      open: '接上：这个会话停在哪、有没有事等你',
      guideDesc: '切过来之后，先看一眼这摊事停在哪',
      empty: '这个会话还是空的，先发一句话。',
      noPending: '没事等你，接着干就行',
      secPending: '需要你拍板',
      secNow: '现在停在哪',
      secTimeline: '最近几轮',
      running: '运行中',
      awaiting: '等你回答',
      approval: '待批准',
      unread: '有未读',
      todoLeft: '待办',
      promptLabel: '你',
      replyLabel: '它',
      more: '再看 %n 轮',
      less: '收起',
      turnUnit: '轮',
      lastAt: '上次动',
      tokens: '上下文',
      model: '模型',
      noText: '（没有文字输出）',
      cwd: '目录',
      placeholder: '这个会话还没有跑完一轮，接不上。',
    }
    const EN = {
      tab: 'Catch up',
      open: 'Catch up: where this session stands',
      guideDesc: 'Before you dive back in, see where it stopped',
      empty: 'This session is empty — send something first.',
      noPending: 'Nothing waiting on you',
      secPending: 'Waiting on you',
      secNow: 'Where it stands',
      secTimeline: 'Recent turns',
      running: 'Running',
      awaiting: 'Needs your answer',
      approval: 'Needs approval',
      unread: 'Unread',
      todoLeft: 'todos',
      promptLabel: 'You',
      replyLabel: 'It',
      more: 'Show %n more',
      less: 'Show less',
      turnUnit: 'turns',
      lastAt: 'Active',
      tokens: 'Context',
      model: 'Model',
      noText: '(no text)',
      cwd: 'Dir',
      placeholder: 'No completed turn yet — nothing to catch up on.',
    }

    // #region logic
    // Pure helpers. No React, no DOM, no host access — kept in their own region so
    // test/logic.test.mjs can lift and exercise them without a browser.
    function plain(text) {
      if (typeof text !== 'string' || text === '') return ''
      let s = text
      s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [label](url) -> label
      s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
      s = s.replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, '') // table separator rows: |---|---|
      s = s.replace(/[`*~]/g, '') // emphasis / code; `_` is kept, it is usually part of a name
      s = s.replace(/^\s*[-+]\s+/gm, '') // bullets
      s = s.replace(/^\s*>\s?/gm, '') // quotes
      s = s.replace(/\|/g, ' ') // table cells
      s = s.replace(/\s+/g, ' ').trim()
      return s
    }

    function firstSentence(text, max) {
      const s = plain(text)
      if (s === '') return ''
      const limit = typeof max === 'number' && max > 0 ? max : 90
      const m = s.match(/^(.{6,}?[。！？!?；;])/)
      let out = m ? m[1] : s
      if (out.length > limit) {
        out = out.slice(0, limit).replace(/[\s,，、；;:：]$/, '') + '…'
      }
      return out
    }

    function relTime(ts, now) {
      if (typeof ts !== 'number' || !isFinite(ts)) return ''
      const ref = typeof now === 'number' ? now : Date.now()
      const d = Math.max(0, ref - ts)
      const min = Math.floor(d / 60000)
      if (min < 1) return '<1m'
      if (min < 60) return min + 'm'
      const hr = Math.floor(min / 60)
      if (hr < 24) return hr + 'h'
      const day = Math.floor(hr / 24)
      if (day < 30) return day + 'd'
      return Math.floor(day / 30) + 'mo'
    }

    function fmtK(n) {
      if (typeof n !== 'number' || !isFinite(n) || n <= 0) return ''
      if (n < 1000) return String(Math.round(n))
      if (n < 10000) return (n / 1000).toFixed(1) + 'k'
      if (n < 1000000) return Math.round(n / 1000) + 'k'
      return (n / 1000000).toFixed(1) + 'M'
    }

    function textOf(value) {
      if (typeof value === 'string') return value
      if (value && typeof value === 'object') {
        for (const key of ['title', 'description', 'summary', 'label', 'reason', 'text', 'objective', 'prompt', 'command', 'question']) {
          if (typeof value[key] === 'string' && value[key] !== '') return value[key]
        }
      }
      return ''
    }

    /**
     * The single most important thing waiting on the human, by precedence:
     * a pending interaction (approval / question from DSH) beats an agent-authored
     * question, which beats an unfinished todo. Returns null when nothing waits.
     */
    function pendingOf(status, values) {
      const pi = status && status.pendingInteraction
      if (pi) {
        const kind = String((pi && (pi.kind || pi.type || pi.domain)) || '')
        const isApproval = /approval|permission|sandbox|consent/i.test(kind)
        return { rank: 1, label: isApproval ? 'approval' : 'awaiting', detail: textOf(pi) }
      }

      const q = values && values.userQuestions
      const active = q && Array.isArray(q.active) && q.active.length > 0 ? q.active[0] : null
      if (active) {
        const first = active && Array.isArray(active.questions) ? active.questions[0] : null
        const options = first && Array.isArray(first.options) ? first.options : null
        return {
          rank: 2,
          label: 'awaiting',
          detail: textOf(first),
          options: options
            ? options.map((o) => (typeof o === 'string' ? o : textOf(o))).filter((x) => x !== '')
            : null,
        }
      }

      const todos = values && values.todos
      if (Array.isArray(todos)) {
        const open = todos.filter((x) => x && x.status !== 'completed' && typeof x.content === 'string')
        if (open.length > 0) return { rank: 3, label: 'todo', detail: open[0].content, count: open.length }
      }

      return null
    }

    function contextOf(usage) {
      if (!usage || typeof usage !== 'object') return 0
      return (
        (usage.uncachedInputTokens || 0) +
        (usage.cacheReadTokens || 0) +
        (usage.cacheWriteTokens || 0) +
        (usage.outputTokens || 0)
      )
    }

    function modelLabel(sel) {
      if (!sel || typeof sel !== 'object') return ''
      const provider = typeof sel.provider === 'string' ? sel.provider : ''
      const model = typeof sel.model === 'string' ? sel.model : typeof sel.id === 'string' ? sel.id : ''
      return [provider, model].filter((x) => x !== '').join('/')
    }

    /** `turnOutline`'s wire view is the turn array itself; tolerate a wrapper too. */
    function turnsOf(outline) {
      if (Array.isArray(outline)) return outline
      if (outline && Array.isArray(outline.turns)) return outline.turns
      return []
    }
    // #endregion logic

    // ------------------------------------------------------------------- style

    const CSS = [
      '.dsh-catchup{',
      '--cu-soft:color-mix(in oklab,currentColor 70%,transparent);',
      '--cu-mute:color-mix(in oklab,currentColor 62%,transparent);',
      '--cu-warn:color-mix(in oklab,#a86c08 80%,currentColor);',
      '--cu-warn-tint:color-mix(in oklab,#c98a1b 10%,transparent);',
      '--cu-warn-line:color-mix(in oklab,#c98a1b 60%,transparent);',
      'height:100%;overflow-y:auto;overflow-x:hidden;color:inherit;font:inherit;}',
      '.dsh-catchup .cu{padding:16px 18px 28px;display:grid;gap:18px;align-content:start;}',
      '.dsh-catchup .cu-head{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.dsh-catchup .cu-title{font-size:14px;font-weight:600;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;}',
      '.dsh-catchup .cu-chip{flex:0 0 auto;font-size:12px;line-height:19px;padding:0 7px;border:1px solid currentColor;border-radius:5px;white-space:nowrap;}',
      '.dsh-catchup .cu-chip-warn{color:var(--cu-warn);}',
      '.dsh-catchup .cu-kicker{font-size:12px;letter-spacing:.06em;color:var(--cu-soft);margin-bottom:6px;}',
      '.dsh-catchup .cu-hero{border:1px solid var(--cu-warn-line);border-left-width:2px;background:var(--cu-warn-tint);border-radius:10px;padding:12px 14px 13px;}',
      '.dsh-catchup .cu-hero .cu-kicker{color:var(--cu-warn);}',
      '.dsh-catchup .cu-ask{margin:0;font-size:13.5px;line-height:1.6;}',
      '.dsh-catchup .cu-opts{list-style:none;margin:9px 0 0;padding:0;display:grid;gap:6px;}',
      '.dsh-catchup .cu-opts li{display:flex;gap:8px;align-items:baseline;font-size:13px;line-height:1.5;}',
      '.dsh-catchup .cu-key{flex:0 0 auto;width:19px;height:19px;border-radius:4px;border:1px solid color-mix(in oklab,currentColor 25%,transparent);font-size:12px;line-height:17px;text-align:center;color:var(--cu-soft);}',
      '.dsh-catchup .cu-clear{display:flex;align-items:center;gap:7px;font-size:13px;color:var(--cu-soft);}',
      '.dsh-catchup .cu-clear svg{width:15px;height:15px;flex:0 0 auto;opacity:.75;}',
      '.dsh-catchup .cu-now{margin:0;font-size:14px;line-height:1.68;}',
      '.dsh-catchup .cu-turns{list-style:none;margin:0;padding:0;display:grid;gap:12px;}',
      '.dsh-catchup .cu-turn{display:grid;grid-template-columns:22px 1fr;gap:8px;}',
      '.dsh-catchup .cu-idx{font-size:12px;color:var(--cu-mute);font-variant-numeric:tabular-nums;padding-top:2px;text-align:right;}',
      '.dsh-catchup .cu-you{margin:0;font-size:13px;line-height:1.5;font-weight:500;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;}',
      '.dsh-catchup .cu-it{margin:2px 0 0;font-size:13px;line-height:1.55;color:var(--cu-soft);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.dsh-catchup .cu-more{margin-top:6px;padding:5px 2px;min-height:28px;border:0;background:none;cursor:pointer;font:inherit;font-size:12.5px;color:var(--cu-soft);text-decoration:underline;text-underline-offset:3px;}',
      '.dsh-catchup .cu-more:hover{color:inherit;}',
      '.dsh-catchup .cu-facts{display:flex;flex-wrap:wrap;gap:3px 10px;font-size:12px;color:var(--cu-mute);font-variant-numeric:tabular-nums;border-top:1px solid color-mix(in oklab,currentColor 14%,transparent);padding-top:12px;}',
      '.dsh-catchup .cu-cwd{flex:1 1 100%;word-break:break-all;}',
      '.dsh-catchup .cu-empty{padding:40px 6px;text-align:center;color:var(--cu-soft);font-size:13px;}',
    ].join('')

    function ensureStyle() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      if (document.getElementById(STYLE_ID)) return () => {}
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
      return () => {
        if (el.parentNode) el.parentNode.removeChild(el)
      }
    }

    // -------------------------------------------------------------------- view

    const CHECK = 'M3 8.5l3.2 3.2L13 5.5'
    const ICON = 'M6 3.5h7.5L18 8v12.5H6zM13.5 3.5V8H18M14 14.5H9.5M11.5 12L9 14.5l2.5 2.5'

    function Glyph(props) {
      return h('svg', {
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.weight || 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: props.size ? { width: props.size, height: props.size, flex: '0 0 auto' } : undefined,
      }, h('path', { d: props.d }))
    }

    function Chip(props) {
      if (!props.kind) return null
      const text = props.t(props.kind)
      if (typeof text !== 'string' || text === '' || text === props.kind) return null
      const warn = props.kind === 'approval'
      return h('span', { className: warn ? 'cu-chip cu-chip-warn' : 'cu-chip' }, text)
    }

    function Block(props) {
      return h('section', null,
        h('div', { className: 'cu-kicker' }, props.title),
        props.children)
    }

    function DigestBody(props) {
      const sid = props.sessionId
      const t = props.t
      const list = props.useSessions((s) => s)
      const status = props.useSessionStatus((s) => (s && typeof s.get === 'function' ? s.get(sid) : undefined))
      const [expanded, setExpanded] = React.useState(false)
      const [now, setNow] = React.useState(Date.now())

      React.useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(id)
      }, [])

      const summary = list && list.byId ? list.byId[sid] : undefined
      const projected = list && list.projectionsBySession ? list.projectionsBySession[sid] : undefined
      const values = (projected && projected.values) || (summary && summary.projectionValues) || {}
      const outline = (props.useProjection && props.useProjection('turnOutline')) || values.turnOutline
      const turns = turnsOf(outline)

      const pending = pendingOf(status, values)
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null
      const nowLine = lastTurn ? firstSentence(lastTurn.response, 110) : ''

      // Silence is the normal state: only speak up while something is happening.
      let statusKind = ''
      if (status && status.running) statusKind = 'running'
      else if (pending && pending.label === 'approval') statusKind = 'approval'
      else if (status && status.pendingInteraction) statusKind = 'awaiting'
      else if (pending && pending.label === 'awaiting') statusKind = 'awaiting'
      else if (status && status.completionUnread) statusKind = 'unread'

      const shown = expanded ? turns : turns.slice(-4)
      const hidden = turns.length - shown.length
      const title = (summary && (summary.displayTitle || summary.title)) || sid

      const out = [h('div', { key: 'head', className: 'cu-head' },
        h('div', { className: 'cu-title', title }, title),
        h(Chip, { kind: statusKind, t }))]

      if (summary && summary.blank && turns.length === 0) {
        out.push(h('div', { key: 'blank', className: 'cu-empty' }, t('empty')))
        return h('div', { className: 'dsh-catchup' }, h('div', { className: 'cu' }, out))
      }

      // 1. The only thing that is a decision, and the only coloured block.
      if (pending) {
        const kids = [h('div', { key: 'k', className: 'cu-kicker' }, t('secPending'))]
        const detail = firstSentence(pending.detail, 150) || pending.detail
        if (detail) kids.push(h('p', { key: 'd', className: 'cu-ask' }, detail))
        if (pending.options && pending.options.length > 0) {
          kids.push(h('ul', { key: 'o', className: 'cu-opts' }, pending.options.slice(0, 6).map((o, i) =>
            h('li', { key: i },
              h('span', { className: 'cu-key' }, String.fromCharCode(65 + i)),
              h('span', null, o)))))
        }
        if (pending.count > 1) {
          kids.push(h('div', { key: 'c', className: 'cu-kicker', style: { marginTop: 8, marginBottom: 0 } },
            pending.count + ' × ' + t('todoLeft')))
        }
        out.push(h('section', { key: 'hero', className: 'cu-hero' }, kids))
      } else {
        out.push(h('div', { key: 'clear', className: 'cu-clear' },
          h(Glyph, { d: CHECK, size: 15 }),
          h('span', null, t('noPending'))))
      }

      // 2. Where it stopped, in its own words.
      out.push(h(Block, { key: 'now', title: t('secNow') },
        h('p', { className: 'cu-now' }, nowLine || t('placeholder'))))

      // 3. Recent turns: numbers on the left, your line, its line.
      if (turns.length > 0) {
        const rows = shown.map((turn, i) =>
          h('li', { key: turn && turn.seq != null ? String(turn.seq) : i, className: 'cu-turn' },
            h('span', { className: 'cu-idx' }, turn && turn.turn != null ? String(turn.turn) : ''),
            h('div', null,
              h('p', { className: 'cu-you' }, firstSentence(turn.prompt, 62) || '—'),
              h('p', { className: 'cu-it' }, firstSentence(turn.response, 132) || t('noText')))))
        let toggle = null
        if (hidden > 0) {
          toggle = h('button', { key: 'more', type: 'button', className: 'cu-more', onClick: () => setExpanded(true) },
            String(t('more')).replace('%n', String(hidden)))
        } else if (expanded && turns.length > 4) {
          toggle = h('button', { key: 'less', type: 'button', className: 'cu-more', onClick: () => setExpanded(false) }, t('less'))
        }
        out.push(h(Block, { key: 'timeline', title: t('secTimeline') },
          h('ol', { className: 'cu-turns' }, rows),
          toggle))
      }

      // 4. Machine facts.
      const facts = []
      if (turns.length > 0) facts.push(turns.length + ' ' + t('turnUnit'))
      const meta = values.sessionListMetadata
      if (meta && typeof meta.lastPromptAt === 'number') {
        const rel = relTime(meta.lastPromptAt, now)
        if (rel !== '') facts.push(t('lastAt') + ' ' + rel)
      }
      const ctxTokens = contextOf(values.tokenUsage)
      if (ctxTokens > 0) facts.push(t('tokens') + ' ' + fmtK(ctxTokens))
      const stats = values.sessionStats
      if (stats && typeof stats.llmMs === 'number' && stats.llmMs > 0) facts.push('LLM ' + Math.round(stats.llmMs / 1000) + 's')
      const model = modelLabel(values.modelSelection)
      if (model !== '') facts.push(model)
      if (facts.length > 0 || (summary && summary.cwd)) {
        out.push(h('footer', { key: 'facts', className: 'cu-facts' },
          facts.map((f, i) => h('span', { key: i }, f)),
          summary && typeof summary.cwd === 'string' && summary.cwd !== ''
            ? h('span', { key: 'cwd', className: 'cu-cwd' }, summary.cwd)
            : null))
      }

      return h('div', { className: 'dsh-catchup' }, h('div', { className: 'cu' }, out))
    }

    function DigestTitle(props) {
      return props.t('tab')
    }

    /** Icon-only, like the design bench's header button: no label competing with the title. */
    function HeaderButton(props) {
      const label = props.t('open')
      return h('div', {
        title: label,
        'aria-label': label,
        role: 'button',
        tabIndex: 0,
        onClick: () => props.open(props.sessionId),
        onKeyDown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            props.open(props.sessionId)
          }
        },
        style: {
          width: 28,
          height: 28,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 8,
          cursor: 'pointer',
          color: 'inherit',
          opacity: 0.75,
        },
      }, h(Glyph, { d: ICON, weight: 1.7, size: 17 }))
    }

    function apply(ctx) {
      let t = (key) => key
      try {
        if (ctx.locale && typeof ctx.locale.bind === 'function') t = ctx.locale.bind(NS)
      } catch (e) {
        console.warn('[dsh-catchup] locale bind failed', e)
      }
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-catchup: copy')
      } catch (e) {
        console.warn('[dsh-catchup] locale register failed', e)
      }

      try {
        ctx.effect(ensureStyle, 'dsh-catchup: style')
      } catch (e) {
        console.warn('[dsh-catchup] style injection failed', e)
      }

      // openTab throws when no Session surface is mounted, and the button only makes
      // sense for the Session actually on screen.
      const open = (sid) => {
        try {
          const mounted = ctx.sidebarRight.mounted
          const onScreen = mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : sid
          if (onScreen !== sid) return
          ctx.sidebarRight.openTab(KIND)
        } catch (e) {
          console.warn('[dsh-catchup] cannot open the right column', e)
        }
      }

      try {
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID,
          kind: KIND,
          title: () => t('tab'),
          keepMounted: true,
          guide: [{ id: 'open', order: 40, title: () => t('tab'), description: () => t('guideDesc') }],
        }), 'dsh-catchup: tab type')
      } catch (e) {
        console.warn('[dsh-catchup] tab type registration failed', e)
      }

      try {
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: ID,
          locale: NS,
        }, DigestBody)), 'dsh-catchup: tab body')
      } catch (e) {
        console.warn('[dsh-catchup] tab body registration failed', e)
      }

      try {
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: ID,
          locale: NS,
        }, DigestTitle)), 'dsh-catchup: tab title')
      } catch (e) {
        console.warn('[dsh-catchup] tab title registration failed', e)
      }

      try {
        ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: ID,
          order: -8,
          locale: NS,
          inject: (sessionId) => ({ sessionId, open }),
        }, HeaderButton)), 'dsh-catchup: header button')
      } catch (e) {
        console.warn('[dsh-catchup] header button registration failed', e)
      }
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']
    return module.exports
  },
})
