/**
 * dsh-session-digest — client half.
 *
 * A right-column briefing for the CURRENT session. Nothing here calls a model:
 * every value is read from projections DSH already folds on the host and pushes
 * to the browser (`session/control` baseline for the attached session, plus the
 * summary block carried by `session/list`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-digest',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const NS = 'sessionDigest'
    const ID = 'dsh-session-digest' // tab type id, also the slot key
    const KIND = 'session-digest' // what ctx.sidebarRight.openTab() names

    const ZH = {
      tab: '会话摘要',
      open: '打开会话摘要',
      guideDesc: '进会话之前，先读一眼它停在哪',
      empty: '这个会话还是空的，先发一句话。',
      noPending: '没事等你拍板',
      secNow: '现状',
      secPending: '待你拍板',
      secTimeline: '最近几轮',
      secMeta: '状态',
      running: '运行中',
      awaiting: '等你回答',
      approval: '待批准',
      unread: '有未读',
      idle: '空闲',
      error: '上一轮出错',
      promptLabel: '你问',
      replyLabel: '它答',
      more: '再看 %n 轮',
      less: '收起',
      turnUnit: '轮',
      lastAt: '上次互动',
      tokens: '上下文',
      model: '模型',
      noText: '（这一轮没有文字输出）',
      cwd: '目录',
      expand: '展开',
      collapse: '收起',
    }
    const EN = {
      tab: 'Session digest',
      open: 'Open session digest',
      guideDesc: 'What state is this session in?',
      empty: 'This session is empty — send something first.',
      noPending: 'Nothing waiting on you',
      secNow: 'Where it stands',
      secPending: 'Waiting on you',
      secTimeline: 'Recent turns',
      secMeta: 'Status',
      running: 'Running',
      awaiting: 'Needs your answer',
      approval: 'Needs approval',
      unread: 'Unread',
      idle: 'Idle',
      error: 'Last turn failed',
      promptLabel: 'You',
      replyLabel: 'It',
      more: 'Show %n more turns',
      less: 'Show less',
      turnUnit: 'turns',
      lastAt: 'Last activity',
      tokens: 'Context',
      model: 'Model',
      noText: '(no text output this turn)',
      cwd: 'Dir',
      expand: 'Expand',
      collapse: 'Collapse',
    }

    // ---------------------------------------------------------------- helpers

    /** Strip the markdown noise a turn preview still carries: bold, code, headings, table pipes. */
    function plain(text) {
      if (typeof text !== 'string' || text === '') return ''
      let s = text
      s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links
      s = s.replace(/[`*_~#>]/g, '')
      s = s.replace(/\|/g, ' ')
      s = s.replace(/^\s*[-+]\s+/gm, '')
      s = s.replace(/\s+/g, ' ').trim()
      return s
    }

    /** First sentence of a preview, hard-capped. Chinese and Latin sentence ends both count. */
    function firstSentence(text, max) {
      const s = plain(text)
      if (s === '') return ''
      const limit = max || 90
      const m = s.match(/^(.{8,}?[。！？!?；;])/)
      let out = m ? m[1] : s
      if (out.length > limit) out = out.slice(0, limit).replace(/[,，、]$/, '') + '…'
      return out
    }

    function relTime(ts, now) {
      if (typeof ts !== 'number') return ''
      const d = Math.max(0, (now || Date.now()) - ts)
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
      if (typeof n !== 'number' || !isFinite(n)) return ''
      if (n < 1000) return String(n)
      if (n < 1000000) return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k'
      return (n / 1000000).toFixed(1) + 'M'
    }

    /** Highest-precedence thing waiting on the human. */
    function pendingOf(status, values) {
      const q = values && values.userQuestions
      const active = q && q.active && q.active.length > 0 ? q.active[0] : null
      const todo = values && values.todos
      const openTodos = Array.isArray(todo) ? todo.filter((x) => x && x.status !== 'completed') : []
      const pi = status && status.pendingInteraction
      if (pi) {
        const kind = String(pi.kind || pi.type || pi.domain || '')
        const isApproval = /approval|permission|sandbox/i.test(kind)
        return {
          rank: 1,
          label: isApproval ? 'approval' : 'awaiting',
          detail: pi.title || pi.description || pi.summary || pi.label || pi.reason || '',
        }
      }
      if (active) {
        const first = (active.questions && active.questions[0]) || null
        return {
          rank: 2,
          label: 'awaiting',
          detail: first ? first.question || first.header || '' : '',
          options: first && Array.isArray(first.options) ? first.options : null,
        }
      }
      if (openTodos.length > 0) {
        return { rank: 3, label: 'todo', detail: openTodos[0].content, count: openTodos.length }
      }
      return null
    }

    // ------------------------------------------------------------------- view

    const css = {
      body: {
        height: '100%',
        overflow: 'auto',
        padding: '12px 14px 20px',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'inherit',
      },
      head: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
      title: { fontSize: 13, fontWeight: 600, opacity: 0.9, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      badge: { fontSize: 11, lineHeight: '16px', padding: '0 6px', borderRadius: 5, border: '1px solid currentColor', opacity: 0.85, whiteSpace: 'nowrap' },
      card: { border: '1px solid rgba(127,127,127,0.28)', borderRadius: 8, padding: '9px 11px', marginBottom: 10 },
      cardLead: { borderColor: 'rgba(247,183,49,0.75)', background: 'rgba(247,183,49,0.08)' },
      label: { fontSize: 11, letterSpacing: '0.04em', textTransform: 'uppercase', opacity: 0.55, marginBottom: 5 },
      text: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      dim: { opacity: 0.55 },
      quote: { margin: '6px 0 0', padding: '5px 8px', borderLeft: '2px solid rgba(247,183,49,0.9)', background: 'rgba(127,127,127,0.08)' },
      opts: { margin: '6px 0 0', paddingLeft: 16, opacity: 0.85 },
      turn: { marginBottom: 9 },
      turnHead: { fontSize: 11, opacity: 0.45, marginBottom: 2 },
      userLine: { fontWeight: 500 },
      botLine: { opacity: 0.8 },
      meta: { display: 'flex', flexWrap: 'wrap', gap: '4px 12px', fontSize: 11.5, opacity: 0.6 },
      link: { background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', opacity: 0.6, cursor: 'pointer', textDecoration: 'underline' },
      err: { color: '#e05c5c' },
    }

    function Badge(props) {
      const labels = { running: props.t('running'), awaiting: props.t('awaiting'), approval: props.t('approval'), unread: props.t('unread'), idle: props.t('idle'), error: props.t('error') }
      const text = labels[props.kind] || ''
      if (text === '') return null
      return h('span', { style: css.badge, title: text }, text)
    }

    function Section(props) {
      return h('div', { style: props.lead ? { ...css.card, ...css.cardLead } : css.card },
        h('div', { style: css.label }, props.title),
        props.children)
    }

    function DigestBody(props) {
      const sid = props.sessionId
      const t = props.t
      const list = props.useSessions((s) => s)
      const status = props.useSessionStatus((s) => (s && typeof s.get === 'function' ? s.get(sid) : undefined))
      const [expanded, setExpanded] = React.useState(false)
      const [now, setNow] = React.useState(Date.now())

      // Keep the relative timestamps honest without re-reading anything.
      React.useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 30000)
        return () => clearInterval(id)
      }, [])

      const summary = list && list.byId ? list.byId[sid] : undefined
      const projected = list && list.projectionsBySession ? list.projectionsBySession[sid] : undefined
      const values = (projected && projected.values) || (summary && summary.projectionValues) || {}
      const outline = (props.useProjection && props.useProjection('turnOutline')) || values.turnOutline
      const turns = outline && Array.isArray(outline.turns) ? outline.turns : []

      const stats = values.sessionStats
      const usage = values.tokenUsage
      const meta = values.sessionListMetadata
      const modelSel = values.modelSelection
      const goal = values.goal

      const pending = pendingOf(status, values)
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null
      const nowLine = lastTurn ? firstSentence(lastTurn.response, 110) : ''

      const statusKind = (() => {
        if (status && status.running) return 'running'
        if (pending && pending.label === 'approval') return 'approval'
        if (status && status.pendingInteraction) return 'awaiting'
        if (pending && pending.label === 'awaiting') return 'awaiting'
        if (status && status.completionUnread) return 'unread'
        return 'idle'
      })()

      const shown = expanded ? turns : turns.slice(-4)
      const hiddenCount = turns.length - shown.length

      const head = h('div', { style: css.head },
        h('span', { style: css.title, title: (summary && summary.displayTitle) || '' }, (summary && summary.displayTitle) || sid),
        h(Badge, { kind: statusKind, t }))

      const body = []

      if (summary && summary.blank && turns.length === 0) {
        body.push(h('div', { key: 'empty', style: { ...css.text, ...css.dim } }, t('empty')))
      } else {
        // 1. What is waiting on the human — first, because it is the decision.
        const pendingChildren = []
        if (pending) {
          pendingChildren.push(h(Badge, { kind: pending.label === 'approval' ? 'approval' : 'awaiting', t }))
          if (pending.detail) pendingChildren.push(h('div', { style: { ...css.text, marginTop: 4 } }, firstSentence(pending.detail, 160) || pending.detail))
          if (pending.options && pending.options.length > 0) {
            pendingChildren.push(h('ul', { style: css.opts }, pending.options.slice(0, 6).map((o, i) =>
              h('li', { key: i, style: css.text }, (o && (o.label || o.value || o.text)) || String(o)))))
          }
          if (pending.count > 1) pendingChildren.push(h('div', { style: { ...css.dim, marginTop: 4, fontSize: 11.5 } }, pending.count + ' × todo'))
        } else {
          pendingChildren.push(h('div', { style: { ...css.dim, fontSize: 12 } }, t('noPending')))
        }
        body.push(h(Section, { key: 'pending', title: t('secPending'), lead: !!pending }, pendingChildren))

        // 2. Where it stands — the last turn's own words.
        if (nowLine !== '') {
          body.push(h(Section, { key: 'now', title: t('secNow') },
            h('div', { style: css.text }, nowLine)))
        }

        // 3. Recent turns.
        if (shown.length > 0) {
          const rows = shown.map((turn, i) =>
            h('div', { key: (turn && turn.seq) || i, style: css.turn },
              h('div', { style: css.turnHead }, '#' + (turn.turn != null ? turn.turn : '') ),
              h('div', { style: { ...css.text, ...css.userLine } }, t('promptLabel') + '：' + (firstSentence(turn.prompt, 60) || '—')),
              h('div', { style: { ...css.text, ...css.botLine } }, t('replyLabel') + '：' + (firstSentence(turn.response, 130) || t('noText')))))
          const toggle = hiddenCount > 0
            ? h('button', { key: 'more', type: 'button', style: css.link, onClick: () => setExpanded(true) },
                t('more').replace('%n', String(hiddenCount)))
            : expanded && turns.length > 4
              ? h('button', { key: 'less', type: 'button', style: css.link, onClick: () => setExpanded(false) }, t('less'))
              : null
          body.push(h(Section, { key: 'timeline', title: t('secTimeline') }, rows, toggle))
        }

        // 4. Machine facts, one line.
        const facts = []
        if (turns.length > 0) facts.push(turns.length + ' ' + t('turnUnit'))
        if (meta && meta.lastPromptAt) facts.push(t('lastAt') + ' ' + relTime(meta.lastPromptAt, now))
        if (usage) {
          const used = (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) + (usage.outputTokens || 0)
          if (used > 0) facts.push(t('tokens') + ' ' + fmtK(used))
        }
        if (stats && stats.llmMs) facts.push('LLM ' + Math.round(stats.llmMs / 1000) + 's')
        if (modelSel && (modelSel.model || modelSel.provider)) facts.push(t('model') + ' ' + [modelSel.provider, modelSel.model].filter(Boolean).join('/'))
        if (goal && (goal.text || goal.objective)) facts.push('🎯 ' + firstSentence(goal.text || goal.objective, 40))
        if (facts.length > 0) body.push(h('div', { key: 'meta', style: css.meta }, facts.map((f, i) => h('span', { key: i }, f))))
        if (summary && summary.cwd) body.push(h('div', { key: 'cwd', style: { ...css.meta, marginTop: 6 } }, h('span', null, t('cwd') + ' ' + summary.cwd)))
      }

      return h('div', { style: css.body }, head, body)
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
          display: 'inline-flex', alignItems: 'center', gap: 5, font: 'inherit', fontSize: 12,
          padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
          border: '1px solid rgba(127,127,127,0.35)', background: 'transparent', color: 'inherit',
        },
      }, h('span', { 'aria-hidden': true }, '☰'), h('span', null, props.t('tab')))
    }

    function apply(ctx) {
      let t
      try {
        t = ctx.locale.bind(NS)
      } catch (e) {
        t = (k) => k
      }
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'session-digest: copy')
      } catch (e) {
        console.warn('[dsh-session-digest] locale', e)
      }

      // openTab throws when no Session surface is mounted; the button only makes
      // sense for the Session actually on screen.
      const open = (sid) => {
        try {
          const mounted = ctx.sidebarRight.mounted
          const onScreen = mounted && typeof mounted.getSnapshot === 'function' ? mounted.getSnapshot() : sid
          if (onScreen !== sid) return
          ctx.sidebarRight.openTab(KIND)
        } catch (e) {
          console.warn('[dsh-session-digest] cannot open the right column', e)
        }
      }

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        title: () => t('tab'),
        keepMounted: true,
        guide: [{ id: 'open', order: 40, title: () => t('tab'), description: () => t('guideDesc') }],
      }), 'session-digest: tab type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
        locale: NS,
      }, DigestBody)), 'session-digest: tab body')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: ID,
        locale: NS,
      }, DigestTitle)), 'session-digest: tab title')

      ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: ID,
        order: -10,
        locale: NS,
        inject: (sessionId) => ({ sessionId, open }),
      }, HeaderButton)), 'session-digest: header button')
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']
    return module.exports
  },
})
