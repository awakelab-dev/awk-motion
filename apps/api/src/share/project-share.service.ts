import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma, type Db } from '@wilox/db';
import { PROJECT_SHARE_KINDS, type ProjectShareKind, type ProjectShareLink, type ProjectShareRequest, type ProjectShareState } from '@wilox/shared';
import { env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { DeliveryService } from '../delivery/delivery.service.js';
import { SHARE_KEY, projectShareOf, projectSharePath, projectVideoPath, resolveProjectShare, type StoredProjectShare } from './project-share.js';
import type { ProjectPage } from './project-share-page.js';

/**
 * Links del proyecto completo: el de **aprobación** del storyboard (hito 9, T6, ADR-112) y el de **revisión de los videos**
 * terminados (T6b, ADR-116), cada uno aparte. En la app se crean, se eligen sus videos (todos o algunos), se cambian por uno
 * nuevo o se desactivan. Las observaciones (y la aprobación del storyboard) quedan en cada video.
 */
@Injectable()
export class ProjectShareService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly delivery: DeliveryService,
  ) {}

  /** Los links del cliente los gestiona todo el que tiene acceso al proyecto (lo comprobó el guard, hito 11, ADR-142). */
  private async own(id: string, _ownerId: string) {
    const p = /^[0-9a-f-]{36}$/i.test(id) ? await this.db.project.findFirst({ where: { id, trashedAt: null }, select: { id: true, delivery: true } }) : null;
    if (!p) throw new NotFoundException('Proyecto no encontrado.');
    return p;
  }

  private url(token: string, kind: ProjectShareKind) {
    return `${env.WEB_ORIGIN.replace(/\/+$/, '')}${projectSharePath(token, kind)}`;
  }

  /** Videos del proyecto con lo que ve el cliente: si tienen fotogramas o final, observaciones abiertas y aprobación. */
  private async videos(projectId: string) {
    const gens = await this.db.generation.findMany({
      where: { projectId, trashedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        text: true,
        finalPath: true,
        updatedAt: true,
        durationSec: true,
        keyframes: { select: { previous: true, versions: { where: { path: { not: null } }, select: { id: true }, take: 1 } } },
        reviews: { select: { kind: true, resolvedAt: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    return gens.map((g) => ({
      id: g.id,
      title: this.delivery.videoTitle(g.text),
      hasKeyframes: g.keyframes.some((k) => k.versions.length > 0 || !!(k.previous as { path?: string } | null)?.path),
      hasFinal: !!g.finalPath,
      // Huella para las miniaturas: cambia con cualquier cambio del video (final nuevo, portada elegida, fotogramas).
      updatedTag: g.updatedAt.getTime().toString(36),
      durationSec: g.durationSec ?? undefined,
      openComments: g.reviews.filter((r) => r.kind === 'comment' && !r.resolvedAt).length,
      openVideoComments: g.reviews.filter((r) => r.kind === 'video' && !r.resolvedAt).length,
      approvedAt: g.reviews.filter((r) => r.kind === 'approval').at(-1)?.createdAt.toISOString(),
    }));
  }

  async state(id: string, ownerId: string): Promise<ProjectShareState> {
    const p = await this.own(id, ownerId);
    const videos = (await this.videos(p.id)).map(({ durationSec: _d, ...v }) => v);
    const links: ProjectShareState['links'] = {};
    for (const kind of PROJECT_SHARE_KINDS) {
      const share = projectShareOf(p.delivery, kind);
      if (share) links[kind] = { url: this.url(share.token, kind), createdAt: share.createdAt, all: share.videoIds === null, videoIds: share.videoIds ?? videos.map((v) => v.id) } satisfies ProjectShareLink;
    }
    return { links, videos };
  }

  private async save(id: string, delivery: unknown, kind: ProjectShareKind, share: StoredProjectShare | undefined) {
    const cur = { ...((delivery ?? {}) as Record<string, unknown>) };
    if (share) cur[SHARE_KEY[kind]] = share;
    else delete cur[SHARE_KEY[kind]];
    await this.db.project.update({ where: { id }, data: { delivery: Object.keys(cur).length ? (cur as Prisma.InputJsonValue) : Prisma.DbNull } });
  }

  /** Crea el link o cambia sus videos; con `renew`, uno nuevo (el anterior deja de funcionar). */
  async upsert(id: string, ownerId: string, body: ProjectShareRequest): Promise<ProjectShareState> {
    const p = await this.own(id, ownerId);
    const all = (await this.videos(p.id)).map((v) => v.id);
    let videoIds: string[] | null = null;
    if (body.videoIds) {
      const wanted = new Set(body.videoIds);
      videoIds = all.filter((x) => wanted.has(x));
      if (!videoIds.length) throw new BadRequestException('Elige al menos un video.');
    }
    const cur = projectShareOf(p.delivery, body.kind);
    const token = cur && !body.renew ? cur.token : randomBytes(18).toString('base64url');
    await this.save(p.id, p.delivery, body.kind, { token, createdAt: cur && !body.renew ? cur.createdAt : new Date().toISOString(), videoIds });
    return this.state(id, ownerId);
  }

  async remove(id: string, ownerId: string, kind: ProjectShareKind): Promise<ProjectShareState> {
    const p = await this.own(id, ownerId);
    await this.save(p.id, p.delivery, kind, undefined);
    return this.state(id, ownerId);
  }

  // ─── Público ───────────────────────────────────────────────────────────────────────────────────────

  /** Datos de la página de un link (undefined si no vale). La de los videos lista solo los terminados. */
  async page(token: string, kind: ProjectShareKind): Promise<ProjectPage | undefined> {
    const s = await resolveProjectShare(this.db, token, kind);
    if (!s) return undefined;
    const visible = new Set(s.ids);
    const all = (await this.videos(s.project.id)).filter((v) => visible.has(v.id));
    const logo = await this.delivery.logoDataUrl(s.project.id, s.project.ownerId, 'project').catch(() => null);
    const list = kind === 'videos' ? all.filter((v) => v.hasFinal) : all.filter((v) => v.hasKeyframes);
    return {
      kind,
      name: s.project.name,
      description: s.project.description,
      logo,
      videos: list.map((v) => {
        const base = projectVideoPath(token, v.id, kind);
        return kind === 'videos'
          ? { id: v.id, title: v.title, href: base, thumb: `${base}/portada.jpg?v=${v.updatedTag}`, durationSec: v.durationSec, openComments: v.openVideoComments, approved: false }
          : { id: v.id, title: v.title, href: `${base}/revision`, thumb: `${base}/miniatura.jpg?v=${v.updatedTag}`, openComments: v.openComments, approved: !!v.approvedAt };
      }),
    };
  }

  /** El video de un link del proyecto, si es visible (para su portada y su archivo). */
  async video(token: string, videoId: string, kind: ProjectShareKind): Promise<{ id: string; ownerId: string }> {
    const s = await resolveProjectShare(this.db, token, kind);
    if (!s || !s.ids.includes(videoId)) throw new NotFoundException('Link no válido o desactivado.');
    return { id: videoId, ownerId: s.project.ownerId };
  }
}
