// Bug Dash's daily race: today's leaderboard and ghosts, and runs checked by
// playing them again with the game's own rules, so a score can't be made up.

import { LATE_MS, RULES_VERSION, dayOf, daySeed, replay, type Move } from '../../mods/bug-dash/hooks/scene'

// The little of D1 this uses.
type Row = Record<string, unknown>
type Statement = {
  bind(...values: unknown[]): Statement
  first<T = Row>(): Promise<T | null>
  all<T = Row>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}
type Env = { DB: { prepare(query: string): Statement } }

const LIMIT_MS = 20 * 60_000 // runs longer than this aren't ranked
const MAX_MOVES = 20_000 // 16 presses a second for 20 minutes
const MAX_BODY = 600_000
const MAX_TRIES = 300 // runs a player may send in a day
// One player's run doesn't hold this much of another's moves, each within a
// few milliseconds, by chance; a copy does, nudged or padded with more. A
// shorter run is a copy only move for move; a run of a move or two is worth
// too little to tell.
const LONG_RUN = 20
const COPIED = 0.8
const NEAR_MS = 8
const SHORT_RUN = 3
const TOP = 10
const NAME = /^[A-Za-z0-9_-]{2,16}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const ACTIONS: ReadonlySet<unknown> = new Set(['jump', 'slide', 'dash'])

class Refusal extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (request.method === 'POST' && url.pathname === '/join') return await join(request, env)
      if (request.method === 'POST' && url.pathname === '/run') return await run(request, env)
      const day = /^\/day\/([^/]+)$/.exec(url.pathname)?.[1]
      if (request.method === 'GET' && day !== undefined) return json(await board(env, day, url.searchParams.get('name')))
      const name = /^\/medals\/([^/]+)$/.exec(url.pathname)?.[1]
      if (request.method === 'GET' && name !== undefined) return json(await medals(env, name))
      throw new Refusal(404, 'Nothing here.')
    } catch (error) {
      if (error instanceof Refusal) return json({ error: error.message }, error.status)
      console.error(error)
      return json({ error: 'Something went wrong.' }, 500)
    }
  },
}

// Takes a name, if it's free, and answers the token that runs are sent with.
async function join(request: Request, env: Env) {
  const { name } = await body(request)
  if (typeof name !== 'string' || !NAME.test(name)) throw new Refusal(400, 'A name is 2 to 16 letters, digits, _ or -.')
  const token = hex(crypto.getRandomValues(new Uint8Array(24)))
  const added = await env.DB.prepare('INSERT INTO players (key, name, token_hash, joined) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO NOTHING')
    .bind(name.toLowerCase(), name, await sha256(token), Date.now())
    .run()
  if (added.meta.changes === 0) throw new Refusal(409, `${name} is taken.`)
  return json({ name, token }, 201)
}

// A day's top runs, how many ran it, where `name` stands, and the moves of
// the leader's run and of `name`'s best, to race as ghosts.
async function board(env: Env, day: string, name: string | null) {
  if (!DAY.test(day)) throw new Refusal(400, 'A day is YYYY-MM-DD.')
  const top = (
    await env.DB.prepare('SELECT name, score, level FROM runs WHERE day = ? AND rules = ? ORDER BY score DESC, at ASC, key ASC LIMIT ?')
      .bind(day, RULES_VERSION, TOP)
      .all<{ name: string; score: number; level: number }>()
  ).results
  const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM runs WHERE day = ? AND rules = ?').bind(day, RULES_VERSION).first<{ total: number }>()
  const ghosts: { name: string; score: number; moves: Move[] }[] = []
  const leader = await env.DB.prepare('SELECT name, score, moves FROM runs WHERE day = ? AND rules = ? ORDER BY score DESC, at ASC, key ASC LIMIT 1')
    .bind(day, RULES_VERSION)
    .first<{ name: string; score: number; moves: string }>()
  if (leader !== null) ghosts.push({ name: leader.name, score: leader.score, moves: JSON.parse(leader.moves) as Move[] })
  let you: { name: string; score: number; level: number; rank: number } | undefined
  if (name !== null && NAME.test(name)) {
    const mine = await env.DB.prepare('SELECT name, score, level, moves, at FROM runs WHERE day = ? AND rules = ? AND key = ?')
      .bind(day, RULES_VERSION, name.toLowerCase())
      .first<{ name: string; score: number; level: number; moves: string; at: number }>()
    if (mine !== null) {
      you = { name: mine.name, score: mine.score, level: mine.level, rank: await rankOf(env, day, mine.score, mine.at, name.toLowerCase()) }
      if (mine.name !== leader?.name) ghosts.push({ name: mine.name, score: mine.score, moves: JSON.parse(mine.moves) as Move[] })
    }
  }
  return { day, rules: RULES_VERSION, total: count?.total ?? 0, top, you, ghosts }
}

// How many final days (whose late runs are in) `name` won, ended in the top
// three, and ended in the top ten, on any rules' board: what earns skins.
// Only the player's own runs are looked at, each counting the runs ahead of
// it on its board, through the indexes.
async function medals(env: Env, name: string) {
  if (!NAME.test(name)) throw new Refusal(400, 'A name is 2 to 16 letters, digits, _ or -.')
  const row = await env.DB.prepare(
    `SELECT COUNT(CASE WHEN ahead < 1 THEN 1 END) AS gold, COUNT(CASE WHEN ahead < 3 THEN 1 END) AS silver, COUNT(CASE WHEN ahead < ? THEN 1 END) AS copper FROM (
       SELECT (SELECT COUNT(*) FROM runs o WHERE o.day = m.day AND o.rules = m.rules
                 AND (o.score > m.score OR (o.score = m.score AND (o.at < m.at OR (o.at = m.at AND o.key < m.key))))) AS ahead
       FROM runs m WHERE m.key = ? AND m.day < ?
     )`,
  )
    .bind(TOP, name.toLowerCase(), dayOf(Date.now() - LATE_MS))
    .first<{ gold: number; silver: number; copper: number }>()
  return { name, gold: row?.gold ?? 0, silver: row?.silver ?? 0, copper: row?.copper ?? 0 }
}

// Plays a run again from today's seed and its moves, and keeps it if it's
// the player's best today. The score is the replay's, whatever was claimed.
// A replay shows a run's moves make its score on the course, not who made
// them: the best runs are public as ghosts, so a run that is mostly one of
// the day's top runs by another player is refused.
async function run(request: Request, env: Env) {
  const sent = await body(request)
  if (sent.rules !== RULES_VERSION) throw new Refusal(409, 'This Bug Dash is out of date: update it to race online.')
  const { day, name, token, moves } = sent
  const now = Date.now()
  if (typeof day !== 'string' || (day !== dayOf(now) && day !== dayOf(now - LATE_MS))) throw new Refusal(409, 'That day is over.')
  if (typeof name !== 'string' || typeof token !== 'string' || !NAME.test(name)) throw new Refusal(401, 'Join first.')
  const key = name.toLowerCase()
  const player = await env.DB.prepare('SELECT name, token_hash FROM players WHERE key = ?').bind(key).first<{ name: string; token_hash: string }>()
  if (player === null || player.token_hash !== (await sha256(token))) throw new Refusal(401, 'That name belongs to someone else.')
  if (!isLog(moves)) throw new Refusal(400, 'Those moves make no run.')
  const before = await env.DB.prepare('SELECT tries FROM runs WHERE day = ? AND rules = ? AND key = ?').bind(day, RULES_VERSION, key).first<{ tries: number }>()
  if ((before?.tries ?? 0) >= MAX_TRIES) throw new Refusal(429, 'That is enough runs for today.')

  const g = replay(daySeed(day), moves, LIMIT_MS)
  if (g.mode !== 'over') throw new Refusal(422, 'Runs over 20 minutes are not ranked.')
  // A run logs only moves that take, and none after the crash.
  if (g.log.length !== moves.length) throw new Refusal(400, 'Those moves make no run.')
  const others = await env.DB.prepare('SELECT name, moves FROM runs WHERE day = ? AND rules = ? AND key != ? ORDER BY score DESC, at ASC, key ASC LIMIT ?')
    .bind(day, RULES_VERSION, key, TOP)
    .all<{ name: string; moves: string }>()
  for (const other of others.results) {
    const theirs = JSON.parse(other.moves) as Move[]
    const copied =
      theirs.length >= LONG_RUN
        ? held(theirs, moves, NEAR_MS) >= theirs.length * COPIED
        : theirs.length >= SHORT_RUN && held(theirs, moves, 0) === theirs.length
    if (copied) throw new Refusal(409, `That run is ${other.name}'s.`)
  }
  await env.DB.prepare(
    `INSERT INTO runs (day, rules, key, name, score, level, moves, at, tries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT (day, rules, key) DO UPDATE SET
       tries = tries + 1,
       moves = CASE WHEN excluded.score > runs.score THEN excluded.moves ELSE runs.moves END,
       level = CASE WHEN excluded.score > runs.score THEN excluded.level ELSE runs.level END,
       at = CASE WHEN excluded.score > runs.score THEN excluded.at ELSE runs.at END,
       score = MAX(runs.score, excluded.score)`,
  )
    .bind(day, RULES_VERSION, key, player.name, g.score, g.level, JSON.stringify(moves), now)
    .run()
  const best = await env.DB.prepare('SELECT score, at FROM runs WHERE day = ? AND rules = ? AND key = ?')
    .bind(day, RULES_VERSION, key)
    .first<{ score: number; at: number }>()
  const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM runs WHERE day = ? AND rules = ?').bind(day, RULES_VERSION).first<{ total: number }>()
  return json({
    score: g.score,
    level: g.level,
    claimed: sent.score,
    best: best?.score ?? g.score,
    rank: best === null ? 1 : await rankOf(env, day, best.score, best.at, key),
    total: count?.total ?? 1,
  })
}

// How many of `theirs` have a move of the same kind in `mine` within
// `near` ms, each of `mine` matching one at most: one pass over each kind of
// move, both in time order, so it stays linear however dense a log is.
function held(theirs: readonly Move[], mine: readonly Move[], near: number) {
  let count = 0
  for (const action of ACTIONS) {
    const a = theirs.filter(m => m[1] === action).map(m => m[0])
    const b = mine.filter(m => m[1] === action).map(m => m[0])
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
      const t = a[i] ?? 0
      const u = b[j] ?? 0
      if (u < t - near) j++
      else if (u > t + near) i++
      else {
        count++
        i++
        j++
      }
    }
  }
  return count
}

// Runs rank by score, then the earlier, then by name.
async function rankOf(env: Env, day: string, score: number, at: number, key: string) {
  const ahead = await env.DB.prepare('SELECT COUNT(*) AS ahead FROM runs WHERE day = ? AND rules = ? AND (score > ? OR (score = ? AND (at < ? OR (at = ? AND key < ?))))')
    .bind(day, RULES_VERSION, score, score, at, at, key)
    .first<{ ahead: number }>()
  return (ahead?.ahead ?? 0) + 1
}

// Moves in order, each at a whole millisecond within the limit.
function isLog(moves: unknown): moves is Move[] {
  if (!Array.isArray(moves) || moves.length > MAX_MOVES) return false
  let last = 0
  for (const m of moves) {
    if (!Array.isArray(m) || m.length !== 2 || !ACTIONS.has(m[1])) return false
    const t: unknown = m[0]
    if (typeof t !== 'number' || !Number.isInteger(t) || t < last || t > LIMIT_MS) return false
    last = t
  }
  return true
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.length > MAX_BODY) throw new Refusal(413, 'That is too much.')
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {}
  throw new Refusal(400, 'Send JSON.')
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
