import { expect, mock, test } from 'claude-code/testing'
import { act, advance, distAt, gameTime, multiplier, newGame, nextWake, speedAt, type Game } from '../hooks/scene'

const BAND = {
  plugin: 'bug-dash',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 24, bodyColumns: 120, scroll: { offset: 0, bodyRows: 23 }, view: {} },
} as const

const BUGDASH = { command: 'bugdash', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

test('/bugdash puts the game above the prompt: it runs, crashes, and pauses when Claude needs you', async ($, on) => {
  // Each hook here stands for the engine beneath the mod.
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'bugdash' } }))
  on('tool.check', () => ({ decision: 'ask' as const }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core" />
  })
  mock.store(on)
  const clock = mock.clock(on)

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const alt = async () => (await ui.find({ type: 'Svg' }))?.props.alt
  expect(await alt()).toBeUndefined()

  await $.command.run(BUGDASH)
  expect(await alt()).toMatch(/ready/)

  await ui.press({ key: 'play' })
  expect(await alt()).toMatch(/running: 0 points/)
  expect(await ui.find({ type: 'Button', key: 'jump' })).toBeDefined()

  // Nobody presses anything: the course catches Clawd.
  await clock.advance(12_000)
  expect(await alt()).toMatch(/over: (squashed by a bug|tests failed)/)

  // A permission ask pauses the next run, and a paused run stays put.
  await ui.press({ key: 'play' })
  expect(await alt()).toMatch(/running/)
  await clock.advance(500)
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' } })
  const paused = await alt()
  expect(paused).toMatch(/paused: Claude needs you/)
  await clock.advance(2000)
  expect(await alt()).toBe(paused)

  await ui.press({ key: 'hide' })
  expect(await alt()).toBeUndefined()
  await ui.unmount()
})

test('the terminal has no SVG, so the band is left to the rest', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'bugdash' } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core" />
  })
  mock.store(on)
  mock.clock(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run(BUGDASH)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  await ui.unmount()
})

// Clawd's body spans these screen columns; a bot reads the course ahead of it.
const CLAWD_BACK = 114
const CLAWD_FRONT = 146

function bot(g: Game, now: number) {
  const t = gameTime(g, now)
  const d = distAt(t)
  const next = g.things.find(x => x.done === undefined && x.kind !== 'token' && x.x - d + (x.kind === 'bug' ? 21 : 41) > CLAWD_BACK)
  if (next === undefined) return
  const gap = next.x - d + 3 - CLAWD_FRONT
  const lead = speedAt(t) * 100
  if (gap <= 0 || gap >= lead) return
  if (next.kind === 'bug' && g.air === null) act(g, 'jump', now)
  if (next.kind === 'fail' && t >= g.slideUntil) act(g, 'slide', now)
}

// Plays a run from `seed` for `ms`, noting the game time each obstacle is cleared.
function play(seed: number, ms: number) {
  const g = newGame()
  g.width = 1000
  act(g, 'jump', seed)
  const cleared = new Map<number, number>()
  for (let now = seed; now < seed + ms && g.mode === 'running'; now += 10) {
    advance(g, now)
    bot(g, now)
    for (const thing of g.things) if (thing.done === 'passed' && !cleared.has(thing.id)) cleared.set(thing.id, gameTime(g, now))
  }
  return { g, cleared: [...cleared.values()] }
}

test('every stretch of the course, to the last level and past it, can be cleared by jumping bugs and sliding under banners', () => {
  for (const seed of [1, 7_331, 90_210]) {
    const { g } = play(seed, 420_000)
    expect(g.mode).toBe('running')
    expect(g.level).toBeGreaterThan(40)
  }
})

test('the run gets harder: faster, with more to clear each second, and worth more', () => {
  expect(speedAt(0)).toBe(0.26)
  expect(speedAt(60_000)).toBeGreaterThan(speedAt(30_000))
  expect(speedAt(180_000)).toBeGreaterThan(0.55)
  expect(speedAt(3_600_000)).toBe(speedAt(360_000))
  const { cleared } = play(4_242, 240_000)
  const rate = (from: number, to: number) => cleared.filter(at => at >= from && at < to).length / ((to - from) / 1000)
  expect(rate(180_000, 240_000)).toBeGreaterThan(rate(0, 60_000) * 1.5)
  expect([0, 3, 4, 8, 40].map(multiplier)).toEqual([1, 1, 2, 3, 11])
})

test('the run only wakes the engine while it is running', () => {
  const g = newGame()
  expect(nextWake(g, 0)).toBeUndefined()
  act(g, 'jump', 0)
  const wait = nextWake(g, 0)
  expect(wait).toBeGreaterThan(100)
  expect(wait).toBeLessThan(5000)
  act(g, 'pause', 50)
  expect(nextWake(g, 60)).toBeUndefined()
  const frozen = gameTime(g, 60)
  expect(gameTime(g, 9000)).toBe(frozen)
})
