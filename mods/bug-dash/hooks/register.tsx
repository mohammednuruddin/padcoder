import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { ClaudeStatus } from '../types'
import { EARNED_BY, SERVER, asked, boardOf, boardPath, hasSkin, joined, medalsFrom, medalsOf, medalsPath, refusal, runBody, sentOf, type Answer, type Medals, type Player } from './race'
import { CODE, NAME, heard as roomHeard, listenArgv, newCode, sayPath, type Heard } from './room'
import {
  COUNTDOWN_MS, FINAL_MS, SKINS, act, advance, dayOf, daySeed, drawScene, gameTime, newGame, nextWake, pause, rivalGone, rivalOut, rivalRun, rivalsRacing, sceneAlt,
  setGhosts, startRace, widthFor,
  type Action, type Move, type PauseReason, type Race, type RoomView, type Skin,
} from './scene'

type Signal = Action | 'on' | 'off' | 'show' | 'hide'

// PadCoder (the controller app) posts these in its game mode, so the pad
// plays without the band holding the keyboard; L1 + touchpad turns it on.
const SIGNALS: Readonly<Record<string, Signal>> = {
  'com.padcoder.game.on': 'on',
  'com.padcoder.game.off': 'off',
  'com.padcoder.game.jump': 'jump',
  'com.padcoder.game.slide': 'slide',
  'com.padcoder.game.dash': 'dash',
  'com.padcoder.game.pause': 'pause',
}
// And these go back to PadCoder: Clawd was caught (rumble), or the game was
// hidden (the pad drives Claude again).
const THUD = 'com.padcoder.game.thud'
const HIDDEN = 'com.padcoder.game.hidden'
const post = ($: EngineInterface, name: string) => void $.process.run(['/usr/bin/notifyutil', '-p', name]).catch(() => undefined)

const claude = atom({ plugin: 'bug-dash', key: 'claude' } as const, 'idle' as ClaudeStatus)
const shown = atom({ plugin: 'bug-dash', key: 'shown' } as const, false)

// The run lives in the module: a reload starts a fresh one.
const game = newGame()
let timer: Timer | undefined
let lastCrash = game.crash
// Whether the pad plays this session's run: from game.on to game.off.
let padPlays = false
// The daily race, once joined: who races here, the board, and its day.
let player: Player | undefined
let race: Race | undefined
let raceDay = ''
let raceAt = -Infinity
let runDay = ''
let runs = 0 // runs started here, so a slow answer about an earlier one is known
const STALE_MS = 10 * 60_000
// The skin Clawd wears, and the medals that earn them, as of the latest final day.
let skin: Skin = 'clay'
let medals: Medals | undefined
let medalsDay = ''

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

// Sound, from sounds/: on unless /bugdash sound or Mute turns it off, in
// every session. In pad game mode every open session plays the same run, so
// one at a time owns the sound: the one last played here, or, from the pad,
// whichever claims it once the owner has gone quiet. The shared store keeps
// both; each session keeps them in memory too, reading the store only when
// another posts SOUND or a hold it saw runs out.
let sound = true
const SOUND = 'com.padcoder.bugdash.sound'
const ME = Math.random().toString(36).slice(2)
const OWNER_MS = 5000
const RENEW_MS = 1000
// A pad move reaches every session at once, so with nobody owning the sound
// each claims it; once all the claims have landed, the last one stands.
const SETTLE_MS = 40
type Owner = { readonly id: string; readonly at: number }
const ownerOf = async ($: EngineInterface) => (await $.store.get('soundOwner')) as Owner | undefined
// When this session last claimed or renewed the sound; until when another holds it.
let mineAt: number | undefined
let otherUntil = 0

async function play($: EngineInterface, clip: string, here = false) {
  if (!sound) return
  const now = await $.clock.now()
  const holding = mineAt !== undefined && now - mineAt < OWNER_MS
  if (!holding) {
    if (!here && now < otherUntil) return
    const owner = await ownerOf($)
    if (!here && owner !== undefined && owner.id !== ME && now - owner.at < OWNER_MS) {
      otherUntil = owner.at + OWNER_MS
      return
    }
    await $.store.set('soundOwner', { id: ME, at: now })
    mineAt = now
    if (!here) {
      await new Promise<void>(resolve => $.clock.after(SETTLE_MS, resolve))
      if ((await ownerOf($))?.id !== ME) {
        mineAt = undefined
        return
      }
    }
    // Any session that thought it held the sound lets go.
    post($, SOUND)
  } else if (now - (mineAt ?? 0) > RENEW_MS) {
    // Renewed only while still held: another may have taken it, its post on the way.
    if ((await ownerOf($))?.id !== ME) {
      mineAt = undefined
      return
    }
    await $.store.set('soundOwner', { id: ME, at: now })
    mineAt = now
  }
  await $.audio.play({ asset: `sounds/${clip}.wav` }, { gain: 0.5 }).catch(() => undefined)
}

// Another session muted, unmuted or took the sound: read where things stand.
// Only the latest read applies: an earlier one finishing late, or one a
// toggle here overtook, is dropped.
let syncs = 0
async function syncSound($: EngineInterface) {
  const sync = ++syncs
  const on = (await $.store.get('sound')) !== false
  const owner = await ownerOf($)
  if (sync !== syncs) return
  const was = sound
  sound = on
  if (owner?.id !== ME) mineAt = undefined
  otherUntil = owner !== undefined && owner.id !== ME ? owner.at + OWNER_MS : 0
  if (sound !== was) redraw($)
}
// The rules' pops (a token, a smash, a double jump, a level) already heard;
// each kind has a clip of its name.
const heard = new WeakSet<object>()
function listenTo($: EngineInterface, now: number, here = false) {
  for (const pop of game.pops) {
    if (heard.has(pop)) continue
    heard.add(pop)
    if (now - pop.wall < 250) void play($, pop.kind, here)
  }
}

// Sleeps until the run can next change (a bug reaching Clawd, a speed-up),
// so nothing ticks between events; a crash rumbles the pad and keeps a best.
async function settle($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  if (game.crash !== null && game.crash !== lastCrash) {
    lastCrash = game.crash
    void play($, 'caught')
    // Taken before anything awaits, so a quick restart can't swap the run. A
    // room race goes to the room, never to the daily race.
    if (roomRun) void sendRun($)
    else if (player !== undefined) void submit($, player, { day: runDay, moves: game.log.slice(), score: game.score })
    post($, THUD)
    if (game.isNewBest) await $.store.set('best', game.best)
  }
  const wait = nextWake(game, await $.clock.now())
  if (wait !== undefined) timer = $.clock.after(wait, () => void wake($))
  else if (rivalsRacing(game) && (await read($, shown))) timer = $.clock.after(WATCH_MS, () => void watch($))
}

// Caught or paused, with rivals still racing: carries them on and redraws.
async function watch($: EngineInterface) {
  timer = undefined
  advance(game, await $.clock.now())
  redraw($)
  await settle($)
}

// One request to the race server; undefined when it can't be reached.
// BUG_DASH_SERVER points the mod at another server, such as a local one.
async function call($: EngineInterface, path: string, body?: unknown): Promise<Answer | undefined> {
  const server = (await $.env.get('BUG_DASH_SERVER')) ?? SERVER
  if (server === '') return undefined
  try {
    const answer = await $.http.fetch(server + path, asked(body))
    return { status: answer.status, text: answer.text }
  } catch {
    return undefined
  }
}

// Sends a run just ended, then fetches the board it changed. Where it put the
// player shows only while that run is the last one, raced under that name.
async function submit($: EngineInterface, who: Player, run: { readonly day: string; readonly moves: readonly Move[]; readonly score: number }) {
  const sending = runs
  race = { ...(race ?? { top: [], total: 0 }), sent: 'sending' }
  redraw($)
  const sent = sentOf(await call($, '/run', runBody(who, run.day, run.moves, run.score)))
  if (player !== who) return
  if (race !== undefined && runs === sending) {
    race = { ...race, sent }
    redraw($)
  }
  await refresh($)
}

// Fetches today's board and ghosts; the run goes on offline if it can't. An
// answer overtaken by a later fetch, or for a name left meanwhile, is dropped.
let fetches = 0
async function refresh($: EngineInterface) {
  const who = player
  if (who === undefined) return
  const fetch = ++fetches
  const now = await $.clock.now()
  const day = dayOf(now)
  const fresh = boardOf(await call($, boardPath(day, who.name)))
  if (fresh === undefined || player !== who || fetch !== fetches) return
  const { ghosts, ...standing } = fresh
  race = { ...standing, sent: race?.sent }
  raceAt = now
  // Mid-run on yesterday's course, today's ghosts wait: the next run fetches again.
  if (setGhosts(game, daySeed(day), ghosts)) raceDay = day
  redraw($)
  await medalsFor($, now)
}

// The player's medals, fetched again only once another day is final, and
// kept for when the race can't be reached. An answer for a name left
// meanwhile is dropped.
async function medalsFor($: EngineInterface, now: number) {
  const day = dayOf(now - FINAL_MS)
  const who = player
  if (who === undefined || medalsDay === day) return
  const got = medalsOf(await call($, medalsPath(who.name)))
  if (got === undefined || player !== who) return
  medals = got
  medalsDay = day
  // Kept under the name they are for, so a write landing after a leave can't
  // dress, or wipe, the next name's.
  await $.store.set(`medals:${who.name}`, got)
}

// /bugdash skin lists the skins; /bugdash skin <name> puts one on.
async function wear($: EngineInterface, name: string) {
  await medalsFor($, await $.clock.now())
  const want = SKINS.find(s => s === name.toLowerCase())
  if (name === '' || want === undefined) {
    const rows = SKINS.map(s => `${s}: ${s === skin ? 'wearing' : hasSkin(s, medals) ? 'earned' : EARNED_BY[s]}`).join('\n')
    const how = player === undefined ? '\n/bugdash join <name> races online, where the metals are earned.' : ''
    return `${name === '' ? '' : `No skin called ${name}. `}Skins for Clawd, /bugdash skin <name> to wear one:\n${rows}${how}`
  }
  if (!hasSkin(want, medals)) return `${want} is earned in the daily race: ${EARNED_BY[want]}.`
  skin = want
  if (player !== undefined) await $.store.set(`skin:${player.name}`, want)
  redraw($)
  return `Clawd wears ${want}.`
}

// ------------------------------------------------------------------- rooms

// The room this session races friends in, when it is in one: its code, the
// name raced under there, the secret that signs what is said, who else is in,
// whether the stream holds, how far the room's clock runs from this one, the
// race last started, and how many of this run's moves the room has had.
type Room = {
  readonly code: string
  readonly name: string
  secret?: string
  others: readonly string[]
  state: RoomView['state']
  offset: number
  // Ends the stream when the room is listened to.
  stop?: () => void
  race?: number
  sent: number
  sending: boolean
  again: boolean
  tries: number
  fails: number
  // A try to listen again, waiting.
  retry?: Timer
}
let room: Room | undefined
// Whether this run is a room race, which the daily race never hears of.
let roomRun = false
const RETRY_MS = 3000
const TRIES = 2
const BATCH_MS = 600 // a run's moves go to the room at most this often
const WATCH_MS = 500 // caught, with rivals still racing, the band redraws this often
const FAILS = 3
const NUDGE_MS = 125

const roomView = (): RoomView | undefined => (room === undefined ? undefined : { code: room.code, others: room.others, state: room.state })
const serverOf = async ($: EngineInterface) => (await $.env.get('BUG_DASH_SERVER')) ?? SERVER

// A rival's news redraws the band, at most every NUDGE_MS however many come.
let nudged: Timer | undefined
function nudge($: EngineInterface) {
  nudged ??= $.clock.after(NUDGE_MS, () => {
    nudged = undefined
    redraw($)
  })
}

// Listens to the room while the band shows it, until the stream ends:
// dropped, closed for idling, refused, or left. A drop is tried again a
// couple of times; then the room shows as lost until ✕ tries it again.
async function listenRoom($: EngineInterface) {
  const here = room
  if (here === undefined || here.stop !== undefined) return
  const base = await serverOf($)
  if (base === '' || room !== here || here.stop !== undefined) return
  here.state = 'joining'
  redraw($)
  const stream = $.process.spawn({ argv: listenArgv(base, here.code, here.name, here.secret) })
  here.stop = () => void stream.return({ code: null, signal: null }).catch(() => undefined)
  let pending = ''
  let why: string | undefined
  try {
    for await (const piece of stream) {
      if (piece.stream !== 'stdout') continue
      const lines = (pending + piece.text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const h = roomHeard(line.trim())
        if (h?.kind === 'bye') why = h.why
        else if (h !== undefined) await onHeard($, here, h)
      }
    }
    // A refusal in place of a stream comes without a newline.
    const last = roomHeard(pending.trim())
    if (last?.kind === 'bye') why = last.why
  } catch {
    // No curl, or it couldn't start: the room is lost.
  }
  here.stop = undefined
  if (room !== here) return
  here.state = 'lost'
  redraw($)
  if (why !== undefined) $.ui.toast(`Bug Dash room ${here.code}: ${why}`)
  else if (here.tries++ < TRIES && (await read($, shown))) {
    here.retry = $.clock.after(RETRY_MS, () => {
      here.retry = undefined
      void (async () => {
        if (room === here && (await read($, shown))) await listenRoom($)
      })()
    })
  }
}

// Stops listening to the room, and tells it so it lets the name go at once.
function quitRoom($: EngineInterface, here: Room) {
  here.retry?.cancel()
  here.retry = undefined
  if (here.stop === undefined) return
  here.stop()
  if (here.secret !== undefined) void call($, sayPath(here.code), { name: here.name, secret: here.secret, kind: 'bye' })
}

async function onHeard($: EngineInterface, here: Room, h: Exclude<Heard, { kind: 'bye' }>) {
  const now = await $.clock.now()
  switch (h.kind) {
    case 'hello': {
      here.secret = h.secret
      here.offset = h.now - now
      here.others = h.members.filter(name => name !== here.name)
      here.state = 'in'
      here.tries = 0
      // Back in the race this run is in: the room's moves fill in whatever
      // was missed, and this run's go on from what the room has of them.
      const on = h.race
      if (on !== undefined && roomRun && on.race === here.race) {
        for (const [name, run] of Object.entries(on.runs)) {
          if (name === here.name) here.sent = Math.min(here.sent, run.moves.length)
          else rivalRun(game, name, { ...run, from: 0 }, now)
        }
        void sendRun($)
      }
      redraw($)
      return
    }
    case 'joined':
      if (h.name !== here.name && !here.others.includes(h.name)) here.others = [...here.others, h.name]
      redraw($)
      return
    case 'left':
      here.others = here.others.filter(name => name !== h.name)
      rivalGone(game, h.name)
      redraw($)
      return
    case 'skip':
      if (h.race === here.race && rivalOut(game, h.name)) redraw($)
      return
    case 'start': {
      // A run under way plays on, and sits the race out; everyone else is off together.
      if (game.mode === 'running' || game.mode === 'paused') {
        if (here.secret !== undefined) void call($, sayPath(here.code), { name: here.name, secret: here.secret, kind: 'skip' })
        return
      }
      const at = h.at - here.offset
      startRace(game, h.seed, at, h.names.filter(name => name !== here.name))
      here.race = h.race
      here.sent = 0
      here.fails = 0
      roomRun = true
      runs++
      // The day's ghosts were left behind: the next daily run fetches them again.
      raceDay = ''
      if (race !== undefined) race = { ...race, sent: undefined }
      void play($, 'start')
      if (at - now > COUNTDOWN_MS) $.clock.after(at - now - COUNTDOWN_MS, () => void play($, 'count'))
      redraw($)
      await settle($)
      return
    }
    case 'run':
      if (h.race === here.race && h.name !== here.name && rivalRun(game, h.name, h.run, now)) nudge($)
      return
  }
}

// Sends the room what it hasn't had of this run: the moves since the last
// batch it took, where the run is, and whether it is paused or over. One
// batch is on its way at a time, BATCH_MS apart at least, so a burst of moves
// goes as one; a batch lost is sent again, a few times at most.
async function sendRun($: EngineInterface) {
  const here = room
  const secret = here?.secret
  const raceId = here?.race
  if (here === undefined || secret === undefined || raceId === undefined || !roomRun) return
  if (here.sending) {
    here.again = true
    return
  }
  here.sending = true
  const now = await $.clock.now()
  const from = here.sent
  const moves = game.log.slice(from)
  const body = {
    name: here.name, secret, kind: 'run', race: raceId, from, moves,
    t: Math.round(gameTime(game, now)), wait: Math.max(0, Math.ceil(game.countdownUntil - now)),
    paused: game.mode === 'paused', over: game.mode === 'over',
  }
  const answer = await call($, sayPath(here.code), body)
  const took = answer !== undefined && answer.status < 300
  if (took && here.race === raceId) here.sent = from + moves.length
  if (!took && here.fails++ < FAILS) here.again = true
  await new Promise<void>(resolve => $.clock.after(BATCH_MS, resolve))
  here.sending = false
  if (here.again) {
    here.again = false
    void sendRun($)
  }
}

async function askStart($: EngineInterface) {
  const here = room
  if (here?.secret === undefined) return
  const answer = await call($, sayPath(here.code), { name: here.name, secret: here.secret, kind: 'start' })
  if (answer === undefined || answer.status >= 500) $.ui.toast("Bug Dash couldn't reach the room to start a race.")
  else if (answer.status >= 300) $.ui.toast(`Bug Dash: ${refusal(answer)}`)
}

// /bugdash room opens a room, /bugdash room <code> [name] joins one, and
// /bugdash room leave leaves it.
async function roomCommand($: EngineInterface, word: string, given: string) {
  if (word.toLowerCase() === 'leave') {
    if (room === undefined) return 'You are not in a room.'
    const left = room.code
    quitRoom($, room)
    room = undefined
    redraw($)
    return `You left room ${left}.`
  }
  if (word === '' && room !== undefined) {
    return `You're in room ${room.code} as ${room.name}${room.others.length > 0 ? `, with ${room.others.join(', ')}` : ', alone so far'}. /bugdash room leave to go.`
  }
  const code = word === '' ? newCode(Math.random) : word.toUpperCase()
  if (!CODE.test(code)) return 'A room code is 5 letters and digits, like K7QXM. /bugdash room alone opens a new room.'
  const name = given || player?.name || ''
  if (!NAME.test(name)) return 'Race under a name: /bugdash room <code> <name>, 2 to 16 letters, digits, _ or -. Your daily race name is used if you have one.'
  if ((await serverOf($)) === '') return "The race server isn't up yet."
  if (room !== undefined) quitRoom($, room)
  room = { code, name, others: [], state: 'joining', offset: 0, sent: 0, sending: false, again: false, tries: 0, fails: 0 }
  await handle($, 'show')
  return word === ''
    ? `Room ${code} is open. Friends join with /bugdash room ${code}, and ✕ starts a race for everyone in it.`
    : `You're in room ${code} as ${name}. ✕ starts a race for everyone in it.`
}

async function wake($: EngineInterface) {
  timer = undefined
  const now = await $.clock.now()
  if (advance(game, now) !== 'none') redraw($)
  listenTo($, now)
  await settle($)
}

// What a press that took sounds like: a run starting, the count after a
// resume, or the move itself (a double jump is heard from its pop).
function soundOf($: EngineInterface, signal: Signal, was: string, now: number, here: boolean) {
  if (game.mode !== 'running') return
  if (was === 'ready' || was === 'over') void play($, 'start', here)
  else if (was === 'paused') void play($, 'count', here)
  else if (signal === 'slide' || signal === 'dash') void play($, signal, here)
  else if (signal === 'jump' && !game.pops.some(pop => pop.kind === 'double' && !heard.has(pop))) void play($, 'jump', here)
  listenTo($, now, here)
}

// `from` the pad, through PadCoder, or here: this session's band or /bugdash.
async function handle($: EngineInterface, signal: Signal, from: 'pad' | 'here' = 'here') {
  const now = await $.clock.now()
  const here = from === 'here'
  let changed = false
  if (signal === 'on' || signal === 'show') {
    await update($, shown, () => true)
    // Whatever was posted before this session listened, before a resume can sound.
    await syncSound($)
    if (room !== undefined && room.stop === undefined) {
      room.tries = 0
      void listenRoom($)
    }
    if (now - raceAt > STALE_MS) void refresh($)
    if (signal === 'on') {
      padPlays = true
      if (game.mode === 'paused' && act(game, 'jump', now)) {
        changed = true
        soundOf($, 'jump', 'paused', now, here)
      }
    }
  } else if (signal === 'off' || signal === 'hide') {
    changed = pause(game, now, signal === 'off' ? 'pad' : 'hidden')
    if (changed && roomRun) void sendRun($)
    if (signal === 'hide') {
      await update($, shown, () => false)
      // A hidden band leaves the room's stream; showing it joins again.
      if (room !== undefined) quitRoom($, room)
      // Hiding the run the pad plays hands the pad back to Claude, which
      // pauses the copies in other sessions too; a run shown with /bugdash
      // alone leaves the pad be.
      if (padPlays) post($, HIDDEN)
    }
    padPlays = false
  } else if (await read($, shown)) {
    if (game.mode === 'paused') await syncSound($)
    // In a room, ✕ starts a race for everyone, or joins the room again if it was lost.
    if ((game.mode === 'ready' || game.mode === 'over') && room !== undefined) {
      if (signal !== 'jump') return
      if (room.state === 'in') void askStart($)
      else if (room.stop === undefined) {
        room.tries = 0
        void listenRoom($)
      }
      return
    }
    // A new run is on today's course, the one everyone runs.
    if (game.mode === 'ready' || game.mode === 'over') {
      roomRun = false
      runDay = dayOf(now)
      game.seed = daySeed(runDay)
      runs++
      if (race !== undefined) race = { ...race, sent: undefined }
      if (player !== undefined && raceDay !== runDay) void refresh($)
    }
    const was = game.mode
    changed = act(game, signal, now)
    if (changed) soundOf($, signal, was, now, here)
    if (changed && roomRun) void sendRun($)
  }
  if (changed) redraw($)
  await settle($)
}

async function stop($: EngineInterface, why: PauseReason) {
  if (pause(game, await $.clock.now(), why)) {
    redraw($)
    if (roomRun) void sendRun($)
  }
  await settle($)
}

async function toggleSound($: EngineInterface) {
  syncs++
  sound = !sound
  await $.store.set('sound', sound)
  post($, SOUND)
  redraw($)
  return sound ? 'Bug Dash has sound again.' : 'Bug Dash is muted. /bugdash sound brings it back.'
}

async function joinRace($: EngineInterface, name: string) {
  if (player !== undefined) return `You race as ${player.name}. /bugdash leave first to change.`
  if (name === '') return 'Pick a name: /bugdash join <name>, 2 to 16 letters, digits, _ or -.'
  if (((await $.env.get('BUG_DASH_SERVER')) ?? SERVER) === '') return "The race server isn't up yet."
  const made = joined(await call($, '/join', { name }))
  if (typeof made === 'string') return made
  player = made
  await $.store.set('player', made)
  await refresh($)
  return `You're in the daily race as ${made.name}. Each run on today's course is sent when Clawd is caught, and the leader's best run and yours race alongside you as ghosts.`
}

async function topText($: EngineInterface) {
  const day = dayOf(await $.clock.now())
  const today = boardOf(await call($, boardPath(day, player?.name)))
  if (today === undefined) return "Couldn't reach the race."
  if (today.top.length === 0) return `Nobody has run ${day} yet.`
  const rows = today.top.map((row, i) => `${i + 1}. ${row.name} ${row.score}`).join('\n')
  return `Bug Dash, ${day} (${today.total} running):\n${rows}${today.you ? `\nYou: #${today.you.rank}, ${today.you.score}` : ''}`
}

async function listen($: EngineInterface) {
  const argv = ['/usr/bin/notifyutil', ...[...Object.keys(SIGNALS), SOUND].flatMap(name => ['-w', name])]
  let pending = ''
  try {
    for await (const piece of $.process.spawn({ argv })) {
      const lines = (pending + piece.text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim() === SOUND) {
          void syncSound($)
          continue
        }
        const signal = SIGNALS[line.trim()]
        if (signal === undefined) continue
        // A move means the pad plays a shown run, even in a session that
        // started after game.on.
        if (signal !== 'on' && signal !== 'off' && (await read($, shown))) padPlays = true
        await handle($, signal, 'pad')
      }
    }
  } catch {
    // No notifyutil: the band's buttons and /bugdash still play.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'bugdash', description: 'Show or hide Bug Dash, a runner to play above the prompt while Claude works' })
    const saved = await $.store.get('best')
    if (typeof saved === 'number') game.best = Math.max(game.best, saved)
    sound = (await $.store.get('sound')) !== false
    const kept = (await $.store.get('player')) as Partial<Player> | undefined
    if (typeof kept?.name === 'string' && typeof kept.token === 'string') player = { name: kept.name, token: kept.token }
    const worn = player === undefined ? undefined : await $.store.get(`skin:${player.name}`)
    skin = SKINS.find(s => s === worn) ?? 'clay'
    medals = player === undefined ? undefined : medalsFrom(await $.store.get(`medals:${player.name}`))
    void listen($)
    void refresh($)
    return started
  })

  // /bugdash shows or hides it; join, leave and top run the daily race.
  on('command.run', { command: 'bugdash' }, async ($, e) => {
    const [word = '', name = '', extra = ''] = e.args.trim().split(/\s+/)
    if (word === 'join') return { text: await joinRace($, name) }
    if (word === 'leave') {
      if (player === undefined) return { text: 'You are not in the daily race.' }
      const left = player.name
      player = undefined
      race = undefined
      setGhosts(game, game.seed, [])
      // The medals, and the skins they earned, were that name's.
      medals = undefined
      medalsDay = ''
      skin = 'clay'
      await $.store.delete('player')
      await $.store.delete(`medals:${left}`)
      await $.store.delete(`skin:${left}`)
      redraw($)
      return { text: `Bug Dash no longer sends runs from here. The name ${left} stays taken.` }
    }
    if (word === 'top') return { text: await topText($) }
    if (word === 'sound') return { text: await toggleSound($) }
    if (word === 'skin') return { text: await wear($, name) }
    if (word === 'room') return { text: await roomCommand($, name, extra) }
    if (word !== '') return { text: 'Use /bugdash to show or hide it, /bugdash join <name> to race online, /bugdash top for the board, /bugdash leave to stop, /bugdash sound to mute or unmute it, /bugdash skin to dress Clawd, /bugdash room to race friends live.' }
    const showing = !(await read($, shown))
    await handle($, showing ? 'show' : 'hide')
    return {
      text: showing
        ? 'Bug Dash is above the prompt. ✕ or Play to run; L1 + touchpad plays it from the pad.'
        : 'Bug Dash is hidden. /bugdash brings it back.',
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, claude, () => 'working')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    if (e.agentId === undefined) {
      await update($, claude, () => 'finished')
      await stop($, 'finished')
    }
    return answered
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask') {
      await update($, claude, () => 'needsYou')
      await stop($, 'needsYou')
    }
    return verdict
  })

  // The band above the prompt, where pets and other mods draw too: the game
  // on top, theirs beneath, and nothing of ours while a survey holds it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, shown))) return next(e)
    const elements = $.ui.resolve(e)
    if (!('Svg' in elements)) return next(e)
    const { Box, Button, Svg } = elements

    const said = await read($, claude)
    const view = { width: widthFor(e.props.bodyColumns), claude: e.props.isWorking ? 'working' : said === 'working' ? 'idle' : said, race, skin, room: roomView() } as const
    const now = await $.clock.now()
    const beneath = await next(e).catch(() => undefined)
    const press = (signal: Signal) => () => handle($, signal)
    const controls =
      game.mode === 'running'
        ? [
            <Button key="jump" label="Jump" hotkey="w" dimColor onPress={press('jump')} />,
            <Button key="slide" label="Slide" hotkey="s" dimColor onPress={press('slide')} />,
            <Button key="dash" label="Dash" hotkey="d" dimColor onPress={press('dash')} />,
            <Button key="pause" label="Pause" hotkey="p" dimColor onPress={press('pause')} />,
          ]
        : [<Button key="play" label={game.mode === 'paused' ? 'Resume' : 'Play'} hotkey="w" dimColor onPress={press('jump')} />]

    return (
      <Box flexDirection="column">
        <Svg source={drawScene(game, view, now)} alt={sceneAlt(game, view)} />
        <Box position="absolute" top={0} right={0} flexDirection="row" gap={1}>
          {controls}
          <Button key="sound" label={sound ? 'Mute' : 'Unmute'} hotkey="m" dimColor onPress={() => void toggleSound($)} />
          <Button key="hide" label="Hide" hotkey="h" dimColor onPress={press('hide')} />
        </Box>
        {beneath}
      </Box>
    )
  })
}
