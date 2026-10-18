// Prueba de la matriz de acceso del hito 11 (ADR-142) contra una API local en modo MOCK. Crea tres usuarios estándar
// (Ana, Beto, Carla) con el admin y recorre los criterios de aceptación: compartir, público, observaciones, descargas,
// lo que es solo del dueño, «Ver los de todos», suspender y pasar los proyectos. NO usar contra producción.
//   WILOX_API=http://localhost:3001/api WILOX_ADMIN=admin@x WILOX_PW=... node apps/api/scripts/access-matrix.mjs
const API = process.env.WILOX_API ?? 'http://localhost:3001/api';
if (/wiloxagency\.com/.test(API)) throw new Error('Solo contra una API local en modo MOCK.');
const results = [];
function ok(name, cond, extra = '') { results.push([cond ? 'OK ' : 'FAIL', name, extra]); }
class Client {
  constructor(name) { this.name = name; this.cookie = ''; }
  async req(method, path, body) {
    const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', cookie: this.cookie, 'x-confirm-change': '1' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let data; const t = await r.text(); try { data = JSON.parse(t); } catch { data = t; }
    return { status: r.status, data };
  }
  login(email, password) { return this.req('POST', '/auth/login', { email, password }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = new Client('admin'), A = new Client('A'), B = new Client('B'), C = new Client('C');
const PW = process.env.WILOX_PW ?? 'clave-de-prueba-1';
await admin.login(process.env.WILOX_ADMIN ?? 'admin@test.local', PW);
const stamp = Date.now();
const mk = async (email, name) => (await admin.req('POST', '/users', { email, name, password: PW, role: 'user' })).data;
const ua = await mk(`a${stamp}@t.local`, 'Ana'), ub = await mk(`b${stamp}@t.local`, 'Beto'), uc = await mk(`c${stamp}@t.local`, 'Carla');
ok('admin crea usuarios estándar', ua.id && ub.id && uc.id && ua.role === 'user');
await A.login(ua.email, PW); await B.login(ub.email, PW); await C.login(uc.email, PW);

const pa = (await A.req('POST', '/projects', { name: `Compartido ${stamp}` })).data;
const pp = (await A.req('POST', '/projects', { name: `Publico ${stamp}` })).data;
const px = (await A.req('POST', '/projects', { name: `Privado ${stamp}` })).data;
ok('A crea proyectos con access.role=owner', pa.access?.role === 'owner', JSON.stringify(pa.access));
const text = 'Este es un texto de prueba bastante largo para generar un video corto en modo mock. Segundo párrafo de la prueba.';
const ga = (await A.req('POST', '/generations', { text, theme: 'pastel', projectId: pa.id })).data;
ok('A genera en su proyecto', !!ga.id, JSON.stringify(ga).slice(0, 200));

// Antes de compartir: B no ve nada
ok('B no ve el proyecto ajeno (404)', (await B.req('GET', `/projects/${pa.id}/delivery`)).status === 404);
ok('B no ve el video ajeno (404)', (await B.req('GET', `/generations/${ga.id}`)).status === 404);
ok('B no ve sus observaciones', (await B.req('GET', '/review-comments')).data.items?.length === 0);

// Compartir
const sh = await A.req('PUT', `/projects/${pa.id}/access`, { userIds: [ub.id], public: false });
ok('A comparte con B', sh.status === 200 && sh.data.shares?.length === 1, JSON.stringify(sh.data).slice(0, 200));
const bl = (await B.req('GET', '/projects')).data.projects;
const bpa = bl.find((p) => p.id === pa.id);
ok('B ve el proyecto compartido con role=shared y dueño Ana', bpa?.access.role === 'shared' && bpa.access.owner.name === 'Ana');
ok('B no ve el privado', !bl.some((p) => p.id === px.id));
ok('B no ve el «Sin clasificar» de A', !bl.some((p) => p.unclassified && p.access.owner.id === ua.id));
ok('B abre el video de A', (await B.req('GET', `/generations/${ga.id}`)).status === 200);
ok('B ve el historial del proyecto', (await B.req('GET', `/generations?project=${pa.id}`)).data.items?.length === 1);
const gb = (await B.req('POST', '/generations', { text, theme: 'dark', projectId: pa.id })).data;
ok('B genera en el proyecto compartido', !!gb.id, JSON.stringify(gb).slice(0, 200));
await sleep(1500);
{ const h = (await A.req('GET', `/generations?project=${pa.id}`)).data; ok('A ve el video de B en su proyecto', h.items?.length === 2, JSON.stringify(h).slice(0,300)); }
ok('B renombra', (await B.req('PATCH', `/projects/${pa.id}`, { name: `Compartido ${stamp} (B)` })).status === 200);
const arch = await B.req('PATCH', `/projects/${pa.id}`, { archived: true });
ok('B no archiva (403)', arch.status === 403, JSON.stringify(arch.data));
const del = await B.req('DELETE', `/projects/${pa.id}`);
ok('B no envía a la papelera el proyecto (403)', del.status === 403, JSON.stringify(del.data));
ok('B no comparte (403)', (await B.req('PUT', `/projects/${pa.id}/access`, { userIds: [], public: true })).status === 403);
ok('B ve los links del cliente', (await B.req('GET', `/projects/${pa.id}/share`)).status === 200);
ok('B ve los logos/entrega', (await B.req('GET', `/projects/${pa.id}/delivery`)).status === 200);
ok('B duplica el proyecto (copia suya)', (await B.req('POST', `/projects/${pa.id}/duplicate`)).data?.project?.access?.role === 'owner');

// Esperar a que A tenga fotogramas para el link de revisión
let st;
for (let i = 0; i < 60; i++) { st = (await A.req('GET', `/generations/${ga.id}`)).data; if (st.status === 'awaiting_approval' || st.status === 'error') break; await sleep(1000); }
ok('video de A en revisión', st.status === 'awaiting_approval', st.status);
const tv = await B.req('DELETE', `/generations/${ga.id}`);
ok('B no envía a la papelera un video (403)', tv.status === 403, JSON.stringify(tv.data));
const link = (await B.req('POST', `/generations/${ga.id}/review`)).data;
ok('B crea el link de revisión del video de A', !!link.link?.url, JSON.stringify(link).slice(0, 200));
const tok = link.link.url.split('/').pop();
const pub = new Client('cliente');
const c1 = await pub.req('POST', `/revision/${tok}/observaciones`, { author: 'Cliente', text: 'Cambiar el color', keyframeIndex: 1 });
ok('el cliente comenta por el link', c1.status === 200, String(c1.status));
const ib = (await B.req('GET', '/review-comments')).data;
const ia = (await A.req('GET', '/review-comments')).data;
ok('B ve la observación en «Observaciones»', ib.items?.length === 1);
ok('A también', ia.items?.length === 1);
ok('contador de B', (await B.req('GET', '/review-comments/count')).data.pending === 1);
ok('C no la ve', (await C.req('GET', '/review-comments')).data.items?.length === 0);
const cid = ib.items[0].id;
ok('B la marca en curso', (await B.req('PATCH', `/review-comments/${cid}`, { status: 'progress' })).status === 200);
ok('C no puede cambiarla (404)', (await C.req('PATCH', `/review-comments/${cid}`, { status: 'resolved' })).status === 404);

// Descargas compartidas
const batch = await B.req('POST', '/download-batches', { projectId: pa.id, format: 'project-zip', videoIds: [] });
ok('B pide una descarga del proyecto', batch.status === 201 || batch.status === 200, JSON.stringify(batch.data).slice(0, 200));
ok('A ve la descarga de B', (await A.req('GET', '/download-batches')).data.some((x) => x.id === batch.data.id));
ok('C no la ve', !(await C.req('GET', '/download-batches')).data.some((x) => x.id === batch.data.id));
ok('C no la borra (404)', (await C.req('DELETE', `/download-batches/${batch.data.id}`)).status === 404);

// Público
ok('A hace público otro proyecto', (await A.req('PUT', `/projects/${pp.id}/access`, { userIds: [], public: true })).data.public === true);
const cpp = (await C.req('GET', '/projects')).data.projects.find((p) => p.id === pp.id);
ok('C ve el público con role=public', cpp?.access.role === 'public');
ok('C genera en el público', !!(await C.req('POST', '/generations', { text, theme: 'light', projectId: pp.id })).data.id);
ok('C no archiva el público (403)', (await C.req('PATCH', `/projects/${pp.id}`, { archived: true })).status === 403);
ok('«Sin clasificar» no se comparte', (await A.req('PUT', `/projects/${(await A.req('GET', '/projects')).data.unclassifiedId}/access`, { userIds: [ub.id], public: true })).status === 400);
ok('sin sesión: 401', (await new Client('x').req('GET', `/projects/${pp.id}/delivery`)).status === 401);

// Admin
const al = (await admin.req('GET', '/projects')).data.projects;
ok('admin ve solo lo suyo por defecto', !al.some((p) => p.id === px.id));
const all = (await admin.req('GET', '/projects?all=1')).data.projects;
ok('admin con ?all=1 ve el privado de A', all.find((p) => p.id === px.id)?.access.role === 'admin');
ok('admin abre el proyecto ajeno', (await admin.req('GET', `/projects/${px.id}/delivery`)).status === 200);
ok('admin no archiva ajeno (403)', (await admin.req('PATCH', `/projects/${px.id}`, { archived: true })).status === 403);
ok('usuario normal: ?all=1 no cambia nada', !(await B.req('GET', '/projects?all=1')).data.projects.some((p) => p.id === px.id));
// Video suelto de A en su «Sin clasificar» (para probar la reasignación)
const uncA = (await A.req('GET', '/projects')).data.unclassifiedId;
const loose = (await A.req('POST', '/generations', { text, theme: 'pastel', projectId: uncA })).data;
await sleep(1500);
ok('admin suspende a A', (await admin.req('PATCH', `/users/${ua.id}`, { active: false })).data.active === false);
ok('A suspendido no entra', (await A.req('GET', '/projects')).status === 401);
ok('B sigue trabajando en el compartido', (await B.req('GET', `/generations/${ga.id}`)).status === 200);
const tr = await admin.req('POST', `/users/${ua.id}/transfer`, { toUserId: ub.id });
ok('admin pasa los proyectos de A a B', tr.status === 200 && tr.data.projects === 3 && tr.data.videos === 1, JSON.stringify(tr.data));
const bl2 = (await B.req('GET', '/projects')).data.projects;
ok('B ahora es dueño del compartido', bl2.find((p) => p.id === pa.id)?.access.role === 'owner');
ok('B ve «Sin clasificar de Ana»', bl2.some((p) => p.name === 'Sin clasificar de Ana' && p.totals.videos === 1));
await sleep(3000);
ok('el video suelto de A sigue en «Sin clasificar de Ana» tras guardarse', (await B.req('GET', `/generations/${loose.id}`)).status === 200);
ok('B ve el antiguo privado de A', bl2.find((p) => p.id === px.id)?.access.role === 'owner');
ok('admin cambia el dueño de un proyecto a sí mismo', (await admin.req('POST', `/projects/${pp.id}/owner`, { ownerId: (await admin.req('GET', '/auth/me')).data.id })).data.role === 'owner');
ok('no se pasa a un suspendido', (await admin.req('POST', `/projects/${px.id}/owner`, { ownerId: ua.id })).status === 400);
ok('B (no admin) no cambia dueños (403)', (await B.req('POST', `/projects/${pa.id}/owner`, { ownerId: uc.id })).status === 403);
ok('loose video sigue', !!loose.id);
const thumb = (await B.req('GET', `/generations/${ga.id}/summary`)).data.thumbnailUrl;
ok('B baja la miniatura del video de A', thumb && (await B.req('GET', thumb.replace('/api', ''))).status === 200, thumb);
ok('C no la baja (404)', thumb && (await C.req('GET', thumb.replace('/api', ''))).status === 404);
ok('admin «Ver los de todos» en Observaciones', (await admin.req('GET', '/review-comments?all=1')).data.items?.length >= 1);
ok('admin sin all no ve las de otros', (await admin.req('GET', '/review-comments')).data.items?.length === 0);
ok('admin Cola ?all=1', (await admin.req('GET', '/queue?all=1')).status === 200);
ok('admin Descargas ?all=1', (await admin.req('GET', '/download-batches?all=1')).data.some((x) => x.id === batch.data.id));
for (let i = 0; i < 40; i++) { const g = (await B.req('GET', `/generations/${gb.id}`)).data; if (['awaiting_approval','error','done','paused'].includes(g.status)) break; await sleep(1000); }
await B.req('POST', `/projects/${pa.id}/pause`); await sleep(1000);
const t1 = await B.req('DELETE', `/projects/${pa.id}`);
ok('B (ya dueño) envía el proyecto a la papelera', t1.status === 200, JSON.stringify(t1.data));
ok('B lo ve en su papelera', (await B.req('GET', '/trash')).data.projects?.some((p) => p.id === pa.id));
ok('C no lo restaura (404)', (await C.req('POST', `/trash/project/${pa.id}/restore`)).status === 404);
ok('admin no lo restaura sin ser dueño (403)', (await admin.req('POST', `/trash/project/${pa.id}/restore`)).status === 403);
{ const r = await B.req('POST', `/trash/project/${pa.id}/restore`); ok('B lo restaura', r.status < 300, r.status + JSON.stringify(r.data)); }

for (const r of results) console.log(r.join(' | '));
console.log(results.filter((r) => r[0] === 'FAIL').length, 'fallos de', results.length);
