/**
 * Paquetes SCORM 1.2 y 2004 4.ª edición (hito 6, ADR-066): un SCO por video, cada uno con su reproductor HTML
 * (index.html) y su video al lado. El reproductor avisa al LMS (Moodle u otro):
 * - al abrir, deja el video "incompleto" y vuelve al segundo donde quedó;
 * - lo marca "completado" al ver el 95 % (lo realmente visto, por tramos, no adelantando) o al terminar;
 * - guarda cada 30 s el punto y lo visto (suspend_data), el avance (2004) y el tiempo de la sesión.
 */

export type ScormVersion = '1.2' | '2004';

export interface ScormItem {
  id: string;
  title: string;
  /** index.html del SCO, relativo a la raíz del paquete. */
  href: string;
  /** Archivos del SCO, relativos a la raíz. */
  files: string[];
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
const ident = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** imsmanifest.xml del paquete. */
export function scormManifest(version: ScormVersion, id: string, title: string, items: ScormItem[]): string {
  const org = `ORG_${ident(id)}`;
  const itemsXml = items
    .map((it, i) => `      <item identifier="ITEM_${i + 1}" identifierref="RES_${i + 1}"${version === '1.2' ? ' isvisible="true"' : ''}>\n        <title>${xml(it.title)}</title>\n      </item>`)
    .join('\n');
  const scoAttr = version === '1.2' ? 'adlcp:scormtype="sco"' : 'adlcp:scormType="sco"';
  const resources = items
    .map(
      (it, i) =>
        `    <resource identifier="RES_${i + 1}" type="webcontent" ${scoAttr} href="${xml(it.href)}">\n${it.files.map((f) => `      <file href="${xml(f)}"/>`).join('\n')}\n    </resource>`,
    )
    .join('\n');
  if (version === '1.2')
    return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST_${ident(id)}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.imsglobal.org/xsd/imsmd_rootv1p2p1 imsmd_rootv1p2p1.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${org}">
    <organization identifier="${org}">
      <title>${xml(title)}</title>
${itemsXml}
    </organization>
  </organizations>
  <resources>
${resources}
  </resources>
</manifest>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="MANIFEST_${ident(id)}" version="1"
  xmlns="http://www.imsglobal.org/xsd/imscp_v1p1"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3"
  xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3"
  xmlns:adlnav="http://www.adlnet.org/xsd/adlnav_v1p3"
  xmlns:imsss="http://www.imsglobal.org/xsd/imsss"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsglobal.org/xsd/imscp_v1p1 imscp_v1p1.xsd http://www.adlnet.org/xsd/adlcp_v1p3 adlcp_v1p3.xsd http://www.adlnet.org/xsd/adlseq_v1p3 adlseq_v1p3.xsd http://www.adlnet.org/xsd/adlnav_v1p3 adlnav_v1p3.xsd http://www.imsglobal.org/xsd/imsss imsss_v1p0.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>2004 4th Edition</schemaversion>
  </metadata>
  <organizations default="${org}">
    <organization identifier="${org}">
      <title>${xml(title)}</title>
${itemsXml}
      <imsss:sequencing>
        <imsss:controlMode choice="true" flow="true"/>
      </imsss:sequencing>
    </organization>
  </organizations>
  <resources>
${resources}
  </resources>
</manifest>
`;
}

/** JavaScript del SCO, incluido en el index.html del reproductor (usa el <video id="video">). */
export function scormRuntime(version: ScormVersion): string {
  return `(function(){
  var V12 = ${version === '1.2' ? 'true' : 'false'};
  var NAME = V12 ? 'API' : 'API_1484_11';
  function find(win){ for (var n = 0; win && n < 12; n++) { try { if (win[NAME]) return win[NAME]; } catch (e) {} if (!win.parent || win.parent === win) break; win = win.parent; } return null; }
  var api = find(window) || (window.opener ? find(window.opener) : null);
  if (!api) return; // fuera de un LMS: el reproductor funciona igual, sin registro
  function call(f12, f04, a, b){ try { var r = V12 ? api[f12](a, b) : api[f04](a, b); return r === undefined || r === null ? '' : String(r); } catch (e) { return ''; } }
  var get = function(k){ return call('LMSGetValue', 'GetValue', k); };
  var set = function(k, v){ return call('LMSSetValue', 'SetValue', k, String(v)); };
  var commit = function(){ call('LMSCommit', 'Commit', ''); };
  var K = V12
    ? { status: 'cmi.core.lesson_status', loc: 'cmi.core.lesson_location', time: 'cmi.core.session_time', exit: 'cmi.core.exit' }
    : { status: 'cmi.completion_status', loc: 'cmi.location', time: 'cmi.session_time', exit: 'cmi.exit' };
  call('LMSInitialize', 'Initialize', '');
  var video = document.getElementById('video'), t0 = Date.now(), done = false, finished = false;
  var status = get(K.status);
  done = status === 'completed' || status === 'passed';
  if (!done) set(K.status, 'incomplete');

  // Lo visto, por tramos (≤ 4000 marcas para caber en suspend_data de SCORM 1.2).
  var seen = null, bucket = 1;
  function setup(){
    var d = video.duration; if (!isFinite(d) || d <= 0 || seen) return;
    bucket = Math.max(1, Math.ceil(d / 4000));
    var n = Math.ceil(d / bucket), prev = get('cmi.suspend_data');
    seen = [];
    for (var i = 0; i < n; i++) seen.push(prev && prev.indexOf('v1:') === 0 && prev.charAt(3 + i) === '1' ? 1 : 0);
    var loc = parseFloat(get(K.loc));
    if (loc > 3 && loc < d - 3) video.currentTime = loc;
  }
  function ratio(){ if (!seen) return 0; var s = 0; for (var i = 0; i < seen.length; i++) s += seen[i]; return s / seen.length; }
  function mark(){
    if (!seen || video.paused || video.seeking) return;
    var i = Math.floor(video.currentTime / bucket); if (i >= 0 && i < seen.length) seen[i] = 1;
    if (!done && ratio() >= 0.95) complete();
  }
  function complete(){ done = true; set(K.status, 'completed'); if (!V12) set('cmi.progress_measure', '1'); save(); }
  function pad(n, w){ n = String(n); while (n.length < w) n = '0' + n; return n; }
  function sessionTime(){
    var s = (Date.now() - t0) / 1000, h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return V12 ? pad(h, 4) + ':' + pad(m, 2) + ':' + pad(r.toFixed(2), 5) : 'PT' + h + 'H' + m + 'M' + r.toFixed(2) + 'S';
  }
  function save(){
    if (finished) return;
    set(K.loc, Math.floor(video.currentTime || 0));
    if (seen) set('cmi.suspend_data', 'v1:' + seen.join(''));
    if (!V12 && !done) set('cmi.progress_measure', Math.min(0.99, ratio()).toFixed(2));
    commit();
  }
  function finish(){
    if (finished) return;
    save();
    set(K.time, sessionTime());
    set(K.exit, done ? (V12 ? '' : 'normal') : 'suspend');
    commit();
    finished = true;
    call('LMSFinish', 'Terminate', '');
  }
  video.addEventListener('loadedmetadata', setup);
  if (video.readyState >= 1) setup();
  video.addEventListener('timeupdate', mark);
  video.addEventListener('ended', function(){ if (!done) complete(); });
  video.addEventListener('pause', save);
  setInterval(save, 30000);
  window.addEventListener('pagehide', finish);
  window.addEventListener('beforeunload', finish);
})();`;
}
