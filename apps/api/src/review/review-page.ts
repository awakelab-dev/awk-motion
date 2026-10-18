import { REVIEW_AUTHOR_MAX, REVIEW_TEXT_MAX, type ClipLogo, type LogoSettings } from '@wilox/shared';

/**
 * Página del link de revisión (hito 8, A4, ADR-098): HTML propio sin dependencias externas, neutra como el
 * reproductor de las descargas (con el logo del proyecto si lo tiene). Los fotogramas son slides; la locución
 * avanza sola de un tramo al siguiente (tramos por clip, ADR-092) y resalta la palabra que se oye; el cliente
 * deja observaciones por fotograma y puede aprobar el storyboard.
 *
 * Modo `video` (T6b, ADR-116, link de revisión de los videos del proyecto): la misma página con el video terminado en el
 * escenario. Las miniaturas son los fotogramas de cada plano; al reproducir, el plano y la palabra que se oye avanzan con
 * el video; un clic en una miniatura salta a su plano. Las observaciones van al plano. Sin aprobación.
 */

export interface ReviewSlide {
  index: number;
  label: string;
  version: number;
  /** URL de la imagen (JPEG); sin el campo, el fotograma aún se está haciendo. */
  image?: string;
  /** Tramo de la locución (s). */
  start: number;
  end: number;
  /** Palabras del tramo: texto, inicio y fin (s). */
  words: { t: string; s: number; e: number }[];
}

export interface PublicComment {
  id: string;
  keyframeIndex: number;
  author: string;
  text: string;
  createdAt: string;
  resolved: boolean;
  outdated: boolean;
}

export interface ReviewDeck {
  /** `storyboard` (por defecto) o `video` (T6b). */
  mode?: 'storyboard' | 'video';
  /** Ruta de la revisión (`/api/revision/<token>` o, en el link del proyecto, `/api/proyecto/<token>/v/<id>/revision`). */
  base: string;
  /** Volver (link del proyecto, T6): a la página del proyecto. */
  back?: { href: string; label: string };
  title: string;
  project: string;
  logo?: string;
  /** URL de la locución (m4a); sin el campo, sin audio. */
  audio?: string;
  /** Modo video: URL del final (MP4). */
  video?: string;
  /** Modo video: el logo del proyecto encima del video, como en el reproductor (esquina por clip). */
  overlay?: { logo: string; settings: LogoSettings; clips: { index: number; start: number; end: number }[]; clipCorners: Record<string, ClipLogo> };
  slides: ReviewSlide[];
  comments: PublicComment[];
  approval?: { author: string; at: string; outdated: boolean };
}

/** JSON seguro dentro de <script>. */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const CSS = `
*{box-sizing:border-box}
[hidden]{display:none!important}
:root{--bg:#0d0e12;--panel:#15171d;--line:#262932;--soft:#9aa0ad;--text:#eef0f4;--accent:#7c8cff;--ok:#3ecf8e;--warn:#f5b041}
html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
button,textarea,input{font:inherit;color:inherit}
button{cursor:pointer}
.top{display:flex;align-items:center;gap:14px;padding:12px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.top img{height:32px;width:auto;max-width:140px;object-fit:contain}
.back{color:var(--soft);text-decoration:none;font-size:13px;border:1px solid var(--line);border-radius:8px;padding:5px 10px}
.back:hover{color:var(--text)}
.ttl{flex:1;min-width:200px}
.ttl b{display:block;font-size:15px;font-weight:600}
.ttl span{color:var(--soft);font-size:12.5px}
.approve{border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:8px 14px;font-weight:600}
.approve:hover{border-color:var(--ok);color:var(--ok)}
.approved{display:flex;align-items:center;gap:8px;color:var(--ok);font-size:13px;font-weight:600}
.approved small{display:block;color:var(--warn);font-weight:500}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:20px;padding:20px;max-width:1500px;margin:0 auto}
@media (max-width:960px){.wrap{grid-template-columns:1fr;padding:12px}}
.show{display:flex;flex-direction:column;gap:12px;min-width:0}
.stage{position:relative;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden}
.stage img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;transition:opacity .35s ease}
.stage img.on{opacity:1}
.stage video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;cursor:pointer}
.vlogo{position:absolute;z-index:3;pointer-events:none;line-height:0;transition:opacity .25s ease}
.stage .vlogo img{position:static;display:block;width:100%;height:auto;opacity:1;object-fit:initial;transition:none}
.stage .wait{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--soft);font-size:13px}
.info{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:-4px}
.tag{border:1px solid var(--line);border-radius:6px;padding:1px 8px;font:600 12px/1.6 ui-monospace,Menlo,monospace}
.tag:empty,.count:empty{display:none}
.count{color:var(--soft);font-size:12px;font-variant-numeric:tabular-nums}
.say{min-height:3.2em;font-size:17px;line-height:1.55;color:var(--soft)}
.say .w.on{color:var(--text);background:rgba(124,140,255,.22);border-radius:4px}
.say .w.past{color:var(--text)}
.say.none{font-size:13px}
.ctl{display:flex;align-items:center;gap:8px}
.btn{width:40px;height:40px;border:1px solid var(--line);border-radius:10px;background:var(--panel);display:flex;align-items:center;justify-content:center;padding:0;flex:none}
.btn:hover{border-color:var(--soft)}
.btn svg{width:20px;height:20px;fill:currentColor}
.btn.main{width:48px;height:48px;background:var(--text);color:#111;border-color:var(--text)}
.btn:disabled{opacity:.35;cursor:default}
.tl{flex:1;display:flex;gap:3px;height:28px;align-items:center;cursor:pointer;min-width:0}
.seg{position:relative;height:8px;border-radius:3px;background:var(--line);overflow:hidden;min-width:6px}
.seg.cur{height:12px}
.seg i{position:absolute;left:0;top:0;bottom:0;background:var(--text);width:0}
.seg.done i{width:100%;background:var(--soft)}
.seg.has::after{content:"";position:absolute;right:2px;top:50%;width:4px;height:4px;margin-top:-2px;border-radius:50%;background:var(--warn)}
.thumbs{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px}
.th{position:relative;flex:none;width:132px;border:2px solid transparent;border-radius:8px;background:var(--panel);padding:0;overflow:hidden}
.th.cur{border-color:var(--accent)}
.th img,.th .ph{display:block;width:100%;aspect-ratio:16/9;object-fit:cover;background:#000}
.th span{display:block;font:600 11px/1.8 ui-monospace,Menlo,monospace;color:var(--soft);text-align:left;padding:0 6px}
.th em{position:absolute;top:4px;right:4px;font-style:normal;background:var(--warn);color:#111;border-radius:9px;padding:0 6px;font-size:11px;font-weight:700}
.side{background:var(--panel);border:1px solid var(--line);border-radius:12px;display:flex;flex-direction:column;min-height:0;max-height:calc(100vh - 110px);position:sticky;top:20px}
@media (max-width:960px){.side{position:static;max-height:none}}
.tabs{display:flex;border-bottom:1px solid var(--line)}
.tabs button{flex:1;border:0;background:none;padding:12px 8px;color:var(--soft);font-weight:600;font-size:13px;border-bottom:2px solid transparent}
.tabs button.on{color:var(--text);border-bottom-color:var(--accent)}
.list{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;min-height:120px}
.empty{color:var(--soft);font-size:13px;padding:6px 0}
.c{border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:var(--bg)}
.c.res{opacity:.6}
.c header{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;font-size:12px;color:var(--soft)}
.c header b{color:var(--text);font-size:13px}
.c header a{color:var(--accent);font:600 11px ui-monospace,Menlo,monospace;cursor:pointer}
.c p{margin:4px 0 0;white-space:pre-wrap;word-wrap:break-word}
.lbl{font-size:11px;border-radius:5px;padding:0 5px}
.lbl.ok{background:rgba(62,207,142,.15);color:var(--ok)}
.lbl.old{background:rgba(245,176,65,.15);color:var(--warn)}
.form{border-top:1px solid var(--line);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.form input,.form textarea{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px;outline:none}
.form input:focus,.form textarea:focus{border-color:var(--accent)}
.form textarea{min-height:76px;resize:vertical}
.form .row{display:flex;align-items:center;gap:8px;justify-content:space-between;font-size:12px;color:var(--soft)}
.form .row a{color:var(--accent);cursor:pointer}
.send{border:0;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;padding:8px 14px}
.send:disabled{opacity:.5;cursor:default}
.err{color:#ff7b7b;font-size:12.5px}
.dlg{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;padding:16px}
.dlg[hidden]{display:none}
.dlg>div{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;max-width:440px;width:100%;display:flex;flex-direction:column;gap:12px}
.dlg h2{margin:0;font-size:16px}
.dlg p{margin:0;color:var(--soft)}
.dlg input{width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.dlg .row{display:flex;gap:8px;justify-content:flex-end}
.ghost{border:1px solid var(--line);background:none;border-radius:8px;padding:8px 14px}
.okb{border:0;border-radius:8px;background:var(--ok);color:#06140d;font-weight:700;padding:8px 14px}
.show:fullscreen,.show.pseudo-fs{background:#000;padding:16px;justify-content:center}
.show.pseudo-fs{position:fixed;inset:0;z-index:40}
.show:fullscreen .stage,.show.pseudo-fs .stage,.show:fullscreen .info,.show.pseudo-fs .info{width:min(100%,calc((100vh - 215px)*16/9));margin:0 auto;border-radius:0}
.show:fullscreen .thumbs,.show.pseudo-fs .thumbs{display:none}
.show:fullscreen .say,.show.pseudo-fs .say{text-align:center;font-size:22px}
.foot{color:var(--soft);font-size:12px;text-align:center;padding:4px 0 20px}
`;

const JS = `(function(){
  var D = JSON.parse(document.getElementById('deck').textContent);
  var $ = function(id){ return document.getElementById(id); };
  var NAME_KEY = 'wilox-review-name';
  var S = D.slides, cur = 0, tab = 'one', playing = false, autoNext = true;
  var VIDEO = D.mode === 'video';
  // En el modo video, el propio video hace de "locución": misma línea de tiempo, mismos controles.
  var audio = VIDEO ? (D.video ? $('vid') : null) : (D.audio ? new Audio(D.audio) : null);
  if (audio) audio.preload = 'auto';
  var imgs = {}, stage = $('stage'), say = $('say');
  var PLAY = '<svg viewBox="0 0 24 24"><path d="M7 5v14l12-7z"/></svg>', PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';

  function getName(){ try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; } }
  function setName(v){ try { localStorage.setItem(NAME_KEY, v); } catch (e) {} }
  function fmtDate(iso){ var d = new Date(iso); return d.toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }); }
  function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function commentsOf(i){ return D.comments.filter(function(c){ return c.keyframeIndex === i; }); }
  function openOf(i){ return commentsOf(i).filter(function(c){ return !c.resolved; }).length; }

  // Imágenes: una capa por slide, con fundido; se cargan la actual y las vecinas.
  function img(i){
    var s = S[i];
    if (VIDEO || !s.image) return null;
    if (!imgs[i]) { var im = new Image(); im.alt = s.label; im.decoding = 'async'; im.src = s.image; stage.appendChild(im); imgs[i] = im; }
    return imgs[i];
  }

  function show(i){
    cur = Math.max(0, Math.min(S.length - 1, i));
    var s = S[cur];
    for (var k in imgs) imgs[k].classList.remove('on');
    var im = img(cur);
    $('wait').hidden = VIDEO ? !!audio : !!im;
    if (im) im.classList.add('on');
    if (cur + 1 < S.length) img(cur + 1);
    if (cur > 0) img(cur - 1);
    $('tag').textContent = s.label + (s.version > 1 ? ' · v' + s.version : '');
    $('count').textContent = (cur + 1) + ' / ' + S.length;
    $('prev').disabled = cur === 0;
    $('next').disabled = cur === S.length - 1;
    renderSay();
    renderTimeline();
    renderThumbs();
    renderList();
  }

  function renderSay(){
    var s = S[cur];
    say.innerHTML = '';
    say.className = 'say';
    if (!s.words.length) { say.classList.add('none'); say.textContent = cur === 0 ? 'Portada' : VIDEO ? 'Sin locución en este plano.' : 'Sin locución en este tramo.'; return; }
    s.words.forEach(function(w, j){ var sp = el('span', 'w', w.t); sp.dataset.j = j; say.appendChild(sp); say.appendChild(document.createTextNode(' ')); });
    highlight();
  }

  function highlight(){
    if (!audio) return;
    var t = audio.currentTime, s = S[cur];
    var spans = say.querySelectorAll('.w');
    for (var j = 0; j < spans.length; j++) {
      var w = s.words[j];
      spans[j].classList.toggle('on', t >= w.s && t < w.e + 0.05);
      spans[j].classList.toggle('past', t >= w.e + 0.05);
    }
  }

  function renderTimeline(){
    var tl = $('tl'); tl.innerHTML = '';
    var total = audio && S.length ? Math.max(0.001, S[S.length - 1].end) : S.length;
    S.forEach(function(s, i){
      var seg = el('div', 'seg' + (i === cur ? ' cur' : '') + (i < cur ? ' done' : '') + (openOf(s.index) ? ' has' : ''));
      var len = audio ? Math.max(0, s.end - s.start) : 1;
      seg.style.flex = String(Math.max(len, total * 0.012));
      seg.title = s.label;
      seg.appendChild(el('i'));
      seg.onclick = function(){ go(i); };
      tl.appendChild(seg);
    });
    progress();
  }

  function progress(){
    if (!audio) return;
    var seg = $('tl').children[cur]; if (!seg) return;
    var s = S[cur], len = s.end - s.start;
    seg.firstChild.style.width = len > 0 ? Math.min(100, Math.max(0, (audio.currentTime - s.start) / len * 100)) + '%' : '0';
  }

  function renderThumbs(){
    var box = $('thumbs');
    if (!box.children.length) {
      S.forEach(function(s, i){
        var b = el('button', 'th');
        if (s.image) { var im = el('img'); im.loading = 'lazy'; im.src = s.image; im.alt = s.label; b.appendChild(im); } else b.appendChild(el('div', 'ph'));
        b.appendChild(el('span', '', s.label));
        b.onclick = function(){ go(i); };
        box.appendChild(b);
      });
    }
    S.forEach(function(s, i){
      var b = box.children[i];
      b.classList.toggle('cur', i === cur);
      var badge = b.querySelector('em'), n = openOf(s.index);
      if (n && !badge) { badge = el('em'); b.appendChild(badge); }
      if (badge) { if (n) badge.textContent = n; else badge.remove(); }
    });
    var c = box.children[cur]; if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderList(){
    var list = $('list'); list.innerHTML = '';
    var s = S[cur];
    $('tabOne').textContent = (VIDEO ? 'Este plano (' : 'Este fotograma (') + commentsOf(s.index).length + ')';
    $('tabAll').textContent = 'Todas (' + D.comments.length + ')';
    $('tabOne').classList.toggle('on', tab === 'one');
    $('tabAll').classList.toggle('on', tab === 'all');
    var items = tab === 'one' ? commentsOf(s.index) : D.comments;
    if (!items.length) list.appendChild(el('div', 'empty', tab === 'one' ? 'Aún no hay observaciones en ' + s.label + '. Escribe abajo lo que quieras cambiar en este ' + (VIDEO ? 'plano del video.' : 'fotograma.') : 'Aún no hay observaciones.'));
    items.forEach(function(c){
      var box = el('div', 'c' + (c.resolved ? ' res' : ''));
      var h = el('header');
      h.appendChild(el('b', '', c.author));
      h.appendChild(document.createTextNode(fmtDate(c.createdAt)));
      if (tab === 'all') { var a = el('a', '', 'K' + String(c.keyframeIndex).padStart(2, '0')); a.onclick = function(){ var i = S.findIndex(function(x){ return x.index === c.keyframeIndex; }); if (i >= 0) { tab = 'one'; go(i); } }; h.appendChild(a); }
      if (c.resolved) h.appendChild(el('span', 'lbl ok', 'Resuelta'));
      if (c.outdated) h.appendChild(el('span', 'lbl old', VIDEO ? 'Sobre una versión anterior del video' : 'Sobre una versión anterior'));
      box.appendChild(h);
      box.appendChild(el('p', '', c.text));
      list.appendChild(box);
    });
    list.scrollTop = list.scrollHeight;
    renderForm();
  }

  function renderForm(){
    var name = getName();
    $('nameRow').hidden = !!name;
    $('who').hidden = !name;
    if (name) $('whoName').textContent = name;
    $('text').placeholder = 'Observación sobre ' + S[cur].label + '…';
  }

  function renderApproval(){
    var a = D.approval, box = $('apprBox');
    box.innerHTML = '';
    if (VIDEO) return;
    if (a) {
      var d = el('div', 'approved');
      d.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
      var t = el('div'); t.appendChild(document.createTextNode('Aprobado por ' + a.author + ' · ' + fmtDate(a.at)));
      if (a.outdated) t.appendChild(el('small', '', 'Hay cambios desde la aprobación'));
      d.appendChild(t); box.appendChild(d);
      if (a.outdated) { var again = el('button', 'approve', 'Aprobar de nuevo'); again.onclick = openApprove; box.appendChild(again); }
    } else {
      var b = el('button', 'approve', 'Todo bien, aprobado'); b.onclick = openApprove; box.appendChild(b);
    }
  }

  function go(i){
    show(i);
    if (audio) { audio.currentTime = S[cur].start; if (playing) audio.play().catch(function(){}); highlight(); progress(); }
  }

  function setPlaying(p){ playing = p; $('play').innerHTML = p ? PAUSE : PLAY; $('play').title = p ? 'Pausa (espacio)' : 'Reproducir (espacio)'; }

  function toggle(){
    if (!audio) return;
    if (playing) { audio.pause(); return; }
    var s = S[cur];
    if (audio.currentTime < s.start - 0.05 || audio.currentTime >= s.end - 0.02) audio.currentTime = s.start;
    if (cur === S.length - 1 && audio.currentTime >= s.end - 0.02) { show(0); audio.currentTime = 0; }
    audio.play().catch(function(){});
  }

  // Logo del proyecto sobre el video (modo video), como en el reproductor: tamaño, margen y realce en proporción al ancho
  // del video que se ve (con barras si no es 16:9) y la esquina del clip que se está viendo ('none' = sin logo).
  var O = VIDEO ? D.overlay : null, vlogo = $('vlogo');
  function cornerAt(t){
    for (var i = 0; i < O.clips.length; i++) { var c = O.clips[i]; if (t >= c.start && t < c.end) return O.clipCorners[String(c.index)] || O.settings.corner; }
    return O.settings.corner;
  }
  function layoutLogo(){
    if (!O || !vlogo || !audio) return;
    var corner = cornerAt(audio.currentTime);
    if (corner === 'none') { vlogo.hidden = true; return; }
    vlogo.hidden = false;
    var SW = stage.clientWidth, SH = stage.clientHeight, ar = audio.videoWidth && audio.videoHeight ? audio.videoWidth / audio.videoHeight : 16 / 9;
    var W = Math.min(SW, SH * ar), H = W / ar, ox = (SW - W) / 2, oy = (SH - H) / 2;
    var s = O.settings, w = W * s.widthPct / 100, m = W * s.marginPct / 100, pad = 0;
    vlogo.style.cssText = '';
    vlogo.style.opacity = s.opacity;
    if (s.effect === 'shadow') vlogo.style.filter = 'drop-shadow(0 ' + (w * 0.02) + 'px ' + (w * 0.05) + 'px rgba(0,0,0,.6))';
    if (s.effect === 'glow') vlogo.style.filter = 'drop-shadow(0 0 ' + (w * 0.05) + 'px rgba(255,255,255,.95)) drop-shadow(0 0 ' + (w * 0.02) + 'px rgba(255,255,255,.9))';
    if (s.effect === 'dark' || s.effect === 'light') {
      pad = w * 0.08;
      vlogo.style.padding = pad + 'px';
      vlogo.style.borderRadius = (w * 0.06) + 'px';
      vlogo.style.background = s.effect === 'dark' ? 'rgba(0,0,0,.45)' : 'rgba(255,255,255,.72)';
    }
    vlogo.style.width = (w + 2 * pad) + 'px';
    vlogo.style[corner.charAt(0) === 't' ? 'top' : 'bottom'] = (oy + m) + 'px';
    vlogo.style[corner.charAt(1) === 'l' ? 'left' : 'right'] = (ox + m) + 'px';
  }
  if (O && audio) {
    ['loadedmetadata', 'timeupdate', 'seeked'].forEach(function(ev){ audio.addEventListener(ev, layoutLogo); });
    window.addEventListener('resize', layoutLogo);
    document.addEventListener('fullscreenchange', function(){ setTimeout(layoutLogo, 60); });
  }

  if (audio) {
    audio.addEventListener('play', function(){ setPlaying(true); });
    audio.addEventListener('pause', function(){ setPlaying(false); });
    audio.addEventListener('ended', function(){ setPlaying(false); });
    audio.addEventListener('timeupdate', function(){
      var t = audio.currentTime;
      // Al terminar el tramo pasa solo al siguiente fotograma (sin ajustar a las palabras, ADR-092).
      if (playing && autoNext) {
        var j = cur;
        while (j + 1 < S.length && t >= S[j].end - 0.02) j++;
        if (j !== cur) show(j);
      }
      highlight(); progress();
    });
    // Un clic en el video: reproducir o pausar.
    if (VIDEO) audio.addEventListener('click', toggle);
  } else {
    $('play').disabled = true;
    $('play').title = VIDEO ? 'Este video aún no está terminado' : 'Este video aún no tiene locución';
  }

  $('play').innerHTML = PLAY;
  $('play').onclick = toggle;
  $('prev').onclick = function(){ go(cur - 1); };
  $('next').onclick = function(){ go(cur + 1); };
  $('tabOne').onclick = function(){ tab = 'one'; renderList(); };
  $('tabAll').onclick = function(){ tab = 'all'; renderList(); };
  $('change').onclick = function(){ setName(''); renderForm(); $('name').focus(); };
  $('text').addEventListener('focus', function(){ if (audio && playing) audio.pause(); });

  var showBox = $('show');
  $('fs').onclick = function(){
    if (document.fullscreenElement) return document.exitFullscreen();
    if (showBox.classList.contains('pseudo-fs')) { showBox.classList.remove('pseudo-fs'); return setTimeout(layoutLogo, 60); }
    if (showBox.requestFullscreen) showBox.requestFullscreen().catch(function(){ showBox.classList.add('pseudo-fs'); });
    else showBox.classList.add('pseudo-fs');
  };

  document.addEventListener('keydown', function(e){
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowRight') { go(cur + 1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { go(cur - 1); e.preventDefault(); }
    else if (e.key === ' ') { toggle(); e.preventDefault(); }
    else if (e.key === 'f' || e.key === 'F') $('fs').click();
    else if (e.key === 'Escape') { showBox.classList.remove('pseudo-fs'); setTimeout(layoutLogo, 60); }
  });

  async function post(path, body){
    var r = await fetch(D.base + '/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    var data = await r.json().catch(function(){ return {}; });
    if (!r.ok) throw new Error(data.message || 'No se pudo enviar. Inténtalo de nuevo.');
    D.comments = data.comments; D.approval = data.approval;
  }

  $('send').onclick = async function(){
    var name = getName() || $('name').value.trim();
    var text = $('text').value.trim();
    $('err').textContent = '';
    if (!name) { $('err').textContent = 'Escribe tu nombre.'; $('name').focus(); return; }
    if (!text) { $('err').textContent = 'Escribe la observación.'; $('text').focus(); return; }
    this.disabled = true;
    try {
      await post('observaciones', { author: name, text: text, keyframeIndex: S[cur].index });
      setName(name); $('text').value = ''; tab = 'one';
      renderList(); renderThumbs(); renderTimeline();
    } catch (e) { $('err').textContent = e.message; }
    this.disabled = false;
  };

  function openApprove(){
    $('aName').value = getName();
    $('aErr').textContent = '';
    $('dlg').hidden = false;
    setTimeout(function(){ ($('aName').value ? $('aOk') : $('aName')).focus(); }, 30);
  }
  $('aCancel').onclick = function(){ $('dlg').hidden = true; };
  $('dlg').onclick = function(e){ if (e.target === this) this.hidden = true; };
  $('aOk').onclick = async function(){
    var name = $('aName').value.trim();
    if (!name) { $('aErr').textContent = 'Escribe tu nombre.'; return; }
    this.disabled = true;
    try { await post('aprobar', { author: name }); setName(name); $('dlg').hidden = true; renderApproval(); renderForm(); }
    catch (e) { $('aErr').textContent = e.message; }
    this.disabled = false;
  };

  renderApproval();
  show(!VIDEO && S.length > 1 && !S[0].image ? 1 : 0);
  layoutLogo();
})();`;

const ICON = (d: string) => `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>`;

export function reviewHtml(d: ReviewDeck): string {
  const title = `${d.project} · ${d.title}`;
  const video = d.mode === 'video';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<link rel="icon" href="data:,">
<title>${video ? 'Revisión del video' : 'Revisión'} · ${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="top">
  ${d.back ? `<a class="back" href="${esc(d.back.href)}">← ${esc(d.back.label)}</a>` : ''}
  ${d.logo ? `<img src="${esc(d.logo)}" alt="">` : ''}
  <div class="ttl"><b>${esc(d.title)}</b><span>${esc(d.project)} · ${video ? 'Revisión del video' : 'Revisión del storyboard'}</span></div>
  <div id="apprBox" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"></div>
</div>
<div class="wrap">
  <div class="show" id="show">
    <div class="info"><span class="tag" id="tag"></span><span class="count" id="count"></span></div>
    <div class="stage" id="stage">${video && d.video ? `<video id="vid" playsinline preload="auto" src="${esc(d.video)}"></video>${d.overlay ? `<div class="vlogo" id="vlogo" hidden><img src="${esc(d.overlay.logo)}" alt=""></div>` : ''}` : ''}<div class="wait" id="wait">${video ? 'Este video aún no está terminado.' : 'Este fotograma aún se está preparando.'}</div></div>
    <div class="say" id="say"></div>
    <div class="ctl">
      <button class="btn" id="prev" title="Anterior (←)">${ICON('M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z')}</button>
      <button class="btn main" id="play"></button>
      <button class="btn" id="next" title="Siguiente (→)">${ICON('M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z')}</button>
      <div class="tl" id="tl"></div>
      <button class="btn" id="fs" title="Pantalla completa (F)">${ICON('M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z')}</button>
    </div>
    <div class="thumbs" id="thumbs"></div>
  </div>
  <aside class="side">
    <div class="tabs"><button id="tabOne"></button><button id="tabAll"></button></div>
    <div class="list" id="list"></div>
    <div class="form">
      <div id="nameRow"><input id="name" maxlength="${REVIEW_AUTHOR_MAX}" placeholder="Tu nombre" autocomplete="name"></div>
      <div class="row" id="who" hidden><span>Como <b id="whoName"></b></span><a id="change">Cambiar nombre</a></div>
      <textarea id="text" maxlength="${REVIEW_TEXT_MAX}"></textarea>
      <div class="row"><span class="err" id="err"></span><button class="send" id="send">Enviar observación</button></div>
    </div>
  </aside>
</div>
<div class="foot">${video ? 'Las miniaturas son los planos del video: avanzan solas al reproducir y un clic salta a ese plano. Deja tus observaciones en el plano que quieras cambiar. Atajos: espacio, ← →, F.' : 'Al terminar el tramo de cada fotograma, la locución pasa sola al siguiente. Atajos: espacio, ← →, F.'}</div>
<div class="dlg" id="dlg" hidden><div>
  <h2>¿Apruebas el storyboard?</h2>
  <p>El equipo recibirá un aviso. Si después cambia algún fotograma, se verá que tu aprobación fue sobre la versión anterior.</p>
  <input id="aName" maxlength="${REVIEW_AUTHOR_MAX}" placeholder="Tu nombre" autocomplete="name">
  <span class="err" id="aErr"></span>
  <div class="row"><button class="ghost" id="aCancel">Cancelar</button><button class="okb" id="aOk">Todo bien, aprobado</button></div>
</div></div>
<script type="application/json" id="deck">${safeJson(d)}</script>
<script>${JS}
addEventListener("pageshow",function(e){if(e.persisted)location.reload()});</script>
</body>
</html>`;
}

/** Página de link no válido (sin datos del video). */
export function reviewGoneHtml(): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Link no disponible</title><style>${CSS}body{display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:20px}</style></head><body><div><h1 style="font-size:18px">Este link de revisión no está disponible</h1><p style="color:var(--soft)">Puede que lo hayan desactivado o reemplazado por uno nuevo. Pide el link actualizado a quien te lo envió.</p></div></body></html>`;
}
