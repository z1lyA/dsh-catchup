/**
 * dsh-catchup — client half.
 *
 * A right-column panel for the session you just switched to. Three blocks, and
 * nothing else:
 *   1. what this session is        — its title, plus the goal when declared
 *   2. what is still open          — every pending item as one condensed line
 *   3. where it stands             — the last turn's own words, plus three facts
 *
 * No model call, no RPC for the attached session. Every value is read from
 * projections DSH already folds on the host and pushes to the browser:
 *  - `session/control` baseline: turnOutline (last turn) / todos / sessionStats / tokenUsage
 *  - `session/list` summary block: title / userQuestions / goal
 *  - `useSessionStatus()`: running / pendingInteraction / completionUnread
 *
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
      running: '运行中',
      awaiting: '等你回答',
      approval: '待批准',
      unread: '有未读',
      tagApproval: '批准',
      tagAsk: '回答',
      tagTodo: '待办',
      tagOpen: '待定',
      total: '累计',
      turnUnit: '轮',
      lastAt: '上次动',
      placeholder: '这个会话还没有跑完一轮，接不上。',
      reading: '正在读这个会话…',
      briefFailed: '摘要没生成',
      cost: '摘要',
      costNone: '没生成',
      costUnknown: '用量未知',
    }
    const EN = {
      tab: 'Catch up',
      open: 'Catch up: where this session stands',
      guideDesc: 'Before you dive back in, see where it stopped',
      empty: 'This session is empty — send something first.',
      running: 'Running',
      awaiting: 'Needs your answer',
      approval: 'Needs approval',
      unread: 'Unread',
      tagApproval: 'Approve',
      tagAsk: 'Answer',
      tagTodo: 'Todo',
      tagOpen: 'Decide',
      total: 'Total',
      turnUnit: 'turns',
      lastAt: 'Active',
      placeholder: 'No completed turn yet — nothing to catch up on.',
      reading: 'Reading this session…',
      briefFailed: 'summary failed',
      cost: 'Digest',
      costNone: 'not generated',
      costUnknown: 'usage unreported',
    }

    // #region logic
    // Pure helpers. No React, no DOM, no host access — kept in their own region so
    // test/logic.test.mjs can lift and exercise them without a browser.
    const MAX_ITEMS = 4 // the open-items block is a glance, not a backlog

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

    /** `turnOutline`'s wire view is the turn array itself; tolerate a wrapper too. */
    function turnsOf(outline) {
      if (Array.isArray(outline)) return outline
      if (outline && Array.isArray(outline.turns)) return outline.turns
      return []
    }

    /**
     * Everything still open, one condensed line each, most blocking first:
     * an approval or question from DSH, then questions the agent asked, then
     * unfinished todos. Capped so the block stays a glance and not a backlog.
     */
    function pendingItemsOf(status, values) {
      const items = []

      const pi = status && status.pendingInteraction
      if (pi) {
        const kind = String((pi && (pi.kind || pi.type || pi.domain)) || '')
        const isApproval = /approval|permission|sandbox|consent/i.test(kind)
        items.push({ kind: isApproval ? 'approval' : 'ask', text: firstSentence(textOf(pi), 130) })
      }

      const q = values && values.userQuestions
      if (q && Array.isArray(q.active)) {
        for (const entry of q.active) {
          const first = entry && Array.isArray(entry.questions) ? entry.questions[0] : null
          const text = firstSentence(textOf(first), 130)
          if (text !== '') items.push({ kind: 'ask', text })
        }
      }

      const todos = values && values.todos
      if (Array.isArray(todos)) {
        for (const todo of todos) {
          if (todo && todo.status !== 'completed' && typeof todo.content === 'string') {
            const text = firstSentence(todo.content, 130)
            if (text !== '') items.push({ kind: 'todo', text })
          }
        }
      }

      return items.slice(0, MAX_ITEMS)
    }

    /** The one line that says what this session is for, when the session declares a goal. */
    function goalOf(values) {
      return firstSentence(textOf(values && values.goal), 140)
    }

    /** Accepts the host's answer, or nothing at all — never throws on a malformed payload. */
    function decodeDigest(payload) {
      if (!payload || typeof payload !== 'object') return null
      const now = typeof payload.now === 'string' ? payload.now.trim() : ''
      if (now === '') return null
      const intro = typeof payload.intro === 'string' ? payload.intro.trim() : ''
      const raw = payload.usage
      const usage = raw && typeof raw === 'object' && (Number(raw.input) > 0 || Number(raw.output) > 0)
        ? { input: Math.max(0, Math.round(Number(raw.input) || 0)), output: Math.max(0, Math.round(Number(raw.output) || 0)) }
        : null
      const open = Array.isArray(payload.open)
        ? payload.open.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()).slice(0, 4)
        : []
      const t = payload.totals
      const totals = t && typeof t === 'object' && Number(t.calls) > 0
        ? {
            calls: Math.max(0, Math.round(Number(t.calls) || 0)),
            input: Math.max(0, Math.round(Number(t.input) || 0)),
            output: Math.max(0, Math.round(Number(t.output) || 0)),
          }
        : null
      return { intro, now, open, usage, totals }
    }

    /**
     * What the panel considers "waiting on you": the structured signals first
     * (an approval, a tool question, an unfinished todo), then whatever the model
     * spotted in prose — which is the only way a plain "回一句做不做" gets caught.
     */
    function mergeOpen(structured, extra) {
      const out = Array.isArray(structured) ? structured.slice() : []
      const seen = new Set(out.map((item) => item && item.text))
      for (const raw of Array.isArray(extra) ? extra : []) {
        if (typeof raw !== 'string') continue
        const text = raw.trim()
        if (text === '' || seen.has(text)) continue
        seen.add(text)
        out.push({ kind: 'open', text })
      }
      return out.slice(0, 5)
    }
    // #endregion logic

    // ------------------------------------------------------------------- style

    const CSS = [
      '.dsh-catchup{',
      '--cu-soft:color-mix(in oklab,currentColor 68%,transparent);',
      '--cu-mute:color-mix(in oklab,currentColor 60%,transparent);',
      '--cu-warn:color-mix(in oklab,#a86c08 80%,currentColor);',
      '--cu-warn-tint:color-mix(in oklab,#c98a1b 10%,transparent);',
      '--cu-warn-line:color-mix(in oklab,#c98a1b 60%,transparent);',
      'height:100%;overflow-y:auto;overflow-x:hidden;color:inherit;font:inherit;}',
      '.dsh-catchup .cu{height:100%;box-sizing:border-box;padding:16px 18px 14px;display:grid;grid-template-rows:minmax(84px,0.95fr) minmax(120px,1.6fr) minmax(72px,0.85fr);}',
      '.dsh-catchup .cu[data-open="0"]{grid-template-rows:minmax(84px,0.9fr) minmax(140px,2fr);}',
      '.dsh-catchup .cu-block{display:flex;flex-direction:column;justify-content:center;gap:8px;padding:14px 0 12px;border-top:1px solid color-mix(in oklab,currentColor 12%,transparent);min-height:0;overflow:hidden;}',
      '.dsh-catchup .cu-block:first-child{border-top:0;padding-top:0;justify-content:flex-start;}',
      '.dsh-catchup .cu-open{background:var(--cu-warn-tint);border-top-color:var(--cu-warn-line);border-radius:0 0 10px 10px;padding:13px 12px 12px;margin:0 -6px -2px;gap:9px;}',
      '.dsh-catchup .cu-head{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.dsh-catchup .cu-title{font-size:16px;font-weight:650;letter-spacing:-.012em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto;min-width:0;}',
      '.dsh-catchup .cu-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:color-mix(in oklab,currentColor 40%,transparent);}',
      '.dsh-catchup .cu-dot[data-kind="running"]{background:color-mix(in oklab,currentColor 85%,transparent);}',
      '.dsh-catchup .cu-dot[data-kind="approval"]{background:var(--cu-warn);}',
      '.dsh-catchup .cu-chip{flex:0 0 auto;font-size:12px;line-height:19px;padding:0 7px;border:1px solid currentColor;border-radius:5px;white-space:nowrap;}',
      '.dsh-catchup .cu-chip-warn{color:var(--cu-warn);}',
      '.dsh-catchup .cu-goal{margin:0;font-size:13.5px;line-height:1.65;color:var(--cu-soft);border-left:2px solid color-mix(in oklab,currentColor 20%,transparent);padding-left:10px;}',
      '.dsh-catchup .cu-item{margin:0;font-size:13.5px;line-height:1.5;display:flex;gap:8px;align-items:baseline;}',
      '.dsh-catchup .cu-tag{flex:0 0 auto;font-size:12px;line-height:18px;padding:0 5px;border:1px solid color-mix(in oklab,currentColor 28%,transparent);border-radius:4px;color:var(--cu-soft);white-space:nowrap;}',
      '.dsh-catchup .cu-tag-warn{color:var(--cu-warn);border-color:var(--cu-warn-line);}',
      '.dsh-catchup .cu-now{margin:0;font-size:15px;line-height:1.72;}',
      '.dsh-catchup .cu-facts{margin:auto 0 0;padding-top:9px;font-size:12px;line-height:1.6;color:var(--cu-mute);border-top:1px solid color-mix(in oklab,currentColor 12%,transparent);font-variant-numeric:tabular-nums;}',
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
      return h('span', { className: props.kind === 'approval' ? 'cu-chip cu-chip-warn' : 'cu-chip' }, text)
    }

    function DigestBody(props) {
      const sid = props.sessionId
      const t = props.t
      const list = props.useSessions((s) => s)
      const status = props.useSessionStatus((s) => (s && typeof s.get === 'function' ? s.get(sid) : undefined))
      const [now, setNow] = React.useState(Date.now())
      const [digest, setDigest] = React.useState(null)
      const [brief, setBrief] = React.useState('idle')
      const [reason, setReason] = React.useState('')

      React.useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(id)
      }, [])

      // One small model call, on the Host, only when this panel is actually opened.
      // The Host answers from its cache unless the session has moved on.
      React.useEffect(() => {
        if (typeof location === 'undefined' || typeof fetch !== 'function') return undefined
        const controller = new AbortController()
        setBrief('loading')
        fetch('api/session-digest?sessionId=' + encodeURIComponent(sid), { signal: controller.signal })
          .then((res) => {
            if (res.ok) return res.json()
            return res.text().then((text) => { throw new Error(text) })
          })
          .then((payload) => {
            const decoded = decodeDigest(payload)
            if (decoded === null) {
              setBrief('error')
              return
            }
            setDigest(decoded)
            setBrief('ok')
          })
          .catch((error) => {
            if (controller.signal.aborted) return
            setBrief('error')
            // Keep the host's own words: "host not loaded" and "model failed" look
            // identical in the panel otherwise, and they need different fixes.
            setReason(String((error && error.message) || error || '').slice(0, 240))
          })
        return () => controller.abort()
      }, [sid])

      const summary = list && list.byId ? list.byId[sid] : undefined
      const projected = list && list.projectionsBySession ? list.projectionsBySession[sid] : undefined
      const values = (projected && projected.values) || (summary && summary.projectionValues) || {}
      const outline = (props.useProjection && props.useProjection('turnOutline')) || values.turnOutline
      const turns = turnsOf(outline)
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null

      const items = mergeOpen(pendingItemsOf(status, values), digest && digest.open)
      const goal = goalOf(values)
      const nowLine = lastTurn ? firstSentence(lastTurn.response, 160) : ''
      const title = (summary && (summary.displayTitle || summary.title)) || sid

      // The Host writes two sentences with one small model call; until it answers,
      // and if it cannot, the panel still says something true from local data.
      const intro = (digest && digest.intro) || goal
      const nowText = digest && digest.now
        ? digest.now
        : brief === 'loading'
          ? t('reading')
          : nowLine || t('placeholder')

      // Silence is the normal state: only speak up while something is happening.
      let statusKind = ''
      if (status && status.running) statusKind = 'running'
      else if (items.some((it) => it.kind === 'approval')) statusKind = 'approval'
      else if (status && status.pendingInteraction) statusKind = 'awaiting'
      else if (items.some((it) => it.kind === 'ask' || it.kind === 'open')) statusKind = 'awaiting'
      else if (status && status.completionUnread) statusKind = 'unread'

      if (summary && summary.blank && turns.length === 0) {
        return h('div', { className: 'dsh-catchup' },
          h('div', { className: 'cu', 'data-open': '0' },
            h('section', { className: 'cu-block' },
              h('div', { className: 'cu-head' }, h('div', { className: 'cu-title', title }, title)),
              h('p', { className: 'cu-empty' }, t('empty')))))
      }

      // 1. What this session is.
      const lead = h('section', { key: 'what', className: 'cu-block' },
        h('div', { className: 'cu-head' },
          statusKind !== '' ? h('span', { className: 'cu-dot', 'data-kind': statusKind }) : null,
          h('div', { className: 'cu-title', title }, title),
          h(Chip, { kind: statusKind, t })),
        intro !== '' ? h('p', { className: 'cu-goal' }, intro) : null)

      // 2. Where it stands.
      const facts = []
      if (turns.length > 0) facts.push(turns.length + ' ' + t('turnUnit'))
      const meta = values.sessionListMetadata
      if (meta && typeof meta.lastPromptAt === 'number') {
        const rel = relTime(meta.lastPromptAt, now)
        if (rel !== '') facts.push(t('lastAt') + ' ' + rel)
      }
      // Only the plugin's own spend. The session's context usage used to be here
      // too, which read as if reading this panel had cost 34M tokens.
      if (brief === 'ok') {
        const u = digest && digest.usage
        facts.push(t('cost') + ' ' + (u ? fmtK(u.input) + '↑ / ' + fmtK(u.output) + '↓' : t('costUnknown')))
      } else if (brief === 'error') {
        facts.push(t('cost') + ' ' + t('costNone') + ' · 0 token')
      }
      if (digest && digest.totals) {
        const all = digest.totals
        facts.push(t('total') + ' ' + all.calls + ' 次 · ' + fmtK(all.input) + '↑ / ' + fmtK(all.output) + '↓')
      }

      const tail = h('section', { key: 'where', className: 'cu-block' },
        h('p', { className: 'cu-now' }, nowText),
        facts.length > 0 ? h('p', { className: 'cu-facts', title: reason || undefined }, facts.join(' · ')) : null)

      // 3. What is still open — the only coloured block, and only when there is one.
      const open = items.length > 0
        ? h('section', { key: 'open', className: 'cu-block cu-open' },
            items.map((item, i) =>
              h('p', { key: i, className: 'cu-item' },
                h('span', {
                  className: item.kind === 'approval' ? 'cu-tag cu-tag-warn' : 'cu-tag',
                }, t(
                  item.kind === 'approval' ? 'tagApproval'
                    : item.kind === 'todo' ? 'tagTodo'
                      : item.kind === 'open' ? 'tagOpen'
                        : 'tagAsk',
                )),
                item.text !== '' ? h('span', null, item.text) : null)))
        : null

      return h('div', { className: 'dsh-catchup' },
        h('div', { className: 'cu', 'data-open': items.length > 0 ? '1' : '0' }, lead, tail, open))
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
