import type { ClipLogo, LogoSettings } from '@wilox/shared';
import { scormRuntime } from './scorm.js';

/**
 * Reproductor HTML de la descarga (hito 6, ADR-065): un index.html sin dependencias externas que funciona
 * sin internet, con doble clic o subido a Moodle. Portada (fotograma con máscara oscura y play grande),
 * controles propios, subtítulos apagados por defecto (dibujados como en la app, ADR-063/064) y el logo
 * dibujado con JavaScript sobre el video (escala con el reproductor y en pantalla completa). La pantalla
 * completa es la del reproductor, no la del video, para que el logo y los subtítulos sigan a la vista.
 *
 * Paquetes (ADR-068): index.html con el HTML, css/reproductor.css, js/reproductor.js, js/config.js (datos del
 * video), js/subtitulos.js (los subtítulos para el reproductor: un .vtt no se puede leer desde una página abierta
 * con doble clic, file://, pero un <script> sí), js/scorm.js en SCORM, img/portada.jpg e img/logo.(png|svg); al
 * lado, subtitulos.vtt y subtitulos.srt. La vista previa de la app y el "un solo .html" lo llevan todo dentro.
 */

export interface PlayerCue {
  start: number;
  end: number;
  text: string;
}

export interface PlayerOptions {
  title: string;
  /** Video junto al HTML ("video.mp4") o URL (vista previa en la app). */
  videoSrc?: string;
  /** Video dentro del HTML (un solo archivo), en base64. */
  videoBase64?: string;
  /** Portada: data URL (todo dentro) o archivo JPEG (paquete). */
  posterDataUrl?: string;
  posterJpeg?: Buffer;
  cues: PlayerCue[];
  /** Logo como data URL; en un paquete se escribe como img/logo.png o .svg. */
  logoDataUrl?: string;
  settings: LogoSettings;
  durationSec: number;
  /** Tramos de los clips (s) y esquina del logo en cada uno (ADR-066); sin esquina, la de los ajustes. */
  clips?: { index: number; start: number; end: number }[];
  clipCorners?: Record<string, ClipLogo>;
  /** Vista previa en la app: acepta ajustes del logo por postMessage. */
  preview?: boolean;
  /** Dentro de un paquete SCORM (ADR-066): avisa al LMS del avance, lo completa y recuerda dónde quedó. */
  scorm?: '1.2' | '2004';
  /** Link para compartir (hito 7, ADR-083): subtítulos encendidos al abrir y fuera de los buscadores. */
  share?: boolean;
}

/** JSON seguro dentro de <script> (sin "</script>" ni "<!--"). */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const PLAYER_CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#0b0b0f;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
body{display:flex;align-items:center;justify-content:center}
.player{position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;outline:none}
.player.pseudo-fs{position:fixed;inset:0;z-index:2147483647}
.stage{position:relative;width:min(100%,calc(100vh*16/9));aspect-ratio:16/9;overflow:hidden;background:#000;user-select:none;-webkit-user-select:none}
.stage video{position:absolute;inset:0;width:100%;height:100%;display:block;background:#000}
.poster{position:absolute;inset:0;background:#000 center/cover no-repeat;cursor:pointer;z-index:5;display:flex;align-items:center;justify-content:center}
.poster::before{content:"";position:absolute;inset:0;background:rgba(0,0,0,.45)}
.poster.hidden{display:none}
.bigplay{position:relative;width:15%;max-width:150px;min-width:56px;aspect-ratio:1;border-radius:50%;border:0;background:rgba(255,255,255,.88);cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 32px rgba(0,0,0,.35);transition:transform .15s ease,background .15s ease}
.bigplay:hover{transform:scale(1.06);background:#fff}
.bigplay svg{width:38%;height:38%;margin-left:8%;fill:#111}
.logo{position:absolute;z-index:6;pointer-events:none;line-height:0;transition:opacity .25s ease}
.logo img{display:block;width:100%;height:auto}
.caption{position:absolute;left:0;right:0;z-index:7;display:flex;justify-content:center;padding:0 4%;pointer-events:none;transition:bottom .2s ease}
.caption span{color:#fff;background:rgba(0,0,0,.6);border-radius:.3em;padding:.15em .5em;line-height:1.35;text-align:center}
.caption.off{display:none}
.controls{position:absolute;left:0;right:0;bottom:0;z-index:8;padding:28px 14px 10px;background:linear-gradient(transparent,rgba(0,0,0,.65));display:flex;flex-direction:column;gap:6px;transition:opacity .25s ease}
.player.idle .controls,.player:not(.started) .controls{opacity:0;pointer-events:none}
.player.idle{cursor:none}
.bar{position:relative;height:16px;display:flex;align-items:center;cursor:pointer;touch-action:none}
.track{position:relative;width:100%;height:4px;border-radius:2px;background:rgba(255,255,255,.3);transition:height .1s}
.bar:hover .track{height:6px}
.fill{position:absolute;left:0;top:0;bottom:0;border-radius:2px;background:#fff}
.knob{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;background:#fff}
.row{display:flex;align-items:center;gap:6px}
.btn{width:36px;height:36px;border:0;border-radius:8px;background:transparent;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0}
.btn:hover{background:rgba(255,255,255,.15)}
.btn svg{width:22px;height:22px;fill:currentColor}
.btn.on{background:rgba(255,255,255,.22)}
.time{font-size:13px;font-variant-numeric:tabular-nums;opacity:.9;margin:0 6px;white-space:nowrap}
.vol{width:80px;accent-color:#fff}
.grow{flex:1}
@media (max-width:520px){.vol{display:none}.time{font-size:12px}}
`;

/** El reproductor (igual para todos los videos): lee los datos de window.WILOX_CONFIG o del <script id="config">. */
const PLAYER_JS = `(function(){
  // Datos del video: en js/config.js y js/subtitulos.js (paquetes) o dentro del HTML (vista previa y un solo .html).
  var C = window.WILOX_CONFIG || JSON.parse(document.getElementById('config').textContent);
  if (window.WILOX_CUES) C.cues = window.WILOX_CUES;
  C.cues = C.cues || [];
  var $ = function(id){ return document.getElementById(id); };
  var player = $('player'), stage = $('stage'), video = $('video'), poster = $('poster');
  var caption = $('caption'), captionText = $('captionText'), logo = $('logo'), logoImg = $('logoImg');
  var fill = $('fill'), knob = $('knob'), bar = $('bar'), time = $('time'), vol = $('vol');
  var ccOn = false, idleTimer = 0, started = false;
  var PLAY = '<path d="M7 5v14l12-7z"/>', PAUSE = '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';
  var VOL = '<path d="M4 9v6h4l5 5V4L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/>';
  var MUTED = '<path d="M4 9v6h4l5 5V4L8 9zm15.6 3 2.2-2.2-1.4-1.4-2.2 2.2-2.2-2.2-1.4 1.4 2.2 2.2-2.2 2.2 1.4 1.4 2.2-2.2 2.2 2.2 1.4-1.4z"/>';

  // Video dentro del HTML (un solo archivo): base64 → Blob, por partes para no agotar la memoria.
  var data = $('videoData');
  if (data) {
    var b64 = data.textContent.replace(/\\s+/g, ''), parts = [], CH = 4 * 1024 * 1024;
    for (var i = 0; i < b64.length; i += CH) {
      var bin = atob(b64.slice(i, i + CH)), arr = new Uint8Array(bin.length);
      for (var j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
      parts.push(arr);
    }
    video.src = URL.createObjectURL(new Blob(parts, { type: 'video/mp4' }));
    data.remove();
  }

  function fmt(s){ s = Math.max(0, Math.floor(s || 0)); var m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); }
  function dur(){ return isFinite(video.duration) && video.duration > 0 ? video.duration : C.duration; }

  // Logo: tamaño, margen y realce en proporción al ancho del video (también en pantalla completa).
  // Esquina del logo en el instante t: la del clip que se ve (ADR-066; 'none' = ese clip sin logo, ADR-067) o
  // la de los ajustes.
  function cornerAt(t){
    for (var i = 0; i < C.clips.length; i++) {
      var c = C.clips[i];
      if (t >= c.start && t < c.end) return C.clipCorners[String(c.index)] || C.settings.corner;
    }
    return C.settings.corner;
  }
  var shownCorner = null, moving = 0;
  // Al cambiar de clip, si cambia la esquina, el logo se desvanece, se mueve y vuelve a aparecer.
  function followCorner(){
    if (!C.logo) return;
    var c = cornerAt(video.currentTime);
    if (c === shownCorner || moving) return;
    if (shownCorner === null || video.paused) { layoutLogo(); return; }
    logo.style.opacity = 0;
    moving = setTimeout(function(){ moving = 0; layoutLogo(); }, 260);
  }
  function layoutLogo(){
    var s = C.settings, W = stage.clientWidth, corner = cornerAt(video.currentTime);
    shownCorner = corner;
    if (!C.logo || corner === 'none') { logo.hidden = true; return; }
    logo.hidden = false;
    if (logoImg.getAttribute('src') !== C.logo) logoImg.src = C.logo;
    var w = W * s.widthPct / 100, m = W * s.marginPct / 100;
    logo.style.width = w + 'px';
    logo.style.opacity = s.opacity;
    logo.style.top = logo.style.bottom = logo.style.left = logo.style.right = '';
    logo.style[corner.charAt(0) === 't' ? 'top' : 'bottom'] = m + 'px';
    logo.style[corner.charAt(1) === 'l' ? 'left' : 'right'] = m + 'px';
    var pad = 0;
    logo.style.background = ''; logo.style.borderRadius = ''; logo.style.filter = ''; logo.style.padding = '';
    if (s.effect === 'shadow') logo.style.filter = 'drop-shadow(0 ' + (w * 0.02) + 'px ' + (w * 0.05) + 'px rgba(0,0,0,.6))';
    if (s.effect === 'glow') logo.style.filter = 'drop-shadow(0 0 ' + (w * 0.05) + 'px rgba(255,255,255,.95)) drop-shadow(0 0 ' + (w * 0.02) + 'px rgba(255,255,255,.9))';
    if (s.effect === 'dark' || s.effect === 'light') {
      pad = w * 0.08;
      logo.style.padding = pad + 'px';
      logo.style.borderRadius = (w * 0.06) + 'px';
      logo.style.background = s.effect === 'dark' ? 'rgba(0,0,0,.45)' : 'rgba(255,255,255,.72)';
      logo.style.width = (w + 2 * pad) + 'px';
    }
  }

  // Subtítulos: letra al 1,6 % del ancho; bien abajo mientras se reproduce y sobre los controles si se ven.
  function layoutCaption(){
    var W = stage.clientWidth, size = Math.max(12, Math.round(W * 0.016));
    captionText.style.fontSize = size + 'px';
    var controlsUp = !player.classList.contains('idle') && started;
    caption.style.bottom = (controlsUp || video.paused ? $('controls').offsetHeight + 4 : Math.max(6, size * 0.45)) + 'px';
  }
  function updateCaption(){
    var t = video.currentTime, cue = null;
    for (var i = 0; i < C.cues.length; i++) { if (t >= C.cues[i].start && t < C.cues[i].end) { cue = C.cues[i]; break; } }
    captionText.textContent = cue ? cue.text : '';
    caption.classList.toggle('off', !ccOn || !cue || !started);
  }

  function update(){
    var d = dur(), p = d ? Math.min(1, video.currentTime / d) : 0;
    fill.style.width = (p * 100) + '%';
    knob.style.left = (p * 100) + '%';
    time.textContent = fmt(video.currentTime) + ' / ' + fmt(d);
    $('playIcon').innerHTML = video.paused ? PLAY : PAUSE;
    $('muteIcon').innerHTML = video.muted || video.volume === 0 ? MUTED : VOL;
    updateCaption();
    followCorner();
  }
  function loop(){ update(); if (!video.paused) requestAnimationFrame(loop); }

  function play(){ started = true; player.classList.add('started'); poster.classList.add('hidden'); video.play(); }
  function toggle(){ if (video.paused) play(); else video.pause(); }
  function seek(dt){ video.currentTime = Math.max(0, Math.min(dur(), video.currentTime + dt)); wake(); }
  function setCC(v){ ccOn = v; $('cc').classList.toggle('on', ccOn); updateCaption(); layoutCaption(); }
  function wake(){
    player.classList.remove('idle');
    clearTimeout(idleTimer);
    if (!video.paused) idleTimer = setTimeout(function(){ player.classList.add('idle'); layoutCaption(); }, 2500);
    layoutCaption();
  }

  var isFs = function(){ return document.fullscreenElement === player || document.webkitFullscreenElement === player || player.classList.contains('pseudo-fs'); };
  function fullscreen(){
    if (isFs()) {
      if (player.classList.contains('pseudo-fs')) player.classList.remove('pseudo-fs');
      else (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else {
      var req = player.requestFullscreen || player.webkitRequestFullscreen;
      if (req) req.call(player); else player.classList.add('pseudo-fs'); // iPhone: a pantalla llena con CSS
    }
    setTimeout(relayout, 120);
  }

  function relayout(){ layoutLogo(); layoutCaption(); }

  $('bigplay').addEventListener('click', function(e){ e.stopPropagation(); play(); });
  poster.addEventListener('click', play);
  video.addEventListener('click', toggle);
  $('play').addEventListener('click', toggle);
  $('mute').addEventListener('click', function(){ video.muted = !video.muted; update(); });
  vol.addEventListener('input', function(){ video.volume = Number(vol.value); video.muted = video.volume === 0; update(); });
  $('cc').addEventListener('click', function(){ setCC(!ccOn); });
  if (C.cc) setCC(true);
  $('fs').addEventListener('click', fullscreen);
  video.addEventListener('play', function(){ started = true; player.classList.add('started'); poster.classList.add('hidden'); wake(); loop(); });
  video.addEventListener('pause', function(){ wake(); update(); });
  video.addEventListener('timeupdate', update);
  video.addEventListener('loadedmetadata', update);
  video.addEventListener('ended', function(){ wake(); update(); });
  ['mousemove', 'touchstart', 'pointerdown'].forEach(function(ev){ player.addEventListener(ev, wake, { passive: true }); });

  // Barra de progreso: clic o arrastre.
  var dragging = false;
  function seekTo(e){ var r = bar.getBoundingClientRect(); var x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); video.currentTime = x * dur(); update(); }
  bar.addEventListener('pointerdown', function(e){ dragging = true; bar.setPointerCapture(e.pointerId); seekTo(e); });
  bar.addEventListener('pointermove', function(e){ if (dragging) seekTo(e); });
  bar.addEventListener('pointerup', function(){ dragging = false; });

  // Atajos: espacio/k, flechas, m, c, f.
  document.addEventListener('keydown', function(e){
    if (e.target && e.target.tagName === 'INPUT' && e.key !== ' ') return;
    var k = e.key.toLowerCase();
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
    else if (k === 'arrowright') { e.preventDefault(); seek(5); }
    else if (k === 'arrowleft') { e.preventDefault(); seek(-5); }
    else if (k === 'arrowup') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.1); vol.value = video.volume; update(); }
    else if (k === 'arrowdown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.1); vol.value = video.volume; update(); }
    else if (k === 'm') { video.muted = !video.muted; update(); }
    else if (k === 'c') { setCC(!ccOn); }
    else if (k === 'f') { fullscreen(); }
  });
  document.addEventListener('fullscreenchange', relayout);
  document.addEventListener('webkitfullscreenchange', relayout);
  if (window.ResizeObserver) new ResizeObserver(relayout).observe(stage); else window.addEventListener('resize', relayout);

  // Vista previa en la app: los ajustes del logo llegan en vivo.
  if (C.preview) window.addEventListener('message', function(e){
    if (!e.data || e.data.type !== 'wilox-delivery') return;
    if (e.data.settings) C.settings = e.data.settings;
    if (e.data.clipCorners) C.clipCorners = e.data.clipCorners;
    if ('logo' in e.data) C.logo = e.data.logo;
    if (e.data.poster) poster.style.backgroundImage = "url('" + e.data.poster + "')";
    // Ver un clip (al elegir su esquina): sin portada, en pausa, en ese segundo.
    if (typeof e.data.seek === 'number') { poster.classList.add('hidden'); video.pause(); video.currentTime = e.data.seek; update(); }
    layoutLogo();
  });

  video.addEventListener('seeked', layoutLogo);
  relayout();
  update();
})();
`;

function config(o: PlayerOptions, logo: string | null, withCues = true) {
  return {
    title: o.title,
    ...(withCues ? { cues: o.cues } : {}),
    logo,
    settings: o.settings,
    duration: o.durationSec,
    preview: !!o.preview,
    embedded: !!o.videoBase64,
    clips: o.clips ?? [],
    clipCorners: o.clipCorners ?? {},
    ...(o.share ? { cc: true } : {}),
  };
}

function page(o: PlayerOptions, head: string, poster: string | undefined, tail: string) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${o.share ? '\n<meta name="robots" content="noindex, nofollow">' : ''}
<title>${esc(o.title)}</title>
${head}
</head>
<body>
<div class="player" id="player" tabindex="0">
  <div class="stage" id="stage">
    <video id="video" playsinline preload="metadata"${o.videoSrc ? ` src="${esc(o.videoSrc)}"` : ''}></video>
    <div class="logo" id="logo" hidden><img id="logoImg" alt=""></div>
    <div class="caption off" id="caption"><span id="captionText"></span></div>
    <div class="poster" id="poster"${poster ? ` style="background-image:url('${poster}')"` : ''}>
      <button class="bigplay" id="bigplay" aria-label="Reproducir"><svg viewBox="0 0 24 24"><path d="M6 4.5v15l13-7.5z"/></svg></button>
    </div>
    <div class="controls" id="controls">
      <div class="bar" id="bar" role="slider" aria-label="Progreso"><div class="track"><div class="fill" id="fill"></div><div class="knob" id="knob"></div></div></div>
      <div class="row">
        <button class="btn" id="play" aria-label="Reproducir (espacio)"><svg viewBox="0 0 24 24" id="playIcon"><path d="M7 5v14l12-7z"/></svg></button>
        <button class="btn" id="mute" aria-label="Silenciar (m)"><svg viewBox="0 0 24 24" id="muteIcon"><path d="M4 9v6h4l5 5V4L8 9zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg></button>
        <input class="vol" id="vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volumen">
        <span class="time" id="time">0:00 / 0:00</span>
        <span class="grow"></span>
        <button class="btn" id="cc" aria-label="Subtítulos (c)" title="Subtítulos (c)"><svg viewBox="0 0 24 24"><path d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm-8 7H9.5v-.5h-2v3h2V13H11v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1zm7 0h-1.5v-.5h-2v3h2V13H18v1a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1z"/></svg></button>
        <button class="btn" id="fs" aria-label="Pantalla completa (f)" title="Pantalla completa (f)"><svg viewBox="0 0 24 24"><path d="M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z"/></svg></button>
      </div>
    </div>
  </div>
</div>
${tail}
</body>
</html>
`;
}

/** Todo en un HTML: vista previa en la app y el "un solo .html" (con el video dentro). */
export function playerHtml(o: PlayerOptions): string {
  return page(
    o,
    `<style>${PLAYER_CSS}</style>`,
    o.posterDataUrl,
    [
      `<script type="application/json" id="config">${safeJson(config(o, o.logoDataUrl ?? null))}</script>`,
      o.videoBase64 ? `<script type="application/octet-stream" id="videoData">${o.videoBase64}</script>` : '',
      `<script>${PLAYER_JS}</script>`,
      o.scorm ? `<script>${scormRuntime(o.scorm)}</script>` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/** Logo de un data URL como archivo del paquete. */
function logoFile(dataUrl: string | undefined): { name: string; data: Buffer } | undefined {
  const m = dataUrl?.match(/^data:(image\/png|image\/svg\+xml);base64,(.+)$/);
  if (!m) return undefined;
  return { name: `img/logo.${m[1] === 'image/png' ? 'png' : 'svg'}`, data: Buffer.from(m[2], 'base64') };
}

/**
 * Paquete del reproductor (ADR-068): el HTML, el CSS, el JavaScript, los datos, los subtítulos, la portada y
 * el logo en archivos separados (rutas relativas a la carpeta del video). `subtitles`: los .vtt y .srt que van
 * al lado (null = no los agrega, p. ej. el ZIP completo ya trae final.vtt y final.srt).
 */
export function playerFiles(o: PlayerOptions, subtitles: { vtt: string; srt: string } | null): Record<string, string | Buffer> {
  const logo = logoFile(o.logoDataUrl);
  const files: Record<string, string | Buffer> = {
    'css/reproductor.css': PLAYER_CSS.trimStart(),
    'js/reproductor.js': PLAYER_JS.trimStart(),
    'js/config.js': `window.WILOX_CONFIG = ${safeJson(config(o, logo?.name ?? null, false))};\n`,
    'js/subtitulos.js': `window.WILOX_CUES = ${safeJson(o.cues)};\n`,
  };
  if (o.scorm) files['js/scorm.js'] = scormRuntime(o.scorm);
  if (o.posterJpeg) files['img/portada.jpg'] = o.posterJpeg;
  if (logo) files[logo.name] = logo.data;
  if (subtitles) {
    files['subtitulos.vtt'] = subtitles.vtt;
    files['subtitulos.srt'] = subtitles.srt;
  }
  files['index.html'] = page(
    o,
    '<link rel="stylesheet" href="css/reproductor.css">',
    o.posterJpeg ? 'img/portada.jpg' : undefined,
    ['<script src="js/config.js"></script>', '<script src="js/subtitulos.js"></script>', '<script src="js/reproductor.js"></script>', o.scorm ? '<script src="js/scorm.js"></script>' : '']
      .filter(Boolean)
      .join('\n'),
  );
  return files;
}
