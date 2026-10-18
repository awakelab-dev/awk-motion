#!/usr/bin/env python3
"""Sintetiza SFX (sin música ni voz) para un clip y los sincroniza con los picos de movimiento.
uso: sfx.py video.mp4 salida.wav 'evento@t,evento@t,...'
eventos: sweep, whoosh, impact, ping, riser, shatter, sparkle, pulse, air
"""
import sys, subprocess, json, numpy as np
SR = 48000
rng = np.random.default_rng(7)

def env_ad(n, a, d):
    t = np.arange(n) / SR
    e = np.minimum(t / max(a, 1e-4), 1.0) * np.exp(-np.maximum(t - a, 0) / d)
    return e

def onepole_lp(x, fc):
    fc = np.broadcast_to(fc, x.shape)
    a = np.exp(-2 * np.pi * fc / SR)
    y = np.zeros_like(x); s = 0.0
    for i in range(len(x)):
        s = (1 - a[i]) * x[i] + a[i] * s; y[i] = s
    return y

def reverb(x, secs=1.2, mix=0.25):
    n = int(secs * SR)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR / (secs / 5))
    ir /= np.sqrt(np.sum(ir ** 2))
    L = len(x) + n
    wet = np.fft.irfft(np.fft.rfft(x, L) * np.fft.rfft(ir, L), L)[:len(x) + n]
    out = np.zeros(len(x) + n); out[:len(x)] += x * (1 - mix); out += wet * mix
    return out

def whoosh(d=0.7, f0=300, f1=5000):
    n = int(d * SR); t = np.linspace(0, 1, n)
    fc = f0 * (f1 / f0) ** np.sin(np.pi * t)
    x = onepole_lp(rng.standard_normal(n), fc) - onepole_lp(rng.standard_normal(n), fc * 0.25) * 0.5
    return x * np.sin(np.pi * t) ** 2 * 0.9

def sweep():  # barrido de luz
    return whoosh(0.6, 800, 9000) * 0.6 + riser(0.6) * 0.3

def riser(d=0.6):
    n = int(d * SR); t = np.arange(n) / SR
    f = 200 * (2400 / 200) ** (t / d)
    s = np.sin(2 * np.pi * np.cumsum(f) / SR) * 0.3 + onepole_lp(rng.standard_normal(n), f * 2) * 0.5
    return s * (t / d) ** 2

def impact():
    n = int(1.4 * SR); t = np.arange(n) / SR
    f = 40 + 90 * np.exp(-t / 0.08)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.35)
    click = rng.standard_normal(n) * np.exp(-t / 0.012) * 0.5
    return (boom + click) * 0.9

def ping(base=2093):
    n = int(1.6 * SR); t = np.arange(n) / SR; x = np.zeros(n)
    for k, (m, a) in enumerate([(1, 1), (1.5, 0.5), (2.76, 0.35), (4.1, 0.2)]):
        x += a * np.sin(2 * np.pi * base * m * t + k) * np.exp(-t / (0.5 / m))
    return x * env_ad(n, 0.002, 10) * 0.35

def pulse():
    n = int(0.5 * SR); t = np.arange(n) / SR
    return np.sin(2 * np.pi * 70 * t) * np.exp(-t / 0.12) * 0.6 + ping(3136) [:n] * 0.4

def shatter():
    n = int(1.5 * SR); x = np.zeros(n)
    x[:int(0.02*SR)] += rng.standard_normal(int(0.02*SR)) * 0.8
    for _ in range(60):
        s = int(rng.uniform(0, 0.9) * SR); p = ping(rng.uniform(2500, 7000))[:n - s]
        x[s:s + len(p)] += p * rng.uniform(0.1, 0.4)
    hp = rng.standard_normal(n) - onepole_lp(rng.standard_normal(n), 3000)
    return x + hp * np.exp(-np.arange(n) / SR / 0.15) * 0.4

def sparkle():
    n = int(1.2 * SR); x = np.zeros(n)
    for _ in range(14):
        s = int(rng.uniform(0, 0.8) * SR); p = ping(rng.uniform(4000, 8000))[:n - s]
        x[s:s + len(p)] += p * 0.25
    return x

def air(d):  # cama muy suave de aire/partículas
    n = int(d * SR)
    return onepole_lp(rng.standard_normal(n), np.full(n, 600.0)) * 0.05

def pop():
    n = int(0.12 * SR); t = np.arange(n) / SR
    f = 200 + 900 * np.exp(-t / 0.02)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.035) * 0.8

def bubble():
    n = int(0.6 * SR); x = np.zeros(n)
    for k in range(6):
        s0 = int(k * 0.07 * SR); p_ = pop()[:n - s0] * (0.9 - k * 0.1)
        x[s0:s0 + len(p_)] += p_ * np.sin(np.linspace(0, 1, len(p_)) * 3 + k)
    return x * 0.6

def tick():
    n = int(0.03 * SR); t = np.arange(n) / SR
    return np.sin(2 * np.pi * 2400 * t) * np.exp(-t / 0.006) * 0.5

GEN = dict(pop=pop, bubble=bubble, tick=tick, sweep=sweep, whoosh=whoosh, impact=impact, ping=ping, riser=riser,
           shatter=shatter, sparkle=sparkle, pulse=pulse)

def motion_curve(video):
    w, h = 160, 90
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', video, '-vf', f'scale={w}:{h},format=gray',
                          '-f', 'rawvideo', '-'], capture_output=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(np.float32)
    fps = float(eval(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v', '-show_entries',
                    'stream=r_frame_rate', '-of', 'csv=p=0', video], capture_output=True, text=True).stdout.strip()))
    d = np.r_[0, np.abs(np.diff(fr, axis=0)).mean(axis=(1, 2))]
    return d, fps

def main():
    video, out, spec = sys.argv[1], sys.argv[2], sys.argv[3]
    dur = float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
                                video], capture_output=True, text=True).stdout)
    d, fps = motion_curve(video)
    n = int(dur * SR) + SR * 3
    L = np.zeros(n); R = np.zeros(n)
    L[:int(dur*SR)] += air(dur); R[:int(dur*SR)] += air(dur)[::-1]
    log = []
    for item in spec.split(','):
        name, t = item.split('@'); t = float(t)
        # alinear con el pico de movimiento más cercano (±0.4 s) para impactos/pings
        if False:
            i0, i1 = max(0, int((t - .4) * fps)), min(len(d) - 1, int((t + .4) * fps))
            if i1 > i0:
                t = (i0 + int(np.argmax(d[i0:i1 + 1]))) / fps
        s = GEN[name]()
        if name in ('whoosh', 'sweep', 'riser'):
            t = max(0.0, t - len(s) / SR * 0.6)  # el whoosh culmina en el evento
        k = int(t * SR); pan = rng.uniform(-0.4, 0.4)
        L[k:k + len(s)] += s[:n - k] * (1 - pan); R[k:k + len(s)] += s[:n - k] * (1 + pan)
        log.append(f'{name}@{t:.2f}')
    st = np.stack([reverb(L, 1.4, 0.22), reverb(R, 1.4, 0.22)], 1)[:int(dur * SR)]
    fade = int(0.15 * SR); st[-fade:] *= np.linspace(1, 0, fade)[:, None]
    st *= 0.7 / max(1e-6, np.abs(st).max())  # pico -3 dBFS aprox
    import wave
    with wave.open(out, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype('<i2').tobytes())
    print('eventos:', ' '.join(log))

main()
