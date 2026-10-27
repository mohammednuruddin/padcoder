import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import type { ClaudeStatus } from '../types'
import { act, advance, drawScene, newGame, nextWake, pause, sceneAlt, widthFor, type Action, type PauseReason } from './scene'

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

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

// Sleeps until the run can next change (a bug reaching Clawd, a speed-up),
// so nothing ticks between events; a crash rumbles the pad and keeps a best.
async function settle($: EngineInterface) {
  timer?.cancel()
  timer = undefined
  if (game.crash !== null && game.crash !== lastCrash) {
    lastCrash = game.crash
    post($, THUD)
    if (game.isNewBest) await $.store.set('best', game.best)
  }
  const wait = nextWake(game, await $.clock.now())
  if (wait !== undefined) timer = $.clock.after(wait, () => void wake($))
}

async function wake($: EngineInterface) {
  timer = undefined
  if (advance(game, await $.clock.now()) !== 'none') redraw($)
  await settle($)
}

async function handle($: EngineInterface, signal: Signal) {
  const now = await $.clock.now()
  let changed = false
  if (signal === 'on' || signal === 'show') {
    await update($, shown, () => true)
    if (signal === 'on') {
      padPlays = true
      if (game.mode === 'paused') changed = act(game, 'jump', now)
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
  } else if (await read($, shown)) changed = act(game, signal, now)
  if (changed) redraw($)
  await settle($)
}

async function stop($: EngineInterface, why: PauseReason) {
  if (pause(game, await $.clock.now(), why)) redraw($)
  await settle($)
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
        if (signal !== undefined) await handle($, signal)
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
    void listen($)
    return started
  })

  on('command.run', { command: 'bugdash' }, async $ => {
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

    game.width = widthFor(e.props.bodyColumns)
    const said = await read($, claude)
    const view = { width: game.width, claude: e.props.isWorking ? 'working' : said === 'working' ? 'idle' : said } as const
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
          <Button key="hide" label="Hide" hotkey="h" dimColor onPress={press('hide')} />
        </Box>
        {beneath}
      </Box>
    )
  })
}
