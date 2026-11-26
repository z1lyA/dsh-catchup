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
  region[1] + '\nreturn { plain, firstSentence, relTime, fmtK, textOf, pendingOf, contextOf, modelLabel }',
)()
const { plain, firstSentence, relTime, fmtK, textOf, pendingOf, contextOf, modelLabel } = api

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
  const s = firstSentence('Should I proceed with option B? The rest is detail that nobody reads.')
  assert.equal(s, 'Should I proceed with option B?')
})

check('firstSentence() hard-caps and marks the cut with an ellipsis', () => {
  const long = '这是一个没有任何标点符号的很长的句子'.repeat(12)
  const s = firstSentence(long, 40)
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

check('contextOf() sums the four token buckets', () => {
  assert.equal(contextOf({ uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 }), 126)
  assert.equal(contextOf(null), 0)
})

check('modelLabel() joins provider and model, tolerates absence', () => {
  assert.equal(modelLabel({ provider: 'wb-proxy', model: 'deepseek-v4.1-flash' }), 'wb-proxy/deepseek-v4.1-flash')
  assert.equal(modelLabel({ model: 'x' }), 'x')
  assert.equal(modelLabel(undefined), '')
})

console.log('\nprecedence of "what is waiting on you"')

check('approval outranks everything', () => {
  const p = pendingOf(
    { pendingInteraction: { kind: 'approval', title: 'pwsh 删除临时目录' } },
    { userQuestions: { active: [{ questions: [{ question: 'A 还是 B？' }] }] }, todos: [{ content: 'x', status: 'pending' }] },
  )
  assert.equal(p.rank, 1)
  assert.equal(p.label, 'approval')
  assert.ok(p.detail.includes('pwsh'))
})

check('an unknown pendingInteraction kind is still rank 1, labelled as a question', () => {
  const p = pendingOf({ pendingInteraction: { type: 'mystery', label: 'something' } }, {})
  assert.equal(p.rank, 1)
  assert.equal(p.label, 'awaiting')
  assert.equal(p.detail, 'something')
})

check('agent question outranks todos and carries its options', () => {
  const p = pendingOf(
    {},
    {
      userQuestions: { active: [{ questions: [{ question: '字段映射选哪个？', options: [{ label: 'A' }, 'B', { text: 'C' }] }] }] },
      todos: [{ content: '收尾', status: 'in_progress' }],
    },
  )
  assert.equal(p.rank, 2)
  assert.equal(p.detail, '字段映射选哪个？')
  assert.deepEqual(p.options, ['A', 'B', 'C'])
})

check('unfinished todos are the fallback, and count them', () => {
  const p = pendingOf({}, { todos: [{ content: '补台账', status: 'pending' }, { content: '已做', status: 'completed' }] })
  assert.equal(p.rank, 3)
  assert.equal(p.detail, '补台账')
  assert.equal(p.count, 1)
})

check('a session whose todos are all completed reads as "nothing waiting"', () => {
  assert.equal(pendingOf({}, { todos: [{ content: 'a', status: 'completed' }] }), null)
})

check('everything absent reads as "nothing waiting"', () => {
  assert.equal(pendingOf(undefined, {}), null)
  assert.equal(pendingOf({ running: true }, {}), null)
})

check('settled questions do not count as pending', () => {
  assert.equal(pendingOf({}, { userQuestions: { active: [], settled: [{ answers: [] }] } }), null)
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

check('placeholder substitution key exists', () => {
  assert.ok(dicts.ZH.has('more'))
  assert.ok(String(source).includes("replace('%n'"))
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

check('no model / RPC call sneaks in', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'ctx.llm', 'session/projections', 'refreshProjections', 'remote.']) {
    assert.equal(source.includes(forbidden), false, 'found ' + forbidden)
  }
})

check('the bundled locale metadata matches the tab name', () => {
  const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'))
  assert.equal(zh.meta.title, '接上')
  assert.ok(zh.meta.detail === 'docs/DETAIL.md')
  assert.ok(source.includes("tab: '接上'"))
})

console.log('')
if (failures > 0) {
  console.log(failures + ' FAILED')
  process.exit(1)
}
console.log('all checks passed')
