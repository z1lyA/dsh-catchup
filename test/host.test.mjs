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
        const answer = state.nextAnswer === undefined ? '{"intro":"做并表","now":"跑完了，卡在映射。"}' : state.nextAnswer
        return (async function* () {
          if (state.nextAnswer === '') {
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider exploded' } } }
            return
          }
          for (const piece of String(answer).match(/[\s\S]{1,40}/g) || []) {
            yield { type: 'text', text: piece }
          }
          yield {
            type: 'finish',
            reason: { kind: 'stop' },
            usage: { inputTokens: 3800, outputTokens: 120 },
          }
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

check('the model was asked with the session\'s own route, a system prompt and a hard cap', () => {
  assert.equal(state.calls.length, 1)
  const options = state.calls[0]
  assert.equal(options.provider, 'wb-proxy')
  assert.equal(options.model, 'deepseek-v4.1-flash')
  assert.equal(options.maxTokens, 400)
  assert.equal(options.temperature, 0)
  assert.ok(typeof options.system === 'string' && options.system.length > 20)
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  assert.ok(options.messages[0].content[0].text.includes('侧边栏摘要插件'), 'the conversation text must reach the model')
})

check('the answer is cached on disk under DSH_HOME', () => {
  const dir = join(home, 'cache', 'dsh-catchup')
  assert.ok(existsSync(dir), 'cache dir missing')
  assert.equal(readdirSync(dir).length, 1)
})

await checkAsync('a second open with no new activity costs nothing', async () => {
  const before = state.calls.length
  const res = await call('http://x/api/session-digest?sessionId=s1')
  assert.equal(res.status, 200)
  assert.equal(state.calls.length, before, 'the model was called again for an unchanged session')
})

await checkAsync('a session that moved on gets a fresh answer', async () => {
  sessions.s1.seq = 43
  const before = state.calls.length
  const res = await call('http://x/api/session-digest?sessionId=s1')
  assert.equal(res.status, 200, res.raw)
  assert.equal(state.calls.length, before + 1)
  assert.equal(res.body.coveredThroughSeq, 43)
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
  assert.equal(readdirSync(dir).length, 1, 'a failed answer must not be cached')
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

console.log('')
if (failures > 0) {
  console.log(failures + ' FAILED')
  process.exit(1)
}
console.log('all checks passed')
