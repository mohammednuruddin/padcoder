import { expect, mock, test } from 'claude-code/testing'
import { LIMIT_MS, RULES_VERSION, act, advance, dayOf, daySeed, distAt, gameTime, multiplier, newGame, nextWake, replay, speedAt, type Game, type Move } from '../hooks/scene'

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

test('hiding the run the pad plays hands the pad back, and a hidden run ignores the pad', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'bugdash' } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core" />
  })
  mock.store(on)
  const clock = mock.clock(on)
  // notifyutil: what the mod posts, and a listener the test feeds lines to.
  const posted: string[] = []
  on('process.run', (_, e) => {
    posted.push(e.argv.at(-1) ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const lines: string[] = []
  let wakeListener = () => {}
  on('process.spawn', async function* () {
    for (;;) {
      for (let line = lines.shift(); line !== undefined; line = lines.shift()) {
        if (line === 'end') return { value: { code: 0, signal: null } }
        yield { stream: 'stdout' as const, text: `com.padcoder.game.${line}\n` }
      }
      await new Promise<void>(resolve => (wakeListener = resolve))
    }
  })
  const pad = async (move: string) => {
    lines.push(move)
    wakeListener()
    await clock.advance(1)
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const alt = async () => (await ui.find({ type: 'Svg' }))?.props.alt

  // Shown and hidden with /bugdash alone: the pad stays where it was.
  await $.command.run(BUGDASH)
  await $.command.run(BUGDASH)
  expect(posted).not.toContain('com.padcoder.game.hidden')

  // L1 + touchpad shows it and ✕ runs it; hiding it hands the pad back.
  await pad('on')
  await pad('jump')
  expect(await alt()).toMatch(/running/)
  await $.command.run(BUGDASH)
  expect(posted).toContain('com.padcoder.game.hidden')

  // ✕ while it is hidden doesn't run it on out of sight.
  await pad('jump')
  await $.command.run(BUGDASH)
  expect(await alt()).toMatch(/paused/)

  // Shown with /bugdash in a session that missed game.on: once the pad
  // plays it, hiding it hands the pad back too.
  posted.length = 0
  await pad('jump')
  expect(await alt()).toMatch(/running/)
  await $.command.run(BUGDASH)
  expect(posted).toContain('com.padcoder.game.hidden')
  await pad('end')
  await ui.unmount()
})

test('the daily race: nothing goes out before /bugdash join, then each run is sent, replays to its score, and ghosts run alongside', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'bugdash' } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core" />
  })
  mock.store(on)
  mock.env(on, { BUG_DASH_SERVER: 'http://race.test' })
  const clock = mock.clock(on)
  // A race server that plays each run again, as the real one does.
  const asked: string[] = []
  let replayed: number | undefined
  let leader: { name: string; score: number; moves: readonly Move[] } | undefined
  on('http.fetch', (_, e) => {
    const path = e.url.replace('http://race.test', '')
    asked.push(`${e.init?.method ?? 'GET'} ${path.split('?')[0]}`)
    const answer = (status: number, value: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(value) } })
    if (path === '/join') return answer(201, { name: 'ada', token: 't0k3n' })
    if (path.startsWith('/day/')) {
      const top = leader ? [{ name: leader.name, score: leader.score, level: 1 }] : []
      return answer(200, { rules: RULES_VERSION, total: top.length, top, you: leader ? { rank: 1, score: leader.score } : undefined, ghosts: leader ? [leader] : [] })
    }
    const run = JSON.parse(e.init?.body ?? '{}') as { day: string; moves: Move[]; score: number; token: string }
    const again = replay(daySeed(run.day), run.moves, LIMIT_MS)
    replayed = again.score
    leader = { name: 'ada', score: again.score, moves: run.moves }
    return answer(200, { score: again.score, level: again.level, claimed: run.score, best: again.score, rank: 1, total: 1 })
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const alt = async () => (await ui.find({ type: 'Svg' }))?.props.alt as string | undefined
  const svg = async () => (await ui.find({ type: 'Svg' }))?.props.source as string | undefined

  // Not joined: a whole run, and not a word to the server.
  await $.command.run(BUGDASH)
  await ui.press({ key: 'play' })
  await clock.advance(1_500)
  await ui.press({ key: 'jump' })
  await clock.advance(15_000)
  expect(await alt()).toMatch(/over/)
  expect(asked).toEqual([])

  // Joined: the next run is sent when Clawd is caught. It is played on the
  // band's buttons as the bot plays today's course for 40 s, then left.
  const said = await $.command.run({ ...BUGDASH, args: 'join ada' })
  expect(JSON.stringify(said)).toMatch(/in the daily race as ada/)
  const plan = play(daySeed(dayOf(clock.now())), 40_000).g.log
  await ui.press({ key: 'play' })
  const started = clock.now()
  for (const [t, action] of plan) {
    const wait = started + t - clock.now()
    if (wait > 0) await clock.advance(wait)
    await ui.press({ key: action })
  }
  await clock.advance(20_000)
  expect(await alt()).toMatch(/over: .* #1 of 1 today/)
  expect(asked).toContain('POST /run')
  const scored = Number((await alt())?.match(/at (\d+) points/)?.[1])
  expect(scored).toBeGreaterThan(300)
  expect(replayed).toBe(scored)

  // The next run races that one as a ghost.
  await ui.press({ key: 'play' })
  expect(await svg()).toMatch(/class="ghost"/)
  expect(await svg()).toMatch(/ada 0/)
  expect(JSON.stringify(await $.command.run({ ...BUGDASH, args: 'top' }))).toMatch(/1\. ada/)

  // Left: runs stay here again.
  await $.command.run({ ...BUGDASH, args: 'leave' })
  const before = asked.length
  await clock.advance(15_000)
  expect(asked.length).toBe(before)
  await ui.unmount()
})

// Clawd's body spans these screen columns; a bot reads the course ahead of it.
const CLAWD_BACK = 114
const CLAWD_FRONT = 146

// Moves when the next obstacle is `leadMs` away.
function bot(g: Game, now: number, leadMs = 100) {
  const t = gameTime(g, now)
  const d = distAt(t)
  const next = g.things.find(x => x.done === undefined && x.kind !== 'token' && x.x - d + (x.kind === 'bug' ? 21 : 41) > CLAWD_BACK)
  if (next === undefined) return
  const gap = next.x - d + 3 - CLAWD_FRONT
  const lead = speedAt(t) * leadMs
  if (gap <= 0 || gap >= lead) return
  if (next.kind === 'bug' && g.air === null) act(g, 'jump', now)
  if (next.kind === 'fail' && t >= g.slideUntil) act(g, 'slide', now)
}

// Plays a run of `seed` for `ms`, noting the game time each obstacle is
// cleared. `jitter` wakes it at uneven times, as the engine's timers do, and
// `sloppy` spreads the bot's timing so it gets caught now and then.
function play(seed: number, ms: number, { jitter = 0, sloppy = 0 } = {}) {
  const g = newGame()
  g.seed = seed
  act(g, 'jump', 0)
  let r = seed
  const rand = () => (r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296
  const cleared = new Map<number, number>()
  for (let now = 0; now < ms && g.mode === 'running'; now += 10 + Math.floor(rand() * jitter)) {
    advance(g, now)
    bot(g, now, 100 + (rand() - 0.5) * sloppy)
    for (const thing of g.things) if (thing.done === 'passed' && !cleared.has(thing.id)) cleared.set(thing.id, gameTime(g, now))
  }
  return { g, cleared: [...cleared.values()] }
}

test('a run plays again exactly from its seed and its moves, however unevenly it was woken', () => {
  let caught = 0
  for (const seed of [3, 1_234, 77_777, daySeed('2026-10-27')]) {
    const { g } = play(seed, 300_000, { jitter: 37, sloppy: 300 })
    if (g.mode === 'over') caught++
    expect(g.log.length).toBeGreaterThan(40)
    const again = replay(seed, g.log, g.mode === 'over' ? 3_600_000 : g.simAt)
    expect([again.mode, again.score, again.simAt, again.level]).toEqual([g.mode, g.score, g.simAt, g.level])
  }
  expect(caught).toBeGreaterThan(0)
})

test('a resume counts 3, 2, 1 with the world still, and buys no safety', () => {
  const seed = daySeed('2026-10-27')
  // Nobody presses anything: the first bug catches Clawd at game time `at`.
  const idle = newGame()
  idle.seed = seed
  act(idle, 'jump', 0)
  for (let now = 0; idle.mode === 'running'; now += 10) advance(idle, now)
  const at = idle.gameAt

  // The same, paused just before it and resumed.
  const g = newGame()
  g.seed = seed
  act(g, 'jump', 0)
  advance(g, at - 30)
  act(g, 'pause', at - 30)
  act(g, 'jump', 50_000)
  expect(nextWake(g, 50_000)).toBe(1201)
  expect(gameTime(g, 51_000)).toBe(gameTime(g, 50_000))
  expect(act(g, 'jump', 51_000)).toBe(false)
  for (let now = 51_200; g.mode === 'running'; now += 10) advance(g, now)
  expect([g.mode, g.gameAt, g.score]).toEqual(['over', at, idle.score])
})

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
