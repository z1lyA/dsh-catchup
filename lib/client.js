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
 */
window.__ModuleLoader__.load({
  id: 'dsh-catchup',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'catchup'
    const ID = 'dsh-catchup' // tab type id, also the slot key
    const KIND = 'catchup' // what ctx.sidebarRight.openTab() names

    const ZH = {
      tab: '接上',
      open: '接上：这个会话停在哪、有没有事等你',
      guideDesc: '切过来之后，先看一眼这摊事停在哪',
      empty: '这个会话还是空的，先发一句话。',
      noPending: '没事等你',
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
      const joined = [provider, model].filter((x) => x !== '').join('/')
      return joined
    }
    // #endregion logic

    // ------------------------------------------------------------------- view

    const S = {
      body: {
        height: '100%',
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '12px 14px 24px',
        fontSize: 13,
        lineHeight: 1.6,
        color: 'inherit',
        boxSizing: 'border-box',
      },
      head: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 },
      title: {
        flex: '1 1 auto',
        minWidth: 0,
        fontSize: 13,
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      badge: {
        flex: '0 0 auto',
        fontSize: 11,
        lineHeight: '17px',
        padding: '0 7px',
        borderRadius: 5,
        border: '1px solid currentColor',
        opacity: 0.8,
        whiteSpace: 'nowrap',
      },
      card: {
        border: '1px solid rgba(127,127,127,0.22)',
        borderRadius: 8,
        padding: '9px 11px 10px',
        marginBottom: 10,
      },
      lead: { borderColor: 'rgba(247,183,49,0.65)', background: 'rgba(247,183,49,0.07)' },
      label: {
        fontSize: 10.5,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        opacity: 0.5,
        marginBottom: 5,
      },
      text: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      dim: { opacity: 0.55 },
      opts: { margin: '6px 0 0', paddingLeft: 17, opacity: 0.85, fontSize: 12.5 },
      turn: { marginBottom: 10 },
      turnHead: { fontSize: 10.5, opacity: 0.4, marginBottom: 1 },
      userLine: { fontWeight: 500 },
      botLine: { opacity: 0.78 },
      meta: { display: 'flex', flexWrap: 'wrap', gap: '3px 12px', fontSize: 11.5, opacity: 0.55 },
      more: {
        background: 'none',
        border: 0,
        padding: 0,
        marginTop: 2,
        font: 'inherit',
        fontSize: 12,
        color: 'inherit',
        opacity: 0.55,
        cursor: 'pointer',
        textDecoration: 'underline',
      },
    }

    function Badge(props) {
      if (!props.kind) return null
      const text = props.t(props.kind)
      if (typeof text !== 'string' || text === '' || text === props.kind) return null
      return h('span', { style: S.badge }, text)
    }

    function Card(props) {
      return h('div', { style: props.lead ? { ...S.card, ...S.lead } : S.card },
        h('div', { style: S.label }, props.title),
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
      const turns = outline && Array.isArray(outline.turns) ? outline.turns : []

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

      const out = []
      out.push(h('div', { key: 'head', style: S.head },
        h('span', { style: S.title, title: (summary && (summary.displayTitle || summary.title)) || sid },
          (summary && (summary.displayTitle || summary.title)) || sid),
        h(Badge, { kind: statusKind, t })))

      const isBlank = !!(summary && summary.blank) && turns.length === 0

      if (isBlank) {
        out.push(h('div', { key: 'blank', style: { ...S.text, ...S.dim } }, t('empty')))
        return h('div', { style: S.body }, out)
      }

      // 1. The only thing that is a decision.
      const pendingKids = []
      if (pending) {
        pendingKids.push(h(Badge, { key: 'b', kind: pending.label === 'todo' ? 'todoLeft' : pending.label === 'approval' ? 'approval' : 'awaiting', t }))
        const detail = firstSentence(pending.detail, 150)
        if (detail !== '') pendingKids.push(h('div', { key: 'd', style: { ...S.text, marginTop: 3 } }, detail))
        if (pending.options && pending.options.length > 0) {
          pendingKids.push(h('ul', { key: 'o', style: S.opts }, pending.options.slice(0, 6).map((o, i) => h('li', { key: i, style: S.text }, o))))
        }
        if (pending.count > 1) pendingKids.push(h('div', { key: 'c', style: { ...S.dim, fontSize: 11.5, marginTop: 3 } }, pending.count + ' × ' + t('todoLeft')))
      } else {
        pendingKids.push(h('div', { key: 'n', style: { ...S.dim, fontSize: 12 } }, t('noPending')))
      }
      out.push(h(Card, { key: 'pending', title: t('secPending'), lead: !!pending }, pendingKids))

      // 2. Where it stopped, in its own words.
      out.push(h(Card, { key: 'now', title: t('secNow') },
        h('div', { style: S.text }, nowLine !== '' ? nowLine : t('placeholder'))))

      // 3. Recent turns: your prompt and its reply, one line each.
      if (turns.length > 0) {
        const rows = shown.map((turn, i) =>
          h('div', { key: turn && turn.seq != null ? String(turn.seq) : i, style: S.turn },
            h('div', { style: S.turnHead }, turn && turn.turn != null ? '#' + turn.turn : ''),
            h('div', { style: { ...S.text, ...S.userLine } }, t('promptLabel') + '：' + (firstSentence(turn.prompt, 62) || '—')),
            h('div', { style: { ...S.text, ...S.botLine } }, t('replyLabel') + '：' + (firstSentence(turn.response, 132) || t('noText')))))
        let toggle = null
        if (hidden > 0) {
          toggle = h('button', { key: 'more', type: 'button', style: S.more, onClick: () => setExpanded(true) },
            String(t('more')).replace('%n', String(hidden)))
        } else if (expanded && turns.length > 4) {
          toggle = h('button', { key: 'less', type: 'button', style: S.more, onClick: () => setExpanded(false) }, t('less'))
        }
        out.push(h(Card, { key: 'timeline', title: t('secTimeline') }, rows, toggle))
      }

      // 4. Machine facts, one line.
      const facts = []
      if (turns.length > 0) facts.push(turns.length + ' ' + t('turnUnit'))
      const meta = values.sessionListMetadata
      if (meta && typeof meta.lastPromptAt === 'number') {
        const rel = relTime(meta.lastPromptAt, now)
        if (rel !== '') facts.push(t('lastAt') + ' ' + rel)
      }
      const ctx = contextOf(values.tokenUsage)
      if (ctx > 0) facts.push(t('tokens') + ' ' + fmtK(ctx))
      const stats = values.sessionStats
      if (stats && typeof stats.llmMs === 'number' && stats.llmMs > 0) facts.push('LLM ' + Math.round(stats.llmMs / 1000) + 's')
      const model = modelLabel(values.modelSelection)
      if (model !== '') facts.push(t('model') + ' ' + model)
      if (facts.length > 0) {
        out.push(h('div', { key: 'facts', style: S.meta }, facts.map((f, i) => h('span', { key: i }, f))))
      }
      if (summary && typeof summary.cwd === 'string' && summary.cwd !== '') {
        out.push(h('div', { key: 'cwd', style: { ...S.meta, marginTop: 4, wordBreak: 'break-all' } },
          h('span', null, t('cwd') + ' ' + summary.cwd)))
      }

      return h('div', { style: S.body }, out)
    }

    function DigestTitle(props) {
      return props.t('tab')
    }

    function HeaderButton(props) {
      const label = props.t('open')
      return h('button', {
        type: 'button',
        title: label,
        'aria-label': label,
        onClick: () => props.open(props.sessionId),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          font: 'inherit',
          fontSize: 12,
          lineHeight: '20px',
          padding: '2px 8px',
          borderRadius: 6,
          cursor: 'pointer',
          border: '1px solid rgba(127,127,127,0.32)',
          background: 'transparent',
          color: 'inherit',
        },
      }, h('span', { 'aria-hidden': true }, '↩'), h('span', null, props.t('tab')))
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
