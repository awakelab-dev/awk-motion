import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { DEFAULT_LOGO_SETTINGS } from '@wilox/shared';
import { playerHtml } from './player.js';
import { scormManifest, scormRuntime, type ScormVersion } from './scorm.js';

const items = [
  { id: 'a', title: 'Video 1 & <uno>', href: 'video01/index.html', files: ['video01/index.html', 'video01/video.mp4'] },
  { id: 'b', title: 'Video 2', href: 'video02/index.html', files: ['video02/index.html', 'video02/video.mp4'] },
];

/** LMS de prueba: guarda lo que el SCO escribe y simula un video que se reproduce. */
function lms(version: ScormVersion, initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial };
  const calls: string[] = [];
  const api =
    version === '1.2'
      ? {
          LMSInitialize: () => (calls.push('init'), 'true'),
          LMSGetValue: (k: string) => data[k] ?? '',
          LMSSetValue: (k: string, v: string) => ((data[k] = v), 'true'),
          LMSCommit: () => (calls.push('commit'), 'true'),
          LMSFinish: () => (calls.push('finish'), 'true'),
        }
      : {
          Initialize: () => (calls.push('init'), 'true'),
          GetValue: (k: string) => data[k] ?? '',
          SetValue: (k: string, v: string) => ((data[k] = v), 'true'),
          Commit: () => (calls.push('commit'), 'true'),
          Terminate: () => (calls.push('finish'), 'true'),
        };
  const listeners: Record<string, (() => void)[]> = {};
  const video = {
    duration: 100,
    currentTime: 0,
    paused: true,
    seeking: false,
    readyState: 1,
    addEventListener: (ev: string, f: () => void) => (listeners[ev] ??= []).push(f),
  };
  const win: Record<string, unknown> = {
    [version === '1.2' ? 'API' : 'API_1484_11']: api,
    addEventListener: (ev: string, f: () => void) => (listeners[ev] ??= []).push(f),
  };
  win.parent = win;
  runInNewContext(scormRuntime(version), { window: win, document: { getElementById: () => video }, setInterval: () => 0, Date, Math, String, parseFloat, isFinite });
  const fire = (ev: string) => listeners[ev]?.forEach((f) => f());
  /** Reproduce de a a b (segundos), en pasos de 0,5 s. */
  const watch = (a: number, b: number) => {
    video.paused = false;
    for (let t = a; t < b; t += 0.5) {
      video.currentTime = t;
      fire('timeupdate');
    }
    video.paused = true;
    fire('pause');
  };
  return { data, calls, video, fire, watch };
}

describe('SCORM 1.2 y 2004 (ADR-066)', () => {
  it('manifiesto 1.2: un SCO por video, con sus archivos y el título escapado', () => {
    const m = scormManifest('1.2', 'p1', 'Proyecto', items);
    expect(m).toContain('<schemaversion>1.2</schemaversion>');
    expect(m).toContain('adlcp:scormtype="sco"');
    expect(m.match(/<item /g)).toHaveLength(2);
    expect(m).toContain('<file href="video02/video.mp4"/>');
    expect(m).toContain('Video 1 &amp; &lt;uno&gt;');
  });

  it('manifiesto 2004 4.ª edición', () => {
    const m = scormManifest('2004', 'p1', 'Proyecto', items);
    expect(m).toContain('<schemaversion>2004 4th Edition</schemaversion>');
    expect(m).toContain('adlcp:scormType="sco"');
    expect(m).toContain('xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"');
  });

  for (const version of ['1.2', '2004'] as const) {
    const K = version === '1.2' ? { status: 'cmi.core.lesson_status', loc: 'cmi.core.lesson_location', exit: 'cmi.core.exit', time: 'cmi.core.session_time' } : { status: 'cmi.completion_status', loc: 'cmi.location', exit: 'cmi.exit', time: 'cmi.session_time' };

    it(`${version}: incompleto al abrir, completo al ver el 95 % (no adelantando) y sesión al salir`, () => {
      const l = lms(version);
      expect(l.calls[0]).toBe('init');
      expect(l.data[K.status]).toBe('incomplete');
      l.watch(0, 40);
      l.video.currentTime = 99; // adelantar no cuenta
      l.fire('timeupdate');
      expect(l.data[K.status]).toBe('incomplete');
      expect(l.data[K.loc]).toBe('39');
      if (version === '2004') expect(Number(l.data['cmi.progress_measure'])).toBeCloseTo(0.4, 1);
      l.watch(40, 96);
      expect(l.data[K.status]).toBe('completed');
      l.fire('pagehide');
      expect(l.calls.at(-1)).toBe('finish');
      expect(l.data[K.exit]).toBe(version === '1.2' ? '' : 'normal');
      expect(l.data[K.time]).toMatch(version === '1.2' ? /^\d{4}:\d{2}:\d{2}\.\d{2}$/ : /^PT\d+H\d+M[\d.]+S$/);
    });

    it(`${version}: retoma donde quedó y conserva lo visto; al salir sin terminar queda suspendido`, () => {
      const l = lms(version, { [K.status]: 'incomplete', [K.loc]: '50', 'cmi.suspend_data': `v1:${'1'.repeat(50)}${'0'.repeat(50)}` });
      expect(l.video.currentTime).toBe(50);
      l.watch(50, 90);
      expect(l.data[K.status]).toBe('incomplete');
      l.watch(90, 96);
      expect(l.data[K.status]).toBe('completed');
      const l2 = lms(version);
      l2.watch(0, 10);
      l2.fire('pagehide');
      expect(l2.data[K.exit]).toBe('suspend');
      expect(l2.calls.filter((c) => c === 'finish')).toHaveLength(1);
      l2.fire('beforeunload');
      expect(l2.calls.filter((c) => c === 'finish')).toHaveLength(1);
    });

    it(`${version}: terminar el video lo completa`, () => {
      const l = lms(version);
      l.fire('ended');
      expect(l.data[K.status]).toBe('completed');
    });
  }

  it('fuera de un LMS el SCO no hace nada (el reproductor funciona igual)', () => {
    const win: Record<string, unknown> = {};
    win.parent = win;
    expect(() => runInNewContext(scormRuntime('2004'), { window: win, document: { getElementById: () => ({}) } })).not.toThrow();
  });

  it('el reproductor lleva la esquina por clip y, en SCORM, el registro del LMS', () => {
    const html = playerHtml({
      title: 'x',
      videoSrc: 'video.mp4',
      cues: [],
      settings: DEFAULT_LOGO_SETTINGS,
      durationSec: 20,
      clips: [
        { index: 1, start: 0, end: 10 },
        { index: 2, start: 10, end: 20 },
      ],
      clipCorners: { '2': 'bl' },
      scorm: '1.2',
    });
    expect(html).toContain('"clipCorners":{"2":"bl"}');
    expect(html).toContain('LMSInitialize');
    expect(playerHtml({ title: 'x', videoSrc: 'v.mp4', cues: [], settings: DEFAULT_LOGO_SETTINGS, durationSec: 1 })).not.toContain('LMSInitialize');
  });
});
