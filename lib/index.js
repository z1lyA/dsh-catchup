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
  timeoutMs: 30000,
  maxOutputTokens: 1200,
  maxMessages: 10,
  maxInputBytes: 12000,
  cooldownMs: 30000,
}

const SYSTEM = [
  '你在给人写一张"接上"卡片。他刚切回这个会话，要在二十秒内知道两件事：这摊事是干什么的，现在卡在哪。',
  '',
  '只输出一个 JSON 对象，不要别的文字：',
  '{"intro": string, "now": string}',
  '',
  'intro —— 这个会话"是干什么的"：目的、要交付什么、有什么硬要求。',
  '  2 句以内，40-70 个汉字。它是**常驻**的，不是进度：如果给出上一版 intro 且目的没变，原样返回，不要换个说法。',
  '  直接陈述目的，不要以"用户""这个会话"开头，不要写"他想""正在进行"。',
  '',
  'now —— 现在停在哪：正在做什么、卡在哪、下一步动什么。',
  '  2-4 句，60-140 个汉字。必须写出当前的**具体卡点或未解决的矛盾**：',
  '  比如需求还没达到预期、方案还没定、某处报错还没修、有个数字对不上。',
  '  如果确实没有卡点，就写下一步要动什么。禁止"进展顺利""继续推进"这类空话。',
  '  写具体的东西（文件名、数量、报错、谁等谁），不要复述对话。',
  '',
  '两个字段都用中文，纯文本：不要 markdown，不要列表，不要在答案外面加引号。',
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

// ------------------------------------------------------------- the material

/** Same route the session itself used — "跟当前会话同款". */
function routeOf(session, config) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  const route = session.requestHeader && session.requestHeader()
  const cfg = route && route.config
  if (cfg && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  return null
}

/**
 * Last N messages, newest kept intact.
 * `deriveMessages()` is cached and O(new events); tool results are dropped because
 * a single one can be larger than everything else combined.
 */
function conversationText(session, maxMessages, maxBytes) {
  const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
  const parts = []
  for (const message of messages.slice(-maxMessages * 2)) {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (text === '') continue
    parts.push((message.role === 'user' ? '### 用户\n' : '### 助手\n') + text)
  }

  const trimmed = parts.slice(-maxMessages)
  let text = trimmed.join('\n\n')
  while (trimmed.length > 1 && Buffer.byteLength(text, 'utf8') > maxBytes) {
    trimmed.shift()
    text = trimmed.join('\n\n')
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    const keep = maxBytes - 3
    text = Buffer.from(text, 'utf8').subarray(0, keep).toString('utf8') + '…'
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
  return { intro, now }
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

    const cached = await readCache(sessionId)
    if (cached && cached.coveredThroughSeq === watermark) return cached

    const until = cooling.get(sessionId)
    if (until && until > Date.now()) throw new Error('上次生成失败了，稍等再试')

    const running = inFlight.get(sessionId)
    if (running) return await running

    const task = (async () => {
      const route = routeOf(session, cfg)
      if (!route) throw new Error('这个会话还没跑过一轮，没有可用的模型路由')
      if (typeof session.deriveMessages !== 'function') throw new Error('这个 DSH 版本读不到会话消息（没有 deriveMessages）')
      const material = conversationText(session, cfg.maxMessages, cfg.maxInputBytes)
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
        const detail = '（块类型 ' + (seen.join(',') || '无') + '；正文 ' + (text ? text.slice(0, 80) : '空') + '）'
        throw new Error(message + (truncated ? '（输出在 maxOutputTokens 处被截断）' : '') + detail)
      }
      const record = {
        intro: parsed.intro,
        now: parsed.now,
        provider: route.provider,
        model: route.model,
        coveredThroughSeq: watermark,
        at: Date.now(),
        usage: usage || null,
      }
      await writeCache(sessionId, record)
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
        return Response.json(record, { headers: { 'cache-control': 'no-store' } })
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
