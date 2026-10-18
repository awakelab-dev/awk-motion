import { BATCH_RETENTION_DAYS, type LinkDays } from '@wilox/shared';
import type { Db } from '@wilox/db';

const DAY = 86_400_000;

/** Fin de un link creado (o cambiado) hoy: 7 o 30 días, o sin caducidad. */
export const linkExpiry = (days: LinkDays, from = new Date()): Date | null => (days === null ? null : new Date(from.getTime() + days * DAY));

/**
 * Cuándo se borra una fila de «Descargas» (T5, ADR-111): 30 días después de quedar lista o, si tiene links activos, cuando
 * venza el último (nunca, con uno sin caducidad). Una fila con error o a medias no se toca aquí.
 */
export function retentionOf(finishedAt: Date, links: { expiresAt: Date | null }[]): Date | null {
  let exp: Date | null = new Date(finishedAt.getTime() + BATCH_RETENTION_DAYS * DAY);
  for (const l of links) {
    if (!l.expiresAt) return null;
    if (l.expiresAt > exp) exp = l.expiresAt;
  }
  return exp;
}

/** Vuelve a calcular el vencimiento de una fila lista según sus links activos. */
export async function applyRetention(db: Db, batchId: string) {
  const b = await db.downloadBatch.findUnique({ where: { id: batchId }, select: { status: true, finishedAt: true, links: { where: { disabledAt: null }, select: { expiresAt: true } } } });
  if (!b || b.status !== 'ready') return;
  await db.downloadBatch.update({ where: { id: batchId }, data: { expiresAt: retentionOf(b.finishedAt ?? new Date(), b.links) } });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (d: Date) => d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Santiago' });
const size = (b?: number) => (b === undefined ? '' : b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export interface LinkPage {
  state: 'ready' | 'preparing' | 'gone';
  projectName?: string;
  videoTitle?: string;
  format?: string;
  fileName?: string;
  bytes?: number;
  expiresAt?: Date | null;
  logoDataUrl?: string | null;
  /** URL del archivo (relativa a la página). */
  fileUrl?: string;
}

/**
 * Página pública del link de descarga (T5, ADR-111): neutra como el reproductor y la revisión, con el logo del proyecto
 * si lo tiene. Sin sesión, fuera de los buscadores. Mientras la descarga se vuelve a armar, se recarga sola.
 */
export function linkPageHtml(p: LinkPage): string {
  const title = p.state === 'gone' ? 'Link no disponible' : `Descarga · ${p.projectName ?? ''}`;
  let body: string;
  if (p.state === 'gone') body = `<h1>Este link ya no está disponible</h1><p class="muted">Caducó o se desactivó. Pide uno nuevo a quien te lo envió.</p>`;
  else {
    const meta = [p.format, size(p.bytes)].filter(Boolean).join(' · ');
    const head = `${p.logoDataUrl ? `<img class="logo" src="${esc(p.logoDataUrl)}" alt="">` : ''}<h1>${esc(p.projectName ?? '')}</h1>${p.videoTitle ? `<p class="video">${esc(p.videoTitle)}</p>` : ''}`;
    const file = `<div class="file"><div class="name">${esc(p.fileName ?? '')}</div>${meta ? `<div class="muted">${esc(meta)}</div>` : ''}</div>`;
    const exp = p.expiresAt ? `<p class="muted small">Disponible hasta el ${date(p.expiresAt)}.</p>` : '';
    body =
      p.state === 'preparing'
        ? `${head}<p>La descarga se está preparando. Esta página se actualiza sola; vuelve en unos minutos.</p>${exp}`
        : `${head}${file}<a class="btn" href="${esc(p.fileUrl ?? '')}" download>Descargar</a>${exp}`;
  }
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">${p.state === 'preparing' ? '\n<meta http-equiv="refresh" content="30">' : ''}
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:#0b0b0f;color:#f4f4f5;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:520px;margin:0 auto;padding:12vh 20px 40px;text-align:center}
.logo{max-width:180px;max-height:64px;object-fit:contain;margin:0 auto 20px;display:block}
h1{font-size:21px;margin:0 0 6px}
.video{margin:0 0 20px;color:#d4d4d8}
.file{border:1px solid #27272a;border-radius:12px;padding:14px 16px;margin:20px 0;background:#141418;word-break:break-all}
.name{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.muted{color:#a1a1aa}
.small{font-size:12.5px}
.btn{display:inline-block;background:#f4f4f5;color:#0b0b0f;text-decoration:none;font-weight:600;border-radius:10px;padding:11px 28px;margin:4px 0 14px}
.btn:hover{background:#fff}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}
