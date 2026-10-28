// A room where friends race live: one Durable Object per room code. Each
// member listens on an event stream; what one says (a race to start, a batch
// of their run) goes out to the rest. Nothing is kept: a room is its members
// while they listen, and an idle room closes its streams.

import { ROOM_SIZE, RULES_VERSION } from '../../mods/bug-dash/hooks/scene'

const NAME = /^[A-Za-z0-9_-]{2,16}$/
const ACTIONS: ReadonlySet<unknown> = new Set(['jump', 'slide', 'dash'])
const START_MS = 3000 // a race starts this long after it's called, for everyone to hear of it
const IDLE_MS = 10 * 60_000 // streams close this long after the last race or join
const PING_MS = 20_000 // a comment down every stream, to keep it open and find who's gone
const MAX_SAY = 16_000
const MAX_BATCH = 400
const SAYS_PER_SECOND = 10

type Member = { readonly name: string; readonly secret: string; readonly writer: WritableStreamDefaultWriter<Uint8Array>; said: number[] }

const encoder = new TextEncoder()
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

export class Room {
  private readonly members = new Map<string, Member>()
  private race = 0
  private startedAt = 0
  private activeAt = 0
  private ping: ReturnType<typeof setInterval> | undefined

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname.endsWith('/listen')) return this.listen(url)
    if (request.method === 'POST' && url.pathname.endsWith('/say')) return this.say(request)
    return json({ error: 'Nothing here.' }, 404)
  }

  // Opens a member's stream: hello first, with the secret that signs what
  // they say, the room's clock and who is in; then whatever the room hears.
  private listen(url: URL) {
    const name = url.searchParams.get('name') ?? ''
    if (!NAME.test(name)) return json({ error: 'A name is 2 to 16 letters, digits, _ or -.' }, 400)
    if (Number(url.searchParams.get('rules')) !== RULES_VERSION) return json({ error: 'This Bug Dash is out of date: update it to race online.' }, 409)
    const key = name.toLowerCase()
    if (this.members.has(key)) return json({ error: `${name} is in this room already.` }, 409)
    if (this.members.size >= ROOM_SIZE) return json({ error: 'This room is full.' }, 409)
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const member: Member = { name, secret: hex(crypto.getRandomValues(new Uint8Array(16))), writer: writable.getWriter(), said: [] }
    this.members.set(key, member)
    this.activeAt = Date.now()
    this.send(member, { kind: 'hello', secret: member.secret, now: Date.now(), members: [...this.members.values()].map(m => m.name) })
    this.broadcast({ kind: 'joined', name }, member)
    this.ping ??= setInterval(() => this.tick(), PING_MS)
    return new Response(readable, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  }

  // What a member says: start a race, or a batch of their run for the rest.
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

    if (said.kind === 'start') {
      // One race at a time starts: a second call while one counts down joins it.
      if (now - this.startedAt > START_MS) {
        this.race += 1
        this.startedAt = now
        this.activeAt = now
        const seed = crypto.getRandomValues(new Int32Array(1))[0] ?? 1
        this.broadcast({ kind: 'start', race: this.race, seed, at: now + START_MS, names: [...this.members.values()].map(m => m.name) })
      }
      return new Response(null, { status: 204 })
    }
    if (said.kind === 'run') {
      const { race, from, moves, t, wait } = said
      if (race !== this.race) return json({ error: 'That race is over.' }, 409)
      const ok =
        Number.isInteger(from) && (from as number) >= 0 &&
        Array.isArray(moves) && moves.length <= MAX_BATCH &&
        moves.every(m => Array.isArray(m) && m.length === 2 && Number.isInteger(m[0]) && ACTIONS.has(m[1])) &&
        typeof t === 'number' && Number.isFinite(t) && typeof wait === 'number' && wait >= 0 && wait <= 5000
      if (!ok) return json({ error: 'That run makes no sense.' }, 400)
      const run = { from, moves, t, wait, paused: said.paused === true, over: said.over === true }
      this.broadcast({ kind: 'run', name: member.name, race, run }, member)
      return new Response(null, { status: 204 })
    }
    return json({ error: 'Say start or run.' }, 400)
  }

  private send(member: Member, event: unknown) {
    member.writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)).catch(() => this.drop(member))
  }

  private broadcast(event: unknown, except?: Member) {
    for (const member of this.members.values()) if (member !== except) this.send(member, event)
  }

  // A member whose stream won't take a write is gone.
  private drop(member: Member) {
    const key = member.name.toLowerCase()
    if (this.members.get(key) !== member) return
    this.members.delete(key)
    member.writer.close().catch(() => undefined)
    this.broadcast({ kind: 'left', name: member.name })
    this.quiet()
  }

  // Keeps the streams open, finds who has gone, and closes an idle room.
  private tick() {
    if (Date.now() - this.activeAt > IDLE_MS) {
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
  }
}
