import type { ProjectShareKind } from '@wilox/shared';

/**
 * Páginas de los links del proyecto, neutras como la revisión y el reproductor, con el logo del proyecto. Cada link es
 * una página aparte (T6b, ADR-116; antes, una sola con dos pestañas, ADR-112):
 * - **Aprobación** (`/api/proyecto/<token>`): el storyboard de cada video; abre su revisión (observaciones y aprobación).
 * - **Revisión de los videos** (`/api/revision-videos/<token>`): los videos terminados; abre la revisión del video
 *   (el video con las miniaturas de sus planos y observaciones por plano).
 */
export interface ProjectPageVideo {
  id: string;
  title: string;
  /** Ruta pública de la revisión (del storyboard o del video). */
  href: string;
  thumb?: string;
  durationSec?: number;
  openComments: number;
  approved: boolean;
}

export interface ProjectPage {
  kind: ProjectShareKind;
  name: string;
  description?: string | null;
  logo?: string | null;
  videos: ProjectPageVideo[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const dur = (s?: number) => (s === undefined ? '' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);

export function projectGoneHtml(): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Link no disponible</title>
<style>html,body{margin:0;background:#0d0e12;color:#eef0f4;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}main{max-width:520px;margin:0 auto;padding:14vh 20px;text-align:center}p{color:#9aa0ad}</style></head>
<body><main><h1 style="font-size:21px">Este link ya no está disponible</h1><p>Se desactivó o cambió. Pide uno nuevo a quien te lo envió.</p></main></body></html>`;
}

export function projectPageHtml(p: ProjectPage): string {
  const videos = p.kind === 'videos';
  const obs = (n: number) => `<span class="chip warn">${n} observaci${n === 1 ? 'ón' : 'ones'}</span>`;
  const card = (v: ProjectPageVideo, i: number) => {
    const status = videos
      ? [v.durationSec !== undefined ? `<span class="chip">${dur(v.durationSec)}</span>` : '', v.openComments ? obs(v.openComments) : ''].join('')
      : v.approved
        ? '<span class="chip ok">Aprobado</span>'
        : v.openComments
          ? obs(v.openComments)
          : '<span class="chip">Por revisar</span>';
    // El título ocupa todo el ancho y los chips van en su propia fila, debajo (T11c, ADR-124).
    // Si la miniatura no carga, queda el aviso de debajo (sin imagen rota).
    const thumb = v.thumb ? `<div class="nothumb">Vista previa no disponible</div><img loading="lazy" src="${esc(v.thumb)}" alt="" onerror="this.remove()">` : `<div class="nothumb">${videos ? 'Sin vista previa' : 'Sin fotogramas aún'}</div>`;
    return `<a class="card" href="${esc(v.href)}"><div class="th">${thumb}${videos ? '<span class="play"></span>' : ''}</div><div class="meta"><div class="head"><span class="n">${i + 1}</span><span class="t">${esc(v.title)}</span></div>${status ? `<div class="chips">${status}</div>` : ''}</div></a>`;
  };
  const what = videos ? 'Revisión de los videos' : 'Aprobación del storyboard';
  const hint = videos
    ? 'Los videos terminados. Ábrelos para verlos con las miniaturas de cada plano y deja tus observaciones en el plano que quieras cambiar.'
    : 'El storyboard de cada video: los fotogramas con la locución. Deja tus observaciones en cada fotograma o apruébalo.';
  const empty = videos ? 'Aún no hay videos terminados.' : 'Aún no hay storyboards para revisar.';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="data:,">
<title>${esc(p.name)} · ${what}</title>
<style>
*{box-sizing:border-box}
:root{--bg:#0d0e12;--panel:#15171d;--line:#262932;--soft:#9aa0ad;--text:#eef0f4;--ok:#3ecf8e;--warn:#f5b041}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.top{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.top img{height:34px;width:auto;max-width:150px;object-fit:contain}
.top b{font-size:16px}
.top span{display:block;color:var(--soft);font-size:12.5px}
main{max-width:1200px;margin:0 auto;padding:18px 20px 60px}
h1{font-size:15px;margin:0 0 4px}
.hint{color:var(--soft);font-size:13px;margin:0 0 14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.card{display:block;text-align:left;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;color:inherit;text-decoration:none;cursor:pointer;padding:0;font:inherit}
.card:hover{border-color:#3a3f4b}
.th{position:relative;aspect-ratio:16/9;background:#000}
.th img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.nothumb{display:grid;place-items:center;height:100%;color:var(--soft);font-size:12px}
.play{position:absolute;inset:0;margin:auto;width:52px;height:52px;border-radius:50%;background:rgba(255,255,255,.88)}
.play::after{content:"";position:absolute;left:21px;top:16px;border-left:15px solid #111;border-top:10px solid transparent;border-bottom:10px solid transparent}
.meta{display:grid;gap:7px;padding:10px 12px}
.head{display:flex;align-items:baseline;gap:8px;min-width:0}
.n{flex:none;color:var(--soft);font-variant-numeric:tabular-nums;font-size:12px}
.t{flex:1;min-width:0;font-size:13.5px;line-height:1.35;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--soft)}
.chip.ok{color:var(--ok);border-color:rgba(62,207,142,.4)}
.chip.warn{color:var(--warn);border-color:rgba(245,176,65,.4)}
.empty{color:var(--soft);padding:30px 0;text-align:center}
</style>
</head>
<body>
<div class="top">
  ${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ''}
  <div><b>${esc(p.name)}</b><span>${p.description ? esc(p.description) : `${p.videos.length} video${p.videos.length === 1 ? '' : 's'}`}</span></div>
</div>
<main>
  <h1>${what}</h1>
  <p class="hint">${hint}</p>
  ${p.videos.length ? `<div class="grid">${p.videos.map(card).join('')}</div>` : `<div class="empty">${empty}</div>`}
</main>
<script>addEventListener("pageshow",function(e){if(e.persisted)location.reload()})</script>
</body>
</html>
`;
}
