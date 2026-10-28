// A room where friends race live: one Durable Object per room code. Each
// member listens on an event stream; what one says (start a race, a batch of
// their run) goes out to the rest. Nothing is stored: a room is its members
// while they listen, and the current race's moves, so a member back from a
// dropped stream picks the race up where it is. An idle room closes.

import { LIMIT_MS, ROOM_SIZE, RULES_VERSION, type Move } from '../../mods/bug-dash/hooks/scene'

const NAME = /^[A-Za-z0-9_-]{2,16}$/
const ACTIONS: ReadonlySet<unknown> = new Set(['jump', 'slide', 'dash'])
const START_MS = 3000 // a race starts this long after it's called, for everyone to hear of it
const IDLE_MS = 10 * 60_000 // with no race on, streams close this long after the last race or join
const PING_MS = 45_000 // a comment down every stream, inside the edge's 100 s idle limit
const MAX_SAY = 16_000
const MAX_BATCH = 400
const SAYS_PER_SECOND = 10

type Member = { readonly name: string; readonly secret: string; readonly writer: WritableStreamDefaultWriter<Uint8Array>; said: number[] }
// A racer's run as the room has it: every move so far, and where it stands.
type Racer = { readonly name: string; moves: Move[]; t: number; wait: number; paused: boolean; over: boolean }

const encoder = new TextEncoder()
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
const runOf = (r: Racer) => ({ moves: r.moves, t: r.t, wait: r.wait, paused: r.paused, over: r.over })

export class Room {
  private readonly members = new Map<string, Member>()
  private readonly racers = new Map<string, Racer>()
  private race = 0
  private seed = 0
  private at = 0
  private activeAt = 0
  private ping: ReturnType<typeof setInterval> | undefined

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname.endsWith('/listen')) return this.listen(url)
    if (request.method === 'POST' && url.pathname.endsWith('/say')) return this.say(request)
    return json({ error: 'Nothing here.' }, 404)
  }

  // Whether a race is on: someone in it not caught yet, and not past its limit.
  private racing() {
    return Date.now() - this.at < LIMIT_MS + START_MS && [...this.racers.values()].some(r => !r.over)
  }

  // Opens a member's stream: hello first, with the secret that signs what
  // they say, the room's clock, who is in, and the race on, moves and all.
  // A member back with their secret takes their own place again.
  private listen(url: URL) {
    const name = url.searchParams.get('name') ?? ''
    if (!NAME.test(name)) return json({ error: 'A name is 2 to 16 letters, digits, _ or -.' }, 400)
    if (Number(url.searchParams.get('rules')) !== RULES_VERSION) return json({ error: 'This Bug Dash is out of date: update it to race online.' }, 409)
    const key = name.toLowerCase()
    const old = this.members.get(key)
    if (old !== undefined && old.secret !== url.searchParams.get('secret')) return json({ error: `${name} is in this room already.` }, 409)
    if (old === undefined && this.members.size >= ROOM_SIZE) return json({ error: 'This room is full.' }, 409)
    if (old !== undefined) old.writer.close().catch(() => undefined)
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const member: Member = { name, secret: old?.secret ?? hex(crypto.getRandomValues(new Uint8Array(16))), writer: writable.getWriter(), said: [] }
    this.members.set(key, member)
    this.activeAt = Date.now()
    const race = this.racing()
    this.send(member, {
      kind: 'hello', secret: member.secret, now: Date.now(), members: [...this.members.values()].map(m => m.name),
      race: race ? { race: this.race, seed: this.seed, at: this.at, names: [...this.racers.values()].map(r => r.name), runs: Object.fromEntries([...this.racers.values()].map(r => [r.name, runOf(r)])) } : undefined,
    })
    if (old === undefined) this.broadcast({ kind: 'joined', name }, member)
    this.ping ??= setInterval(() => this.tick(), PING_MS)
    return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  }

  // What a member says: start a race, a batch of their run, sit a race out, or go.
  private async say(request: Request) {
    const text = await request.text()
    if (text.length > MAX_SAY) return json({ error: 'That is too much.' }, 413)
    let said: Record<string, unknown>
    try {
      said = JSON.parse(text) as Record<string, unknown>
    } catch {
      return json({ error: 'Send JSON.' }, 400)
    }
    const member = typeof said.name === 'string' ? this.members.get(said.name.toLowerCase()) : undefined
    if (member === undefined || said.secret !== member.secret) return json({ error: 'Listen to the room first.' }, 401)
    const now = Date.now()
    member.said = member.said.filter(at => now - at < 1000)
    if (member.said.length >= SAYS_PER_SECOND) return json({ error: 'Slow down.' }, 429)
    member.said.push(now)
    const key = member.name.toLowerCase()

    switch (said.kind) {
      case 'start': {
        // One race at a time: the next starts once everyone in this one is caught.
        if (this.racing()) return json({ error: 'A race is on: the next starts once everyone is caught.' }, 409)
        this.race += 1
        this.seed = crypto.getRandomValues(new Int32Array(1))[0] ?? 1
        this.at = now + START_MS
        this.activeAt = now
        this.racers.clear()
        for (const m of this.members.values()) this.racers.set(m.name.toLowerCase(), { name: m.name, moves: [], t: 0, wait: 0, paused: false, over: false })
        this.broadcast({ kind: 'start', race: this.race, seed: this.seed, at: this.at, names: [...this.members.values()].map(m => m.name) })
        return new Response(null, { status: 204 })
      }
      case 'run': {
        const racer = this.racers.get(key)
        const { race, from, moves, t, wait } = said
        if (race !== this.race || racer === undefined) return json({ error: 'That race is over.' }, 409)
        const ok =
          Number.isInteger(from) && (from as number) >= 0 && (from as number) <= racer.moves.length &&
          Array.isArray(moves) && moves.length <= MAX_BATCH &&
          moves.every(m => Array.isArray(m) && m.length === 2 && Number.isInteger(m[0]) && ACTIONS.has(m[1])) &&
          typeof t === 'number' && Number.isFinite(t) && typeof wait === 'number' && wait >= 0 && wait <= 5000
        if (!ok) return json({ error: 'That run makes no sense.' }, 400)
        // Moves the room has already are skipped; a batch sent again is harmless.
        const fresh = (moves as Move[]).slice(racer.moves.length - (from as number))
        racer.moves.push(...fresh)
        Object.assign(racer, { t, wait, paused: said.paused === true, over: said.over === true })
        this.activeAt = now
        this.broadcast({ kind: 'run', name: member.name, race, run: { from, moves, t: racer.t, wait: racer.wait, paused: racer.paused, over: racer.over } }, member)
        return new Response(null, { status: 204 })
      }
      case 'skip': {
        // Busy with a run of their own: out of this race.
        if (this.racers.delete(key)) this.broadcast({ kind: 'skip', name: member.name, race: this.race })
        return new Response(null, { status: 204 })
      }
      case 'bye':
        this.drop(member)
        return new Response(null, { status: 204 })
    }
    return json({ error: 'Say start, run, skip or bye.' }, 400)
  }

  private send(member: Member, event: unknown) {
    member.writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => this.drop(member))
  }

  private broadcast(event: unknown, except?: Member) {
    for (const member of this.members.values()) if (member !== except) this.send(member, event)
  }

  // A member gone: said bye, or their stream won't take a write. Out of the
  // race too, where they stand.
  private drop(member: Member) {
    const key = member.name.toLowerCase()
    if (this.members.get(key) !== member) return
    this.members.delete(key)
    member.writer.close().catch(() => undefined)
    const racer = this.racers.get(key)
    if (racer !== undefined) racer.over = true
    this.broadcast({ kind: 'left', name: member.name })
    this.quiet()
  }

  // Keeps the streams open and finds who has gone; closes a room idle, with no race on.
  private tick() {
    if (!this.racing() && Date.now() - this.activeAt > IDLE_MS) {
      for (const member of [...this.members.values()]) {
        this.send(member, { kind: 'bye', why: 'The room closed after 10 minutes without a race. /bugdash room with its code joins again.' })
        this.members.delete(member.name.toLowerCase())
        member.writer.close().catch(() => undefined)
      }
    } else {
      for (const member of [...this.members.values()]) member.writer.write(encoder.encode(': ping\n\n')).catch(() => this.drop(member))
    }
    this.quiet()
  }

  private quiet() {
    if (this.members.size > 0 || this.ping === undefined) return
    clearInterval(this.ping)
    this.ping = undefined
    this.racers.clear()
  }
}
