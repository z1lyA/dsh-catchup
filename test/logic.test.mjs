/**
 * Node-only verification for dsh-catchup.
 *
 * The plugin runs in DSH's browser module loader, so there is no bundler and no
 * test runner here. Instead this file lifts the `// #region logic` block out of
 * lib/client.js and exercises the real shipped code, then checks the parts that
 * fail silently in a browser: dictionary coverage and registration wiring.
 *
 *   node test/logic.test.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
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
    console.log('  FAIL ' + name + '\n       ' + (e && e.message ? e.message.split('\n')[0] : e))
  }
}

// ---------------------------------------------------------------- load helpers

const region = source.match(/\/\/ #region logic([\s\S]*?)\/\/ #endregion logic/)
assert.ok(region, 'lib/client.js must keep its // #region logic block')
const api = new Function(
  region[1] + '\nreturn { plain, firstSentence, relTime, fmtK, textOf, turnsOf, pendingItemsOf, goalOf, decodeDigest, mergeOpen }',
)()
const { plain, firstSentence, relTime, fmtK, textOf, turnsOf, pendingItemsOf, goalOf, decodeDigest, mergeOpen } = api

console.log('\nlogic')

check('plain() strips markdown emphasis, headings, bullets, tables', () => {
  const raw = '**一句话汇报**：主线③已经收口\n\n## 归档位置\n- 新建 `99_归档`\n| 日志 | 时间 |\n|---|---|'
  const out = plain(raw)
  assert.equal(/[*`#|\-]{1}/.test(out), false, 'no markdown control chars left: ' + out)
  assert.ok(out.includes('一句话汇报'), out)
  assert.ok(out.includes('新建 99_归档'), out)
})

check('plain() collapses newlines into single spaces', () => {
  assert.equal(plain('a\n\nb\r\nc'), 'a b c')
})

check('plain() tolerates non-strings', () => {
  assert.equal(plain(undefined), '')
  assert.equal(plain(null), '')
  assert.equal(plain(42), '')
})

check('firstSentence() cuts at a CJK full stop', () => {
  const s = firstSentence('做完了，而且不止两份——那轮改组一共留下 6 份日志，全都归档了。后面还有一大堆没说完的话。')
  assert.equal(s, '做完了，而且不止两份——那轮改组一共留下 6 份日志，全都归档了。')
})

check('firstSentence() cuts at a Latin question mark', () => {
  assert.equal(firstSentence('Should I proceed with option B? The rest is detail that nobody reads.'), 'Should I proceed with option B?')
})

check('firstSentence() hard-caps and marks the cut with an ellipsis', () => {
  const s = firstSentence('这是一个没有任何标点符号的很长的句子'.repeat(12), 40)
  assert.ok(s.length <= 41, 'length ' + s.length)
  assert.ok(s.endsWith('…'), s)
})

check('firstSentence() never leaves a dangling comma before the ellipsis', () => {
  const s = firstSentence('一二三四五六七八九十，'.repeat(8), 12)
  assert.equal(/[,，、]$/.test(s.replace(/…$/, '')), false, s)
})

check('firstSentence() returns empty for empty input', () => {
  assert.equal(firstSentence(''), '')
  assert.equal(firstSentence('   '), '')
})

check('relTime() bucket boundaries', () => {
  const now = 1_700_000_000_000
  assert.equal(relTime(now - 30_000, now), '<1m')
  assert.equal(relTime(now - 5 * 60_000, now), '5m')
  assert.equal(relTime(now - 3 * 3600_000, now), '3h')
  assert.equal(relTime(now - 2 * 86400_000, now), '2d')
  assert.equal(relTime(now - 90 * 86400_000, now), '3mo')
  assert.equal(relTime(undefined, now), '')
})

check('fmtK() formats context sizes', () => {
  assert.equal(fmtK(0), '')
  assert.equal(fmtK(999), '999')
  assert.equal(fmtK(1500), '1.5k')
  assert.equal(fmtK(45_000), '45k')
  assert.equal(fmtK(1_200_000), '1.2M')
  assert.equal(fmtK(NaN), '')
})

check('textOf() digs a string out of whatever shape the host hands over', () => {
  assert.equal(textOf('plain'), 'plain')
  assert.equal(textOf({ title: 'a' }), 'a')
  assert.equal(textOf({ description: 'b' }), 'b')
  assert.equal(textOf({ label: 'c' }), 'c')
  assert.equal(textOf({ reason: 'd' }), 'd')
  assert.equal(textOf({ command: 'e' }), 'e')
  assert.equal(textOf({ nope: 1 }), '')
  assert.equal(textOf(undefined), '')
})

check('turnsOf() reads the wire value, which is the array itself', () => {
  const turns = [{ turn: 1, seq: 10, prompt: 'a', response: 'b' }]
  assert.equal(turnsOf(turns), turns)
})

check('turnsOf() tolerates a { turns } wrapper and junk', () => {
  const turns = [{ turn: 1, seq: 10, prompt: 'a', response: 'b' }]
  assert.equal(turnsOf({ turns }), turns)
  assert.deepEqual(turnsOf(undefined), [])
  assert.deepEqual(turnsOf({}), [])
})

console.log('\nwhat is still open')

check('an approval comes first and is tagged as an approval', () => {
  const items = pendingItemsOf(
    { pendingInteraction: { kind: 'approval', title: 'pwsh 删除临时目录' } },
    { userQuestions: { active: [{ questions: [{ question: 'A 还是 B？' }] }] }, todos: [{ content: 'x', status: 'pending' }] },
  )
  assert.equal(items[0].kind, 'approval')
  assert.ok(items[0].text.includes('pwsh'))
})

check('an unknown pendingInteraction kind is still first, tagged as a question', () => {
  const items = pendingItemsOf({ pendingInteraction: { type: 'mystery', label: 'something' } }, {})
  assert.equal(items[0].kind, 'ask')
  assert.equal(items[0].text, 'something')
})

check('questions the agent asked come next, one line each', () => {
  const items = pendingItemsOf({}, {
    userQuestions: { active: [{ questions: [{ question: '字段映射选哪个？' }] }, { questions: [{ question: '要不要写进 README？' }] }] },
  })
  assert.deepEqual(items.map((i) => i.text), ['字段映射选哪个？', '要不要写进 README？'])
  assert.ok(items.every((i) => i.kind === 'ask'))
})

check('unfinished todos are last, one line each', () => {
  const items = pendingItemsOf({}, { todos: [{ content: '补台账', status: 'pending' }, { content: '已做', status: 'completed' }] })
  assert.deepEqual(items, [{ kind: 'todo', text: '补台账' }])
})

check('a session whose todos are all completed reads as nothing waiting', () => {
  assert.deepEqual(pendingItemsOf({}, { todos: [{ content: 'a', status: 'completed' }] }), [])
})

check('no pending interaction, no questions, no todos reads as nothing waiting', () => {
  assert.deepEqual(pendingItemsOf(undefined, {}), [])
  assert.deepEqual(pendingItemsOf({ running: true }, {}), [])
})

check('settled questions do not count as pending', () => {
  assert.deepEqual(pendingItemsOf({}, { userQuestions: { active: [], settled: [{ answers: [] }] } }), [])
})

check('the block stays a glance: at most four items', () => {
  const todos = Array.from({ length: 7 }, (_, i) => ({ content: 'todo ' + i, status: 'pending' }))
  const items = pendingItemsOf({}, { todos })
  assert.equal(items.length, 4)
  assert.equal(items[3].text, 'todo 3')
})

check('an item with no text is kept when it is the pending interaction itself', () => {
  const items = pendingItemsOf({ pendingInteraction: { kind: 'approval' } }, {})
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'approval')
  assert.equal(items[0].text, '')
})

console.log('\nwhat the model spotted, merged in')

check('mergeOpen() keeps the structured signals first', () => {
  const structured = [{ kind: 'approval', text: '批准删目录' }]
  const merged = mergeOpen(structured, ['等你定映射口径'])
  assert.equal(merged[0].kind, 'approval')
  assert.deepEqual(merged[1], { kind: 'open', text: '等你定映射口径' })
})

check('mergeOpen() is what catches a plain-prose request for a decision', () => {
  // The session that exposed this: the agent asked in the message body, never
  // through ask_user_question, so nothing structured ever arrived.
  const merged = mergeOpen([], ['回一句「能干」或「干不了」'])
  assert.deepEqual(merged, [{ kind: 'open', text: '回一句「能干」或「干不了」' }])
})

check('mergeOpen() drops duplicates and empties', () => {
  const merged = mergeOpen([{ kind: 'todo', text: '补字段' }], ['补字段', '', '  ', null, 42])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].kind, 'todo')
})

check('mergeOpen() stays a glance: five at most', () => {
  const merged = mergeOpen([], ['a', 'b', 'c', 'd', 'e', 'f'])
  assert.equal(merged.length, 5)
})

check('mergeOpen() tolerates junk', () => {
  assert.deepEqual(mergeOpen(undefined, undefined), [])
  assert.deepEqual(mergeOpen(null, 'nope'), [])
})

console.log('\nwhat this session is')

check('goalOf() uses the declared goal', () => {
  assert.equal(goalOf({ goal: { text: '把 31 省的政策表并成一张总表' } }), '把 31 省的政策表并成一张总表')
})

check('goalOf() stays empty when there is no goal — the title already says it', () => {
  assert.equal(goalOf({}), '')
  assert.equal(goalOf(undefined), '')
  assert.equal(goalOf({ goal: { nope: 1 } }), '')
})

console.log('\nthe host\'s answer')

check('decodeDigest() keeps the two sentences and the reported usage', () => {
  const d = decodeDigest({ intro: '做并表', now: '跑完了，卡在映射。', usage: { input: 3800, output: 120 } })
  assert.deepEqual(d, { intro: '做并表', now: '跑完了，卡在映射。', open: [], usage: { input: 3800, output: 120 }, totals: null })
})

check('decodeDigest() carries the open list and the running total', () => {
  const d = decodeDigest({
    now: 'ok',
    open: ['等你定口径', '  ', '确认后补字段'],
    totals: { calls: 12, input: 87000, output: 14000 },
  })
  assert.deepEqual(d.open, ['等你定口径', '确认后补字段'])
  assert.deepEqual(d.totals, { calls: 12, input: 87000, output: 14000 })
})

check('decodeDigest() rejects anything without a "now" sentence', () => {
  assert.equal(decodeDigest(null), null)
  assert.equal(decodeDigest(undefined), null)
  assert.equal(decodeDigest({}), null)
  assert.equal(decodeDigest({ now: '   ' }), null)
  assert.equal(decodeDigest('nope'), null)
})

check('decodeDigest() treats a missing intro or usage as absent, not as an error', () => {
  assert.deepEqual(decodeDigest({ now: 'ok' }), { intro: '', now: 'ok', open: [], usage: null, totals: null })
  assert.equal(decodeDigest({ now: 'ok', usage: { input: 0, output: 0 } }).usage, null)
  assert.equal(decodeDigest({ now: 'ok', usage: 'junk' }).usage, null)
})

console.log('\ndictionaries')

const dicts = {}
for (const lang of ['ZH', 'EN']) {
  const start = source.indexOf('const ' + lang + ' = {')
  assert.ok(start > -1, lang + ' dictionary must exist')
  const end = source.indexOf('\n    }', start)
  const block = source.slice(start, end)
  dicts[lang] = new Set([...block.matchAll(/^\s{6}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1]))
}

check('ZH and EN define the same keys', () => {
  const zh = [...dicts.ZH].sort()
  const en = [...dicts.EN].sort()
  assert.deepEqual(en, zh, 'missing in EN: ' + zh.filter((k) => !dicts.EN.has(k)).join(', '))
})

check('every t() key used in the code exists in both dictionaries', () => {
  const used = new Set([...source.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'\)/g)].map((m) => m[1]))
  const missingZh = [...used].filter((k) => !dicts.ZH.has(k))
  const missingEn = [...used].filter((k) => !dicts.EN.has(k))
  assert.deepEqual(missingZh, [], 'missing in ZH: ' + missingZh.join(', '))
  assert.deepEqual(missingEn, [], 'missing in EN: ' + missingEn.join(', '))
})

console.log('\nwiring')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

check('package name is dsh-catchup', () => {
  assert.equal(pkg.name, 'dsh-catchup')
})

check('every declared export resolves to a real file', () => {
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key.includes('*')) {
      const dir = target.replace('/' + target.split('/').pop(), '')
      assert.ok(existsSync(join(root, dir)), 'glob export dir missing: ' + dir)
      continue
    }
    assert.ok(existsSync(join(root, target)), 'missing export ' + key + ' -> ' + target)
  }
})

check('bundle patch and client entry are declared', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0)
})

check('loader id equals the package name', () => {
  assert.ok(source.includes("id: 'dsh-catchup'"), 'module loader id must match the package name')
  assert.ok(source.includes("const ID = 'dsh-catchup'"))
  assert.ok(source.includes("const KIND = 'catchup'"))
})

check('registers the tab type, its body, its title, and a header button', () => {
  for (const slot of [
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
    'conversation.session.header.utilities',
  ]) {
    assert.ok(source.includes("'" + slot + "'"), 'missing slot registration: ' + slot)
  }
  assert.ok(source.includes('ctx.sidebarRightTabs.register'), 'missing tab type registration')
  assert.ok(source.includes('ctx.sidebarRight.openTab(KIND)'), 'missing openTab call')
})

check('client services are injected', () => {
  assert.ok(/module\.exports\.inject = \[[^\]]*'slots'/.test(source))
  assert.ok(/module\.exports\.inject = \[[^\]]*'locale'/.test(source))
  assert.ok(/module\.exports\.inject = \[[^\]]*'sidebarRight'/.test(source))
  assert.ok(/module\.exports\.inject = \[[^\]]*'sidebarRightTabs'/.test(source))
})

check('the client never calls a model, and its only request is the digest route', () => {
  for (const forbidden of ['ctx.llm', 'session/projections', 'refreshProjections', 'remote.', 'XMLHttpRequest']) {
    assert.equal(source.includes(forbidden), false, 'found ' + forbidden)
  }
  const calls = [...source.matchAll(/\bfetch\(([^)]*)/g)].map((m) => m[1])
  assert.equal(calls.length, 1, 'expected exactly one fetch, found ' + calls.length)
  assert.ok(calls[0].includes('api/session-digest'), 'the one request must be the digest route: ' + calls[0])
})

check('the bundled locale metadata matches the tab name', () => {
  const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
  assert.equal(zh.meta.title, '接上')
  assert.ok(zh.meta.detail === 'docs/DETAIL.md')
  assert.ok(source.includes("tab: '接上'"))
})

check('cordis.patch.yml is YAML, not JavaScript', () => {
  const yaml = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  // `//` is a JS comment; YAML would read it as a scalar and choke on the next line.
  const badComment = yaml.split(/\r?\n/).find((line) => /^\s*\/\//.test(line))
  assert.equal(badComment, undefined, 'use # for YAML comments, found: ' + badComment)
  assert.ok(/^- insert:/m.test(yaml), 'patch must start an insert list')
  assert.ok(/^\s+- id: dsh-catchup$/m.test(yaml), 'patch must mount the package id')
  assert.ok(/^\s+name: dsh-catchup$/m.test(yaml), 'patch must name the package')
})

console.log('\nstyles')

check('every class the markup uses has a rule, and no rule is orphaned', () => {
  const cssBlock = source.match(/const CSS = \[([\s\S]*?)\]\.join\(''\)/)
  assert.ok(cssBlock, 'client.js must keep its CSS array')
  const css = cssBlock[1]
  const styled = new Set([...css.matchAll(/\.(cu-[a-z][\w-]*)/g)].map((m) => m[1]))
  const rest = source.replace(cssBlock[0], '')
  const used = new Set([...rest.matchAll(/\b(cu-[a-z][\w-]*)\b/g)].map((m) => m[1]))
  const missing = [...used].filter((c) => !styled.has(c))
  const orphaned = [...styled].filter((c) => !used.has(c))
  assert.deepEqual(missing, [], 'classes used in markup but never styled: ' + missing.join(', '))
  assert.deepEqual(orphaned, [], 'styled but never used: ' + orphaned.join(', '))
})

check('the stylesheet is prefix-scoped, not global', () => {
  const cssBlock = source.match(/const CSS = \[([\s\S]*?)\]\.join\(''\)/)[1]
  const cssText = [...cssBlock.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]).join('\n')
  assert.ok(cssText.includes('.dsh-catchup'), 'root rule must hang off .dsh-catchup')
  for (const chunk of cssText.split('}')) {
    if (!chunk.includes('{')) continue
    const selector = chunk.split('{')[0].trim()
    if (selector === '') continue
    assert.ok(selector.startsWith('.dsh-catchup'), 'unscoped rule would leak into the host UI: ' + selector.slice(0, 60))
  }
})

console.log('')
if (failures > 0) {
  console.log(failures + ' FAILED')
  process.exit(1)
}
console.log('all checks passed')
