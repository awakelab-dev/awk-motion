/**
 * pnpm finales:cierre (ADR-158): los videos terminados cuyo último clip quedó cortado por el fin de la voz (antes de
 * ADR-157) y, con --aplicar, vuelve a unir su final, uno por uno, para que el último clip se vea entero con su pausa.
 *   (sin flag)  solo lista los videos afectados (proyecto, inicio del texto, frames que se ven del último clip)
 *   --aplicar   pide el usuario y la contraseña (un administrador ve todos los videos) y, video por video, llama a
 *               «volver a unir» en la API de esta instalación (solo ffmpeg, sin costo) y espera el final nuevo
 * Corre al lado de la API (usa su .env: la base y el puerto). No toca los videos en la papelera ni los eliminados.
 */
import { createDb } from '@wilox/db';
import { env } from '../src/config/env.js';
import { ask, askHidden } from '../../../packages/db/scripts/tty.js';

interface Row {
  id: string;
  project: string;
  text: string;
  visible: number;
  delivered: number;
}

const apply = process.argv.includes('--aplicar');
const db = createDb(env.DATABASE_URL);
const API = `http://127.0.0.1:${env.PORT}/api`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function affected(): Promise<Row[]> {
  return db.$queryRawUnsafe<Row[]>(`
    SELECT g.id, p.name AS project, left(regexp_replace(g.text, '\\s+', ' ', 'g'), 60) AS text,
      (c."slotEndFrame" - c."startFrame")::int AS visible, coalesce(c."deliveredFrames", 124)::int AS delivered
    FROM "Generation" g
    JOIN "Project" p ON p.id = g."projectId"
    JOIN LATERAL (SELECT * FROM "Clip" x WHERE x."generationId" = g.id ORDER BY x.index DESC LIMIT 1) c ON true
    WHERE g.status = 'done' AND g."deletedAt" IS NULL AND g."trashedAt" IS NULL
      AND c."startFrame" + coalesce(c."deliveredFrames", 124) > c."slotEndFrame"
    ORDER BY p.name, g."createdAt"`);
}

let cookie = '';
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-confirm-change': '1', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { message: text };
  }
  return { status: r.status, data };
}

try {
  const rows = await affected();
  console.log(`Videos terminados con el último clip cortado: ${rows.length}.`);
  for (const r of rows) console.log(`  · ${r.project} | ${r.text} | se ven ${r.visible} de ${r.delivered} frames`);
  if (!apply || !rows.length) {
    if (rows.length) console.log('Solo lista. Para volver a unirlos (sin costo), repite con --aplicar.');
  } else {
    const email = (await ask('Email (administrador) [leonardojbarreto@gmail.com]: ')) || 'leonardojbarreto@gmail.com';
    const password = await askHidden('Contraseña: ');
    const login = await call('POST', '/auth/login', { email, password });
    if (login.status !== 200) throw new Error(`No se pudo entrar (${login.status}): ${String(login.data.message ?? '')}`);
    let ok = 0;
    for (const [i, r] of rows.entries()) {
      const before = (await call('GET', `/generations/${r.id}`)).data.finalUrl;
      const res = await call('POST', `/generations/${r.id}/rejoin`);
      if (res.status !== 202) {
        console.log(`  ✗ ${i + 1}/${rows.length} ${r.project} | ${r.text}: ${String(res.data.message ?? res.status)}`);
        continue;
      }
      let msg = '';
      for (let t = 0; t < 300; t++) {
        await sleep(3000);
        const s = (await call('GET', `/generations/${r.id}`)).data;
        if (s.status === 'error') {
          msg = `✗ error: ${String(s.message ?? '')}`;
          break;
        }
        if (s.status === 'done' && s.finalUrl !== before) {
          msg = `✓ ${String(s.message ?? '')}`;
          ok++;
          break;
        }
      }
      console.log(`  ${i + 1}/${rows.length} ${r.project} | ${r.text}: ${msg || '✗ no terminó en 15 min (sigue en la cola)'}`);
    }
    console.log(`Listo: ${ok} de ${rows.length} videos con el final nuevo.`);
    const left = await affected();
    console.log(`Quedan con el último clip cortado: ${left.length}.`);
  }
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
