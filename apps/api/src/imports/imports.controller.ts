import { BadRequestException, Body, Controller, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser, ImportResult, ScriptRow } from '@wilox/shared';
import type { Db } from '@wilox/db';
import { CurrentUser } from '../auth/decorators.js';
import { AccessService } from '../access/access.service.js';
import { DB } from '../db/db.module.js';
import { withJobs } from '../jobs/job-scope.js';
import { askJson } from '../pipeline/llm-json.js';
import { splitParagraphs } from '../pipeline/text.js';
import { PROVIDERS, type LlmContent, type Providers } from '../providers/ports.js';
import { appearsInDocument, docxText, docxWithTables, pdfText } from './extract.js';

const MAX_BYTES = 20 * 1024 * 1024;

const ImportSchema = z.object({
  fileName: z.string().min(1).max(300),
  data: z.string().min(10),
  mode: z.enum(['text', 'script']),
  structure: z.string().max(2000).nullish(),
  styleId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
});

/** Respuesta de Opus al leer un guion (todos los campos presentes; "" = no aplica). */
const ScriptSchema = z.object({
  rows: z.array(
    z.object({
      voice: z.string().describe('Narration text of this row, copied VERBATIM from the document.'),
      scene: z.string().describe('Graphic / scene description for this narration, or "" if none.'),
      expression: z.string().describe('Tone or expression indication for the voice, or "" if none.'),
      layout: z.string().describe('Composition or layout hint, or "" if none.'),
      voiceTag: z.string().describe('If there is an expression: one ElevenLabs v3 audio tag in English, lowercase, no brackets (excited, calm, serious, warm, cheerful, whispers…); else "".'),
    }),
  ),
  warnings: z.array(z.string()).describe('Ambiguities or problems found, in Spanish (can be empty).'),
});

const SYSTEM = `You read a client's script document for a short educational motion-graphics video (Chilean Spanish) and turn it into rows.
The user explains how the document is organized (for example: "in the table, column 1 is the narration and column 2 the graphic description of the scene"). Follow that explanation.

Return one row per narration unit, in document order:
- "voice": the narration EXACTLY as written in the document: same words, punctuation, accents and capitalization. Never fix, shorten, summarize, translate or add anything. Join line breaks inside the same cell or paragraph with single spaces.
- Exclude titles, column headings, page numbers, scene numbers, timecodes and production notes unless the user's explanation says they are narrated.
- "scene": the graphic description that goes with that narration (as written, only cleaned of line breaks), or "".
- "expression": indications about how to say it (tone, emotion, pace), or "".
- "layout": composition or layout hints (positions, split screen, list of items…), or "".
- "voiceTag": when there is an expression, the single ElevenLabs v3 audio tag that best conveys it; otherwise "".
- If the document is plain text without a script structure, each paragraph is a row with empty scene, expression and layout.
- "warnings": anything ambiguous (e.g. a row without narration, a column you could not identify), in Spanish.`;

/**
 * Importar un PDF o un Word para la locución (hito 5, ADR-049).
 * - Texto: se extrae literal (sin Opus) y se separa en párrafos.
 * - Guion: Opus lee el documento (el PDF entero, con sus tablas; el Word con sus tablas convertidas a texto)
 *   y la explicación de cómo está armado, y devuelve filas: locución literal, escena, expresión y layout.
 *   Cada locución se coteja con el texto del documento: si no aparece tal cual, se avisa.
 */
@Controller('imports')
export class ImportsController {
  constructor(
    @Inject(PROVIDERS) private readonly p: Providers,
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  /**
   * El proyecto recuerda el estilo de guion de esta importación (ADR-072). Hito 11 (ADR-142): en un proyecto al que el
   * usuario tiene acceso, con un estilo suyo o del dueño del proyecto.
   */
  private async rememberStyle(user: AuthUser, projectId?: string | null, styleId?: string | null) {
    if (!projectId) return;
    const project = await this.access.project(projectId, user).catch(() => undefined);
    if (!project) return;
    // El proyecto solo recuerda estilos que su dueño puede ver: los suyos (o, si quien importa es el dueño, los propios).
    const style = styleId ? await this.db.scriptStyle.findFirst({ where: { id: styleId, ownerId: project.ownerId }, select: { id: true } }) : null;
    if (styleId && !style && project.ownerId !== user.id) return;
    await this.db.project.update({ where: { id: projectId }, data: { scriptStyleId: style?.id ?? null } });
  }

  @Post()
  async import(@Body() body: unknown, @CurrentUser() user: AuthUser): Promise<ImportResult> {
    const r = ImportSchema.safeParse(body ?? {});
    if (!r.success) throw new BadRequestException('Archivo no válido.');
    const { fileName, mode, structure } = r.data;
    const buf = Buffer.from(r.data.data.replace(/^data:[^,]+,/, ''), 'base64');
    if (buf.length > MAX_BYTES) throw new BadRequestException('El archivo pasa de 20 MB.');
    const kind = /\.pdf$/i.test(fileName) || buf.subarray(0, 5).toString() === '%PDF-' ? 'pdf' : /\.docx$/i.test(fileName) ? 'docx' : undefined;
    if (!kind) throw new BadRequestException('Sube un PDF o un Word (.docx). Los .doc antiguos: guárdalos antes como .docx.');

    let text = '';
    let pages: number | undefined;
    try {
      if (kind === 'pdf') ({ text, pages } = await pdfText(buf));
      else text = await docxText(buf);
    } catch (e) {
      throw new BadRequestException(`No se pudo leer el archivo: ${(e as Error).message}`);
    }
    const warnings: string[] = [];

    if (mode === 'text') {
      const paras = splitParagraphs(text);
      if (!paras.length) throw new BadRequestException('El documento no tiene texto seleccionable (¿es un PDF escaneado?). Prueba con «Guion»: Opus lo lee como imagen.');
      if (paras.length > 30) warnings.push(`El documento tiene ${paras.length} párrafos: revisa que todo sea locución (los títulos también se narrarían).`);
      return { mode, text: paras.join('\n\n'), warnings, pages };
    }

    // Guion: Opus lee el documento con la explicación de su estructura (máxima prioridad en la cola, como el Estudio).
    const content: Exclude<LlmContent, string> = [
      { type: 'text', text: `HOW THE DOCUMENT IS ORGANIZED (user's explanation):\n${structure?.trim() || '(no explanation: infer it; if it is plain text, one row per paragraph)'}` },
    ];
    if (kind === 'pdf') {
      content.push({ type: 'document', mediaType: 'application/pdf', base64: buf.toString('base64') });
      content.push({ type: 'text', text: `EXTRACTED TEXT OF THE PDF (may lose the table layout; use it only to copy the words exactly):\n${text}` });
    } else content.push({ type: 'text', text: `DOCUMENT (Word converted to text; table rows as | cell | cell |):\n${await docxWithTables(buf)}` });
    content.push({ type: 'text', text: 'Return the rows as JSON.' });

    const out = await withJobs({ ownerId: user.id, priority: 0 }, () => askJson(this.p.llm, ScriptSchema, SYSTEM, content, 'Importar guion'));
    const rows: ScriptRow[] = out.rows
      .map((x) => ({
        voice: x.voice.replace(/\s+/g, ' ').trim(),
        scene: x.scene.trim() || undefined,
        expression: x.expression.trim() || undefined,
        layout: x.layout.trim() || undefined,
        voiceTag: x.voiceTag.trim().replace(/^\[|\]$/g, '').toLowerCase() || undefined,
      }))
      .filter((x) => x.voice)
      .map((x) => ({ ...x, verified: appearsInDocument(x.voice, text || x.voice) }));
    if (!rows.length) throw new BadRequestException(`Opus no encontró locución en el documento. ${out.warnings.join(' ')}`);
    const bad = rows.filter((x) => !x.verified).length;
    if (bad) warnings.push(`${bad} fila(s) no coinciden palabra por palabra con el documento: revísalas antes de generar.`);
    if (!text) warnings.push('El PDF no tiene texto seleccionable: no se pudo comprobar la locución contra el documento.');
    warnings.push(...out.warnings);
    await this.rememberStyle(user, r.data.projectId, r.data.styleId);
    return { mode, text: rows.map((x) => x.voice).join('\n\n'), script: { rows, structure: structure?.trim() || undefined, source: fileName }, warnings, pages };
  }
}
