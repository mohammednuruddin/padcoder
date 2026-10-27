// The daily race online: what goes to the race server and how its answers
// are read. A name to race under, today's board and ghosts, and each run sent
// when Clawd is caught, for the server to play again and rank.

import { RULES_VERSION, type GhostRun, type Move, type Race } from './scene'

// The race server, server/ in this repository; empty turns the race off.
export const SERVER = 'https://bug-dash.nurusterling.workers.dev'

export type Player = { readonly name: string; readonly token: string }
export type Board = Omit<Race, 'sent'> & { readonly ghosts: readonly GhostRun[] }
export type Sent = Exclude<Race['sent'], undefined>
export type Answer = { readonly status: number; readonly text: string }

export const asked = (body?: unknown) =>
  body === undefined ? { method: 'GET' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }

export const boardPath = (day: string, name?: string) => `/day/${day}${name === undefined ? '' : `?name=${encodeURIComponent(name)}`}`
export const runBody = (player: Player, day: string, moves: readonly Move[], score: number) => ({ day, rules: RULES_VERSION, name: player.name, token: player.token, moves, score })

function fields(answer: Answer): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(answer.text)
    if (typeof data === 'object' && data !== null) return data as Record<string, unknown>
  } catch {}
  return {}
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const isMoves = (v: unknown): v is Move[] =>
  Array.isArray(v) && v.every(m => Array.isArray(m) && isNumber(m[0]) && (m[1] === 'jump' || m[1] === 'slide' || m[1] === 'dash'))

// The player a join made, or why not.
export function joined(answer: Answer | undefined): Player | string {
  if (answer === undefined) return "Couldn't reach the race."
  const data = fields(answer)
  if (answer.status === 201 && isText(data.name) && isText(data.token)) return { name: data.name, token: data.token }
  return isText(data.error) ? data.error : `The race answered ${answer.status}.`
}

// A day's board, with the ghosts to race; undefined when there is none to read.
export function boardOf(answer: Answer | undefined): Board | undefined {
  if (answer === undefined || answer.status !== 200) return undefined
  const data = fields(answer)
  if (data.rules !== RULES_VERSION || !Array.isArray(data.top) || !Array.isArray(data.ghosts)) return undefined
  const rows = data.top as Record<string, unknown>[]
  const top = rows.filter(r => isText(r?.name) && isNumber(r?.score)).map(r => ({ name: r.name as string, score: r.score as number }))
  const runs = data.ghosts as Record<string, unknown>[]
  const ghosts = runs
    .filter(r => isText(r?.name) && isNumber(r?.score) && isMoves(r?.moves))
    .map(r => ({ name: r.name as string, score: r.score as number, moves: r.moves as Move[] }))
  const you = data.you as Record<string, unknown> | undefined
  return {
    top,
    total: isNumber(data.total) ? data.total : top.length,
    you: isNumber(you?.rank) && isNumber(you?.score) ? { rank: you.rank, score: you.score } : undefined,
    ghosts,
  }
}

// Where a run sent put the player.
export function sentOf(answer: Answer | undefined): Sent {
  if (answer === undefined || answer.status !== 200) return 'failed'
  const data = fields(answer)
  return isNumber(data.rank) && isNumber(data.total) && isNumber(data.best) ? { rank: data.rank, total: data.total, best: data.best } : 'failed'
}
