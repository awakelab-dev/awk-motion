import { brand } from '../brand/brand.js';

/**
 * Código para Articulate Rise 360 (hito 9, T3, ADR-103): un `<video>` por video para pegarlo en un bloque de
 * código de Rise, con el video, los subtítulos y la portada servidos desde la carpeta pública del bucket
 * (publicaciones, ADR-101) y, si se pidió, el logo dibujado en el video (ADR-102). Es el código que Leonardo
 * probó en Rise, tal cual: `<video controls crossorigin="anonymous">`, `<source>` MP4 y `<track>` .vtt. Nada más: el
 * bloque «Embed» de Rise rechaza el código con `playsinline`, `preload`, `poster` o `style` («Please enter a valid URL or
 * iframe», ADR-115).
 */

export interface RiseItem {
  title: string;
  video: string;
  subtitles?: string;
  poster?: string;
}

export interface RiseOptions {
  /** Subtítulos encendidos al empezar (`default` en el `<track>`). */
  subtitlesOn: boolean;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** El código de un video, listo para pegar. */
export function riseCode(it: RiseItem, o: RiseOptions): string {
  const lines = [
    `<video controls crossorigin="anonymous">`,
    `  <source src="${attr(it.video)}" type="video/mp4">`,
  ];
  if (it.subtitles) lines.push(`  <track kind="subtitles" src="${attr(it.subtitles)}" srclang="es" label="Español"${o.subtitlesOn ? ' default' : ''}>`);
  lines.push('</video>');
  return lines.join('\n');
}

const HOW = [
  'En Rise 360, añade un bloque «Embed» y pega el código del video.',
  'El video y los subtítulos se cargan desde la nube: no hace falta subir archivos a Rise.',
  `Si corriges el video en ${brand.name}, se actualiza solo en estas mismas direcciones (tarda unos minutos).`,
  `Si despublicas el video en ${brand.name}, el código deja de mostrarlo.`,
];

/** Documento de texto: título y código de cada video. */
export function riseTxt(title: string, items: RiseItem[], o: RiseOptions & { quality: string; logo: boolean; createdAt: Date }): string {
  const line = '─'.repeat(72);
  const out = [
    `Código para Rise 360 · ${title}`,
    `${items.length} video${items.length === 1 ? '' : 's'} · ${o.quality}${o.logo ? ' · con el logo del proyecto' : ''} · subtítulos ${o.subtitlesOn ? 'encendidos' : 'apagados'} al empezar`,
    `Generado el ${o.createdAt.toLocaleDateString('es-CL')}`,
    '',
    ...HOW.map((h) => `- ${h}`),
    '',
  ];
  items.forEach((it) => {
    out.push(line, it.title, line, riseCode(it, o), '');
  });
  return out.join('\n');
}

/**
 * Documento HTML: lo mismo con una vista previa de cada video (el mismo código) y un botón «Copiar». Sin
 * dependencias externas, neutro como el reproductor.
 */
export function riseHtml(title: string, items: RiseItem[], o: RiseOptions & { quality: string; logo: boolean; createdAt: Date }): string {
  const cards = items
    .map((it, i) => {
      const code = riseCode(it, o);
      return `<section class="card">
  <h2>${html(it.title)}</h2>
  <div class="preview">${code}</div>
  <div class="bar"><span>Código para pegar en Rise 360</span><button type="button" data-i="${i}">Copiar</button></div>
  <textarea id="c${i}" readonly spellcheck="false" rows="7">${html(code)}</textarea>
</section>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Código para Rise 360 · ${html(title)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#f4f4f5;color:#18181b;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:900px;margin:0 auto;padding:32px 16px 64px}
h1{font-size:22px;margin:0 0 4px}
.meta{color:#52525b;font-size:13px;margin:0 0 16px}
ul{margin:0 0 24px;padding-left:20px;color:#3f3f46;font-size:13px}
.card{background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:16px;margin:0 0 20px}
.card h2{font-size:16px;margin:0 0 12px}
.preview{border-radius:8px;overflow:hidden;background:#000}
.preview video{width:100%;height:auto;display:block}
.bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 6px;font-size:12px;color:#52525b}
button{border:1px solid #d4d4d8;background:#18181b;color:#fff;border-radius:8px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}
button.ok{background:#16a34a;border-color:#16a34a}
textarea{width:100%;resize:vertical;border:1px solid #e4e4e7;border-radius:8px;padding:10px;background:#fafafa;color:#27272a;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
</style>
</head>
<body>
<main>
<h1>Código para Rise 360 · ${html(title)}</h1>
<p class="meta">${items.length} video${items.length === 1 ? '' : 's'} · ${html(o.quality)}${o.logo ? ' · con el logo del proyecto' : ''} · subtítulos ${o.subtitlesOn ? 'encendidos' : 'apagados'} al empezar · ${html(o.createdAt.toLocaleDateString('es-CL'))}</p>
<ul>${HOW.map((h) => `<li>${html(h)}</li>`).join('')}</ul>
${cards}
</main>
<script>
document.addEventListener('click', function (e) {
  var b = e.target.closest('button[data-i]');
  if (!b) return;
  var t = document.getElementById('c' + b.getAttribute('data-i'));
  var done = function () { b.textContent = 'Copiado'; b.classList.add('ok'); setTimeout(function () { b.textContent = 'Copiar'; b.classList.remove('ok'); }, 2000); };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t.value).then(done, function () { t.select(); document.execCommand('copy'); done(); });
  else { t.select(); document.execCommand('copy'); done(); }
});
</script>
</body>
</html>
`;
}
