// Synthesizes Bug Dash's chiptune effects as 16-bit mono WAVs:
// node tools/make-sounds.mjs mods/bug-dash/sounds
import { mkdirSync, writeFileSync } from 'node:fs'

const RATE = 22050
const out = process.argv[2]
mkdirSync(out, { recursive: true })

let seed = 7
const noise = () => {
  seed = (seed * 1103515245 + 12345) >>> 0
  return (seed / 4294967296) * 2 - 1
}

// One voice: a pulse, triangle or noise, its pitch sliding from f0 to f1
// along an exponential curve, under an attack/release envelope.
function voice({ ms, f0 = 440, f1 = f0, wave = 'pulse', duty = 0.5, vol = 0.5, attack = 4, release = 40, vib = 0, cutoff = 1 }) {
  const n = Math.round((ms / 1000) * RATE)
  const buf = new Float32Array(n)
  let phase = 0
  let low = 0
  for (let i = 0; i < n; i++) {
    const t = i / n
    const f = f0 * Math.pow(f1 / f0, t) * (1 + vib * Math.sin(2 * Math.PI * 9 * (i / RATE)))
    phase = (phase + f / RATE) % 1
    let s
    if (wave === 'pulse') s = phase < duty ? 1 : -1
    else if (wave === 'tri') s = 4 * Math.abs(phase - 0.5) - 1
    else {
      low += cutoff * (noise() - low)
      s = low * 1.6
    }
    const ms_ = (i / RATE) * 1000
    const env = Math.min(1, ms_ / attack) * Math.min(1, (ms - ms_) / release)
    buf[i] = s * vol * env
  }
  return buf
}

const mix = (...parts) => {
  const n = Math.max(...parts.map(([at, b]) => Math.round((at / 1000) * RATE) + b.length))
  const buf = new Float32Array(n)
  for (const [at, b] of parts) {
    const o = Math.round((at / 1000) * RATE)
    b.forEach((v, i) => (buf[o + i] += v))
  }
  return buf
}

function wav(name, buf) {
  const data = Buffer.alloc(buf.length * 2)
  buf.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32000), i * 2))
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(RATE, 24)
  head.writeUInt32LE(RATE * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  writeFileSync(`${out}/${name}.wav`, Buffer.concat([head, data]))
}

const note = (midi) => 440 * Math.pow(2, (midi - 69) / 12)

wav('jump', voice({ ms: 120, f0: 260, f1: 640, duty: 0.25, vol: 0.4, release: 60 }))
wav('double', voice({ ms: 100, f0: 540, f1: 1040, duty: 0.125, vol: 0.35, release: 50 }))
wav('slide', mix([0, voice({ ms: 150, wave: 'noise', cutoff: 0.08, vol: 0.5, release: 90 })], [0, voice({ ms: 120, f0: 330, f1: 170, duty: 0.5, vol: 0.18, release: 70 })]))
wav('dash', mix([0, voice({ ms: 220, wave: 'noise', cutoff: 0.35, vol: 0.4, release: 140 })], [0, voice({ ms: 200, f0: 180, f1: 920, duty: 0.25, vol: 0.25, release: 90 })]))
wav('token', mix([0, voice({ ms: 60, f0: note(83), duty: 0.5, vol: 0.3, release: 10 })], [55, voice({ ms: 200, f0: note(88), duty: 0.5, vol: 0.3, release: 170 })]))
wav('smash', mix([0, voice({ ms: 140, wave: 'noise', cutoff: 0.6, vol: 0.5, release: 110 })], [0, voice({ ms: 120, f0: 140, f1: 55, duty: 0.5, vol: 0.35, release: 80 })]))
wav('level', mix(...[72, 76, 79, 84].map((m, i) => [i * 70, voice({ ms: i === 3 ? 260 : 80, f0: note(m), duty: 0.25, vol: 0.28, release: i === 3 ? 200 : 20 })])))
wav('caught', mix([0, voice({ ms: 560, f0: 560, f1: 80, duty: 0.5, vol: 0.32, release: 160, vib: 0.03 })], [480, voice({ ms: 160, wave: 'noise', cutoff: 0.05, vol: 0.5, release: 140 })]))
wav('count', mix(...[0, 400, 800].map(at => [at, voice({ ms: 90, f0: note(81), duty: 0.5, vol: 0.25, release: 40 })]), [1200, voice({ ms: 220, f0: note(93), duty: 0.25, vol: 0.28, release: 160 })]))
wav('start', mix(...[67, 72, 79].map((m, i) => [i * 60, voice({ ms: i === 2 ? 180 : 70, f0: note(m), duty: 0.25, vol: 0.26, release: i === 2 ? 140 : 20 })])))
console.log('wrote', out)
