import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pLimit from 'p-limit';
import {
  CLIP_FRAMES,
  FPS,
  MAX_REFERENCES_IN_PROMPT,
  activeCorrections,
  briefSignature,
  StudioReviewSchema,
  ThemeProposalSchema,
  type StoredTheme,
  type ThemeStyle,
  type ThemeTest,
  type ThemeTestFrame,
} from '@wilox/shared';
import {
  imageReviewItemText,
  MEDIA_FRAME_RULE,
  standardTestShots,
  studioReviewSystemPrompt,
  testClipPrompt,
  testFramePrompt,
  themeProposalSystemPrompt,
  themeProposalUserText,
} from '@wilox/prompts';
import { env } from '../config/env.js';
import { durationSec, ffmpeg, imagePreviewJpeg, normalizeClip, ssimAgainst } from '../media/ffmpeg.js';
import { motionCurve, motionPeaks } from '../media/motion.js';
import { planSfx, renderSfx } from '../media/sfx.js';
import { askJson } from '../pipeline/llm-json.js';
import { PROVIDERS, type LlmContent, type Providers } from '../providers/ports.js';
import { withJobs } from '../jobs/job-scope.js';
import { flattenPng } from '../media/flatten.js';
import { ThemeStore } from './theme-store.js';

type FrameKey = 'A' | 'B';
const RUNNING_TEST: ThemeTest['status'][] = ['queued', 'frames', 'review', 'clip', 'post'];

/**
 * Motor del Estudio: propuesta del tema (Opus con visión) y prueba estándar
 * (frames A/B con GPT Image + referencias, revisión de Opus, clip A→B con MiniMax + SFX).
 * Todo se guarda en storage/themes/<id>/pruebas/<n>/ y sobrevive a un reinicio.
 */
@Injectable()
export class StudioService {
  private readonly logger = new Logger('Studio');
  /** Cola de imágenes (como ADR-011) y de clips: lo que excede el límite espera. */
  private readonly imageSlots = pLimit(Math.max(1, env.IMAGE_CONCURRENCY));
  private readonly clipSlots = pLimit(4);
  /** Referencias remotas de los frames de cada prueba (job_id / media_id / ruta). */
  private readonly frameRefs = new Map<string, string>();
  private readonly busy = new Set<string>();

  constructor(
    private readonly themes: ThemeStore,
    @Inject(PROVIDERS) private readonly p: Providers,
  ) {}

  // ---------------------------------------------------------------- helpers

  /** Los trabajos de los proveedores dentro de fn quedan anotados al tema (y a la prueba) y a su dueño. */
  private scoped<T>(id: string, n: number | undefined, fn: () => Promise<T>): Promise<T> {
    return withJobs({ ownerId: this.theme(id).ownerId!, themeId: id, testN: n, priority: 0 }, fn);
  }

  private testDir(id: string, n: number) {
    return join(this.themes.dir(id), 'pruebas', String(n).padStart(3, '0'));
  }

  private rel(id: string, abs: string) {
    return abs.slice(this.themes.dir(id).length + 1);
  }

  private theme(id: string): StoredTheme {
    const t = this.themes.stored(id);
    if (!t) throw new Error('Tema no encontrado.');
    return t;
  }

  private test(id: string, n: number): ThemeTest {
    const test = this.theme(id).tests.find((x) => x.n === n);
    if (!test) throw new Error(`No existe la prueba ${n}.`);
    return test;
  }

  private patchTest(id: string, n: number, fn: (t: ThemeTest) => void) {
    this.themes.update(id, (th) => {
      const t = th.tests.find((x) => x.n === n);
      if (t) fn(t);
    });
  }

  /** Imagen reducida para Opus (lado mayor 1344 px). */
  private async forClaude(src: string, out: string) {
    await ffmpeg([
      '-i',
      src,
      '-vf',
      "scale='if(gt(iw,ih),min(1344,iw),-2)':'if(gt(iw,ih),-2,min(1344,ih))'",
      '-frames:v',
      '1',
      '-update',
      '1',
      '-q:v',
      '3',
      out,
    ]);
    return (await readFile(out)).toString('base64');
  }

  /** Referencias del tema listas para GPT Image; en MCP el media_id se guarda en theme.json. */
  private async referenceRefs(id: string): Promise<string[]> {
    const t = this.theme(id);
    const out: string[] = [];
    for (const r of t.references.slice(0, MAX_REFERENCES_IN_PROMPT)) {
      if (!r.mediaId) {
        const path = join(this.themes.dir(id), 'referencias', r.file);
        const ref = this.p.uploadRef ? await this.p.uploadRef(path) : path;
        this.themes.update(id, (th) => {
          const x = th.references.find((y) => y.file === r.file);
          if (x) x.mediaId = ref;
        });
        r.mediaId = ref;
      }
      out.push(r.mediaId);
    }
    return out;
  }

  /** Láminas tipográficas listas de la versión del tema que usa la prueba (ADR-094), detrás de las referencias. */
  private sheetRefs(id: string, style: ThemeStyle): string[] {
    return (style.typefaces ?? [])
      .filter((f) => f.status === 'ready' && f.sheet)
      .map((f) => join(this.themes.dir(id), 'tipografias', f.sheet!))
      .filter((p) => existsSync(p));
  }

  // ---------------------------------------------------------------- restauración

  /** Tras un reinicio de la API, lo que estaba en marcha se marca para regenerar (como ADR-013). */
  recover(id: string) {
    const t = this.themes.stored(id);
    if (!t || this.busy.has(id)) return;
    let dirty = !!t.activity;
    const live = (k: string) => [...this.busy].some((b) => b === k || b.startsWith(`${k}#`));
    for (const test of t.tests) {
      const running = RUNNING_TEST.includes(test.status) && !live(`${id}#${test.n}`);
      for (const f of test.frames)
        if ((f.status === 'generating' || f.activity) && !live(`${id}#${test.n}#${f.key}`)) {
          f.activity = undefined;
          f.status = existsSync(join(this.testDir(id, test.n), `${f.key}_v${f.version}.png`)) ? 'ready' : 'error';
          if (f.status === 'error') f.error = 'Interrumpido por un reinicio de la API; regénéralo.';
          dirty = true;
        }
      if (test.clip.status === 'generating' && !live(`${id}#${test.n}#clip`)) {
        test.clip.status = 'error';
        test.clip.error = 'Interrumpido por un reinicio de la API; regénéralo.';
        dirty = true;
      }
      if (running) {
        test.status = 'error';
        test.message = 'Interrumpida por un reinicio de la API.';
        dirty = true;
      }
    }
    if (dirty) this.themes.update(id, (th) => (th.activity = undefined));
  }

  // ---------------------------------------------------------------- propuesta

  // ---------------------------------------------------------------- correcciones (ADR-042)

  private refFiles(id: string) {
    return this.theme(id).references.map((r) => r.file);
  }

  /** Añade una corrección al historial y pide a Opus que la aplique (crea una versión nueva). */
  addCorrection(id: string, text: string) {
    const t = this.theme(id);
    if (t.activity) throw new Error('Opus ya está trabajando en este tema.');
    const c = { id: randomUUID().slice(0, 8), text: text.trim(), active: true, createdAt: new Date().toISOString() };
    this.themes.update(id, (th) => (th.brief.corrections = [...(th.brief.corrections ?? []), c]));
    this.propose(id, { correctionId: c.id });
  }

  /** Activa, desactiva o elimina una corrección. No llama a Opus: el tema queda pendiente de regenerar. */
  changeCorrection(id: string, correctionId: string, change: { active?: boolean; remove?: boolean }) {
    const t = this.theme(id);
    if (t.activity) throw new Error('Espera a que Opus termine con el tema.');
    if (!t.brief.corrections?.some((c) => c.id === correctionId)) throw new Error('Corrección no encontrada.');
    this.themes.update(id, (th) => {
      const list = th.brief.corrections ?? [];
      th.brief.corrections = change.remove
        ? list.filter((c) => c.id !== correctionId)
        : list.map((c) => (c.id === correctionId && change.active !== undefined ? { ...c, active: change.active } : c));
    });
  }

  // ---------------------------------------------------------------- propuesta

  /**
   * Opus propone el ThemeStyle. Con `correctionId` (y el tema al día salvo esa corrección) revisa el
   * tema vigente para aplicarla; en cualquier otro caso lo regenera desde la descripción y TODAS las
   * correcciones activas, así una corrección desactivada o eliminada deja de pesar (ADR-042).
   */
  propose(id: string, opts: { correctionId?: string } = {}) {
    const t = this.theme(id);
    if (t.activity) throw new Error('Opus ya está trabajando en este tema.');
    const hasStyle = !!t.style.imageBible;
    const withoutNew = { ...t.brief, corrections: (t.brief.corrections ?? []).filter((c) => c.id !== opts.correctionId) };
    const upToDate = !t.brief.applied || t.brief.applied.signature === briefSignature(withoutNew, this.refFiles(id));
    const revise = hasStyle && !!opts.correctionId && upToDate;
    this.themes.update(id, (th) => (th.activity = revise ? 'Opus aplica la corrección…' : hasStyle ? 'Opus regenera el tema desde la descripción y las correcciones…' : 'Opus diseña el tema…'));
    this.busy.add(id);
    void this.scoped(id, undefined, () => this.doPropose(id, revise ? opts.correctionId : undefined))
      .catch((e) => {
        this.logger.error(`[${id}] propuesta: ${(e as Error).message}`);
        this.themes.update(id, (th) => {
          th.activity = undefined;
          th.proposalNotes = `Error: ${(e as Error).message}`;
        });
      })
      .finally(() => this.busy.delete(id));
  }

  private async doPropose(id: string, reviseFor?: string) {
    const t = this.theme(id);
    const signature = briefSignature(t.brief, this.refFiles(id));
    const active = activeCorrections(t.brief);
    const refs = this.themes.referencePaths(id).slice(0, 8);
    const system = themeProposalSystemPrompt();
    const text = themeProposalUserText(t.brief, refs.length, reviseFor ? { current: t.style, newCorrectionId: reviseFor } : {});
    const content: Exclude<LlmContent, string> = [{ type: 'text', text }];
    const tmpDir = join(this.themes.dir(id), 'referencias', '_opus');
    mkdirSync(tmpDir, { recursive: true });
    for (const [i, r] of refs.entries()) {
      content.push({ type: 'text', text: `Reference image ${i + 1}:` });
      content.push({ type: 'image', mediaType: 'image/jpeg', base64: await this.forClaude(r, join(tmpDir, `ref_${i + 1}.jpg`)) });
    }
    const dir = join(this.themes.dir(id), 'propuestas');
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
    await this.themes.savePrompt(id, undefined, `${stamp}_system.md`, system);
    await this.themes.savePrompt(id, undefined, `${stamp}_user.md`, text);
    const r = await askJson(this.p.llm, ThemeProposalSchema, system, content, 'Propuesta de tema');
    await this.themes.savePrompt(id, undefined, `${stamp}_respuesta.json`, JSON.stringify(r, null, 2));
    const { description, swatches, ...fields } = r.style;
    const style: ThemeStyle = {
      ...fields,
      info: { id, name: t.style.info.name || t.brief.name, description: description.slice(0, 160), swatches: swatches.slice(0, 6) },
    };
    // La animación de las imágenes la elige el usuario (ADR-080): regenerar el tema no la cambia.
    if (t.style.mediaFrameRule) style.mediaFrameRule = t.style.mediaFrameRule;
    // «Colores planos» (ADR-137) tampoco.
    if (t.style.flatColors) style.flatColors = true;
    // Las tipografías del tema (ADR-094) tampoco las toca Opus.
    if (t.style.typefaces) style.typefaces = t.style.typefaces;
    if (t.brief.imageryMode === 'photos') style.usesMediaFrames = true;
    if (t.brief.imageryMode === 'objects') style.usesMediaFrames = false;
    // Transversal (docs/04): con fotos reales, la regla de alternancia video/foto va en las notas, salvo que Opus
    // ya haya escrito una (p. ej. la versión corregida por el cliente): añadir la estándar las contradecía (ADR-080).
    if (style.usesMediaFrames && !/media[- ]frame rule|alternate video and still/i.test(style.directorNotes))
      style.directorNotes += ` ${MEDIA_FRAME_RULE}`;
    if (!style.usesMediaFrames && !/mediaFrames must always be an empty array/i.test(style.directorNotes))
      style.directorNotes += ' NO realistic photos or footage; mediaFrames must always be an empty array.';
    const how = new Map(r.corrections.map((c) => [c.number, c.how]));
    const updated = this.themes.update(
      id,
      (th) => {
        th.style = style;
        th.proposalNotes = r.notes;
        th.activity = undefined;
      },
      { styleChanged: true },
    );
    // Historial: qué versión aplicó cada corrección y cómo. Al regenerar se aplican todas las activas;
    // al revisar, solo la nueva (las anteriores ya estaban en el tema).
    this.themes.update(id, (th) => {
      th.brief.applied = { signature, version: updated.version, at: new Date().toISOString() };
      th.brief.corrections = (th.brief.corrections ?? []).map((c) => {
        const n = active.findIndex((a) => a.id === c.id);
        if (n < 0 || (reviseFor && c.id !== reviseFor)) return c;
        return { ...c, appliedInVersion: updated.version, how: how.get(n + 1) ?? c.how };
      });
    });
  }

  // ---------------------------------------------------------------- prueba estándar

  /** Nueva prueba con la versión actual del tema: frames A y B en paralelo (+ clip A→B si withClip). */
  startTest(id: string, withClip: boolean): ThemeTest {
    const t = this.theme(id);
    if (!t.style.imageBible) throw new Error('El tema aún no tiene estilo: pide primero la propuesta de Opus.');
    if (t.activity) throw new Error('Espera a que Opus termine con el tema.');
    const n = t.tests.reduce((m, x) => Math.max(m, x.n), 0) + 1;
    const dir = this.testDir(id, n);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    const refCount = Math.min(t.references.length, MAX_REFERENCES_IN_PROMPT);
    const { A, B } = standardTestShots(t.style);
    const frame = (key: FrameKey): ThemeTestFrame => ({
      key,
      label: key === 'A' ? 'Frame A · Portada' : 'Frame B · Enumeración',
      texts: (key === 'A' ? A : B).keyframe.texts,
      prompt: testFramePrompt(t.style, key, refCount, this.sheetRefs(id, t.style).length),
      status: 'pending',
      version: 0,
    });
    const test: ThemeTest = {
      n,
      createdAt: new Date().toISOString(),
      status: 'queued',
      message: 'En cola…',
      themeVersion: t.version,
      frames: [frame('A'), frame('B')],
      withClip,
      clip: { prompt: testClipPrompt(t.style), status: 'pending', version: 0 },
    };
    this.themes.update(id, (th) => th.tests.push(test));
    const key = `${id}#${n}`;
    this.busy.add(key);
    void this.scoped(id, n, async () => {
      // Copia del tema usado: regenerar dentro de esta prueba usa siempre esta versión.
      await writeFile(join(dir, 'theme.snapshot.json'), JSON.stringify(t.style, null, 2));
      await Promise.all((['A', 'B'] as const).map((k) => this.frame(id, n, k)));
      await this.review(id, n);
      if (withClip && this.test(id, n).frames.every((f) => f.status === 'ready')) await this.clip(id, n);
      this.finish(id, n);
    })
      .catch((e) => this.failTest(id, n, e))
      .finally(() => this.busy.delete(key));
    return test;
  }

  private async snapshot(id: string, n: number): Promise<ThemeStyle> {
    const f = join(this.testDir(id, n), 'theme.snapshot.json');
    return existsSync(f) ? (JSON.parse(await readFile(f, 'utf8')) as ThemeStyle) : this.theme(id).style;
  }

  private failTest(id: string, n: number, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    this.logger.error(`[${id} #${n}] ${msg}`);
    this.patchTest(id, n, (t) => {
      t.status = 'error';
      t.error = msg;
      t.message = `Error: ${msg.split('\n')[0]}`;
    });
  }

  private finish(id: string, n: number) {
    this.patchTest(id, n, (t) => {
      const bad = t.frames.filter((f) => f.status === 'error').length + (t.withClip && t.clip.status === 'error' ? 1 : 0);
      const working = t.frames.some((f) => f.activity || f.status === 'generating') || t.clip.status === 'generating';
      if (working) return;
      t.status = bad ? 'error' : 'done';
      t.message = bad
        ? 'Hay elementos con error: regénéralos.'
        : t.frames.some((f) => f.review?.verdict === 'improve') || t.suggestions?.some((s) => !s.applied)
          ? 'Prueba lista. Opus sugiere mejoras: revísalas.'
          : 'Prueba lista.';
      if (!bad) t.error = undefined;
    });
  }

  /** Genera (o regenera) un frame de la prueba; pasa por la cola de imágenes. */
  private async frame(id: string, n: number, key: FrameKey) {
    const busyKey = `${id}#${n}#${key}`;
    this.busy.add(busyKey);
    const dir = this.testDir(id, n);
    try {
      const style = await this.snapshot(id, n);
      let version = 0;
      let prompt = '';
      const styleRefs = await this.referenceRefs(id);
      const sheets = this.sheetRefs(id, style);
      const refs = [...styleRefs, ...(this.p.uploadRef ? await Promise.all(sheets.map((p) => this.p.uploadRef!(p))) : sheets)];
      this.patchTest(id, n, (t) => {
        const f = t.frames.find((x) => x.key === key)!;
        f.version += 1;
        f.prompt = testFramePrompt(style, key, styleRefs.length, sheets.length);
        f.status = 'generating';
        f.activity = 'En cola…';
        f.error = undefined;
        f.review = undefined;
        version = f.version;
        prompt = f.prompt;
        if (t.status !== 'clip' && t.status !== 'post') ((t.status = 'frames'), (t.message = 'Generando los frames de prueba…'));
      });
      await this.themes.savePrompt(id, n, `${key}_imagen_v${version}.md`, prompt);
      await this.imageSlots(async () => {
        this.patchTest(id, n, (t) => (t.frames.find((x) => x.key === key)!.activity = 'Generando imagen…'));
        const [r] = await this.p.images.generate([{ key, prompt, references: refs, outBase: join(dir, `${key}_v${version}`) }]);
        if (!r?.path || !r.ref) throw new Error(r?.error ?? 'No se generó la imagen.');
        // «Colores planos» (ADR-137): con el valor actual del tema, para ver el efecto en las pruebas.
        if (this.themes.style(id)?.flatColors && this.p.mode !== 'mcp') {
          this.patchTest(id, n, (t) => (t.frames.find((x) => x.key === key)!.activity = 'Aplanando colores…'));
          await flattenPng(r.path);
        }
        this.frameRefs.set(`${id}#${n}#${key}`, r.ref);
        this.patchTest(id, n, (t) => {
          const f = t.frames.find((x) => x.key === key)!;
          f.status = 'ready';
          f.activity = undefined;
          f.url = this.themes.fileUrl(id, this.rel(id, r.path!), version);
        });
      });
    } catch (e) {
      this.patchTest(id, n, (t) => {
        const f = t.frames.find((x) => x.key === key)!;
        f.status = 'error';
        f.activity = undefined;
        f.error = (e as Error).message;
      });
    } finally {
      this.busy.delete(busyKey);
    }
  }

  private framePath(id: string, n: number, key: FrameKey) {
    const f = this.test(id, n).frames.find((x) => x.key === key)!;
    return join(this.testDir(id, n), `${key}_v${f.version}.png`);
  }

  /** Revisión visual de Opus sobre A y B (+ referencias) con cambios aplicables al tema. */
  private async review(id: string, n: number) {
    if (!env.IMAGE_REVIEW) return;
    const test = this.test(id, n);
    const ready = test.frames.filter((f) => f.status === 'ready');
    if (!ready.length) return;
    const t = this.theme(id);
    const style = await this.snapshot(id, n);
    this.patchTest(id, n, (x) => {
      if (x.status === 'frames' || x.status === 'queued') x.status = 'review';
      x.message = 'Opus revisa los frames…';
      x.frames.forEach((f) => f.status === 'ready' && (f.activity = 'Opus revisa…'));
    });
    const dir = this.testDir(id, n);
    const refs = this.themes.referencePaths(id).slice(0, MAX_REFERENCES_IN_PROMPT);
    const content: Exclude<LlmContent, string> = [];
    for (const [i, r] of refs.entries()) {
      content.push({ type: 'text', text: `Style reference image ${i + 1}:` });
      content.push({ type: 'image', mediaType: 'image/jpeg', base64: await this.forClaude(r, join(dir, `_revision_ref_${i + 1}.jpg`)) });
    }
    content.push({ type: 'text', text: 'Review each test frame below (brief, then image). Return one review per frame, using its index (0 = A, 1 = B).' });
    const { A, B } = standardTestShots(style);
    for (const f of ready) {
      const jpg = join(dir, `_revision_${f.key}_v${f.version}.jpg`);
      await imagePreviewJpeg(this.framePath(id, n, f.key), jpg, 1344);
      const idx = f.key === 'A' ? 0 : 1;
      content.push({ type: 'text', text: imageReviewItemText(idx, f.label, (f.key === 'A' ? A : B).keyframe.scene, f.texts) });
      content.push({ type: 'image', mediaType: 'image/jpeg', base64: (await readFile(jpg)).toString('base64') });
    }
    const system = studioReviewSystemPrompt(style, t.brief, refs.length);
    try {
      await this.themes.savePrompt(id, n, 'revision_system.md', system);
      const r = await askJson(this.p.llm, StudioReviewSchema, system, content, 'Revisión del Estudio');
      await this.themes.savePrompt(id, n, `revision_${Date.now()}.json`, JSON.stringify(r, null, 2));
      this.patchTest(id, n, (x) => {
        for (const rv of r.reviews) {
          const f = x.frames.find((y) => (y.key === 'A' ? 0 : 1) === rv.index && ready.some((z) => z.key === y.key));
          if (f) f.review = { verdict: rv.verdict, issues: rv.issues };
        }
        x.reviewSummary = r.summary;
        x.suggestions = r.suggestions.map((s) => ({ ...s }));
      });
    } catch (e) {
      this.logger.warn(`[${id} #${n}] revisión falló: ${(e as Error).message}`);
      this.patchTest(id, n, (x) => (x.reviewSummary = `La revisión de Opus falló (no bloquea): ${(e as Error).message}`));
    } finally {
      this.patchTest(id, n, (x) => x.frames.forEach((f) => f.activity === 'Opus revisa…' && (f.activity = undefined)));
    }
  }

  /** Ref remota de un frame; tras un reinicio se vuelve a subir. */
  private async frameRef(id: string, n: number, key: FrameKey) {
    const k = `${id}#${n}#${key}`;
    const cached = this.frameRefs.get(k);
    if (cached) return cached;
    const path = this.framePath(id, n, key);
    if (!existsSync(path)) throw new Error(`Falta el frame ${key}; regénéralo.`);
    const ref = this.p.uploadRef ? await this.p.uploadRef(path) : path;
    this.frameRefs.set(k, ref);
    return ref;
  }

  /** Clip de transición A→B (MiniMax, 2K, 24 fps) + SFX del perfil del tema. */
  private async clip(id: string, n: number) {
    const busyKey = `${id}#${n}#clip`;
    this.busy.add(busyKey);
    const dir = this.testDir(id, n);
    try {
      const test = this.test(id, n);
      if (test.frames.some((f) => f.status !== 'ready')) throw new Error('Los frames A y B deben estar listos antes del clip.');
      const style = await this.snapshot(id, n);
      let version = 0;
      const prompt = testClipPrompt(style);
      this.patchTest(id, n, (t) => {
        t.withClip = true;
        t.clip.version += 1;
        t.clip.prompt = prompt;
        t.clip.status = 'generating';
        t.clip.error = undefined;
        t.status = 'clip';
        t.message = 'Generando el clip A→B (≈9 min)…';
        version = t.clip.version;
      });
      await this.themes.savePrompt(id, n, `clip_video_v${version}.md`, prompt);
      const [a, b] = [await this.frameRef(id, n, 'A'), await this.frameRef(id, n, 'B')];
      const raw = join(dir, `clip_ia_v${version}.mp4`);
      await this.clipSlots(async () => {
        const [r] = await this.p.video.generate([
          { key: 'clip', prompt, start: { ref: a, path: this.framePath(id, n, 'A') }, end: { ref: b, path: this.framePath(id, n, 'B') }, outPath: raw },
        ]);
        if (!r?.path) throw new Error(r?.error ?? 'No se generó el clip.');
      });
      this.patchTest(id, n, (t) => ((t.status = 'post'), (t.message = 'SFX y verificación…')));
      const frames = Math.min(CLIP_FRAMES, Math.max(1, Math.floor((await durationSec(raw)) * FPS + 1e-3)));
      const curve = (await motionCurve(raw)).slice(0, frames);
      const events = planSfx(motionPeaks(curve), frames / FPS, style.sfx);
      const wav = join(dir, `clip_sfx_v${version}.wav`);
      const log = await renderSfx(events, frames / FPS, wav, 7 + n);
      const out = join(dir, `clip_v${version}.mp4`);
      await normalizeClip(raw, wav, frames, out);
      await this.themes.savePrompt(id, n, `clip_sfx_v${version}.txt`, log.join('\n'));
      const [s0, s1] = await Promise.all([ssimAgainst(out, 0, this.framePath(id, n, 'A')), ssimAgainst(out, 'last', this.framePath(id, n, 'B'))]);
      this.patchTest(id, n, (t) => {
        t.clip.status = 'ready';
        t.clip.url = this.themes.fileUrl(id, this.rel(id, out), version);
        t.clip.deliveredFrames = frames;
        t.clip.fromFrames = t.frames.map((f) => `${f.key} v${f.version}`).join(' → ');
        t.clip.ssimStart = s0;
        t.clip.ssimEnd = s1;
      });
    } catch (e) {
      this.patchTest(id, n, (t) => ((t.clip.status = 'error'), (t.clip.error = (e as Error).message)));
    } finally {
      this.busy.delete(busyKey);
    }
  }

  // ---------------------------------------------------------------- iteración

  regenerateFrame(id: string, n: number, key: FrameKey) {
    const test = this.test(id, n);
    const f = test.frames.find((x) => x.key === key);
    if (!f) throw new Error('Frame inválido.');
    if (f.status === 'generating' || f.activity) throw new Error(`El frame ${key} ya se está generando.`);
    if (test.clip.status === 'generating') throw new Error('Espera a que termine el clip.');
    this.patchTest(id, n, (t) => {
      const x = t.frames.find((y) => y.key === key)!;
      x.status = 'generating';
      x.activity = 'En cola…';
      t.status = 'frames';
      t.message = `Regenerando el frame ${key}…`;
    });
    this.frameRefs.delete(`${id}#${n}#${key}`);
    void this.scoped(id, n, async () => {
      await this.frame(id, n, key);
      await this.review(id, n);
      this.finish(id, n);
    }).catch((e) => this.failTest(id, n, e));
  }

  regenerateClip(id: string, n: number) {
    const test = this.test(id, n);
    if (test.clip.status === 'generating') throw new Error('El clip ya se está generando.');
    if (test.frames.some((f) => f.status !== 'ready' || f.activity)) throw new Error('Los frames A y B deben estar listos (y sin regeneraciones en curso).');
    this.patchTest(id, n, (t) => ((t.clip.status = 'generating'), (t.status = 'clip')));
    void this.scoped(id, n, async () => {
      await this.clip(id, n);
      this.finish(id, n);
    }).catch((e) => this.failTest(id, n, e));
  }

  /** Aplica las sugerencias de la revisión al tema (nueva versión); la prueba no cambia. */
  applySuggestions(id: string, n: number, indices?: number[]) {
    const test = this.test(id, n);
    const list = (test.suggestions ?? []).map((s, i) => ({ s, i })).filter(({ s, i }) => !s.applied && (!indices || indices.includes(i)));
    if (!list.length) throw new Error('No hay sugerencias pendientes.');
    this.themes.update(
      id,
      (th) => {
        for (const { s } of list) (th.style as unknown as Record<string, string>)[s.field] = s.value;
        const tt = th.tests.find((x) => x.n === n)!;
        for (const { i } of list) tt.suggestions![i].applied = true;
        if (tt.status === 'done') tt.message = `Sugerencias aplicadas al tema (v${th.version + 1}): lanza una prueba nueva para verlas.`;
      },
      { styleChanged: true },
    );
  }
}
