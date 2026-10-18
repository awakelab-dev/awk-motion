/**
 * Port a TypeScript de referencia/scripts/sfx.py: sintetiza SFX (sin samples externos,
 * sin música ni voz) y los coloca en los tiempos indicados.
 */
import { writeFile } from 'node:fs/promises';
import type { SfxName } from '@wilox/styles';

export const SR = 48000;

// ---------- RNG determinista (mulberry32 + Box-Muller) ----------
export class Rng {
  private s: number;
  private spare: number | null = null;
  constructor(seed = 7) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
  noise(n: number): Float64Array {
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = this.normal();
    return x;
  }
}

// ---------- utilidades DSP ----------
const zeros = (n: number) => new Float64Array(n);

function onepoleLp(x: Float64Array, fc: number | Float64Array): Float64Array {
  const y = zeros(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const f = typeof fc === 'number' ? fc : fc[i];
    const a = Math.exp((-2 * Math.PI * f) / SR);
    s = (1 - a) * x[i] + a * s;
    y[i] = s;
  }
  return y;
}

function envAd(n: number, a: number, d: number): Float64Array {
  const e = zeros(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    e[i] = Math.min(t / Math.max(a, 1e-4), 1) * Math.exp(-Math.max(t - a, 0) / d);
  }
  return e;
}

/** Oscilador con frecuencia variable: sin(2π·cumsum(f)/SR). */
function chirp(f: Float64Array): Float64Array {
  const y = zeros(f.length);
  let ph = 0;
  for (let i = 0; i < f.length; i++) {
    ph += f[i];
    y[i] = Math.sin((2 * Math.PI * ph) / SR);
  }
  return y;
}

// FFT radix-2 in-place (re, im)
function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      const half = len >> 1;
      for (let k = 0; k < half; k++) {
        const ar = re[i + k + half] * cr - im[i + k + half] * ci;
        const ai = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k + half] = re[i + k] - ar;
        im[i + k + half] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function convolve(x: Float64Array, h: Float64Array): Float64Array {
  const L = x.length + h.length;
  let n = 1;
  while (n < L) n <<= 1;
  const ar = zeros(n);
  const ai = zeros(n);
  const br = zeros(n);
  const bi = zeros(n);
  ar.set(x);
  br.set(h);
  fft(ar, ai);
  fft(br, bi);
  for (let i = 0; i < n; i++) {
    const r = ar[i] * br[i] - ai[i] * bi[i];
    const im = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  return ar.subarray(0, L);
}

function reverb(rng: Rng, x: Float64Array, secs = 1.2, mix = 0.25): Float64Array {
  const n = Math.floor(secs * SR);
  const ir = rng.noise(n);
  let e = 0;
  for (let i = 0; i < n; i++) {
    ir[i] *= Math.exp(-i / SR / (secs / 5));
    e += ir[i] * ir[i];
  }
  const norm = Math.sqrt(e);
  for (let i = 0; i < n; i++) ir[i] /= norm;
  const wet = convolve(x, ir);
  const out = zeros(x.length + n);
  for (let i = 0; i < x.length; i++) out[i] += x[i] * (1 - mix);
  for (let i = 0; i < out.length && i < wet.length; i++) out[i] += wet[i] * mix;
  return out;
}

// ---------- generadores ----------
function makeGenerators(rng: Rng) {
  const riser = (d = 0.6) => {
    const n = Math.floor(d * SR);
    const f = zeros(n);
    for (let i = 0; i < n; i++) f[i] = 200 * Math.pow(2400 / 200, i / SR / d);
    const s = chirp(f);
    const f2 = f.map((v) => v * 2);
    const nz = onepoleLp(rng.noise(n), f2);
    const y = zeros(n);
    for (let i = 0; i < n; i++) y[i] = (s[i] * 0.3 + nz[i] * 0.5) * Math.pow(i / SR / d, 2);
    return y;
  };
  const whoosh = (d = 0.7, f0 = 300, f1 = 5000) => {
    const n = Math.floor(d * SR);
    const fc = zeros(n);
    for (let i = 0; i < n; i++) fc[i] = f0 * Math.pow(f1 / f0, Math.sin((Math.PI * i) / Math.max(1, n - 1)));
    const a = onepoleLp(rng.noise(n), fc);
    const b = onepoleLp(rng.noise(n), fc.map((v) => v * 0.25));
    const y = zeros(n);
    for (let i = 0; i < n; i++) y[i] = (a[i] - b[i] * 0.5) * Math.pow(Math.sin((Math.PI * i) / Math.max(1, n - 1)), 2) * 0.9;
    return y;
  };
  const ping = (base = 2093) => {
    const n = Math.floor(1.6 * SR);
    const x = zeros(n);
    const partials: [number, number][] = [
      [1, 1],
      [1.5, 0.5],
      [2.76, 0.35],
      [4.1, 0.2],
    ];
    partials.forEach(([m, a], k) => {
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        x[i] += a * Math.sin(2 * Math.PI * base * m * t + k) * Math.exp(-t / (0.5 / m));
      }
    });
    const e = envAd(n, 0.002, 10);
    for (let i = 0; i < n; i++) x[i] *= e[i] * 0.35;
    return x;
  };
  const sweep = () => {
    const w = whoosh(0.6, 800, 9000);
    const r = riser(0.6);
    const y = zeros(Math.max(w.length, r.length));
    for (let i = 0; i < y.length; i++) y[i] = (w[i] ?? 0) * 0.6 + (r[i] ?? 0) * 0.3;
    return y;
  };
  const impact = () => {
    const n = Math.floor(1.4 * SR);
    const f = zeros(n);
    for (let i = 0; i < n; i++) f[i] = 40 + 90 * Math.exp(-i / SR / 0.08);
    const boom = chirp(f);
    const y = zeros(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      y[i] = (boom[i] * Math.exp(-t / 0.35) + rng.normal() * Math.exp(-t / 0.012) * 0.5) * 0.9;
    }
    return y;
  };
  const pulse = () => {
    const n = Math.floor(0.5 * SR);
    const p = ping(3136);
    const y = zeros(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      y[i] = Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t / 0.12) * 0.6 + p[i] * 0.4;
    }
    return y;
  };
  const shatter = () => {
    const n = Math.floor(1.5 * SR);
    const x = zeros(n);
    const burst = Math.floor(0.02 * SR);
    for (let i = 0; i < burst; i++) x[i] += rng.normal() * 0.8;
    for (let k = 0; k < 60; k++) {
      const s = Math.floor(rng.uniform(0, 0.9) * SR);
      const p = ping(rng.uniform(2500, 7000));
      const g = rng.uniform(0.1, 0.4);
      for (let i = 0; i < p.length && s + i < n; i++) x[s + i] += p[i] * g;
    }
    const hp = rng.noise(n);
    const lp = onepoleLp(rng.noise(n), 3000);
    for (let i = 0; i < n; i++) x[i] += (hp[i] - lp[i]) * Math.exp(-i / SR / 0.15) * 0.4;
    return x;
  };
  const sparkle = () => {
    const n = Math.floor(1.2 * SR);
    const x = zeros(n);
    for (let k = 0; k < 14; k++) {
      const s = Math.floor(rng.uniform(0, 0.8) * SR);
      const p = ping(rng.uniform(4000, 8000));
      for (let i = 0; i < p.length && s + i < n; i++) x[s + i] += p[i] * 0.25;
    }
    return x;
  };
  const pop = () => {
    const n = Math.floor(0.12 * SR);
    const f = zeros(n);
    for (let i = 0; i < n; i++) f[i] = 200 + 900 * Math.exp(-i / SR / 0.02);
    const s = chirp(f);
    for (let i = 0; i < n; i++) s[i] *= Math.exp(-i / SR / 0.035) * 0.8;
    return s;
  };
  const bubble = () => {
    const n = Math.floor(0.6 * SR);
    const x = zeros(n);
    for (let k = 0; k < 6; k++) {
      const s0 = Math.floor(k * 0.07 * SR);
      const p = pop();
      const len = Math.min(p.length, n - s0);
      for (let i = 0; i < len; i++) {
        x[s0 + i] += p[i] * (0.9 - k * 0.1) * Math.sin((i / Math.max(1, len - 1)) * 3 + k);
      }
    }
    return x.map((v) => v * 0.6);
  };
  const tick = () => {
    const n = Math.floor(0.03 * SR);
    const y = zeros(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      y[i] = Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t / 0.006) * 0.5;
    }
    return y;
  };
  const air = (d: number) => onepoleLp(rng.noise(Math.floor(d * SR)), 600).map((v) => v * 0.05);
  const gens: Record<SfxName, () => Float64Array> = {
    pop,
    bubble,
    tick,
    sweep,
    whoosh: () => whoosh(),
    impact,
    ping: () => ping(),
    riser: () => riser(),
    shatter,
    sparkle,
    pulse,
  };
  return { gens, air };
}

export interface SfxEvent {
  name: SfxName;
  t: number;
}

/** Sintetiza la pista estéreo de SFX de `durSec` segundos y la escribe como WAV 16 bits. */
export async function renderSfx(events: SfxEvent[], durSec: number, outWav: string, seed = 7): Promise<string[]> {
  const rng = new Rng(seed);
  const { gens, air } = makeGenerators(rng);
  const total = Math.floor(durSec * SR);
  const n = total + SR * 3;
  const L = zeros(n);
  const R = zeros(n);
  const bed = air(durSec);
  for (let i = 0; i < bed.length; i++) {
    L[i] += bed[i];
    R[i] += bed[bed.length - 1 - i];
  }
  const log: string[] = [];
  for (const ev of events) {
    const s = gens[ev.name]();
    let t = ev.t;
    // whoosh/sweep/riser se anticipan para que su pico caiga en el evento
    if (ev.name === 'whoosh' || ev.name === 'sweep' || ev.name === 'riser') t = Math.max(0, t - (s.length / SR) * 0.6);
    const k = Math.floor(t * SR);
    const pan = rng.uniform(-0.4, 0.4);
    for (let i = 0; i < s.length && k + i < n; i++) {
      L[k + i] += s[i] * (1 - pan);
      R[k + i] += s[i] * (1 + pan);
    }
    log.push(`${ev.name}@${t.toFixed(2)}`);
  }
  const l = reverb(rng, L, 1.4, 0.22).subarray(0, total);
  const r = reverb(rng, R, 1.4, 0.22).subarray(0, total);
  const fade = Math.floor(0.15 * SR);
  for (let i = 0; i < fade && i < total; i++) {
    const g = 1 - i / fade;
    l[total - fade + i] *= g;
    r[total - fade + i] *= g;
  }
  let peak = 1e-6;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i]));
  const gain = 0.7 / peak; // pico ≈ -3 dBFS
  await writeFile(outWav, encodeWav16(l, r, gain));
  return log;
}

function encodeWav16(l: Float64Array, r: Float64Array, gain: number): Buffer {
  const n = l.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 4, 40);
  const clamp = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * gain * 32767)));
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(clamp(l[i]), 44 + i * 4);
    buf.writeInt16LE(clamp(r[i]), 46 + i * 4);
  }
  return buf;
}

/**
 * Elige eventos automáticamente a partir de los picos de movimiento (antes se hacía a mano):
 * un sonido de arranque, el pico más fuerte con `hit` y el resto con los acentos del estilo.
 */
export function planSfx(
  peaks: { t: number; v: number }[],
  durSec: number,
  profile: { opener: SfxName; accents: SfxName[]; hit: SfxName },
): SfxEvent[] {
  const lo = 0.25;
  const hi = durSec - 0.6;
  const inRange = peaks.filter((p) => p.t >= lo && p.t <= hi).sort((a, b) => b.v - a.v);
  const chosen: { t: number; v: number }[] = [];
  for (const p of inRange) {
    if (chosen.length >= 6) break;
    if (chosen.every((c) => Math.abs(c.t - p.t) >= 0.35)) chosen.push(p);
  }
  // Mínimo 4 acentos: se rellenan los huecos más grandes de la zona de construcción (0,8–3,8 s).
  for (const t of [1.0, 2.2, 3.4, 1.6, 2.8]) {
    if (chosen.length >= 4) break;
    if (t <= hi && chosen.every((c) => Math.abs(c.t - t) >= 0.5)) chosen.push({ t, v: 0.5 });
  }
  const strongest = chosen.reduce((a, b) => (b.v > a.v ? b : a), chosen[0]);
  const byTime = [...chosen].sort((a, b) => a.t - b.t);
  const events: SfxEvent[] = [{ name: profile.opener, t: Math.max(0.35, Math.min(byTime[0]?.t ?? 0.5, 0.8)) }];
  let k = 0;
  for (const p of byTime) {
    if (p === strongest) events.push({ name: profile.hit, t: p.t });
    else events.push({ name: profile.accents[k++ % profile.accents.length], t: p.t });
  }
  return events;
}
