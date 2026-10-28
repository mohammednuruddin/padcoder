import { expect, mock, test } from 'claude-code/testing'
import { sentOf } from '../hooks/race'
import { LIMIT_MS, RULES_VERSION, act, advance, dayOf, daySeed, distAt, gameTime, gateHeight, multiplier, newGame, nextWake, replay, setGhosts, speedAt, type Game, type Move } from '../hooks/scene'

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

test('sound: a start, each move, the count after a resume, getting caught, and Mute', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'bugdash' } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core" />
  })
  mock.store(on)
  const clock = mock.clock(on)
  const heard: string[] = []
  on('audio.play', (_, e) => {
    heard.push(e.clip.asset?.replace(/^sounds\/|\.wav$/g, '') ?? '')
    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await $.command.run(BUGDASH)

  await ui.press({ key: 'play' })
  await clock.advance(200)
  await ui.press({ key: 'jump' })
  await clock.advance(150)
  await ui.press({ key: 'jump' })
  await clock.advance(800)
  await ui.press({ key: 'slide' })
  await ui.press({ key: 'dash' })
  await ui.press({ key: 'pause' })
  await ui.press({ key: 'play' })
  await clock.advance(30_000)
  expect(heard.slice(0, 6)).toEqual(['start', 'jump', 'double', 'slide', 'dash', 'count'])
  expect(heard).toContain('caught')

  heard.length = 0
  await ui.press({ key: 'sound' })
  await ui.press({ key: 'play' })
  await clock.advance(200)
  await ui.press({ key: 'jump' })
  expect(heard).toEqual([])
  await ui.unmount()
})

test("with another session's band owning the sound, the pad's moves stay quiet here; a press here takes it over; another's Mute holds here", async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'bugdash' } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core" />
  })
  // The store all sessions share, which the other session writes to here.
  const shared = new Map<string, unknown>([['soundOwner', { id: 'another-session', at: 0 }]])
  on('store.get', (_, e) => ({ value: shared.get(e.key) }))
  on('store.set', (_, e) => {
    shared.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    shared.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...shared.keys()] }))
  const clock = mock.clock(on)
  const heard: string[] = []
  on('audio.play', (_, e) => {
    heard.push(e.clip.asset?.replace(/^sounds\/|\.wav$/g, '') ?? '')
    return { value: undefined }
  })
  const lines: string[] = []
  let wakeListener = () => {}
  on('process.spawn', async function* () {
    for (;;) {
      for (let line = lines.shift(); line !== undefined; line = lines.shift()) {
        if (line === 'end') return { value: { code: 0, signal: null } }
        yield { stream: 'stdout' as const, text: `${line.startsWith('com.') ? line : `com.padcoder.game.${line}`}\n` }
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
  await pad('on')
  await pad('jump')
  await clock.advance(200)
  await pad('jump')
  expect(heard).toEqual([])
  await ui.press({ key: 'slide' })
  expect(heard).toEqual(['slide'])
  // Muted in another session, which posts it: quiet here too, and the band says so.
  shared.set('sound', false)
  await pad('com.padcoder.bugdash.sound')
  await ui.press({ key: 'slide' })
  expect(heard).toEqual(['slide'])
  expect(await ui.find({ type: 'Button', key: 'sound' })).toMatchObject({ props: { label: 'Unmute' } })
  await pad('end')
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
    if (path === '/medals/ada') return answer(200, { name: 'ada', gold: 0, silver: 1, copper: 2 })
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

  // Not joined: a whole run, and not a word to the server; no metal to wear.
  await $.command.run(BUGDASH)
  expect(JSON.stringify(await $.command.run({ ...BUGDASH, args: 'skin silver' }))).toMatch(/earned in the daily race: end a day in the top three/)
  // The ready card's hint names <name>, escaped so the drawing stays whole.
  expect(await svg()).toMatch(/join &#60;name&#62; to race/)
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
  // Caught without a single move: still a run, and sent.
  await ui.press({ key: 'play' })
  await clock.advance(15_000)
  expect(asked.filter(a => a === 'POST /run')).toHaveLength(1)
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

  // A day in the top three earns silver; gold waits for a win.
  const skins = JSON.stringify(await $.command.run({ ...BUGDASH, args: 'skin' }))
  expect(skins).toMatch(/clay: wearing.*copper: earned.*silver: earned.*gold: win a day/)
  expect(JSON.stringify(await $.command.run({ ...BUGDASH, args: 'skin gold' }))).toMatch(/earned in the daily race: win a day/)
  expect(JSON.stringify(await $.command.run({ ...BUGDASH, args: 'skin silver' }))).toMatch(/Clawd wears silver/)
  expect(await svg()).toMatch(/\.pc\{fill:#b4bec9\}/)

  // Left: runs stay here again, and the medals and skin go with the name.
  await $.command.run({ ...BUGDASH, args: 'leave' })
  expect(JSON.stringify(await $.command.run({ ...BUGDASH, args: 'skin' }))).toMatch(/clay: wearing.*silver: end a day in the top three/)
  const before = asked.length
  await clock.advance(15_000)
  expect(asked.length).toBe(before)
  await ui.unmount()
})

// Clawd's body spans these screen columns; a bot reads the course ahead of it.
const CLAWD_BACK = 114
const CLAWD_FRONT = 146

// What clears each obstacle, where its box ends, and how early the bot moves
// for it: a gate wants Clawd high as it passes.
const CLEARS: Readonly<Record<string, { readonly by: 'jump' | 'slide'; readonly r: number; readonly early: number }>> = {
  bug: { by: 'jump', r: 21, early: 0 },
  gate: { by: 'jump', r: 12, early: 50 },
  fail: { by: 'slide', r: 41, early: 0 },
  moth: { by: 'slide', r: 20, early: 0 },
}

// Moves when the next obstacle is `leadMs` away, never dashing.
function bot(g: Game, now: number, leadMs = 100) {
  const t = gameTime(g, now)
  const d = distAt(t)
  const next = g.things.find(x => x.done === undefined && CLEARS[x.kind] !== undefined && x.x - d + (CLEARS[x.kind]?.r ?? 0) > CLAWD_BACK)
  const clears = next && CLEARS[next.kind]
  if (next === undefined || clears === undefined) return
  const gap = next.x - d + 3 - CLAWD_FRONT
  const lead = speedAt(t) * (leadMs + clears.early)
  if (gap <= 0 || gap >= lead) return
  if (clears.by === 'jump' && g.air === null) act(g, 'jump', now)
  if (clears.by === 'slide' && t >= g.slideUntil) act(g, 'slide', now)
}

// Plays a run of `seed` for `ms`, noting the game time each obstacle is
// cleared, how each thing ended, and each kind met. `jitter` wakes it at
// uneven times, as the engine's timers do, and `sloppy` spreads the bot's
// timing so it gets caught now and then; an `idle` one presses nothing. `setUp`
// changes the run once it starts.
function play(seed: number, ms: number, { jitter = 0, sloppy = 0, idle = false, setUp = (_: Game) => {} } = {}) {
  const g = newGame()
  g.seed = seed
  act(g, 'jump', 0)
  setUp(g)
  let r = seed
  const rand = () => (r = (Math.imul(r, 1103515245) + 12345) >>> 0) / 4294967296
  const cleared = new Map<number, number>()
  const ended = new Map<number, string>()
  const kinds = new Set<string>()
  for (let now = 0; now < ms && g.mode === 'running'; now += 10 + Math.floor(rand() * jitter)) {
    advance(g, now)
    if (!idle) bot(g, now, 100 + (rand() - 0.5) * sloppy)
    for (const thing of g.things) {
      kinds.add(thing.kind)
      if (thing.done !== undefined && !ended.has(thing.id)) ended.set(thing.id, `${thing.kind} ${thing.done}`)
      if (thing.done === 'passed' && !cleared.has(thing.id)) cleared.set(thing.id, gameTime(g, now))
    }
  }
  return { g, cleared: [...cleared.values()], ended: [...ended.values()], kinds }
}

test('a run plays again exactly from its seed and its moves, however unevenly it was woken', () => {
  let caught = 0
  for (const seed of [3, 1_234, 77_777, daySeed('2026-10-27')]) {
    const { g } = play(seed, 300_000, { jitter: 37, sloppy: 300 })
    if (g.mode === 'over') caught++
    expect(g.log.length).toBeGreaterThan(20)
    const again = replay(seed, g.log, g.mode === 'over' ? 3_600_000 : g.simAt)
    expect([again.mode, again.score, again.simAt, again.level, again.log.length]).toEqual([g.mode, g.score, g.simAt, g.level, g.log.length])
  }
  expect(caught).toBeGreaterThan(0)
})

test("ghosts of another day's course wait for the next run", () => {
  const g = newGame()
  g.seed = daySeed('2026-10-27')
  act(g, 'jump', 0)
  const tomorrow = daySeed('2026-10-28')
  expect(setGhosts(g, tomorrow, [{ name: 'ada', score: 0, moves: [] }])).toBe(false)
  expect(g.ghosts).toHaveLength(0)
  expect(setGhosts(g, g.seed, [{ name: 'ada', score: 0, moves: [] }])).toBe(true)
  expect(g.ghosts).toHaveLength(1)
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

test('every stretch of the course, to the last level and past it, can be cleared by jumping bugs and gates and sliding under banners and moths', () => {
  for (const seed of [1, 7_331, 90_210]) {
    const { g, ended, kinds } = play(seed, 420_000)
    expect(g.mode).toBe('running')
    expect(g.level).toBeGreaterThan(40)
    expect([...kinds].sort()).toEqual(['bug', 'fail', 'gate', 'magnet', 'moth', 'shield', 'token'])
    // Cleared, not shielded: nothing was smashed, and every gate and moth passed.
    expect(ended.filter(e => e.endsWith('smashed'))).toEqual([])
    expect(ended.filter(e => e.startsWith('gate ') || e.startsWith('moth ')).every(e => e.endsWith('passed'))).toBe(true)
  }
})

test('a CI gate goes down and up in straight lines, the same on every lap', () => {
  expect([0, 400, 800, 1200, 1600, -400, 3200 + 200].map(t => gateHeight(0, t))).toEqual([8, 26, 44, 26, 8, 26, 17])
  expect(gateHeight(1_000, 1_000)).toBe(8)
})

test('a shield takes one hit for Clawd, and a magnet draws in tokens at any height', () => {
  // Shielded and idle: the first obstacle is blocked, and the next one catches Clawd.
  const { g: idle, ended } = play(5, 60_000, { idle: true, setUp: g => (g.shield = true) })
  expect(idle.mode).toBe('over')
  expect(ended.filter(e => e.endsWith('smashed'))).toHaveLength(1)
  expect(idle.shield).toBe(false)

  // With a magnet the whole way, no token is missed.
  const { ended: drawn } = play(5, 60_000, { setUp: g => (g.magnetUntil = Infinity) })
  expect(drawn.filter(e => e === 'token taken').length).toBeGreaterThan(10)
  expect(drawn.filter(e => e === 'token missed')).toEqual([])
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

test("a run the race turns away says why, not that the race couldn't be reached", () => {
  expect(sentOf({ status: 409, text: JSON.stringify({ error: 'This Bug Dash is out of date: update it to race online.' }) })).toEqual({ refused: 'This Bug Dash is out of date: update it to race online.' })
  expect(sentOf({ status: 503, text: 'busy' })).toBe('failed')
  expect(sentOf(undefined)).toBe('failed')
})

test('a magnet running out redraws the run, so its icon leaves the HUD', () => {
  const run = (magnetUntil: number) => {
    const g = newGame()
    g.seed = 9
    act(g, 'jump', 0)
    g.magnetUntil = magnetUntil
    advance(g, 200)
    return advance(g, 300)
  }
  expect(run(0)).toBe('none')
  expect(run(250)).toBe('changed')
})

test('a room: join it, start a race for everyone, see a rival run from the batches they send, and the standings; the daily race hears nothing', { timeoutMs: 15_000 }, async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'bugdash' } }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="core" />
  })
  // Joined the daily race too, to be sure a room race never goes to it.
  mock.store(on, { player: { name: 'ada', token: 't0k3n' } })
  mock.env(on, { BUG_DASH_SERVER: 'http://race.test' })
  const clock = mock.clock(on)
  const asked: string[] = []
  const said: Record<string, unknown>[] = []
  on('http.fetch', (_, e) => {
    const path = e.url.replace('http://race.test', '')
    asked.push(`${e.init?.method ?? 'GET'} ${path.split('?')[0]}`)
    if (path.startsWith('/rooms/')) said.push(JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>)
    const answer = (status: number, value: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(value) } })
    if (path.startsWith('/day/')) return answer(200, { rules: RULES_VERSION, total: 0, top: [], ghosts: [] })
    if (path.startsWith('/medals/')) return answer(200, { name: 'ada', gold: 0, silver: 0, copper: 0 })
    return answer(204, {})
  })
  // The room's stream, through curl; notifyutil has nothing to say here.
  const heard: string[] = []
  let wakeStream = () => {}
  let listened: readonly string[] = []
  on('process.spawn', async function* (_, e) {
    if (!e.argv[0]?.endsWith('curl')) return { value: { code: 0, signal: null } }
    listened = e.argv
    for (;;) {
      for (let line = heard.shift(); line !== undefined; line = heard.shift()) yield { stream: 'stdout' as const, text: `data: ${line}\n\n` }
      await new Promise<void>(resolve => (wakeStream = resolve))
    }
  })
  const room = async (event: unknown) => {
    heard.push(JSON.stringify(event))
    wakeStream()
    await clock.advance(1)
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const alt = async () => (await ui.find({ type: 'Svg' }))?.props.alt as string | undefined
  const svg = async () => (await ui.find({ type: 'Svg' }))?.props.source as string | undefined

  expect(JSON.stringify(await $.command.run({ ...BUGDASH, args: 'room k7qxm' }))).toMatch(/in room K7QXM as ada/)
  expect(listened.at(-1)).toMatch(/\/rooms\/K7QXM\/listen\?name=ada&rules=2$/)
  await room({ kind: 'hello', secret: 's3cr3t', now: clock.now(), members: ['ada', 'bo'] })
  expect(await alt()).toMatch(/ready.*Room K7QXM, in, with bo/)

  // ✕ asks the room to start; the room starts everyone 3 s from now.
  await ui.press({ key: 'play' })
  expect(said.at(-1)).toMatchObject({ name: 'ada', secret: 's3cr3t', kind: 'start' })
  const seed = 4_242
  await room({ kind: 'start', race: 1, seed, at: clock.now() + 3000, names: ['ada', 'bo'] })
  expect(await svg()).toMatch(/GET READY/)
  await clock.advance(3000)
  expect(await alt()).toMatch(/running/)

  // bo's run, as the room relays it: two batches, the second overlapping the first.
  // bo plays 8 s, then stops pressing and is caught.
  const bo = play(seed, 8_000)
  for (let now = 8_000; bo.g.mode === 'running'; now += 10) advance(bo.g, now)
  const half = Math.floor(bo.g.log.length / 2)
  await room({ kind: 'run', name: 'bo', race: 1, run: { from: 0, moves: bo.g.log.slice(0, half), t: bo.g.log[half - 1]?.[0] ?? 0, wait: 0, paused: false, over: false } })
  expect(await svg()).toMatch(/hue-rotate\(150deg\)/)
  expect(await svg()).toMatch(/>bo \d+/)

  // Clawd, untouched, is caught: the room hears the whole run, and the daily race nothing.
  await clock.advance(30_000)
  expect(await alt()).toMatch(/over/)
  const last = said.filter(s => s.kind === 'run').at(-1)
  expect(last).toMatchObject({ race: 1, over: true })
  expect(asked).not.toContain('POST /run')

  // bo is caught too, after the overlap is skipped: bo wins, with bo's real score.
  const end = bo.g.mode === 'over' ? bo.g.gameAt : bo.g.simAt
  await room({ kind: 'run', name: 'bo', race: 1, run: { from: half - 2, moves: bo.g.log.slice(half - 2), t: end, wait: 0, paused: false, over: true } })
  await clock.advance(200)
  expect(bo.g.mode).toBe('over')
  expect(await alt()).toMatch(new RegExp(`Race: 1\\. bo ${bo.g.score} · 2\\. you \\d+\\.`))
  expect(await svg()).toMatch(/BO WINS/)

  expect(JSON.stringify(await $.command.run({ ...BUGDASH, args: 'room leave' }))).toMatch(/left room K7QXM/)
  await ui.unmount()
})
