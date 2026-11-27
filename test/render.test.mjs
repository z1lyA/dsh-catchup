/**
 * Renders the real client bundle in Node, with a fake DSH.
 *
 * This is the closest thing to "will the panel actually work" without a browser:
 * it loads lib/client.js through the same module-loader entry point DSH uses,
 * runs `apply()` against a recording ctx, then invokes the registered components
 * with fake slot props and inspects the text that comes out.
 *
 *   node test/render.test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log('  ok   ' + name)
  } catch (e) {
    failures += 1
    console.log('  FAIL ' + name + '\n       ' + (e && e.message ? String(e.message).split('\n')[0] : e))
  }
}

// ------------------------------------------------------------ a tiny React

let hookCursor = 0
const React = {
  createElement(type, props, ...children) {
    const all = children.length === 1 && Array.isArray(children[0]) ? children[0] : children
    const node = { type, props: props || {}, children: all }
    if (typeof type === 'function') {
      hookCursor = 0
      return type({ ...(props || {}), children: all })
    }
    return node
  },
  useState(initial) {
    hookCursor += 1
    return [initial, () => {}]
  },
  useEffect() {
    hookCursor += 1
  },
}

/** Flatten a rendered tree into readable text, dropping styles/handlers. */
function toText(node, out = []) {
  if (node == null || node === false || node === true) return out.join(' ')
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out.join(' ')
  }
  if (Array.isArray(node)) {
    for (const child of node) toText(child, out)
    return out.join(' ')
  }
  if (node.children) for (const child of node.children) toText(child, out)
  return out.join(' ')
}

// ------------------------------------------------------- load the real bundle

let captured = null
globalThis.window = { __ModuleLoader__: { load: (m) => { captured = m } } }
await import('file://' + join(root, 'lib', 'client.js').replace(/\\/g, '/'))
assert.ok(captured, 'client.js must call window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-catchup')

const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}
const exported = captured.factory(requireStub)

// ------------------------------------------------------------- a fake DSH ctx

const registered = { type: null, body: null, title: null, header: null }
const localeDict = {}
const warnings = []

const ctx = {
  locale: {
    bind: (ns) => (key) => (localeDict[ns] && localeDict[ns][key]) || key,
    register: (ns, dicts) => { localeDict[ns] = dicts.zh },
  },
  effect: (fn) => { fn(); return () => {} },
  slots: {
    inject: (_slot, cb) => cb(),
    register: (options, component) => {
      if (options.name === 'sidebar.right.pane.tab') registered.body = component
      if (options.name === 'sidebar.right.pane.tab.title') registered.title = component
      if (options.name === 'conversation.session.header.utilities') registered.header = component
      return component
    },
  },
  sidebarRightTabs: {
    register: (definition) => { registered.type = definition; return () => {} },
  },
  sidebarRight: {
    mounted: { getSnapshot: () => 's1' },
    openTab: (kind) => { registered.openedKind = kind },
  },
}

const realWarn = console.warn
console.warn = (...args) => warnings.push(args.join(' '))
exported.apply(ctx)
console.warn = realWarn

console.log('\nregistration')

check('apply() registers all four seats without warnings', () => {
  assert.deepEqual(warnings, [], 'warnings: ' + warnings.join(' | '))
  assert.ok(registered.type, 'tab type')
  assert.ok(registered.body, 'tab body')
  assert.ok(registered.title, 'tab title')
  assert.ok(registered.header, 'header button')
})

check('tab type is well formed', () => {
  assert.equal(registered.type.id, 'dsh-catchup')
  assert.equal(registered.type.kind, 'catchup')
  assert.equal(registered.type.title(), '接上')
  assert.equal(registered.type.keepMounted, true)
  assert.equal(registered.type.guide.length, 1)
  assert.equal(registered.type.guide[0].description(), '切过来之后，先看一眼这摊事停在哪')
})

check('injected services are declared', () => {
  assert.deepEqual(exported.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])
})

// ------------------------------------------------------------- fake slot props

function props(overrides) {
  const sid = 's1'
  const list = overrides.list
  const status = overrides.status
  // DSH hands the body a ReadonlyMap<SessionId, SessionStatus>, not a plain object.
  const statusMap = status === undefined ? undefined : new Map([[sid, status]])
  return {
    sessionId: sid,
    t: (key) => localeDict.catchup[key] || key,
    useSessions: (sel) => sel(list),
    useSessionStatus: (sel) => sel(statusMap),
    useProjection: (key) => {
      const projected = list.projectionsBySession[sid]
      return projected && projected.values ? projected.values[key] : undefined
    },
    ...overrides.extra,
  }
}

function session(extra) {
  return {
    id: 's1',
    displayTitle: '登录页限流',
    cwd: 'H:\\CodeProject\\login-gateway',
    blank: false,
    updatedAt: Date.now(),
    projectionValues: {},
    ...extra,
  }
}

function listOf(summary, values) {
  return {
    ids: ['s1'],
    byId: { s1: summary },
    phase: 'ready',
    projectionsBySession: { s1: { values: values || {}, state: 'ready' } },
  }
}

const turn = (n, prompt, response) => ({ turn: n, seq: n * 10, prompt, response })

const turns = [
  turn(1, '把限流加上，用令牌桶', '桶已经接进中间件了，两个边界用例待补。'),
  turn(2, '补那两个用例', '用例补好了，一个卡在时间窗边界。'),
  turn(3, '卡住的那个怎么回事', '虚拟时钟没有推进，我换成了注入时钟。'),
  turn(4, '继续', '已经跑通了，现在整理配置项。'),
  turn(5, '配置项从哪读', '从 settings 读，默认值写在 schema 里。'),
  turn(6, '那 README 呢', 'README 我还没动，等你确认要不要加一节。'),
  turn(7, '配置项怎么排序', '按字母序，和 schema 里的声明顺序一致。'),
  turn(8, '加个注释', '每个字段补了一行注释，没有改动逻辑。'),
  turn(9, '现在什么状态', '全部改完，12 个测试全过，等你决定要不要写进 README。'),
]

console.log('\nrender — a session with an approval waiting')

const approvalText = toText(registered.body(props({
  list: listOf(session({}), {
    turnOutline: turns,
    sessionStats: { turns: 9, steps: 40, llmMs: 96_000 },
    tokenUsage: { uncachedInputTokens: 40_000, outputTokens: 8_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    sessionListMetadata: { blank: false, lastPromptAt: Date.now() - 12 * 60_000 },
    modelSelection: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' },
  }),
  status: { running: false, pendingInteraction: { kind: 'approval', title: 'pwsh 删除临时目录' }, completionUnread: false },
})))

check('shows the title and the approval badge', () => {
  assert.ok(approvalText.includes('登录页限流'), approvalText.slice(0, 120))
  assert.ok(approvalText.includes('待批准'), approvalText.slice(0, 120))
})

check('shows the approval detail', () => {
  assert.ok(approvalText.includes('pwsh 删除临时目录'), approvalText)
})

check('introduces the session from how it began', () => {
  assert.ok(approvalText.includes('把限流加上，用令牌桶'), approvalText)
  assert.ok(approvalText.includes('——'), 'the opening request and reply are joined: ' + approvalText)
  assert.equal(approvalText.split('把限流加上，用令牌桶').length - 1, 1, 'the opening line must appear once, not in the list too')
})

check('says where it stands in its own last words', () => {
  assert.ok(approvalText.includes('全部改完'), approvalText)
})

check('the list holds what led here, not the last turn', () => {
  assert.ok(approvalText.includes('配置项从哪读'), 'turn 5 is within the last six: ' + approvalText)
  assert.equal(approvalText.includes('补那两个用例'), false, 'turn 2 must be folded away')
  assert.ok(approvalText.includes('再看 2 轮'), approvalText)
})

check('shows the machine facts line', () => {
  for (const fact of ['9 轮', '上次动 12m', '48k', 'LLM 96s', 'wb-proxy/deepseek-v4.1-flash', 'login-gateway']) {
    assert.ok(approvalText.includes(fact), 'missing fact "' + fact + '" in: ' + approvalText)
  }
})

console.log('\nrender — nothing waiting')

const idleText = toText(registered.body(props({
  list: listOf(session({}), { turnOutline: turns.slice(0, 2) }),
  status: { running: false, pendingInteraction: undefined, completionUnread: false },
})))

check('says nothing is waiting', () => {
  assert.ok(idleText.includes('没事等你'), idleText)
})

check('does not render an approval badge when nothing waits', () => {
  assert.equal(idleText.includes('待批准'), false)
})

console.log('\nrender — an agent question with options')

const questionText = toText(registered.body(props({
  list: listOf(session({}), {
    turnOutline: turns.slice(0, 3),
    userQuestions: {
      active: [{ callId: 'c1', questions: [{ question: '字段映射按哪个来？', options: [{ label: '按省份' }, { label: '按年份' }] }], state: 'open' }],
      settled: [],
    },
  }),
  status: { running: false, pendingInteraction: undefined, completionUnread: false },
})))

check('renders the question and its options', () => {
  assert.ok(questionText.includes('字段映射按哪个来？'), questionText)
  assert.ok(questionText.includes('按省份'), questionText)
  assert.ok(questionText.includes('按年份'), questionText)
})

console.log('\nrender — an empty session')

const blankText = toText(registered.body(props({
  list: listOf(session({ blank: true }), {}),
  status: { running: false, pendingInteraction: undefined, completionUnread: false },
})))

check('says the session is empty', () => {
  assert.ok(blankText.includes('这个会话还是空的'), blankText)
})

console.log('\nrender — a running session with no completed turn yet')

let runningText = ''
check('renders without throwing and says there is nothing to catch up on', () => {
  runningText = toText(registered.body(props({
    list: listOf(session({}), { turnOutline: [] }),
    status: { running: true, pendingInteraction: undefined, completionUnread: false },
  })))
  assert.ok(runningText.includes('运行中'), runningText)
  assert.ok(runningText.includes('还没有跑完一轮'), runningText)
})

console.log('\nrender — label and header button')

check('the panel root carries the style hook', () => {
  const node = registered.body(props({
    list: listOf(session({}), { turnOutline: turns.slice(0, 2) }),
    status: { running: true, pendingInteraction: undefined, completionUnread: false },
  }))
  assert.equal(node.props.className, 'dsh-catchup')
})

check('tab title renders 接上', () => {
  assert.equal(toText(registered.title({ t: (k) => localeDict.catchup[k] || k })), '接上')
})

check('header button is icon-only but still labelled and clickable', () => {
  let opened = null
  const node = registered.header({
    t: (k) => localeDict.catchup[k] || k,
    sessionId: 's1',
    open: (sid) => { opened = sid },
  })
  assert.equal(toText(node).trim(), '', 'the button must not render a text label')
  assert.equal(node.props['aria-label'], '接上：这个会话停在哪、有没有事等你')
  node.props.onClick()
  assert.equal(opened, 's1', 'clicking must open the tab for this session')
})

console.log('')
if (failures > 0) {
  console.log(failures + ' FAILED')
  process.exit(1)
}
console.log('all checks passed')
