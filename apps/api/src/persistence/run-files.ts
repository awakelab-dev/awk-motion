import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isBaseThemeId, type RunState, type Shot, type Storyboard, type ThemeStyle } from '@wilox/shared';
import type { TimedWord } from '@wilox/prompts';
import { BASE_THEMES } from '@wilox/styles';
import type { PlannedClip } from '../pipeline/timeline.js';
import type { RunData } from './run-data.js';

/**
 * Lectura de las generaciones antiguas en archivos (hitos 1 y 2: state.json, internal.json,
 * theme.json y prompts/). Solo la usa `pnpm db:import`: desde el hito 3 la fuente es la BD.
 */

const nn = (i: number) => String(i).padStart(2, '0');

interface InternalFile {
  approved: boolean;
  storyboard?: Storyboard;
  plan?: PlannedClip[];
  shots?: Shot[];
  keyAssets: [number, { ref: string; path: string }][];
  clipRaw: [number, string][];
}

interface RunThemeFile {
  style: ThemeStyle;
  references: { path: string; ref?: string }[];
}

/** JSON.parse tolerante: si el archivo quedó con basura al final, toma el primer objeto completo. */
export function parseFirstJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return JSON.parse(text.slice(0, i + 1)) as T;
    }
    throw new Error('JSON ilegible');
  }
}

export interface RunFromFiles {
  data: Omit<RunData, 'ownerId'>;
  /** Qué hubo que reconstruir o no se pudo leer (para el informe de importación). */
  notes: string[];
  source: { internal: boolean; themeCopy: boolean };
}

/** Lee una generación del hito 1/2 desde su carpeta. Las que no tienen internal.json se reconstruyen desde prompts/ (ADR-013). */
export function readRunFromFiles(dir: string): RunFromFiles {
  const notes: string[] = [];
  const state = parseFirstJson<RunState>(readFileSync(join(dir, 'state.json'), 'utf8'));
  state.keyframes ??= [];
  state.clips ??= [];
  state.paragraphs ??= [];
  state.log ??= [];

  // Tema: su copia (theme.json) o el tema base (generaciones del hito 1, ADR-018).
  let theme: RunThemeFile;
  const themeFile = join(dir, 'theme.json');
  const themeCopy = existsSync(themeFile);
  if (themeCopy) theme = parseFirstJson<RunThemeFile>(readFileSync(themeFile, 'utf8'));
  else if (isBaseThemeId(state.theme)) theme = { style: BASE_THEMES[state.theme], references: [] };
  else throw new Error(`no hay copia del tema "${state.theme}" (theme.json)`);

  state.themeName ??= theme.style.info.name;
  const p = (f: string) => join(dir, 'prompts', f);
  const words = existsSync(p('tiempos_por_palabra.json')) ? (JSON.parse(readFileSync(p('tiempos_por_palabra.json'), 'utf8')) as TimedWord[]) : undefined;
  if (!words) notes.push('sin tiempos_por_palabra.json');

  const data: Omit<RunData, 'ownerId'> = {
    state,
    dir,
    theme: theme.style,
    themeRefs: theme.references ?? [],
    approved: false,
    words,
    keyAssets: new Map(),
    clipRaw: new Map(),
  };

  const internalPath = join(dir, 'internal.json');
  const internal = existsSync(internalPath);
  if (internal) {
    const i = parseFirstJson<InternalFile>(readFileSync(internalPath, 'utf8'));
    data.approved = i.approved;
    data.storyboard = i.storyboard;
    data.plan = i.plan;
    data.shots = i.shots;
    data.keyAssets = new Map(i.keyAssets);
    data.clipRaw = new Map(i.clipRaw);
  } else {
    notes.push('sin internal.json: reconstruida desde prompts/');
    if (existsSync(p('storyboard.json'))) data.storyboard = JSON.parse(readFileSync(p('storyboard.json'), 'utf8'));
    if (existsSync(p('plan.json'))) data.plan = JSON.parse(readFileSync(p('plan.json'), 'utf8'));
    if (data.storyboard && data.plan && words) {
      const shots = data.storyboard.shots
        .map((sh) => ({ ...sh, anchorWordIndex: Math.max(0, Math.min(words.length - 1, Math.round(sh.anchorWordIndex))) }))
        .sort((a, b) => a.anchorWordIndex - b.anchorWordIndex);
      shots[0].anchorWordIndex = 0;
      if (!data.theme.usesMediaFrames) shots.forEach((sh) => (sh.keyframe.mediaFrames = []));
      data.shots = data.plan.map((pl) => shots[pl.shot]);
      // Planos reescritos durante la revisión (K0n_plano_vX.json, el de mayor versión gana).
      const files = existsSync(join(dir, 'prompts')) ? readdirSync(join(dir, 'prompts')) : [];
      data.shots.forEach((_, i) => {
        const versions = files
          .map((f) => f.match(new RegExp(`^K${nn(i + 1)}_plano_v(\\d+)\\.json$`)))
          .filter(Boolean)
          .map((m) => Number(m![1]))
          .sort((a, b) => b - a);
        if (versions.length) data.shots![i] = JSON.parse(readFileSync(p(`K${nn(i + 1)}_plano_v${versions[0]}.json`), 'utf8'));
      });
    } else notes.push('no se pudo reconstruir el storyboard');
    // Sin internal.json no se conocen las referencias remotas: se vuelven a subir si hace falta (ADR-013).
    for (const k of state.keyframes) {
      const f = join(dir, 'keyframes', `K${nn(k.index)}_v${k.version}.png`);
      if (existsSync(f)) data.keyAssets.set(k.index, { ref: '', path: f });
    }
    for (const c of state.clips) {
      const f = join(dir, 'clips', `clip${nn(c.index)}_ia_v${c.version}.mp4`);
      if (c.status === 'ready' && existsSync(f)) data.clipRaw.set(c.index, f);
    }
    data.approved = ['clips', 'post', 'render', 'done'].includes(state.status);
  }
  return { data, notes, source: { internal, themeCopy } };
}
