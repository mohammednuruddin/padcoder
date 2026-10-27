// Bug Dash: the run's rules and its drawing, apart from the engine.
//
// The world is laid out in world pixels and scrolls at a speed that changes
// only at fixed times, so where everything is follows from the game clock.
// The band is redrawn for many reasons (other mods, the app) and the desktop
// restarts a drawing's animations on each, so a drawing is made for the
// moment it is drawn and CSS carries the run on from there: the engine only
// redraws when something changes.

import type { ClaudeStatus } from '../types'

export const HEIGHT = 96
const GROUND = 78
const RX = 104 // Clawd's left edge, clear of the score
// One of Clawd's pixels: a terminal quadrant, twice as tall as it is wide.
const PW = 3
const PH = 5
const CLAWD_H = 5 * PH
const RUN_L = RX + 10 // Clawd's body, less a little grace
const RUN_R = RX + 42
const STAND_H = 22
const SLIDE_H = 13
const FAIL_LOW = 15 // how far above the ground a FAIL banner hangs

const GRAVITY = 0.00118 // px/ms²
const JUMP_V = 0.33 // px/ms: a 46 px hop, 560 ms in the air
const DOUBLE_V = 0.3
const DIVE_V = -0.42
const CEILING = 50
const SLIDE_MS = 520
const DASH_MS = 420
const COUNTDOWN_MS = 1200 // a resumed run counts 3, 2, 1 with the world still
const REGEN = 1 / 6500 // dash charges a millisecond
const CHARGES = 3

// Every level the world speeds up, the long gaps close in and harder
// patterns come in, until the last level, six minutes in.
const BASE_SPEED = 0.26 // px/ms
const TOP_SPEED = 0.66 // what the speed closes in on
const RAMP = 0.92 // the share of the climb still to go after each level
const LEVEL_MS = 9000
const LAST_LEVEL = 40
const GAP_MS = 560 // the shortest gap: a whole jump
const SPREAD_MS = 820 // how much longer a gap may be at first
const LAST_SPREAD_MS = 280 // and at the last level

// The rules run in 4 ms steps on a fixed grid of game time, and course is
// laid out a fixed way ahead, so a run is a function of its seed and its
// moves alone: the server plays it again to check a score.
export const RULES_VERSION = 1
const STEP_MS = 4
export const WIDEST = 1400 // the widest band drawn
export const LIMIT_MS = 20 * 60_000 // the longest run the race ranks
const GHOSTS = 2
const AHEAD = 2 * WIDEST // course is laid out at least this far ahead
const WORLD_MS = 20000 // how long one drawing's scroll runs on
const POP_MS = 750
const LEVEL_POP_MS = 1400
const POINTS = { pass: 10, token: 25, smash: 15 } as const

export type Action = 'jump' | 'slide' | 'dash' | 'pause'
// A move that took, at a whole millisecond of game time.
export type Move = readonly [t: number, action: Exclude<Action, 'pause'>]
export type Mode = 'ready' | 'running' | 'paused' | 'over'
export type PauseReason = 'you' | 'pad' | 'finished' | 'needsYou' | 'hidden'
type Kind = 'bug' | 'fail' | 'token'

type Thing = { readonly id: number; readonly kind: Kind; readonly x: number; readonly h: number; done?: 'passed' | 'taken' | 'smashed' | 'missed' }
type Air = { readonly at: number; readonly h: number; readonly v: number }
// `value` is the points scored, or the level reached.
type Pop = { readonly kind: 'token' | 'smash' | 'double' | 'level'; readonly y: number; readonly wall: number; readonly value: number }

export type Game = {
  mode: Mode
  why: PauseReason
  seed: number
  rng: number
  // Game time stands still unless running: `gameAt` at the wall clock's
  // `clockAt`, which a resume sets after the countdown.
  gameAt: number
  clockAt: number
  countdownUntil: number
  simAt: number
  air: Air | null
  jumps: number
  slideUntil: number
  dashUntil: number
  energy: number
  energyAt: number
  things: Thing[]
  log: Move[]
  nextId: number
  aheadTo: number
  level: number
  charges: number
  score: number
  best: number
  isNewBest: boolean
  pops: Pop[]
  crash: { readonly kind: Kind; readonly h: number; readonly wall: number } | null
  ghosts: Ghost[]
}

// Another player's run of the day, raced as a ghost from its moves.
export type GhostRun = { readonly name: string; readonly score: number; readonly moves: readonly Move[] }
type Ghost = GhostRun & { readonly seed: number; readonly endsAt: number; game: Game; next: number }

// The daily race as the band shows it, once the player has joined.
export type Race = {
  readonly top: readonly { readonly name: string; readonly score: number }[]
  readonly total: number
  readonly you?: { readonly rank: number; readonly score: number }
  // The last run sent: on its way, lost, or where it put the player.
  readonly sent?: 'sending' | 'failed' | { readonly rank: number; readonly total: number; readonly best: number }
}

export type View = { readonly width: number; readonly claude: ClaudeStatus; readonly race?: Race }

export const widthFor = (columns: number) => Math.min(WIDEST, Math.max(360, Math.round(columns * 8)))

export const newGame = (): Game => ({
  mode: 'ready', why: 'you', seed: 1, rng: 1, gameAt: 0, clockAt: 0, countdownUntil: 0, simAt: 0, air: null, jumps: 0,
  slideUntil: 0, dashUntil: 0, energy: 1, energyAt: 0, things: [], log: [], nextId: 1, aheadTo: 0,
  level: 0, charges: 1, score: 0, best: 0, isNewBest: false, pops: [], crash: null, ghosts: [],
})

export const gameTime = (g: Game, now: number) => (g.mode === 'running' ? g.gameAt + Math.max(0, now - g.clockAt) : g.gameAt)

// Everyone runs the same course on a given day, in UTC.
export const dayOf = (wall: number) => new Date(wall).toISOString().slice(0, 10)
export function daySeed(day: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < day.length; i++) h = Math.imul(h ^ day.charCodeAt(i), 0x01000193)
  return h | 0
}

// ------------------------------------------------------------------ motion

const levelAt = (t: number) => Math.max(0, Math.floor(t / LEVEL_MS))
// RAMP to the power of each level, by repeated multiplication: exact in every
// engine, where a power function need not be, so the server's replay lands
// where the run did.
const DECAY = Array.from({ length: LAST_LEVEL + 1 }, (_, level) => {
  let k = 1
  for (let l = 0; l < level; l++) k *= RAMP
  return k
})
const decay = (level: number) => DECAY[Math.min(level, LAST_LEVEL)] ?? 0
const speedOf = (level: number) => TOP_SPEED - (TOP_SPEED - BASE_SPEED) * decay(level)
export const speedAt = (t: number) => speedOf(levelAt(t))
// Points count for more the longer the run lasts.
export const multiplier = (level: number) => 1 + Math.floor(level / 4)

// How far the world has scrolled when each level starts, up to the last.
const LEVEL_DIST = Array.from({ length: LAST_LEVEL + 1 }, (_, level) => {
  let d = 0
  for (let l = 0; l < level; l++) d += speedOf(l) * LEVEL_MS
  return d
})

// How far the world has scrolled by game time `t`, and the inverse.
export function distAt(t: number): number {
  const level = Math.min(levelAt(t), LAST_LEVEL)
  return (LEVEL_DIST[level] ?? 0) + speedOf(level) * (t - level * LEVEL_MS)
}

function timeAtDist(d: number): number {
  let level = 0
  while (level < LAST_LEVEL && (LEVEL_DIST[level + 1] ?? Infinity) <= d) level++
  return level * LEVEL_MS + (d - (LEVEL_DIST[level] ?? 0)) / speedOf(level)
}

const heightAt = (air: Air | null, t: number) => {
  if (air === null) return 0
  const dt = t - air.at
  return Math.max(0, air.h + air.v * dt - (GRAVITY * dt * dt) / 2)
}
const velocityAt = (air: Air, t: number) => air.v - GRAVITY * (t - air.at)
const landTime = (air: Air) => air.at + (air.v + Math.sqrt(air.v * air.v + 2 * GRAVITY * air.h)) / GRAVITY
const isSliding = (g: Game, t: number) => t < g.slideUntil && heightAt(g.air, t) === 0
const energyAt = (g: Game, t: number) => Math.min(CHARGES, g.energy + (t - g.energyAt) * REGEN)

const BOX: Readonly<Record<Kind, { readonly l: number; readonly r: number; readonly w: number }>> = {
  bug: { l: 3, r: 21, w: 24 },
  fail: { l: 3, r: 41, w: 44 },
  token: { l: 1, r: 13, w: 14 },
}
const reach = (thing: Thing): readonly [number, number] =>
  thing.kind === 'bug' ? [0, 10] : thing.kind === 'fail' ? [FAIL_LOW, 999] : [thing.h, thing.h + 12]

function touches(g: Game, thing: Thing, t: number): boolean {
  const x = thing.x - distAt(t)
  const box = BOX[thing.kind]
  if (x + box.l >= RUN_R || x + box.r <= RUN_L) return false
  const h = heightAt(g.air, t)
  const [low, high] = reach(thing)
  return h + (isSliding(g, t) ? SLIDE_H : STAND_H) > low && h < high
}

// ------------------------------------------------------------------- world

function random(g: Game) {
  g.rng = (g.rng + 0x6d2b79f5) | 0
  let t = g.rng
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

function place(g: Game, kind: Kind, x: number, h = 0) {
  g.things.push({ id: g.nextId++, kind, x, h })
  return x + BOX[kind].w
}

// A stretch of course laid from `x` at `speed`; returns where it ends.
type Lay = (g: Game, x: number, speed: number) => number

const layBug: Lay = (g, x) => place(g, 'bug', x)

// Each pattern: the level it first comes up at, and how often it comes up
// at the first level and at the last. The parts of a combo are spaced in
// time, so each can be cleared in turn at any speed.
const PATTERNS: readonly { readonly from: number; readonly first: number; readonly last: number; readonly lay: Lay }[] = [
  { from: 0, first: 30, last: 10, lay: layBug },
  {
    from: 0, first: 24, last: 10,
    lay: (g, x) => {
      const end = place(g, 'fail', x)
      if (random(g) < 0.5) place(g, 'token', x + 15, 2)
      return end
    },
  },
  {
    from: 0, first: 18, last: 6,
    lay: (g, x) => {
      place(g, 'token', x - 26, 24)
      place(g, 'token', x + 5, 40)
      place(g, 'token', x + 36, 24)
      return place(g, 'bug', x)
    },
  },
  {
    from: 0, first: 9, last: 3,
    lay: (g, x) => {
      for (let i = 0; i < 3; i++) place(g, 'token', x + i * 22, 2)
      return place(g, 'token', x + 66, 2)
    },
  },
  {
    from: 0, first: 7, last: 2,
    lay: (g, x) => {
      for (let i = 0; i < 2; i++) place(g, 'token', x + i * 22, 30)
      return place(g, 'token', x + 44, 30)
    },
  },
  {
    from: 1, first: 12, last: 12,
    lay: (g, x) => {
      place(g, 'bug', x)
      return place(g, 'bug', x + 30)
    },
  },
  // A bug, then a banner: land and slide, or dive under it.
  { from: 3, first: 10, last: 14, lay: (g, x, speed) => place(g, 'fail', place(g, 'bug', x) + speed * 640) },
  // A banner, then a bug: slide, then jump.
  { from: 5, first: 10, last: 14, lay: (g, x, speed) => place(g, 'bug', place(g, 'fail', x) + speed * 600) },
  // Three bugs in a row: one long jump, or a double.
  {
    from: 8, first: 8, last: 12,
    lay: (g, x) => {
      place(g, 'bug', x)
      place(g, 'bug', x + 30)
      return place(g, 'bug', x + 60)
    },
  },
  // Two banners: one long slide, with a token between them.
  {
    from: 11, first: 8, last: 10,
    lay: (g, x) => {
      place(g, 'fail', x)
      place(g, 'token', x + 49, 2)
      return place(g, 'fail', x + 56)
    },
  },
]

function pick(g: Game, level: number): Lay {
  const k = level / LAST_LEVEL
  const open = PATTERNS.filter(p => level >= p.from).map(p => ({ lay: p.lay, weight: p.first + (p.last - p.first) * k }))
  let roll = random(g) * open.reduce((sum, p) => sum + p.weight, 0)
  return open.find(p => (roll -= p.weight) < 0)?.lay ?? layBug
}

// Lays the course out ahead of Clawd. Gaps are timed, so they grow with the
// speed and every pattern stays clearable; the long ones close in level by
// level.
function generate(g: Game, upTo: number) {
  while (g.aheadTo < upTo) {
    const level = Math.min(LAST_LEVEL, levelAt(timeAtDist(g.aheadTo)))
    const speed = speedOf(level)
    const spread = LAST_SPREAD_MS + (SPREAD_MS - LAST_SPREAD_MS) * decay(level)
    const x = g.aheadTo + speed * (GAP_MS + random(g) * spread) + 30
    g.aheadTo = pick(g, level)(g, x, speed)
  }
  g.things.sort((a, b) => a.x - b.x)
}

// ------------------------------------------------------------------- rules

function start(g: Game, now: number) {
  Object.assign(g, {
    mode: 'running', why: 'you', rng: g.seed, gameAt: 0, clockAt: now, countdownUntil: 0, simAt: 0, air: null, jumps: 0,
    slideUntil: 0, dashUntil: 0, energy: 1, energyAt: 0, things: [], log: [], aheadTo: RX + 300,
    level: 0, charges: 1, score: 0, isNewBest: false, pops: [], crash: null,
  } satisfies Partial<Game>)
  generate(g, AHEAD + WIDEST)
  g.ghosts = g.ghosts.filter(ghost => ghost.seed === g.seed)
  for (const ghost of g.ghosts) setOff(ghost)
}

// Ghosts: other runs of the same course, played again from their moves in
// step with the player's game time.
export function setGhosts(g: Game, seed: number, runs: readonly GhostRun[]) {
  // Mid-run on another day's course, they wait for the next run.
  if ((g.mode === 'running' || g.mode === 'paused') && seed !== g.seed) return
  g.ghosts = runs.slice(0, GHOSTS).map(run => {
    const ghost = { ...run, seed, endsAt: replay(seed, run.moves, LIMIT_MS).gameAt, game: newGame(), next: 0 }
    setOff(ghost)
    // Joining a run under way, or one just ended, they catch up with it.
    if (g.mode !== 'ready' && seed === g.seed) follow(ghost, g.simAt)
    return ghost
  })
}

function setOff(ghost: Ghost) {
  ghost.game = newGame()
  ghost.game.seed = ghost.seed
  start(ghost.game, 0)
  ghost.next = 0
}

// Plays a ghost on to game time `t`; true when it moved or was caught.
function follow(ghost: Ghost, t: number): boolean {
  const run = ghost.game
  if (run.mode !== 'running') return false
  let moved = false
  for (let m = ghost.moves[ghost.next]; m !== undefined && m[0] <= t; m = ghost.moves[++ghost.next]) {
    if (runTo(run, m[0], m[0]) === 'over') return true
    moved = move(run, m[1], m[0], m[0]) || moved
  }
  return runTo(run, t, t) === 'over' || moved
}

function crash(g: Game, kind: Kind, t: number, wall: number) {
  g.crash = { kind, h: heightAt(g.air, t), wall }
  g.mode = 'over'
  g.gameAt = t
  g.simAt = t
  g.level = levelAt(t)
  g.isNewBest = g.score > g.best
  g.best = Math.max(g.best, g.score)
}

const lifetime = (pop: Pop) => (pop.kind === 'level' ? LEVEL_POP_MS : POP_MS)

// Runs the world on to game time `end`, a grid step at a time, laying course
// as it goes: tokens taken, bugs smashed or passed, or Clawd caught. However
// often it is called, the same moves meet the course the same way.
function runTo(g: Game, end: number, now: number): 'none' | 'changed' | 'over' {
  if (g.mode !== 'running') return 'none'
  let changed = false
  for (let t = g.simAt + STEP_MS; t <= end; t += STEP_MS) {
    g.simAt = t
    const d = distAt(t)
    if (g.aheadTo < d + AHEAD) {
      generate(g, d + AHEAD + WIDEST)
      changed = true
    }
    const times = multiplier(levelAt(t))
    if (g.air !== null && t >= landTime(g.air)) {
      g.air = null
      g.jumps = 0
    }
    for (const thing of g.things) {
      // Things lie in order along the course: the rest have yet to reach Clawd.
      if (thing.x - d >= RUN_R) break
      if (thing.done !== undefined) continue
      if (thing.x - d + BOX[thing.kind].r <= RUN_L) {
        thing.done = thing.kind === 'token' ? 'missed' : 'passed'
        if (thing.kind !== 'token') g.score += POINTS.pass * times
        changed ||= thing.kind !== 'token'
        continue
      }
      if (!touches(g, thing, t)) continue
      const wall = now - (end - t)
      if (thing.kind === 'token') {
        thing.done = 'taken'
        g.score += POINTS.token * times
        g.pops.push({ kind: 'token', y: heightAt(g.air, t), wall, value: POINTS.token * times })
        changed = true
      } else if (t < g.dashUntil) {
        thing.done = 'smashed'
        g.score += POINTS.smash * times
        g.pops.push({ kind: 'smash', y: 0, wall, value: POINTS.smash * times })
        changed = true
      } else {
        crash(g, thing.kind, t, wall)
        return 'over'
      }
    }
  }
  const at = Math.max(end, g.simAt)
  const d = distAt(at)
  const level = levelAt(at)
  if (level > g.level) g.pops.push({ kind: 'level', y: 0, wall: now - (at - level * LEVEL_MS), value: level })
  g.things = g.things.filter(thing => thing.x - d > -80)
  g.pops = g.pops.filter(pop => now - pop.wall < lifetime(pop))
  const charges = Math.floor(energyAt(g, at))
  if (level !== g.level || charges !== g.charges) changed = true
  g.level = level
  g.charges = charges
  return changed ? 'changed' : 'none'
}

// Runs the run on to `now`. 'none' when nothing shows it.
export function advance(g: Game, now: number): 'none' | 'changed' | 'over' {
  const counted = g.countdownUntil !== 0 && now >= g.countdownUntil
  if (counted) g.countdownUntil = 0
  const result = runTo(g, gameTime(g, now), now)
  let ghosts = false
  for (const ghost of g.ghosts) ghosts = follow(ghost, gameTime(g, now)) || ghosts
  return (counted || ghosts) && result === 'none' ? 'changed' : result
}

// When the run can next change, in wall milliseconds from `now`: the
// countdown ending, a thing reaching Clawd, Clawd touching one as things
// stand, the next level, a dash charge filling, the course needing more laid out.
export function nextWake(g: Game, now: number): number | undefined {
  if (g.mode !== 'running') return undefined
  if (now < g.countdownUntil) return Math.ceil(g.countdownUntil - now) + 1
  const t = gameTime(g, now)
  let next = Infinity
  for (const thing of g.things) {
    if (thing.done !== undefined) continue
    const box = BOX[thing.kind]
    const enter = timeAtDist(thing.x + box.l - RUN_R)
    const exit = timeAtDist(thing.x + box.r - RUN_L)
    if (enter > t) {
      next = Math.min(next, enter)
      continue
    }
    let at = exit
    for (let s = t; s < exit; s += STEP_MS) {
      if (touches(g, thing, s)) {
        at = s
        break
      }
    }
    next = Math.min(next, at)
  }
  for (const ghost of g.ghosts) {
    if (ghost.game.mode !== 'running') continue
    next = Math.min(next, ghost.moves[ghost.next]?.[0] ?? Infinity, ghost.endsAt)
  }
  next = Math.min(next, (levelAt(t) + 1) * LEVEL_MS)
  const e = energyAt(g, t)
  if (e < CHARGES) next = Math.min(next, t + (Math.floor(e) + 1 - e) / REGEN)
  next = Math.min(next, timeAtDist(g.aheadTo - AHEAD))
  return Math.max(4, Math.ceil(next - t) + 1)
}

export function pause(g: Game, now: number, why: PauseReason): boolean {
  if (g.mode === 'paused' && (why === 'finished' || why === 'needsYou')) {
    g.why = why
    return true
  }
  if (g.mode !== 'running') return false
  if (advance(g, now) === 'over') return true
  g.gameAt = gameTime(g, now)
  g.clockAt = now
  g.countdownUntil = 0
  g.mode = 'paused'
  g.why = why
  return true
}

// What a button does now: ✕ starts, resumes or jumps; the rest act mid-run.
// A move that takes goes in the log with its game time.
export function act(g: Game, action: Action, now: number): boolean {
  if (g.mode === 'ready' || g.mode === 'over') {
    if (action !== 'jump') return false
    start(g, now)
    return true
  }
  if (g.mode === 'paused') {
    if (action !== 'jump' && action !== 'pause') return false
    // A count of 3, 2, 1 with the world still, not a spell of safety a pause
    // could buy before every bug.
    g.mode = 'running'
    g.clockAt = now + COUNTDOWN_MS
    g.countdownUntil = g.clockAt
    return true
  }
  if (action === 'pause') return pause(g, now, 'you')
  if (now < g.countdownUntil) return false
  const t = Math.round(gameTime(g, now))
  if (runTo(g, t, now) === 'over') return true
  if (!move(g, action, t, now)) return false
  g.log.push([t, action])
  return true
}

function move(g: Game, action: Move[1], t: number, now: number): boolean {
  if (g.air !== null && t >= landTime(g.air)) {
    g.air = null
    g.jumps = 0
  }
  if (action === 'jump') {
    if (g.air === null) {
      g.slideUntil = Math.min(g.slideUntil, t)
      g.air = { at: t, h: 0, v: JUMP_V }
      g.jumps = 1
      return true
    }
    if (g.jumps >= 2) return false
    const h = heightAt(g.air, t)
    g.air = { at: t, h, v: Math.min(DOUBLE_V, Math.sqrt(2 * GRAVITY * Math.max(0, CEILING - h))) }
    g.jumps = 2
    g.pops.push({ kind: 'double', y: h, wall: now, value: 0 })
    return true
  }
  if (action === 'slide') {
    if (g.air === null) g.slideUntil = t + SLIDE_MS
    else {
      g.air = { at: t, h: heightAt(g.air, t), v: Math.min(DIVE_V, velocityAt(g.air, t)) }
      g.slideUntil = landTime(g.air) + SLIDE_MS * 0.8
    }
    return true
  }
  const e = energyAt(g, t)
  if (e < 1 || t < g.dashUntil) return false
  g.energy = e - 1
  g.energyAt = t
  g.dashUntil = t + DASH_MS
  g.charges = Math.floor(g.energy)
  return true
}

// A run played again from its seed and moves, as the server checks one: on
// to the crash, or to `limit` ms of game time. Moves out of order end it.
export function replay(seed: number, log: readonly Move[], limit: number): Game {
  const g = newGame()
  g.seed = seed
  start(g, 0)
  for (const [t, action] of log) {
    if (!(t >= g.simAt && t <= limit) || runTo(g, t, t) === 'over') break
    move(g, action, t, t)
  }
  runTo(g, limit, limit)
  return g
}

const STATUS_TEXT: Readonly<Record<ClaudeStatus, string>> = {
  idle: '',
  working: 'Claude is working',
  finished: 'Claude finished',
  needsYou: 'Claude needs you',
}

const PAUSE_TEXT: Readonly<Record<PauseReason, string>> = {
  you: '✕ or Options to dash on',
  hidden: '✕ or Options to dash on',
  pad: 'The pad is driving Claude · L1 + touchpad to play',
  finished: 'Claude finished ✓ · have a look, then ✕ to dash on',
  needsYou: 'Claude needs you · answer it, then ✕ to dash on',
}

// Where today's race stands, for the ready card.
function standing(race: Race) {
  const leader = race.top[0]
  if (leader === undefined) return "Today's course: nobody has run it yet"
  return `Today: ${leader.name} leads with ${leader.score}` + (race.you ? ` · you're #${race.you.rank} of ${race.total}` : '')
}

// Where the last run sent went, for the over card.
function sentText(race: Race | undefined) {
  const sent = race?.sent
  if (sent === undefined) return undefined
  if (sent === 'sending') return 'Sending your run'
  if (sent === 'failed') return "Couldn't reach the race"
  return `#${sent.rank} of ${sent.total} today · best ${sent.best}`
}

export function sceneAlt(g: Game, view: View): string {
  const status = STATUS_TEXT[view.claude]
  const race = view.race
  switch (g.mode) {
    case 'ready':
      return `Bug Dash, ready: ✕ or Play to run. Best ${g.best}.${race ? ` ${standing(race)}.` : ''}`
    case 'running':
      return `Bug Dash, running: ${g.score} points, level ${g.level + 1}, best ${g.best}.${status ? ` ${status}.` : ''}`
    case 'paused':
      return `Bug Dash, paused: ${PAUSE_TEXT[g.why]}. ${g.score} points, level ${g.level + 1}, best ${g.best}.`
    case 'over':
      return `Bug Dash, over: ${g.crash?.kind === 'fail' ? 'tests failed' : 'squashed by a bug'} at ${g.score} points on level ${g.level + 1}${g.isNewBest ? ', a new best' : `, best ${g.best}`}.${sentText(race) ? ` ${sentText(race)}.` : ''}`
  }
}

// ----------------------------------------------------------------- drawing

const n = (v: number) => String(Math.round(v * 10) / 10)
const FONT = 'font-family="ui-monospace, SFMono-Regular, Menlo, monospace"'
const CLAY = '#D97757'

function seeded(seed: number) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), s | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Pixel art, one path per colour: `.` is empty; `l` light, `#` clay, `d`
// shade, `e` an eye.
const PIXEL_FILL: Readonly<Record<string, string>> = { l: '#EE9B7C', '#': CLAY, d: '#B5593C', e: '#1E1412' }
function pixels(rows: readonly string[], fill?: string): string {
  const paths = new Map<string, string>()
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const c = row[x] ?? '.'
      if (c === '.') {
        x++
        continue
      }
      let end = x
      while (row[end] === c) end++
      const key = fill === undefined ? c : '#'
      paths.set(key, `${paths.get(key) ?? ''}M${x * PW} ${y * PH}h${(end - x) * PW}v${PH}h${-(end - x) * PW}z`)
      x = end
    }
  })
  return [...paths].map(([c, d]) => `<path${c === 'e' ? ' class="eye"' : ''} fill="${fill ?? PIXEL_FILL[c] ?? CLAY}" d="${d}"/>`).join('')
}

// Clawd, Claude Code's own: ▐▛███▜▌ over ▝▜█████▛▘ over ▘▘ ▝▝, a quadrant a pixel.
const CLAWD_TOP = ['...lll#########...', '...##e######e##...']
const RUN_A = [...CLAWD_TOP, '.################.', '...dddddddddddd...', '....d.d....d.d....']
const RUN_B = [...CLAWD_TOP, '.################.', '...dddddddddddd...', '...d.d......d.d...']
const AIR = ['...lll#########...', '.#.##e######e##.#.', '..##############..', '...dddddddddddd...', '.....d......d.....']
const SLIDE = ['....llll######....', '.###e########e###.', '..dddddddddddddd..']
const DEAD = [...RUN_A].reverse().map(row => row.replaceAll('e', '#'))

const BUG = `<g id="bug">
<ellipse cx="13" cy="15.3" rx="10" ry="1.5" class="shade"/>
<path d="M5 10.5Q13-1 23 9.5Q23 13 19 13H8Q5 13 5 10.5Z" fill="url(#bugBody)"/>
<path d="M7 10.8Q13 2 21.6 9.6" fill="none" stroke="#7d1d27" stroke-width=".9" opacity=".7"/>
<circle cx="12" cy="7" r="1.5" fill="#6e1620"/><circle cx="17" cy="6.6" r="1.2" fill="#6e1620"/><circle cx="19.6" cy="9.8" r="1.1" fill="#6e1620"/>
<ellipse cx="11.5" cy="4.6" rx="3.6" ry="1.1" fill="#fff" opacity=".4" transform="rotate(-20 11.5 4.6)"/>
<circle cx="5.2" cy="10" r="3.9" fill="#2a1a1f"/>
<circle cx="3.9" cy="9.1" r="1.6" fill="#fff"/><circle cx="3.3" cy="9.2" r=".85" fill="#111"/>
<path d="M3.6 6.6q-1.6-3.2-3.6-3.4M5.6 6.3q.4-3.6-1.4-4.8" fill="none" stroke="#2a1a1f" stroke-width="1" stroke-linecap="round"/>
</g>
<g id="legsA" fill="none" stroke="#2a1a1f" stroke-width="1.3" stroke-linecap="round"><path d="M9 12.6l-2 2.4M14 12.8v2.2M19 12.6l2 2.4"/></g>
<g id="legsB" fill="none" stroke="#2a1a1f" stroke-width="1.3" stroke-linecap="round"><path d="M9 12.6l1 2.4M14 12.8l-1.6 2.2M19 12.6l-.4 2.4"/></g>`

const BANNER_TOP = GROUND - FAIL_LOW - 18
const FAIL = `<g id="fail">
<path class="rope" d="M8 0V${BANNER_TOP}M36 0V${BANNER_TOP}" stroke-width="1" stroke-dasharray="2 1.5"/>
<rect y="${BANNER_TOP}" width="44" height="18" rx="3" fill="url(#failFill)"/>
<rect x=".5" y="${BANNER_TOP + 0.5}" width="43" height="17" rx="2.5" fill="none" stroke="#ff9a9a" stroke-opacity=".55"/>
<text x="22" y="${BANNER_TOP + 12.4}" text-anchor="middle" font-size="9.5" font-weight="800" letter-spacing="1" fill="#fff" ${FONT}>✗ FAIL</text>
</g>`

const SPARK_POINTS = Array.from({ length: 16 }, (_, i) => {
  const a = (i * Math.PI) / 8 - Math.PI / 2
  const r = i % 2 === 1 ? 2.3 : i % 4 === 0 ? 6.4 : 4.6
  return `${n(Math.cos(a) * r)},${n(Math.sin(a) * r)}`
}).join(' ')
const SPARK = `<g id="spark"><polygon points="${SPARK_POINTS}" fill="url(#sparkFill)"/><circle r="1.3" fill="#fff6ee"/></g>`

// A row of buildings, windows lit here and there; it repeats every `tile`.
function skyline(id: string, seed: number, tile: number, low: number, high: number) {
  const r = seeded(seed)
  let body = ''
  let lit = ''
  for (let x = 2; x < tile - 16; ) {
    const w = Math.min(14 + Math.floor(r() * 26), tile - 2 - x)
    const top = GROUND - low - Math.floor(r() * (high - low))
    body += `M${x} ${GROUND}V${top + 2}q0-2 2-2h${w - 4}q2 0 2 2V${GROUND}z`
    if (r() < 0.3) body += `M${x + Math.floor(w / 2)} ${top}v-6h1v6z`
    for (let y = top + 5; y < GROUND - 4; y += 5) {
      for (let wx = x + 3; wx < x + w - 4; wx += 5) if (r() < 0.28) lit += `M${wx} ${y}h2v2h-2z`
    }
    x += w + 2 + Math.floor(r() * 8)
  }
  return `<g id="${id}"><path class="${id}" d="${body}"/><path class="lit" d="${lit}"/></g>`
}

// Lines of code drifting past, coloured like a theme's tokens.
const CODE = (() => {
  const r = seeded(11)
  const colors = ['#c792ea', '#82aaff', '#c3e88d', '#f78c6c', '#89ddff', '#ffcb6b']
  let bars = ''
  for (let line = 0; line < 10; line++) {
    let x = Math.floor(r() * 640)
    const y = 22 + Math.floor(r() * 5) * 9
    for (let k = 2 + Math.floor(r() * 4); k > 0 && x < 690; k--) {
      const w = Math.min(6 + Math.floor(r() * 30), 698 - x)
      bars += `<rect x="${x}" y="${y}" width="${w}" height="2.5" rx="1.25" fill="${colors[Math.floor(r() * colors.length)] ?? CLAY}"/>`
      x += w + 4
    }
  }
  return `<g id="code" class="code">${bars}</g>`
})()

const TILES = `<g id="tiles" class="tile"><rect x="4" y="${GROUND + 5}" width="14" height="1.5" rx=".75"/><rect x="30" y="${GROUND + 10}" width="6" height="1.5" rx=".75"/><rect x="19" y="${GROUND + 14}" width="3" height="1.5" rx=".75"/></g>`

const STARS = (() => {
  const r = seeded(5)
  return Array.from({ length: 46 }, () => ({ x: Math.round(r() * 1400), y: 4 + Math.round(r() * 44), r: r() < 0.2 ? 1 : 0.6, o: 0.25 + r() * 0.6, delay: r() * 3, twinkles: r() < 0.4 }))
})()

const BURSTS = Array.from({ length: 6 }, (_, i) => {
  const a = (i * Math.PI) / 3 + 0.3
  return `@keyframes b${i}{from{transform:translate(0,0);opacity:1}to{transform:translate(${n(Math.cos(a) * 15)}px,${n(Math.sin(a) * 12)}px);opacity:0}}`
}).join('')

const DEFS = `
<linearGradient id="skyD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#131019"/><stop offset=".6" stop-color="#1f1821"/><stop offset="1" stop-color="#3b2521"/></linearGradient>
<linearGradient id="skyL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf7f1"/><stop offset=".6" stop-color="#f6e9dc"/><stop offset="1" stop-color="#f2d6c2"/></linearGradient>
<linearGradient id="gndD" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#231c1f"/><stop offset="1" stop-color="#151215"/></linearGradient>
<linearGradient id="gndL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ead9c8"/><stop offset="1" stop-color="#e2cdb9"/></linearGradient>
<linearGradient id="haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${CLAY}" stop-opacity="0"/><stop offset="1" stop-color="${CLAY}" stop-opacity=".12"/></linearGradient>
<linearGradient id="edgeGlow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${CLAY}" stop-opacity="0"/><stop offset="1" stop-color="${CLAY}" stop-opacity=".35"/></linearGradient>
<radialGradient id="halo"><stop offset="0" stop-color="${CLAY}" stop-opacity=".32"/><stop offset="1" stop-color="${CLAY}" stop-opacity="0"/></radialGradient>
<linearGradient id="sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f7b58f"/><stop offset="1" stop-color="${CLAY}"/></linearGradient>
<linearGradient id="bugBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7d7d"/><stop offset=".55" stop-color="#e5484d"/><stop offset="1" stop-color="#a8202c"/></linearGradient>
<linearGradient id="failFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ef5b60"/><stop offset="1" stop-color="#b4232c"/></linearGradient>
<radialGradient id="sparkFill"><stop offset="0" stop-color="#ffe6d2"/><stop offset=".45" stop-color="#f3a882"/><stop offset="1" stop-color="${CLAY}"/></radialGradient>
<radialGradient id="tokGlow"><stop offset="0" stop-color="${CLAY}" stop-opacity=".5"/><stop offset="1" stop-color="${CLAY}" stop-opacity="0"/></radialGradient>
<radialGradient id="dashGlow"><stop offset="0" stop-color="#ffb08a" stop-opacity=".55"/><stop offset="1" stop-color="${CLAY}" stop-opacity="0"/></radialGradient>
<linearGradient id="title" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f8c2a3"/><stop offset="1" stop-color="${CLAY}"/></linearGradient>
${skyline('farB', 3, 560, 18, 40)}${skyline('farA', 9, 520, 10, 28)}${CODE}${TILES}${BUG}${FAIL}${SPARK}
<g id="cRunA">${pixels(RUN_A)}</g><g id="cRunB">${pixels(RUN_B)}</g><g id="cAir">${pixels(AIR)}</g>
<g id="cSlide">${pixels(SLIDE)}</g><g id="cGhost">${pixels(RUN_A, CLAY)}</g>
<g id="cDead">${pixels(DEAD)}<path d="M15 15.5l3 4M18 15.5l-3 4M36 15.5l3 4M39 15.5l-3 4" stroke="#1E1412" stroke-width="1.2"/></g>`

const CSS = `
.sky{fill:url(#skyD)}.gnd{fill:url(#gndD)}.farB{fill:#211b26}.farA{fill:#2c2430}.lit{fill:#f4b183;opacity:.45}
.code{opacity:.2}.tile{fill:#3a2f33}.edge{fill:${CLAY}}.star{fill:#fff}.shade{fill:#000;opacity:.35}.rope{stroke:#8b7d75}
.txt{fill:#f3ede7}.dim{fill:#a39a93}.chip{fill:#000;fill-opacity:.3}.card{fill:#17141a;fill-opacity:.9;stroke:#40363a}
.veil{fill:#0c0a0e;opacity:.42}.frame{fill:none;stroke:#fff;stroke-opacity:.08}.pip{fill:${CLAY}}.pip0{fill:none;stroke:${CLAY};stroke-opacity:.6}
.lv{fill:${CLAY}}.mul{fill:#f2bd63}.ghost{opacity:.4;filter:grayscale(1) brightness(1.8)}.up{fill:#ffe2b6;stroke:#140f14;stroke-opacity:.55}
@media (prefers-color-scheme: light){
.sky{fill:url(#skyL)}.gnd{fill:url(#gndL)}.farB{fill:#eadfd2}.farA{fill:#e0d0c0}.lit{fill:#c58f6c;opacity:.35}
.code{opacity:.32}.tile{fill:#d3bfab}.star{display:none}.shade{opacity:.13}.rope{stroke:#a8968a}
.txt{fill:#2b2420}.dim{fill:#7d736b}.chip{fill:#fff;fill-opacity:.6}.card{fill:#fffaf4;fill-opacity:.95;stroke:#e3d5c6}
.veil{fill:#fffaf4;opacity:.45}.frame{stroke:#000;stroke-opacity:.08}.mul{fill:#a8701c}.ghost{opacity:.3;filter:grayscale(1) brightness(.55)}.up{fill:#b5593c;stroke:#fffaf4;stroke-opacity:.85}}
.lb{opacity:0}.spin{transform-box:fill-box;transform-origin:center}.swing{transform-box:fill-box;transform-origin:50% 0}
.ring{transform-box:fill-box;transform-origin:center}
@keyframes on{to{opacity:1}}@keyframes off{to{opacity:0}}
@keyframes legA{0%,49.9%{opacity:1}50%,100%{opacity:0}}@keyframes legB{0%,49.9%{opacity:0}50%,100%{opacity:1}}
@keyframes blink{0%,95%,100%{fill:#1E1412}96.5%{fill:${CLAY}}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes bob{from{transform:translateY(-1.5px)}to{transform:translateY(1.5px)}}
@keyframes swing{from{transform:rotate(-2.5deg)}to{transform:rotate(2.5deg)}}
@keyframes tw{from{opacity:.12}to{opacity:.9}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes rise{from{transform:translateY(0);opacity:1}to{transform:translateY(-14px);opacity:0}}
@keyframes ring{from{transform:scale(.3);opacity:.9}to{transform:scale(1.7);opacity:0}}
@keyframes flash{from{opacity:.5}to{opacity:0}}
@keyframes shake{0%,100%{transform:translate(0,0)}20%{transform:translate(-3px,1px)}40%{transform:translate(3px,-1px)}60%{transform:translate(-2px,0)}80%{transform:translate(2px,1px)}}
@keyframes dust{from{transform:translateX(0);opacity:.7}to{transform:translateX(-12px);opacity:0}}
@keyframes zip{from{transform:translateX(0)}to{transform:translateX(-140px)}}
@keyframes count{from{transform:scale(1.6);opacity:0}25%{opacity:1}to{transform:scale(1)}}
@keyframes lvl{0%{opacity:0;transform:translateY(5px)}14%,78%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-6px)}}
@keyframes glow{from{fill:#ffe2b6}}
@keyframes intro{from{transform:translateY(6px);opacity:0}to{transform:translateY(0);opacity:1}}
${BURSTS}`

// Only a run in motion animates: a paused or finished drawing costs nothing to show.
const LIVE_CSS = `
.la{animation:legA .2s infinite}.lb{animation:legB .2s infinite}.eye{animation:blink 3.8s infinite}
.spin{animation:spin 3s linear infinite}.bob{animation:bob .9s ease-in-out infinite alternate}
.swing{animation:swing 1.4s ease-in-out infinite alternate}.tw{animation:tw 2.2s ease-in-out infinite alternate}
.pulse{animation:pulse 1.2s ease-in-out infinite}`

// A layer repeating every `tile`, scrolled at `factor` of the world's speed.
function layer(id: string, tile: number, factor: number, width: number, d: number, speed: number, live: boolean, css: string[]) {
  const offset = (d * factor) % tile
  const uses = Array.from({ length: Math.ceil(width / tile) + 1 }, (_, i) => `<use href="#${id}" x="${i * tile}"/>`).join('')
  if (!live) return `<g transform="translate(${n(-offset)} 0)">${uses}</g>`
  const period = tile / (speed * factor)
  css.push(`@keyframes loop-${id}{from{transform:translateX(0)}to{transform:translateX(-${tile}px)}}`)
  return `<g style="animation:loop-${id} ${n(period)}ms linear ${n((-offset / tile) * period)}ms infinite">${uses}</g>`
}

// Shown from `from` ms on and hidden from `to` ms on, from this drawing's moment.
function during(from: number, to: number) {
  const runs = [from > 0 ? `on 1ms linear ${n(from)}ms forwards` : '', Number.isFinite(to) ? `off 1ms linear ${n(to)}ms forwards` : ''].filter(Boolean)
  return `style="opacity:${from > 0 ? 0 : 1}${runs.length > 0 ? `;animation:${runs.join(',')}` : ''}"`
}

function backdrop(width: number, d: number, speed: number, live: boolean, css: string[]) {
  const stars = STARS.filter(s => s.x < width)
    .map(s => `<circle class="star${s.twinkles ? ' tw' : ''}" cx="${s.x}" cy="${s.y}" r="${s.r}" style="opacity:${n(s.o)};animation-delay:-${n(s.delay)}s"/>`)
    .join('')
  const sx = Math.round(width * 0.8)
  return (
    `<rect class="sky" width="${width}" height="${HEIGHT}"/>${stars}` +
    `<circle cx="${sx}" cy="${GROUND - 12}" r="74" fill="url(#halo)"/>` +
    `<g mask="url(#bands)"><circle cx="${sx}" cy="${GROUND - 12}" r="25" fill="url(#sun)"/></g>` +
    layer('farB', 560, 0.05, width, d, speed, live, css) +
    layer('farA', 520, 0.12, width, d, speed, live, css) +
    layer('code', 700, 0.35, width, d, speed, live, css) +
    `<rect y="${GROUND - 20}" width="${width}" height="20" fill="url(#haze)"/>` +
    `<rect class="gnd" y="${GROUND}" width="${width}" height="${HEIGHT - GROUND}"/>` +
    `<rect y="${GROUND - 6}" width="${width}" height="6" fill="url(#edgeGlow)"/>` +
    `<rect class="edge" y="${GROUND - 0.5}" width="${width}" height="1.5"/>` +
    layer('tiles', 48, 1, width, d, speed, live, css)
  )
}

function world(g: Game, width: number, d: number, speed: number, live: boolean, css: string[]) {
  const drawn = g.things
    .filter(thing => thing.done !== 'taken' && thing.done !== 'smashed' && thing.x - d > -60)
    .map(thing => {
      const x = n(thing.x - d)
      const lag = `animation-delay:-${n((thing.id % 7) * 0.13)}s`
      if (thing.kind === 'bug') {
        return `<g transform="translate(${x} ${GROUND - 15})"><use href="#bug"/><use class="la" href="#legsA" style="${lag}"/><use class="lb" href="#legsB" style="${lag}"/></g>`
      }
      if (thing.kind === 'fail') {
        return `<g transform="translate(${x} 0)"><rect x="2" y="${GROUND}" width="40" height="1.5" fill="#F0565B" opacity=".55"/><g class="swing" style="${lag}"><use href="#fail"/></g></g>`
      }
      return `<g transform="translate(${n(thing.x - d + 7)} ${GROUND - thing.h - 6})"><g class="bob" style="${lag}"><circle r="9" fill="url(#tokGlow)"/><g class="spin"><use href="#spark"/></g></g></g>`
    })
    .join('') + fallenGhosts(g, d)
  if (!live) return `<g>${drawn}</g>`
  css.push(`@keyframes world{to{transform:translateX(${n(-speed * WORLD_MS)}px)}}`)
  return `<g style="animation:world ${WORLD_MS}ms linear forwards">${drawn}</g>`
}

function runner(g: Game, t: number, now: number, live: boolean, css: string[]) {
  const top = GROUND - CLAWD_H
  if (g.mode === 'over' && g.crash !== null) {
    const age = now - g.crash.wall
    if (g.crash.h > 0) css.push(`@keyframes fall{from{transform:translateY(${n(-g.crash.h)}px)}to{transform:translateY(0)}}`)
    const fall = g.crash.h > 0 ? ` style="animation:fall 260ms ease-in -${n(age)}ms both"` : ''
    return (
      `<ellipse cx="${RX + 27}" cy="${GROUND + 1}" rx="17" ry="2.2" class="shade"/>` +
      `<g transform="translate(${RX} ${top})" shape-rendering="crispEdges"><g${fall}><use href="#cDead"/></g></g>` +
      `<g transform="translate(${RX + 40} ${top - 2})"><circle class="ring" r="7" fill="none" stroke="#ffd2b8" stroke-width="2" style="animation:ring 420ms ease-out -${n(age)}ms both"/></g>`
    )
  }

  const h = heightAt(g.air, t)
  const land = g.air === null ? t : landTime(g.air)
  const airEnd = land - t
  const slideEnd = g.slideUntil - t
  let hop = h > 0 ? ` transform="translate(0 ${n(-h)})"` : ''
  let shadow = `<ellipse cx="${RX + 27}" cy="${GROUND + 1}" rx="17" ry="2.2" class="shade"/>`
  if (live && g.air !== null && airEnd > 8) {
    const air = g.air
    const steps = 20
    const frames = Array.from({ length: steps + 1 }, (_, i) => [(i / steps) * 100, heightAt(air, t + (airEnd * i) / steps)] as const)
    css.push(`@keyframes hop{${frames.map(([p, y]) => `${n(p)}%{transform:translateY(${n(-y)}px)}`).join('')}}`)
    css.push(`@keyframes shadow{${frames.map(([p, y]) => `${n(p)}%{transform:scale(${n(Math.max(0.35, 1 - y / 70))})}`).join('')}}`)
    hop = ` style="animation:hop ${n(airEnd)}ms linear forwards"`
    shadow = `<g transform="translate(${RX + 27} ${GROUND + 1})"><ellipse class="shade ring" rx="17" ry="2.2" style="animation:shadow ${n(airEnd)}ms linear forwards"/></g>`
  }

  // The poses Clawd goes through if nothing is pressed: up, sliding, running.
  const poses: string[] = []
  const running = (from: number) => `<g ${during(from, Infinity)}><use class="la" href="#cRunA"/><use class="lb" href="#cRunB"/></g>`
  if (!live) {
    const pose = g.air !== null && h > 0 ? '#cAir' : isSliding(g, t) ? '#cSlide' : '#cRunA'
    poses.push(pose === '#cSlide' ? `<use href="${pose}" y="10"/>` : `<use href="${pose}"/>`)
  } else {
    const upTo = g.air === null ? 0 : airEnd
    if (g.air !== null) poses.push(`<g ${during(0, airEnd)}><use href="#cAir"/></g>`)
    if (slideEnd > upTo) {
      poses.push(
        `<g ${during(upTo, slideEnd)}><use href="#cSlide" y="10"/>` +
          [0, 1, 2].map(i => `<circle cx="${2 - i * 3}" cy="23.5" r="${1.6 - i * 0.3}" class="dim" style="animation:dust 300ms linear -${i * 100}ms infinite"/>`).join('') +
          `</g>`,
      )
    }
    poses.push(running(Math.max(upTo, slideEnd, 0)))
  }

  // A dash: afterimages trailing Clawd, a glow, the air rushing past.
  let dash = ''
  let lines = ''
  if (live && t < g.dashUntil) {
    const left = g.dashUntil - t
    dash =
      `<g ${during(0, left)}><ellipse cx="27" cy="13" rx="36" ry="17" fill="url(#dashGlow)"/>` +
      `<ellipse class="ring" cx="27" cy="13" rx="20" ry="15" fill="none" stroke="#ffd2b8" stroke-width="1.5" style="animation:ring 380ms ease-out -${n(DASH_MS - left)}ms both"/>` +
      [1, 2, 3].map(i => `<use href="#cGhost" x="${-i * 10}" opacity="${n(0.5 - i * 0.13)}"/>`).join('') +
      `</g>`
    const r = seeded(Math.floor(g.dashUntil))
    lines =
      `<g ${during(0, left)}>` +
      Array.from({ length: 6 }, (_, i) => `<rect x="${RX + 60 + Math.round(r() * 200)}" y="${20 + Math.round(r() * 52)}" width="${20 + Math.round(r() * 30)}" height="1" fill="#ffd2b8" opacity=".55" style="animation:zip 220ms linear -${i * 37}ms infinite"/>`).join('') +
      `</g>`
  }

  return `${shadow}${lines}<g transform="translate(${RX} ${top})" shape-rendering="crispEdges"><g${hop}>${dash}${poses.join('')}</g></g>`
}

const esc = (text: string) => text.replace(/[&<>"]/g, c => `&#${c.charCodeAt(0)};`)
const ghostX = (i: number) => RX - 9 * (i + 1)

// Ghosts run a step behind Clawd, faint, going through the poses their moves
// make, with their names and scores on the ground beneath.
function ghostRunners(g: Game, t: number, live: boolean, css: string[]) {
  return g.ghosts
    .map((ghost, i) => {
      const run = ghost.game
      const tag = `<text class="dim" x="${ghostX(i) + 27}" y="${GROUND + 9 + i * 7}" text-anchor="middle" font-size="6.5" ${FONT}>${esc(ghost.name)} ${run.mode === 'over' ? '✕ ' : ''}${run.score}</text>`
      if (run.mode !== 'running') return tag
      const h = heightAt(run.air, t)
      const airEnd = run.air === null ? 0 : landTime(run.air) - t
      const slideEnd = run.slideUntil - t
      let hop = h > 0 ? ` transform="translate(0 ${n(-h)})"` : ''
      let poses: string
      if (!live) {
        poses = h > 0 ? '<use href="#cAir"/>' : isSliding(run, t) ? '<use href="#cSlide" y="10"/>' : '<use href="#cRunA"/>'
      } else {
        if (run.air !== null && airEnd > 8) {
          const air = run.air
          const frames = Array.from({ length: 13 }, (_, k) => [(k / 12) * 100, heightAt(air, t + (airEnd * k) / 12)] as const)
          css.push(`@keyframes ghop${i}{${frames.map(([at, y]) => `${n(at)}%{transform:translateY(${n(-y)}px)}`).join('')}}`)
          hop = ` style="animation:ghop${i} ${n(airEnd)}ms linear forwards"`
        }
        const upTo = Math.max(0, airEnd)
        poses =
          (run.air !== null ? `<g ${during(0, airEnd)}><use href="#cAir"/></g>` : '') +
          (slideEnd > upTo ? `<g ${during(upTo, slideEnd)}><use href="#cSlide" y="10"/></g>` : '') +
          `<g ${during(Math.max(upTo, slideEnd, 0), Infinity)}><use class="la" href="#cRunA"/><use class="lb" href="#cRunB"/></g>`
      }
      return `<g class="ghost" transform="translate(${ghostX(i)} ${GROUND - CLAWD_H})" shape-rendering="crispEdges"><g${hop}>${poses}</g></g>${tag}`
    })
    .join('')
}

// Caught ghosts lie where they fell, and the world carries them off.
function fallenGhosts(g: Game, d: number) {
  return g.ghosts
    .map((ghost, i) => {
      if (ghost.game.mode !== 'over') return ''
      const x = ghostX(i) + distAt(ghost.game.gameAt) - d
      return x < -60 ? '' : `<g class="ghost" transform="translate(${n(x)} ${GROUND - CLAWD_H})" shape-rendering="crispEdges"><use href="#cDead"/></g>`
    })
    .join('')
}

// A new level, called out mid-band.
function levelUp(level: number, width: number, age: string) {
  const faster = level <= LAST_LEVEL ? 'FASTER' : ''
  const times = multiplier(level) > multiplier(level - 1) ? `×${multiplier(level)} POINTS` : ''
  const sub = [faster, times].filter(Boolean).join(' · ')
  return (
    `<g ${FONT} text-anchor="middle" stroke-width="3" paint-order="stroke" style="opacity:0;animation:lvl ${LEVEL_POP_MS}ms ease-out ${age} both">` +
    `<text class="up" x="${n(width / 2)}" y="46" font-size="14" font-weight="800" letter-spacing="3">LEVEL ${level + 1}</text>` +
    (sub ? `<text class="up" x="${n(width / 2)}" y="58" font-size="8.5" font-weight="700" letter-spacing="1.5">${sub}</text>` : '') +
    `</g>`
  )
}

function pops(g: Game, now: number, width: number) {
  return g.pops
    .filter(pop => now - pop.wall < lifetime(pop))
    .map(pop => {
      const age = `-${n(now - pop.wall)}ms`
      if (pop.kind === 'level') return levelUp(pop.value, width, age)
      const x = RX + 27
      const y = GROUND - pop.y - CLAWD_H - 4
      if (pop.kind === 'double') {
        return `<g transform="translate(${x} ${n(GROUND - pop.y + 1)})"><ellipse class="ring" rx="12" ry="3" fill="none" stroke="#ffd2b8" stroke-width="1.5" style="animation:ring 380ms ease-out ${age} both"/></g>`
      }
      const color = pop.kind === 'token' ? '#ffd2b8' : '#ff8a8a'
      const label = `+${pop.value}`
      return (
        `<g transform="translate(${x + (pop.kind === 'smash' ? 14 : 0)} ${n(y)})">` +
        Array.from({ length: 6 }, (_, i) => `<circle r="1.4" fill="${color}" style="animation:b${i} 460ms ease-out ${age} both"/>`).join('') +
        `<text y="-8" text-anchor="middle" font-size="9" font-weight="700" fill="${color}" ${FONT} style="animation:rise ${POP_MS}ms ease-out ${age} both">${label}</text></g>`
      )
    })
    .join('')
}

function hud(g: Game, view: View, width: number, t: number, now: number, live: boolean) {
  if (g.mode === 'ready') return ''
  const score = String(g.score)
  const chip = Math.max(86, 30 + score.length * 8)
  const charges = Math.floor(energyAt(g, t))
  const pips = Array.from({ length: CHARGES }, (_, i) => `<rect class="${i < charges ? 'pip' : 'pip0'}" x="${26 + i * 11}" y="35" width="8" height="3.5" rx="1.75"/>`).join('')
  const up = g.pops.find(pop => pop.kind === 'level' && now - pop.wall < LEVEL_POP_MS)
  const glow = up === undefined ? '' : ` style="animation:glow ${LEVEL_POP_MS}ms ease-out -${n(now - up.wall)}ms both"`
  const level =
    `<text x="26" y="49" font-size="8" font-weight="700" letter-spacing=".6"><tspan class="lv"${glow}>LV ${g.level + 1}</tspan>` +
    `<tspan class="mul" dx="6">×${multiplier(g.level)}</tspan></text>`
  let status = ''
  if (live && view.claude !== 'idle') {
    const text = STATUS_TEXT[view.claude]
    const w = 26 + text.length * 5.6
    const dot = view.claude === 'finished' ? '#5fb878' : view.claude === 'needsYou' ? '#f5a524' : CLAY
    status =
      `<g transform="translate(${n(width / 2 - w / 2)} 7)"><rect class="chip" width="${n(w)}" height="17" rx="8.5"/>` +
      `<circle cx="10" cy="8.5" r="3" fill="${dot}"${view.claude === 'finished' ? '' : ' class="pulse"'}/>` +
      `<text x="18" y="11.6" font-size="9.5" class="txt" ${FONT}>${text}</text></g>`
  }
  return (
    `<g ${FONT}><rect class="chip" x="7" y="6" width="${chip}" height="48" rx="9"/>` +
    `<g transform="translate(17 14.5) scale(.75)"><use href="#spark"/></g>` +
    `<text x="26" y="19" font-size="13" font-weight="700" class="txt">${score}</text>` +
    `<text x="26" y="30" font-size="8" letter-spacing=".6" class="dim">BEST ${g.best}</text>${pips}${level}</g>${status}`
  )
}

function card(g: Game, view: View, width: number, now: number) {
  if (g.mode === 'running') return ''
  const w = Math.min(440, width - 24)
  const x = n(width / 2 - w / 2)
  const cx = n(width / 2)
  let title: string
  let line: string
  let foot: string
  if (g.mode === 'ready') {
    title = 'BUG DASH'
    line = '✕ jump · ○ slide · □ dash · Options pause'
    foot = view.race ? standing(view.race) : `Best ${g.best} · no pad? Play, then w s d p · /bugdash join <name> to race`
  } else if (g.mode === 'paused') {
    title = 'PAUSED'
    line = PAUSE_TEXT[g.why]
    foot = `${g.score} pts · level ${g.level + 1} · best ${g.best}`
  } else {
    title = g.crash?.kind === 'fail' ? 'TESTS FAILED' : 'SQUASHED BY A BUG'
    line = g.isNewBest ? `New best · ${g.score} pts` : `${g.score} pts · best ${g.best}`
    foot = `${sentText(view.race) ?? `Reached level ${g.level + 1}`} · ✕ to run again`
  }
  const age = g.crash === null ? 0 : now - g.crash.wall
  const flash = g.mode === 'over' ? `<rect width="${width}" height="${HEIGHT}" fill="#F0565B" style="opacity:0;animation:flash 450ms ease-out -${n(age)}ms"/>` : ''
  const intro = g.mode === 'over' ? ` style="animation:intro 300ms ease-out ${n(250 - age)}ms both"` : ''
  return (
    `${flash}<rect class="veil" width="${width}" height="${HEIGHT}"/>` +
    `<g${intro}><rect class="card" x="${x}" y="11" width="${w}" height="62" rx="11"/>` +
    `<text x="${cx}" y="33" text-anchor="middle" font-size="15" font-weight="800" letter-spacing="3" fill="url(#title)" ${FONT}>${title}</text>` +
    `<text x="${cx}" y="50" text-anchor="middle" font-size="9.5" class="txt" ${FONT}>${line}</text>` +
    `<text x="${cx}" y="64" text-anchor="middle" font-size="8.5" class="dim" ${FONT}>${foot}</text></g>`
  )
}

// The 3, 2, 1 after a resume, over a world standing still.
function countdown(g: Game, width: number, now: number) {
  const left = g.countdownUntil - now
  if (g.mode !== 'running' || left <= 0) return ''
  const beat = COUNTDOWN_MS / 3
  return [3, 2, 1]
    .map((digit, i) => {
      const from = i * beat - (COUNTDOWN_MS - left)
      if (from + beat <= 0) return ''
      return (
        `<g ${during(from, from + beat)}><text class="up" x="${n(width / 2)}" y="60" font-size="30" font-weight="800" text-anchor="middle" stroke-width="4" paint-order="stroke" ${FONT}` +
        ` style="transform-box:fill-box;transform-origin:center;animation:count ${n(beat)}ms ease-out ${n(from)}ms both">${digit}</text></g>`
      )
    })
    .join('')
}

// The run as it is at `now`, an SVG the band draws as an image.
export function drawScene(g: Game, view: View, now: number): string {
  const width = Math.round(view.width)
  const t = gameTime(g, now)
  const d = distAt(t)
  const live = g.mode === 'running' && now >= g.countdownUntil
  const speed = speedAt(t)
  const css: string[] = []
  const scene =
    backdrop(width, d, speed, live, css) +
    world(g, width, d, speed, live, css) +
    ghostRunners(g, t, live, css) +
    runner(g, t, now, live, css) +
    pops(g, now, width)
  const shake = g.mode === 'over' && g.crash !== null ? ` style="animation:shake 320ms linear -${n(now - g.crash.wall)}ms"` : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}">` +
    `<defs>${DEFS}<clipPath id="clip"><rect width="${width}" height="${HEIGHT}" rx="10"/></clipPath>` +
    `<mask id="bands" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${HEIGHT}"><rect width="${width}" height="${HEIGHT}" fill="#fff"/>` +
    `<rect y="${GROUND - 15}" width="${width}" height="2" fill="#000"/><rect y="${GROUND - 10}" width="${width}" height="2.5" fill="#000"/><rect y="${GROUND - 5}" width="${width}" height="3" fill="#000"/></mask></defs>` +
    `<style>${CSS}${live ? LIVE_CSS : ''}${css.join('')}</style>` +
    `<g clip-path="url(#clip)"><g${shake}>${scene}</g>${hud(g, view, width, t, now, live)}${countdown(g, width, now)}${card(g, view, width, now)}</g>` +
    `<rect class="frame" x=".5" y=".5" width="${width - 1}" height="${HEIGHT - 1}" rx="9.5"/></svg>`
  )
}
