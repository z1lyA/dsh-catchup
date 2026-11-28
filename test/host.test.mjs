/**
 * Exercises the Host half for real: fake ctx, fake model stream, real module.
 *
 * The panel only works if this file's contract holds, and the browser side can
 * only report "it failed" — so the contract gets tested here instead.
 *
 *   node test/host.test.mjs
 */
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

// Point the cache somewhere disposable BEFORE the module reads it.
const home = mkdtempSync(join(tmpdir(), 'dsh-catchup-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')

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
async function checkAsync(name, fn) {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (e) {
    failures += 1
    console.log('  FAIL ' + name + '\n       ' + (e && e.message ? String(e.message).split('\n')[0] : e))
  }
}

// ------------------------------------------------------------------- fakes

function makeSession(id, seq, messages) {
  return {
    id,
    seq,
    requestHeader: () => ({ config: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' } }),
    deriveMessages: () => messages,
  }
}

const textBlock = (text) => ({ type: 'text', text })
const userMsg = (text) => ({ role: 'user', content: [textBlock(text)] })
const botMsg = (text) => ({ role: 'assistant', content: [textBlock(text)] })

function makeCtx(sessions) {
  const state = { route: null, calls: [], warnings: [] }
  const ctx = {
    effect: (fn) => fn(),
    sessions: { get: (id) => sessions[id], list: () => Object.values(sessions) },
    connection: { fetch: { register: (route) => { state.route = route; return () => {} } } },
    llm: {
      stream: (options) => {
        state.calls.push(options)
        const answer = state.nextAnswer === undefined
          ? '{"intro":"做并表","now":"跑完了，卡在映射。","open":["等你定映射口径","确认后我补剩下 6 个字段"]}'
          : state.nextAnswer
        return (async function* () {
          if (state.nextAnswer === '') {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } }
            return
          }
          // The real protocol (dsh-llm/assembler.ts): deltas per index, then a
          // separate usage chunk and a finish. Reasoning arrives as its own block
          // and must never end up in the answer.
          yield { type: 'block-start', index: 0, blockType: 'reasoning' }
          for (const piece of String('这里是想一想的内容').match(/[\s\S]{1,4}/g) || []) {
            yield { type: 'reasoning-delta', index: 0, text: piece }
          }
          if (state.onlyReasoning) {
            yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: '这里是想一想的内容' } }
            yield { type: 'finish', reason: { kind: 'max-tokens' } }
            return
          }
          yield { type: 'block-start', index: 1, blockType: 'text' }
          for (const piece of String(answer).match(/[\s\S]{1,40}/g) || []) {
            yield { type: 'text-delta', index: 1, text: piece }
          }
          yield { type: 'block-end', index: 1, block: { type: 'text', text: String(answer) } }
          yield { type: 'usage', usage: { uncachedInputTokens: 3800, outputTokens: 120 } }
          yield { type: 'finish', reason: { kind: state.finishKind || 'stop' } }
        })()
      },
    },
  }
  return { ctx, state }
}

const sessions = {
  s1: makeSession('s1', 42, [userMsg('帮我做个侧边栏摘要插件'), botMsg('先摸清能力边界')]),
  s2: makeSession('s2', 7, [userMsg('把表并了'), botMsg('并好了')]),
}

const { ctx, state } = makeCtx(sessions)
apply(ctx, {})

const call = async (url) => {
  const response = await state.route.fetch(new Request(url))
  const raw = await response.text()
  let body = null
  try { body = JSON.parse(raw) } catch { /* not JSON */ }
  return { status: response.status, body, raw }
}

console.log('\nregistration')

check('apply() registers one GET route under /api', () => {
  assert.ok(state.route, 'no route registered')
  assert.equal(state.route.path, '/api/session-digest')
  assert.deepEqual(state.route.methods, ['GET'])
  assert.equal(state.route.requestBody, 'buffered')
  assert.equal(typeof state.route.fetch, 'function')
})

console.log('\nthe first question')

await checkAsync('answers with the two sentences and the reported usage', async () => {
  const res = await call('http://x/api/session-digest?sessionId=s1')
  assert.equal(res.status, 200, res.raw)
  assert.equal(res.body.intro, '做并表')
  assert.equal(res.body.now, '跑完了，卡在映射。')
  assert.deepEqual(res.body.usage, { input: 3800, output: 120 })
  assert.equal(res.body.coveredThroughSeq, 42)
})

await checkAsync('carries what is waiting on the human, straight from the answer', async () => {
  const res = await call('http://x/api/session-digest?sessionId=s1')
  assert.deepEqual(res.body.open, ['等你定映射口径', '确认后我补剩下 6 个字段'])
})

await checkAsync('prices the call from the configured rate', async () => {
  const res = await call('http://x/api/session-digest?sessionId=s1')
  // 3800/1e6*4 + 120/1e6*24
  assert.ok(Math.abs(res.body.cost - 0.01808) < 1e-9, 'cost was ' + res.body.cost)
  assert.equal(res.body.currency, '¥')
  assert.ok(Math.abs(res.body.totals.cost - 0.01808) < 1e-9, 'totals.cost was ' + res.body.totals.cost)
})

await checkAsync('adds this call to a running total the panel can show', async () => {
  const res = await call('http://x/api/session-digest?sessionId=s1')
  assert.equal(res.body.totals.calls, 1)
  assert.equal(res.body.totals.input, 3800)
  assert.equal(res.body.totals.output, 120)
})

check('the model was asked for the three fields, with the session\'s own route', () => {
  assert.equal(state.calls.length >= 1, true)
  const options = state.calls[0]
  assert.equal(options.provider, 'wb-proxy')
  assert.equal(options.model, 'deepseek-v4.1-flash')
  assert.equal(options.maxTokens, 2200, 'the cap covers reasoning but no longer overshoots')
  assert.equal(options.temperature, 0)
  assert.ok(typeof options.system === 'string' && options.system.length > 20)
  for (const field of ['"intro"', '"now"', '"open"']) {
    assert.ok(options.system.includes(field), 'the system prompt must ask for ' + field)
  }
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  assert.ok(options.messages[0].content[0].text.includes('侧边栏摘要插件'), 'the conversation text must reach the model')
})

check('the answer is cached on disk under DSH_HOME', () => {
  const dir = join(home, 'cache', 'dsh-catchup')
  assert.ok(existsSync(dir), 'cache dir missing')
  const files = readdirSync(dir)
  assert.ok(files.some((f) => f !== 'totals.json'), 'no per-session digest file: ' + files.join(','))
  assert.ok(files.includes('totals.json'), 'the running total must be kept next to it')
})

await checkAsync('a second open with no new activity costs nothing', async () => {
  const before = state.calls.length
  const res = await call('http://x/api/session-digest?sessionId=s1')
  assert.equal(res.status, 200)
  assert.equal(state.calls.length, before, 'the model was called again for an unchanged session')
})

await checkAsync('a session that moved on gets a fresh answer', async () => {
  const more = sessions.s1.deriveMessages().concat([userMsg('再问一件'), botMsg('好'), userMsg('又问一件'), botMsg('好')])
  sessions.s1 = makeSession('s1', 43, more)
  const before = state.calls.length
  const res = await call('http://x/api/session-digest?sessionId=s1')
  assert.equal(res.status, 200, res.raw)
  assert.equal(state.calls.length, before + 1)
  assert.equal(res.body.coveredThroughSeq, 43)
})

await checkAsync('one new turn is not worth a new call — the cached glance stands', async () => {
  const one = sessions.s1.deriveMessages().concat([userMsg('只加一句'), botMsg('好')])
  sessions.s1 = makeSession('s1', 44, one)
  const before = state.calls.length
  const res = await call('http://x/api/session-digest?sessionId=s1')
  assert.equal(res.status, 200, res.raw)
  assert.equal(state.calls.length, before, 'a single turn must not trigger a rewrite')
  assert.equal(res.body.coveredThroughSeq, 43, 'the cached digest is still what is shown')
})

await checkAsync('feeds the whole arc, not only the tail', async () => {
  const many = [userMsg('开场：做一个摘要插件')]
  for (let i = 1; i <= 20; i += 1) {
    many.push(botMsg('第 ' + i + ' 步做完了'), userMsg('问题 ' + i))
  }
  many.push(botMsg('最后一步：交付'))
  sessions.s9 = makeSession('s9', 20, many)
  state.nextAnswer = undefined
  const res = await call('http://x/api/session-digest?sessionId=s9')
  assert.equal(res.status, 200, res.raw)
  const material = state.calls[state.calls.length - 1].messages[0].content[0].text
  assert.ok(material.includes('开场：做一个摘要插件'), 'the opening must be in the material')
  assert.ok(material.includes('最后一步：交付'), 'the latest must be in the material')
  assert.ok(material.includes('[开头]') && material.includes('[最近]'), material.slice(0, 160))
  assert.ok(material.includes('[中途]'), 'a middle sample must be in the material')
  // and it must stay within the byte budget
  assert.ok(Buffer.byteLength(material, 'utf8') <= 24000)
})

console.log('\nbad input')

await checkAsync('no sessionId is a 400', async () => {
  const res = await call('http://x/api/session-digest')
  assert.equal(res.status, 400)
})

await checkAsync('an unknown session is a 404', async () => {
  const res = await call('http://x/api/session-digest?sessionId=nope')
  assert.equal(res.status, 404)
})

await checkAsync('prose instead of JSON fails loudly, and the cache is not written', async () => {
  const before = state.calls.length
  state.nextAnswer = '当然可以，这是一段没有 JSON 的话。'
  sessions.s2.seq = 8
  const res = await call('http://x/api/session-digest?sessionId=s2')
  assert.equal(res.status, 500)
  assert.ok(res.raw.includes('JSON'), res.raw)
  assert.equal(state.calls.length, before + 1)
  const dir = join(home, 'cache', 'dsh-catchup')
  assert.equal(existsSync(join(dir, 's2.json')), false, 'a failed answer must not be cached')
})

await checkAsync('a failure cools down instead of re-hitting the provider on every render', async () => {
  const before = state.calls.length
  const res = await call('http://x/api/session-digest?sessionId=s2')
  assert.equal(res.status, 500)
  assert.equal(state.calls.length, before, 'the cooldown did not hold')
})

await checkAsync('a provider error surfaces its message', async () => {
  state.nextAnswer = ''
  sessions.s2.seq = 9
  await new Promise((r) => setTimeout(r, 0))
  // cooldown is per session; use a third session to bypass it
  sessions.s3 = makeSession('s3', 3, [userMsg('x'), botMsg('y')])
  const res = await call('http://x/api/session-digest?sessionId=s3')
  assert.equal(res.status, 500)
  assert.ok(res.raw.includes('provider exploded'), res.raw)
})

await checkAsync('hitting the token cap is only fatal when the answer did not survive it', async () => {
  // A complete object that happened to end at the cap is usable; a cut-off one is not.
  state.nextAnswer = '{"intro":"做并表","now":"跑完了，卡在映射。"}'
  state.finishKind = 'max-tokens'
  sessions.s4 = makeSession('s4', 11, [userMsg('看看'), botMsg('好')])
  const ok = await call('http://x/api/session-digest?sessionId=s4')
  assert.equal(ok.status, 200, ok.raw)
  assert.equal(ok.body.now, '跑完了，卡在映射。')

  state.nextAnswer = '{"intro":"做并表","now":"跑完'
  sessions.s5 = makeSession('s5', 12, [userMsg('看看'), botMsg('好')])
  const cut = await call('http://x/api/session-digest?sessionId=s5')
  assert.equal(cut.status, 500)
  assert.ok(cut.raw.includes('截断'), cut.raw)
})

await checkAsync('a reasoning-only answer is named as such, not as a JSON problem', async () => {
  state.onlyReasoning = true
  sessions.s6 = makeSession('s6', 13, [userMsg('看看'), botMsg('好')])
  const res = await call('http://x/api/session-digest?sessionId=s6')
  state.onlyReasoning = false
  assert.equal(res.status, 500)
  assert.ok(res.raw.includes('只输出了思考过程'), res.raw)
  assert.ok(res.raw.includes('maxOutputTokens'), res.raw)
})

console.log('')
if (failures > 0) {
  console.log(failures + ' FAILED')
  process.exit(1)
}
console.log('all checks passed')
