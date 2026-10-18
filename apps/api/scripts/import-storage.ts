/**
 * Importa a la BD lo que hay en storage/ (hito 3, ADR-029): todo queda asignado a un usuario
 * (por defecto leonardojbarreto@gmail.com, que debe existir: pnpm db:admin).
 *
 *   pnpm db:import:check     → solo informe (no escribe nada)
 *   pnpm db:import           → importa
 *   … -- --email otro@x.com  → otro dueño
 *
 * - No mueve ni borra archivos: la BD apunta a las rutas actuales.
 * - Idempotente: lo que ya está en la BD se salta ("ya importado"), así que una segunda pasada
 *   no duplica nada ni deshace lo que se haya cambiado después desde la app.
 * - Temas: storage/themes/<id>/theme.json + pruebas/NNN/ (theme.snapshot.json, prompts/) + propuestas/.
 *   Los de _papelera/ no se importan (solo se cuentan).
 * - Generaciones: storage/runs/<id>/ (state.json, internal.json, theme.json, prompts/). Las que no tienen
 *   internal.json se reconstruyen desde prompts/ y las que no tienen copia del tema usan el tema base
 *   (ADR-013, ADR-018). Quedan en "Sin clasificar" del dueño (hito 4, ADR-035).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { createDb, ensureUnclassified, loadRootEnv, REPO_ROOT, type Db } from '@wilox/db';
import type { StoredTheme, ThemeStyle } from '@wilox/shared';
import { promptMeta } from '../src/persistence/prompt-meta.js';
import { markInterrupted } from '../src/persistence/run-data.js';
import { readRunFromFiles } from '../src/persistence/run-files.js';
import { persistRun, relInRun } from '../src/persistence/run-persistence.js';
import { persistTheme } from '../src/persistence/theme-persistence.js';

const DEFAULT_OWNER = 'leonardojbarreto@gmail.com';
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const argValue = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

loadRootEnv();
const storageDir = process.env.STORAGE_DIR ?? 'storage';
const STORAGE = isAbsolute(storageDir) ? storageDir : resolve(REPO_ROOT, storageDir);

interface Report {
  found: number;
  imported: number;
  already: number;
  failed: number;
  detail: Record<string, number>;
  problems: string[];
}
const newReport = (): Report => ({ found: 0, imported: 0, already: 0, failed: 0, detail: {}, problems: [] });
const add = (r: Report, key: string, n = 1) => (r.detail[key] = (r.detail[key] ?? 0) + n);

const dirs = (p: string) => (existsSync(p) ? readdirSync(p).filter((d) => statSync(join(p, d)).isDirectory()) : []);
const files = (p: string) => (existsSync(p) ? readdirSync(p).filter((f) => statSync(join(p, f)).isFile() && !f.startsWith('.')) : []);
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
/** Los errores de Prisma traen la consulta entera: solo interesa la última línea (la causa). */
const short = (e: unknown) => {
  const lines = String((e as Error)?.message ?? e).split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? 'error desconocido').slice(0, 300);
};

// ---------------------------------------------------------------- temas

async function importThemes(db: Db, ownerId: string): Promise<Report> {
  const r = newReport();
  const root = join(STORAGE, 'themes');
  const trash = join(root, '_papelera');
  add(r, 'en la papelera (no se importan)', dirs(trash).length);
  for (const id of dirs(root).filter((d) => !d.startsWith('_'))) {
    const dir = join(root, id);
    if (!existsSync(join(dir, 'theme.json'))) continue;
    r.found += 1;
    try {
      const t = readJson<StoredTheme>(join(dir, 'theme.json'));
      if (t.id !== id) throw new Error(`theme.json dice id "${t.id}"`);
      t.tests ??= [];
      t.references ??= [];
      t.activity = undefined;
      const snapshots = new Map<number, ThemeStyle>();
      const promptsByTest = new Map<number, { name: string; content: string }[]>();
      for (const test of t.tests) {
        const tdir = join(dir, 'pruebas', String(test.n).padStart(3, '0'));
        const snap = join(tdir, 'theme.snapshot.json');
        if (existsSync(snap)) snapshots.set(test.n, readJson<ThemeStyle>(snap));
        else r.problems.push(`${id}: la prueba ${test.n} no tiene theme.snapshot.json (se usa el estilo actual)`);
        promptsByTest.set(
          test.n,
          files(join(tdir, 'prompts')).map((name) => ({ name, content: readFileSync(join(tdir, 'prompts', name), 'utf8') })),
        );
      }
      const proposals = files(join(dir, 'propuestas')).map((name) => ({ name, content: readFileSync(join(dir, 'propuestas', name), 'utf8') }));
      const missingRefs = t.references.filter((x) => !existsSync(join(dir, 'referencias', x.file)));
      for (const m of missingRefs) r.problems.push(`${id}: falta la referencia referencias/${m.file}`);

      add(r, 'pruebas', t.tests.length);
      add(r, 'referencias', t.references.length);
      add(r, 'prompts', proposals.length + [...promptsByTest.values()].reduce((s, l) => s + l.length, 0));
      add(r, t.status === 'saved' ? 'guardados' : 'borradores');

      if (await db.theme.findUnique({ where: { id }, select: { id: true } })) {
        r.already += 1;
        continue;
      }
      if (DRY) continue;
      await persistTheme(db, { ...t, ownerId }, { ownerId, dir: `themes/${id}`, snapshots });
      const tests = await db.themeTest.findMany({ where: { themeId: id }, select: { id: true, n: true } });
      const data = [
        ...proposals.map((p) => ({ themeId: id, name: p.name, content: p.content, ...promptMeta(p.name) })),
        ...tests.flatMap((row) => (promptsByTest.get(row.n) ?? []).map((p) => ({ themeTestId: row.id, name: p.name, content: p.content, ...promptMeta(p.name) }))),
      ];
      if (data.length) await db.prompt.createMany({ data, skipDuplicates: true });
      r.imported += 1;
    } catch (e) {
      r.failed += 1;
      r.problems.push(`${id}: ${short(e)}`);
    }
  }
  return r;
}

// ---------------------------------------------------------------- generaciones

async function importRuns(db: Db, ownerId: string): Promise<Report> {
  const r = newReport();
  const root = join(STORAGE, 'runs');
  for (const id of dirs(root).filter((d) => !d.startsWith('_'))) {
    const dir = join(root, id);
    if (!existsSync(join(dir, 'state.json'))) {
      r.problems.push(`${id}: sin state.json (no es una generación)`);
      continue;
    }
    r.found += 1;
    try {
      const { data, notes, source } = readRunFromFiles(dir);
      if (data.state.id !== id) throw new Error(`state.json dice id "${data.state.id}"`);
      for (const n of notes) r.problems.push(`${id}: ${n}`);
      const prompts = files(join(dir, 'prompts')).map((name) => ({ name, content: readFileSync(join(dir, 'prompts', name), 'utf8') }));
      add(r, `estado ${data.state.status}`);
      add(r, source.internal ? 'con internal.json' : 'reconstruidas desde prompts/');
      add(r, source.themeCopy ? 'con copia del tema' : 'con el tema base');
      add(r, 'fotogramas', data.state.keyframes.length);
      add(r, 'clips', data.state.clips.length);
      add(r, 'prompts', prompts.length);
      add(r, 'con video final', existsSync(join(dir, 'final.mp4')) ? 1 : 0);
      const missing = [...data.keyAssets.values()].filter((a) => !existsSync(join(dir, relInRun(dir, id, a.path))));
      if (missing.length) r.problems.push(`${id}: faltan ${missing.length} archivo(s) de fotogramas`);

      if (await db.generation.findUnique({ where: { id }, select: { id: true } })) {
        r.already += 1;
        continue;
      }
      if (DRY) continue;
      const d = { ...data, ownerId };
      // Las generaciones de storage/ se renderizaron con MUSIC_PATH (hito 5, ADR-044).
      if (d.state.musicTrack === undefined) d.state.musicTrack = basename(process.env.MUSIC_PATH || 'assets/music/Inspiring.mp3');
      markInterrupted(d);
      const log = [...d.state.log, { at: new Date().toISOString(), level: 'info' as const, message: `Importada desde storage/ (hito 3)${notes.length ? `: ${notes.join('; ')}` : ''}.` }];
      const projectId = await ensureUnclassified(db, ownerId);
      await persistRun(db, d, { relDir: `runs/${id}`, projectId, parentId: null, newLogs: log, createdAt: new Date(d.state.createdAt) });
      if (prompts.length) await db.prompt.createMany({ data: prompts.map((p) => ({ generationId: id, name: p.name, content: p.content, ...promptMeta(p.name) })), skipDuplicates: true });
      add(r, 'versiones anteriores de fotogramas y clips', await importOldVersions(db, id, dir));
      r.imported += 1;
    } catch (e) {
      r.failed += 1;
      r.problems.push(`${id}: ${short(e)}`);
    }
  }
  return r;
}

/** Versiones anteriores (K01_v1.png cuando la vigente es la v2…): también quedan en la BD con su archivo. */
async function importOldVersions(db: Db, id: string, dir: string): Promise<number> {
  const nn = (i: number) => String(i).padStart(2, '0');
  const readPrompt = (name: string) => (existsSync(join(dir, 'prompts', name)) ? readFileSync(join(dir, 'prompts', name), 'utf8') : '');
  let n = 0;
  for (const k of await db.keyframe.findMany({ where: { generationId: id, version: { gt: 1 } } })) {
    for (let v = 1; v < k.version; v++) {
      const rel = `keyframes/K${nn(k.index)}_v${v}.png`;
      if (!existsSync(join(dir, rel))) continue;
      await db.keyframeVersion.upsert({
        where: { keyframeId_version: { keyframeId: k.id, version: v } },
        create: { keyframeId: k.id, version: v, path: rel, prompt: readPrompt(`K${nn(k.index)}_imagen_v${v}.md`) },
        update: {},
      });
      n += 1;
    }
  }
  for (const c of await db.clip.findMany({ where: { generationId: id, version: { gt: 1 } } })) {
    for (let v = 1; v < c.version; v++) {
      const rel = `clips/clip${nn(c.index)}_ia_v${v}.mp4`;
      if (!existsSync(join(dir, rel))) continue;
      await db.clipVersion.upsert({ where: { clipId_version: { clipId: c.id, version: v } }, create: { clipId: c.id, version: v, path: rel, prompt: '' }, update: {} });
      n += 1;
    }
  }
  return n;
}

// ---------------------------------------------------------------- informe

function print(title: string, r: Report) {
  const verb = DRY ? 'se importarían' : 'importados';
  const pending = DRY ? r.found - r.already - r.failed : r.imported;
  console.log(`\n${title}`);
  console.log(`  encontrados en storage/: ${r.found}`);
  console.log(`  ${verb}: ${pending} · ya en la BD: ${r.already} · con error: ${r.failed}`);
  for (const [k, v] of Object.entries(r.detail).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${k}: ${v}`);
  if (r.problems.length) {
    console.log('  avisos:');
    for (const p of r.problems) console.log(`   - ${p}`);
  }
}

async function main() {
  const email = (argValue('--email') ?? DEFAULT_OWNER).trim().toLowerCase();
  const db = createDb();
  try {
    const owner = await db.user.findUnique({ where: { email } });
    if (!owner) throw new Error(`No existe el usuario ${email}: créalo antes con pnpm db:admin.`);
    console.log(`${DRY ? 'Informe (sin escribir nada)' : 'Importación'} de ${STORAGE} → ${email}`);
    // Primero los temas: una generación hecha con un tema del Estudio queda enlazada a él.
    const themes = await importThemes(db, owner.id);
    print('Temas del Estudio', themes);
    const runs = await importRuns(db, owner.id);
    print('Generaciones (quedan en "Sin clasificar")', runs);
    const failed = themes.failed + runs.failed;
    console.log(failed ? `\n✖ ${failed} elemento(s) con error (ver avisos).` : `\n✔ ${DRY ? 'Informe listo. Para importar: pnpm db:import' : 'Importación terminada.'}`);
    if (failed) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(`✖ ${e.message}`);
  process.exit(1);
});
