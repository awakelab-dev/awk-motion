/**
 * pnpm storage:migrate (hito 8, ADR-096): sube a S3 todo lo que hay en storage/ y lo verifica.
 *   --dry-run   cuánto falta subir, sin subir nada
 *   (sin flag)  sube lo que falte, carpeta por carpeta (se puede cortar y volver a lanzar: sigue donde quedó)
 *   --verify    compara cada archivo del disco con S3 (existe y mismo tamaño) y deja un informe
 *   --evict runs/<id>   saca del disco esa carpeta (solo si todo lo suyo está en S3); se vuelve a bajar al usarla
 * Sin --evict no borra nada del disco. Usa el MEDIA_DRIVER, AWS_* y MEDIA_ENV del .env.
 */
import { createDb } from '@wilox/db';
import { env } from '../src/config/env.js';
import { MediaService } from '../src/storage/media.service.js';

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
const arg = process.argv[2];
if (env.MEDIA_DRIVER === 'none') {
  console.error('MEDIA_DRIVER=none en el .env: pon MEDIA_DRIVER=s3 (y AWS_REGION, AWS_S3_BUCKET, MEDIA_ENV) antes de migrar.');
  process.exit(1);
}
const db = createDb(env.DATABASE_URL);
const media = new MediaService(db);
console.log(`Remoto: ${media.driver} · prefijo ${media.prefix}${env.AWS_S3_BUCKET ? ` · bucket ${env.AWS_S3_BUCKET} (${env.AWS_REGION})` : ''}`);
try {
  if (arg === '--dry-run') {
    const p = await media.pending();
    console.log(`En el disco: ${p.total.files} archivos, ${mb(p.total.bytes)}.`);
    console.log(`Falta subir: ${p.files} archivos, ${mb(p.bytes)}.`);
    for (const [top, v] of Object.entries(p.byTop)) console.log(`  ${top}: ${v.files} archivos, ${mb(v.bytes)}`);
  } else if (arg === '--evict') {
    const unit = (process.argv[3] ?? '').replace(/^storage\//, '').replace(/\/+$/, '');
    if (!/^(runs|downloads)\/[^/]+$/.test(unit)) {
      console.error('Indica la carpeta: --evict runs/<id> (o downloads/<id>).');
      process.exitCode = 1;
    } else {
      const r = await media.evict({ force: true, only: unit });
      console.log(r.units ? `Fuera del disco: ${unit} (${mb(r.bytes)}). Está en S3 y se vuelve a bajar sola al usarla.` : `No se sacó ${unit}: no existe, ya está fuera del disco o le falta algo por subir.`);
    }
  } else if (arg === '--verify') {
    const v = await media.verify();
    console.log(`Disco: ${v.local} archivos · remoto: ${v.remote} archivos.`);
    console.log(`Faltan en el remoto: ${v.missing.length} · tamaño distinto: ${v.sizeMismatch.length} · subidos sin registrar: ${v.notIndexed.length}`);
    for (const k of [...v.missing, ...v.sizeMismatch].slice(0, 20)) console.log(`  ${k}`);
    console.log(v.ok ? 'VERIFICACIÓN OK: todo lo del disco está en el remoto con el mismo tamaño.' : 'VERIFICACIÓN CON DIFERENCIAS: vuelve a lanzar la subida y verifica otra vez.');
    console.log(`Informe: ${v.report}`);
  } else {
    const t0 = Date.now();
    const before = await media.pending();
    console.log(`Subiendo ${before.files} archivos (${mb(before.bytes)})…`);
    let done = 0;
    const r = await media.sweep({
      onUnit: (unit, ok) => {
        done++;
        if (!ok || done % 25 === 0) console.log(`  ${done} carpetas · ${unit}${ok ? '' : ' (quedan archivos: se reintenta al volver a lanzar)'}`);
      },
    });
    const after = await media.pending();
    const s = (Date.now() - t0) / 1000;
    console.log(`Listo en ${s.toFixed(0)} s: ${r.units} carpetas; faltan ${after.files} archivos (${mb(after.bytes)}).`);
    if (after.files) console.log('Los que faltan suelen ser archivos que se están escribiendo: vuelve a lanzarlo en unos minutos.');
  }
} finally {
  await db.$disconnect();
}
