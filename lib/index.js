/**
 * dsh-catchup — Host half.
 *
 * The only job: turn one session into two plain sentences, once, on demand.
 *
 * Why the panel needs this at all: DSH stores a per-turn preview (50 chars of
 * your prompt, 120 of the reply) and nothing else. A sentence like "where is
 * this thing up to" does not exist anywhere on disk — it has to be written once,
 * so it costs one small model call. Everything else on the panel stays 0-token.
 *
 * Shape: GET /api/session-digest?sessionId=…  →  {intro, now, …}
 *
 * Two deliberate constraints from the platform:
 *  - A profile-installed bundle cannot use @Remote (that needs build-time codegen
 *    and the client refuses codec-less descriptors), so the browser reaches this
 *    through a Connection Fetch route instead.
 *  - No @deepseek-ai/* imports: this package lives in the profile, where those
 *    specifiers do not resolve. Stream chunks are assembled by hand and the cache
 *    is a plain JSON file under DSH_HOME.
 */
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const name = 'dsh-catchup'
export const inject = ['llm', 'sessions', 'connection']

const ROUTE = '/api/session-digest'
const CACHE_DIR_NAME = 'dsh-catchup'

const DEFAULT_CONFIG = {
  timeoutMs: 45000,
  // Reasoning tokens bill against this cap and the deepseek route thinks by
  // default. 5000 worked but output was 62% of the bill; 2200 still leaves room
  // for thinking plus ~200 tokens of answer, and the answer is what we keep.
  maxOutputTokens: 2200,
  // Regenerate only when the session has actually moved on: two more turns, or the
  // cached digest is this old. Saves most of the calls without going stale.
  minNewTurns: 2,
  maxAgeMs: 10 * 60 * 1000,
  // The material is head + sampled middle + tail, so the budget is the real knob.
  maxInputBytes: 24000,
  cooldownMs: 30000,
  // CNY per million tokens. Defaults follow models.dev's DeepSeek V4.1 Flash list
  // price (USD 0.6 in / 3.6 out, cache read 0.12) at 1 USD ≈ 6.67 CNY. models.dev
  // quotes off-peak; weekday 09:00-12:00 and 14:00-18:00 Beijing time bill double.
  priceInputPerMTok: 4,
  priceOutputPerMTok: 24,
  currency: '¥',
}

const SYSTEM = [
  '你在给人写一张"接上"卡片。他刚切回这个会话，要在二十秒内知道三件事：这摊事是干什么的、现在停在哪、有没有事等他。',
  '',
  '输入分三段：[开头] 是会话怎么开始的，[中途] 是中间抽的几条，[最近] 是末尾几条。',
  '三段都只截取了一部分，不是全文——你要按这三段拼出**整个会话的脉络**，不要只讲最近那几条在聊什么。',
  '',
  '只输出一个 JSON 对象，不要别的文字：',
  '{"intro": string, "now": string, "open": string[]}',
  '',
  'intro —— 这个会话"是干什么的"：目的、要交付什么、有什么硬要求。按全部三段归纳，不要只按最近。',
  '  2 句以内，40-70 个汉字。它是**常驻**的，不是进度：如果给出上一版 intro 且目的没变，原样返回，不要换个说法。',
  '  直接陈述目的，不要以"用户""这个会话"开头。',
  '',
  'now —— 现在停在哪：整体走到哪一步、主线是什么、此刻卡在哪个具体问题。',
  '  2-4 句，60-140 个汉字。先给"整体进度"，再说"最新这一步"。',
  '  如果最近几轮在讨论某个细节，要说明它是主线的哪一部分，不要写成"最近在讨论 A 还是 B"。',
  '  禁止"进展顺利""继续推进"这类空话。',
  '',
  'open —— 现在有哪几件事**必须他回一句**才能往下走。每条一句，不超过 40 个汉字，最多 4 条。',
  '  典型：等你选方案、等你确认口径、等你授权某个操作、等你回复"做/不做"。',
  '  没有就返回空数组 []，不要为了凑数编。',
  '  只写他需要做的动作，不要重复 now 里的话。',
  '',
  '全部用中文，纯文本：不要 markdown，不要列表，不要在答案外面加引号。',
  '直接输出这个 JSON，不要先写计划、提纲或推理过程；能少想就少想。',
].join('\n')

// ------------------------------------------------------------------ cache

function cacheDir() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
  return path.join(home, 'cache', CACHE_DIR_NAME)
}

function cacheFile(sessionId) {
  return path.join(cacheDir(), encodeURIComponent(String(sessionId)) + '.json')
}

async function readCache(sessionId) {
  try {
    const raw = await fs.readFile(cacheFile(sessionId), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.now === 'string') return parsed
    return null
  } catch {
    return null
  }
}

async function writeCache(sessionId, record) {
  try {
    await fs.mkdir(cacheDir(), { recursive: true })
    await fs.writeFile(cacheFile(sessionId), JSON.stringify(record), 'utf8')
  } catch (error) {
    console.warn('[dsh-catchup] could not write the digest cache', error)
  }
}

/** What one call cost, in the configured currency. Null when usage is unreported. */
function costOf(usage, config) {
  if (!usage) return null
  const priceIn = Number(config.priceInputPerMTok) || 0
  const priceOut = Number(config.priceOutputPerMTok) || 0
  if (priceIn <= 0 && priceOut <= 0) return null
  return ((usage.input || 0) / 1e6) * priceIn + ((usage.output || 0) / 1e6) * priceOut
}

function totalsFile() {
  return path.join(cacheDir(), 'totals.json')
}

/** Every call this plugin has ever made, so the panel can show its own bill. */
async function readTotals() {
  try {
    const raw = await fs.readFile(totalsFile(), 'utf8')
    const value = JSON.parse(raw)
    return {
      calls: Number(value.calls) || 0,
      input: Number(value.input) || 0,
      output: Number(value.output) || 0,
      cost: Number(value.cost) || 0,
    }
  } catch {
    return { calls: 0, input: 0, output: 0, cost: 0 }
  }
}

async function addTotals(usage, cost) {
  const totals = await readTotals()
  totals.calls += 1
  if (usage) {
    totals.input += usage.input || 0
    totals.output += usage.output || 0
  }
  if (typeof cost === 'number') totals.cost = (totals.cost || 0) + cost
  try {
    await fs.mkdir(cacheDir(), { recursive: true })
    await fs.writeFile(totalsFile(), JSON.stringify(totals), 'utf8')
  } catch (error) {
    console.warn('[dsh-catchup] could not write the totals file', error)
  }
}

// ------------------------------------------------------------- the material

/** Same route the session itself used — "跟当前会话同款". */
function routeOf(session, config) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  const route = session.requestHeader && session.requestHeader()
  const cfg = route && route.config
  if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  return null
}

function messageText(message) {
  const content = Array.isArray(message && message.content) ? message.content : []
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/** How many human turns the session has — the unit the regeneration gate counts in. */
function countUserTurns(session) {
  const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
  let count = 0
  for (const message of messages) {
    if (message && message.role === 'user') count += 1
  }
  return count
}

function clip(text, limit) {
  if (text.length <= limit) return text
  return text.slice(0, limit).replace(/\s+$/, '') + '…'
}

/**
 * The whole arc, not the tail.
 *
 * Only the last N messages was the bug: a 27-turn session produced a digest about
 * whatever the last eight messages were arguing over. Now the material is the
 * opening (how it started), an evenly spaced sample of the middle (what the
 * session has been about), and the recent run (where it stands), and the byte
 * budget spends itself on the middle first.
 */
function conversationText(session, maxBytes) {
  const all = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
  const usable = all.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && messageText(m) !== '')
  if (usable.length === 0) return ''

  const line = (m) => (m.role === 'user' ? '### 用户\n' : '### 助手\n') + clip(messageText(m), m.role === 'user' ? 500 : 800)
  const render = (head, middle, tail) => {
    const blocks = []
    if (head.length) blocks.push('[开头]\n' + head.map(line).join('\n\n'))
    if (middle.length) blocks.push('[中途]\n' + middle.map(line).join('\n\n'))
    if (tail.length) blocks.push('[最近]\n' + tail.map(line).join('\n\n'))
    return blocks.join('\n\n')
  }

  const headEnd = Math.min(2, usable.length)
  const tailStart = Math.max(headEnd, usable.length - 6)
  const head = usable.slice(0, headEnd)
  const tail = usable.slice(tailStart)
  const pool = usable.slice(headEnd, tailStart)

  // Evenly spaced, user messages first: the questions are the spine of a session.
  const middle = []
  if (pool.length > 0) {
    const step = Math.max(1, Math.floor(pool.length / 6))
    for (let i = 0; i < pool.length && middle.length < 6; i += step) middle.push(pool[i])
  }

  let text = render(head, middle, tail)
  while (Buffer.byteLength(text, 'utf8') > maxBytes && middle.length > 1) {
    middle.pop()
    text = render(head, middle, tail)
  }
  while (Buffer.byteLength(text, 'utf8') > maxBytes && head.length > 1) {
    head.shift()
    text = render(head, middle, tail)
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = Buffer.from(text, 'utf8').subarray(0, maxBytes - 3).toString('utf8') + '…'
  }
  return text
}

// ---------------------------------------------------------------- the call

function parseAnswer(raw) {
  const text = String(raw || '')
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON')
  const value = JSON.parse(body.slice(start, end + 1))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('模型返回的不是一个对象')
  const intro = typeof value.intro === 'string' ? value.intro.trim() : ''
  const now = typeof value.now === 'string' ? value.now.trim() : ''
  if (now === '') throw new Error('模型返回里没有 now')
  const open = Array.isArray(value.open)
    ? value.open
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .slice(0, 4)
    : []
  return { intro, now, open }
}

async function callModel(ctx, route, material, sessionId, config, previousIntro) {
  const ask = previousIntro
    ? material + '\n\n---\n上一版 intro（若这个会话的目的没变，原样返回这一句）：' + previousIntro
    : material
  const messages = [{ role: 'user', content: [{ type: 'text', text: ask }] }]
  const signal = config.timeoutMs > 0 ? AbortSignal.timeout(config.timeoutMs) : undefined
  const options = {
    provider: route.provider,
    model: route.model,
    system: SYSTEM,
    messages,
    maxTokens: config.maxOutputTokens,
    temperature: 0,
    sessionId,
    purpose: 'session-digest',
    ...(signal ? { signal } : {}),
  }

  // The stream speaks deltas, not whole blocks: a text answer arrives as
  // {type:'text-delta', index, text} and is only authoritative at block-end.
  const parts = new Map()
  const seen = new Set()
  let finish = null
  let usage = null
  const partial = (index, type) => {
    let part = parts.get(index)
    if (!part) {
      part = { type, text: '' }
      parts.set(index, part)
    }
    return part
  }

  for await (const chunk of ctx.llm.stream(options)) {
    if (!chunk || typeof chunk.type !== 'string') continue
    seen.add(chunk.type)
    switch (chunk.type) {
      case 'block-start':
        partial(chunk.index, chunk.blockType || 'text')
        break
      case 'text-delta':
        partial(chunk.index, 'text').text += chunk.text || ''
        break
      case 'reasoning-delta':
        break // thinking is not the answer
      case 'block-end':
        if (chunk.block && chunk.block.type === 'text') partial(chunk.index, 'text').text = chunk.block.text || ''
        break
      case 'usage':
        usage = chunk.usage || usage
        break
      case 'finish':
        finish = chunk.reason || null
        if (chunk.usage) usage = chunk.usage
        break
      default:
        break
    }
  }

  const text = [...parts.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, part]) => part.type === 'text')
    .map(([, part]) => part.text)
    .join('')

  if (usage) {
    const input = typeof usage.inputTokens === 'number'
      ? usage.inputTokens
      : (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
    const output = usage.outputTokens || usage.completionTokens || 0
    usage = input > 0 || output > 0 ? { input, output } : null
  }

  if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
    const failure = finish.failure || {}
    throw new Error(failure.message || (finish.kind === 'aborted' ? '调用被中止' : '调用失败'))
  }
  // A cap hit only matters if the answer did not survive it; the caller decides.
  return {
    text,
    usage,
    truncated: !!(finish && finish.kind === 'max-tokens'),
    seen: [...seen],
  }
}

// ---------------------------------------------------------------- routing

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) }
  const inFlight = new Map()
  const cooling = new Map()

  async function digest(session, signal) {
    const sessionId = session.id
    const watermark = typeof session.seq === 'number' ? session.seq : 0
    const turnsNow = countUserTurns(session)

    const cached = await readCache(sessionId)
    if (cached) {
      if (cached.coveredThroughSeq === watermark) return cached
      // A digest is a glance, not a mirror: rewriting it every single turn costs
      // more than it is worth. Wait for minNewTurns, unless it has simply aged.
      const gained = turnsNow - (Number(cached.coveredTurns) || 0)
      const stale = Date.now() - (Number(cached.at) || 0) > (Number(cfg.maxAgeMs) || 0)
      if (gained < (Number(cfg.minNewTurns) || 0) && !stale) return cached
    }

    const until = cooling.get(sessionId)
    if (until && until > Date.now()) throw new Error('上次生成失败了，稍等再试')

    const running = inFlight.get(sessionId)
    if (running) return await running

    const task = (async () => {
      const route = routeOf(session, cfg)
      if (!route) throw new Error('这个会话还没跑过一轮，没有可用的模型路由')
      if (typeof session.deriveMessages !== 'function') throw new Error('这个 DSH 版本读不到会话消息（没有 deriveMessages）')
      const material = conversationText(session, cfg.maxInputBytes)
      if (material.trim() === '') throw new Error('这个会话没有可以总结的文字')
      if (signal && signal.aborted) throw new Error('已取消')

      const { text, usage, truncated, seen } = await callModel(ctx, route, material, sessionId, cfg, cached && cached.intro)
      let parsed
      try {
        parsed = parseAnswer(text)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Say what actually came back: chunk types and a glimpse of the text. That
        // turns "it failed" into a one-round diagnosis.
        const onlyThought = text === '' && seen.includes('reasoning-delta')
        const detail = '（块类型 ' + (seen.join(',') || '无') + '；正文 ' + (text ? text.slice(0, 80) : '空') + '）'
        const hint = onlyThought ? '模型只输出了思考过程，没有写正文——maxOutputTokens 不够' : ''
        throw new Error(message + (truncated ? '（输出在 maxOutputTokens 处被截断）' : '') + (hint ? '（' + hint + '）' : '') + detail)
      }
      const cost = costOf(usage, cfg)
      const record = {
        intro: parsed.intro,
        now: parsed.now,
        open: parsed.open,
        provider: route.provider,
        model: route.model,
        coveredThroughSeq: watermark,
        coveredTurns: turnsNow,
        at: Date.now(),
        usage: usage || null,
        cost,
        currency: cfg.currency || '¥',
      }
      await writeCache(sessionId, record)
      await addTotals(usage, cost)
      cooling.delete(sessionId)
      return record
    })()

    inFlight.set(sessionId, task)
    try {
      return await task
    } catch (error) {
      cooling.set(sessionId, Date.now() + (cfg.cooldownMs || 0))
      throw error
    } finally {
      if (inFlight.get(sessionId) === task) inFlight.delete(sessionId)
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const id = new URL(request.url).searchParams.get('sessionId')
      if (!id) return new Response('sessionId is required', { status: 400 })
      const session = ctx.sessions.get(id)
      if (!session) return new Response('session is not live', { status: 404 })
      try {
        const record = await digest(session, request.signal)
        const totals = await readTotals()
        return Response.json({ ...record, totals }, { headers: { 'cache-control': 'no-store' } })
      } catch (error) {
        if (request.signal && request.signal.aborted) return new Response('aborted', { status: 499 })
        const message = error instanceof Error ? error.message : String(error)
        console.warn('[dsh-catchup] digest failed:', message)
        return new Response(message, { status: 500 })
      }
    },
  }), 'dsh-catchup: digest route')

  // One line so "did the Host half even load" is answerable from the console.
  console.log('[dsh-catchup] host ready: ' + ROUTE)
}
