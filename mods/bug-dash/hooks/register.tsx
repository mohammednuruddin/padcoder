import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { ClaudeStatus } from '../types'
import { SERVER, asked, boardOf, boardPath, joined, runBody, sentOf, type Answer, type Player } from './race'
import { act, advance, dayOf, daySeed, drawScene, newGame, nextWake, pause, sceneAlt, setGhosts, widthFor, type Action, type Move, type PauseReason, type Race } from './scene'

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
const STALE_MS = 10 * 60_000

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

// Sound, from sounds/: on unless /bugdash sound or Mute turns it off.
let sound = true
const play = ($: EngineInterface, clip: string) => {
  if (sound) void $.audio.play({ asset: `sounds/${clip}.wav` }, { gain: 0.5 }).catch(() => undefined)
}
// The rules' pops (a token, a smash, a double jump, a level) already heard;
// each kind has a clip of its name.
const heard = new WeakSet<object>()
function listenTo($: EngineInterface, now: number) {
  for (const pop of game.pops) {
    if (heard.has(pop)) continue
    heard.add(pop)
    if (now - pop.wall < 250) play($, pop.kind)
  }
}

// Sleeps until the run can next change (a bug reaching Clawd, a speed-up),
// so nothing ticks between events; a crash rumbles the pad and keeps a best.
async function settle($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  if (game.crash !== null && game.crash !== lastCrash) {
    lastCrash = game.crash
    play($, 'caught')
    // Taken before anything awaits, so a quick restart can't swap the run.
    if (player !== undefined) void submit($, player, { day: runDay, moves: game.log.slice(), score: game.score })
    post($, THUD)
    if (game.isNewBest) await $.store.set('best', game.best)
  }
  const wait = nextWake(game, await $.clock.now())
  if (wait !== undefined) timer = $.clock.after(wait, () => void wake($))
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

// Sends a run just ended, then fetches the board it changed.
async function submit($: EngineInterface, who: Player, run: { readonly day: string; readonly moves: readonly Move[]; readonly score: number }) {
  race = { ...(race ?? { top: [], total: 0 }), sent: 'sending' }
  redraw($)
  const sent = sentOf(await call($, '/run', runBody(who, run.day, run.moves, run.score)))
  if (race !== undefined) race = { ...race, sent }
  redraw($)
  await refresh($)
}

// Fetches today's board and ghosts; the run goes on offline if it can't.
async function refresh($: EngineInterface) {
  if (player === undefined) return
  const now = await $.clock.now()
  const day = dayOf(now)
  const fresh = boardOf(await call($, boardPath(day, player.name)))
  if (fresh === undefined || player === undefined) return
  const { ghosts, ...standing } = fresh
  race = { ...standing, sent: race?.sent }
  raceAt = now
  // Mid-run on yesterday's course, today's ghosts wait: the next run fetches again.
  if (setGhosts(game, daySeed(day), ghosts)) raceDay = day
  redraw($)
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
function soundOf($: EngineInterface, signal: Signal, was: string, now: number) {
  if (game.mode !== 'running') return
  if (was === 'ready' || was === 'over') play($, 'start')
  else if (was === 'paused') play($, 'count')
  else if (signal === 'slide' || signal === 'dash') play($, signal)
  else if (signal === 'jump' && !game.pops.some(pop => pop.kind === 'double' && !heard.has(pop))) play($, 'jump')
  listenTo($, now)
}

async function handle($: EngineInterface, signal: Signal) {
  const now = await $.clock.now()
  let changed = false
  if (signal === 'on' || signal === 'show') {
    await update($, shown, () => true)
    if (now - raceAt > STALE_MS) void refresh($)
    if (signal === 'on') {
      padPlays = true
      if (game.mode === 'paused' && act(game, 'jump', now)) {
        changed = true
        soundOf($, 'jump', 'paused', now)
      }
    }
  } else if (signal === 'off' || signal === 'hide') {
    changed = pause(game, now, signal === 'off' ? 'pad' : 'hidden')
    if (signal === 'hide') {
      await update($, shown, () => false)
      // Hiding the run the pad plays hands the pad back to Claude, which
      // pauses the copies in other sessions too; a run shown with /bugdash
      // alone leaves the pad be.
      if (padPlays) post($, HIDDEN)
    }
    padPlays = false
  } else if (await read($, shown)) {
    // A new run is on today's course, the one everyone runs.
    if (game.mode === 'ready' || game.mode === 'over') {
      runDay = dayOf(now)
      game.seed = daySeed(runDay)
      if (race !== undefined) race = { ...race, sent: undefined }
      if (player !== undefined && raceDay !== runDay) void refresh($)
    }
    const was = game.mode
    changed = act(game, signal, now)
    if (changed) soundOf($, signal, was, now)
  }
  if (changed) redraw($)
  await settle($)
}

async function stop($: EngineInterface, why: PauseReason) {
  if (pause(game, await $.clock.now(), why)) redraw($)
  await settle($)
}

async function toggleSound($: EngineInterface) {
  sound = !sound
  await $.store.set('sound', sound)
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
  return `You're in the daily race as ${made.name}. Each run on today's course is sent when Clawd is caught, and the leader's and your best run alongside you as ghosts.`
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
  const argv = ['/usr/bin/notifyutil', ...Object.keys(SIGNALS).flatMap(name => ['-w', name])]
  let pending = ''
  try {
    for await (const piece of $.process.spawn({ argv })) {
      const lines = (pending + piece.text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const signal = SIGNALS[line.trim()]
        if (signal === undefined) continue
        // A move means the pad plays a shown run, even in a session that
        // started after game.on.
        if (signal !== 'on' && signal !== 'off' && (await read($, shown))) padPlays = true
        await handle($, signal)
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
    void listen($)
    void refresh($)
    return started
  })

  // /bugdash shows or hides it; join, leave and top run the daily race.
  on('command.run', { command: 'bugdash' }, async ($, e) => {
    const [word = '', name = ''] = e.args.trim().split(/\s+/)
    if (word === 'join') return { text: await joinRace($, name) }
    if (word === 'leave') {
      if (player === undefined) return { text: 'You are not in the daily race.' }
      const left = player.name
      player = undefined
      race = undefined
      setGhosts(game, game.seed, [])
      await $.store.delete('player')
      redraw($)
      return { text: `Bug Dash no longer sends runs from here. The name ${left} stays taken.` }
    }
    if (word === 'top') return { text: await topText($) }
    if (word === 'sound') return { text: await toggleSound($) }
    if (word !== '') return { text: 'Use /bugdash to show or hide it, /bugdash join <name> to race online, /bugdash top for the board, /bugdash leave to stop, /bugdash sound to mute or unmute it.' }
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
    const view = { width: widthFor(e.props.bodyColumns), claude: e.props.isWorking ? 'working' : said === 'working' ? 'idle' : said, race } as const
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
