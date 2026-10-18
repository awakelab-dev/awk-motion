import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Remote } from './remote.js';

/**
 * Remoto en S3 (hito 8, ADR-096). Credenciales: la cadena por defecto del SDK (AWS_ACCESS_KEY_ID y
 * AWS_SECRET_ACCESS_KEY del .env, o el perfil de ~/.aws del usuario que corre la API). Bucket privado: el
 * navegador recibe URLs firmadas solo para lo que no está en la caché local.
 */
export class S3Remote implements Remote {
  readonly name = 's3';
  private readonly s3: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    endpoint?: string,
  ) {
    const cfg: S3ClientConfig = { region };
    // MEDIA_S3_ENDPOINT: solo para pruebas con un S3 local (moto).
    if (endpoint) Object.assign(cfg, { endpoint, forcePathStyle: true });
    this.s3 = new S3Client(cfg);
  }

  async put(key: string, file: string, contentType: string, o: { cacheControl?: string } = {}) {
    const size = (await stat(file)).size;
    // Archivos grandes en partes de 16 MB (4 a la vez); los chicos, de una vez.
    const up = new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: createReadStream(file), ContentType: contentType, ContentLength: size, CacheControl: o.cacheControl },
      partSize: 16 * 1024 * 1024,
      queueSize: 4,
    });
    const r = await up.done();
    return { etag: 'ETag' in r ? r.ETag?.replace(/"/g, '') : undefined };
  }

  async get(key: string, file: string) {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!r.Body) throw new Error(`S3 devolvió ${key} vacío.`);
    await mkdir(dirname(file), { recursive: true });
    await pipeline(r.Body as Readable, createWriteStream(file));
  }

  async head(key: string) {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404) return undefined;
      throw e;
    }
  }

  async delete(keys: string[]) {
    for (let i = 0; i < keys.length; i += 1000) {
      const r = await this.s3.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }),
      );
      if (r.Errors?.length) throw new Error(`S3 no borró ${r.Errors.length} archivo(s): ${r.Errors[0].Message ?? r.Errors[0].Code}`);
    }
  }

  async copy(from: string, to: string) {
    await this.s3.send(new CopyObjectCommand({ Bucket: this.bucket, Key: to, CopySource: `${this.bucket}/${from.split('/').map(encodeURIComponent).join('/')}` }));
  }

  async list(prefix: string) {
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const r = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: Number(o.Size ?? 0) });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  url(key: string, o: { ttlSec: number; downloadName?: string; contentType?: string }) {
    const disposition = o.downloadName ? `attachment; filename="${o.downloadName.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(o.downloadName)}` : undefined;
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: disposition, ResponseContentType: o.contentType }),
      { expiresIn: o.ttlSec },
    );
  }
}
