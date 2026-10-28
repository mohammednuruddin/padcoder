// Racing friends live, in a room: how a room is named, how the mod listens to
// it, and how what it hears is read. Everyone in a room runs the same course
// at the same moment once anyone starts a race, and sees the others' runs as
// they happen: each run's moves go to the room in batches, and every player
// plays them again with the game's own rules.

import { RULES_VERSION, type RivalRun } from './scene'

const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no I, L, O, 0 or 1 to misread
export const CODE = /^[A-HJKMNP-Z2-9]{5}$/
export const NAME = /^[A-Za-z0-9_-]{2,16}$/
export const newCode = (random: () => number) => Array.from({ length: 5 }, () => LETTERS[Math.floor(random() * LETTERS.length)] ?? 'A').join('')

// curl holds the room's event stream open and writes it out as it comes; it
// gives up after half an hour, and the room closes an idle stream sooner.
// A member back with the secret the room gave them takes their own place again.
export const listenArgv = (server: string, code: string, name: string, secret?: string) => [
  '/usr/bin/curl', '-sN', '--max-time', '1800', '-H', 'accept: text/event-stream',
  `${server}/rooms/${code}/listen?name=${encodeURIComponent(name)}&rules=${RULES_VERSION}${secret === undefined ? '' : `&secret=${secret}`}`,
]
export const sayPath = (code: string) => `/rooms/${code}/say`

// A race under way as the room has it: every racer's run so far.
export type RaceOn = { readonly race: number; readonly seed: number; readonly at: number; readonly names: readonly string[]; readonly runs: Readonly<Record<string, Omit<RivalRun, 'from'>>> }

// What the room says: hello (with the secret that signs what this player
// says, the room's clock, who is in and the race on), someone joining or
// leaving, a race starting, a batch of someone's run, someone sitting a race
// out, or the room closing the stream.
export type Heard =
  | { readonly kind: 'hello'; readonly secret: string; readonly now: number; readonly members: readonly string[]; readonly race?: RaceOn }
  | { readonly kind: 'joined' | 'left'; readonly name: string }
  | { readonly kind: 'skip'; readonly name: string; readonly race: number }
  | { readonly kind: 'start'; readonly race: number; readonly seed: number; readonly at: number; readonly names: readonly string[] }
  | { readonly kind: 'run'; readonly name: string; readonly race: number; readonly run: RivalRun }
  | { readonly kind: 'bye'; readonly why: string }

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const isNames = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText)
const isMoves = (v: unknown): v is RivalRun['moves'] =>
  Array.isArray(v) && v.every(m => Array.isArray(m) && isNumber(m[0]) && (m[1] === 'jump' || m[1] === 'slide' || m[1] === 'dash'))

// One line of the stream: an event (`data: {...}`), or the refusal a room
// answers instead of a stream (`{"error": ...}`), read as a bye.
export function heard(line: string): Heard | undefined {
  const text = line.startsWith('data: ') ? line.slice(6) : line.startsWith('{') ? line : undefined
  if (text === undefined) return undefined
  let d: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return undefined
    d = value as Record<string, unknown>
  } catch {
    return undefined
  }
  if (isText(d.error)) return { kind: 'bye', why: d.error }
  switch (d.kind) {
    case 'hello':
      return isText(d.secret) && isNumber(d.now) && isNames(d.members) ? { kind: 'hello', secret: d.secret, now: d.now, members: d.members, race: raceOn(d.race) } : undefined
    case 'skip':
      return isText(d.name) && isNumber(d.race) ? { kind: 'skip', name: d.name, race: d.race } : undefined
    case 'joined':
    case 'left':
      return isText(d.name) ? { kind: d.kind, name: d.name } : undefined
    case 'start':
      return isNumber(d.race) && isNumber(d.seed) && isNumber(d.at) && isNames(d.names) ? { kind: 'start', race: d.race, seed: d.seed, at: d.at, names: d.names } : undefined
    case 'run': {
      const run = runOf(d.run)
      return isText(d.name) && isNumber(d.race) && run !== undefined ? { kind: 'run', name: d.name, race: d.race, run } : undefined
    }
    case 'bye':
      return { kind: 'bye', why: isText(d.why) ? d.why : 'The room closed.' }
    default:
      return undefined
  }
}

const objectOf = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined)

function runOf(value: unknown): RivalRun | undefined {
  const r = objectOf(value)
  if (r === undefined || !isNumber(r.from) || !isMoves(r.moves) || !isNumber(r.t) || !isNumber(r.wait)) return undefined
  return { from: r.from, moves: r.moves, t: r.t, wait: r.wait, paused: r.paused === true, over: r.over === true }
}

function raceOn(value: unknown): RaceOn | undefined {
  const r = objectOf(value)
  const runs = objectOf(r?.runs)
  if (r === undefined || runs === undefined || !isNumber(r.race) || !isNumber(r.seed) || !isNumber(r.at) || !isNames(r.names)) return undefined
  const read: Record<string, Omit<RivalRun, 'from'>> = {}
  for (const [name, run] of Object.entries(runs)) {
    const whole = runOf({ ...objectOf(run), from: 0 })
    if (whole !== undefined) read[name] = whole
  }
  return { race: r.race, seed: r.seed, at: r.at, names: r.names, runs: read }
}
