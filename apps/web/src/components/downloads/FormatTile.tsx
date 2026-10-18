import { Archive, CloudCog, Code2, FileCode2, Film, FolderArchive, GraduationCap, Layers3 } from 'lucide-react';
import type { DownloadBatchInfo } from '@wilox/shared';
import { cn } from '@/lib/utils';

/** Ícono del tipo de descarga en «Descargas» (hito 9, T3c): HTML, SCORM 1.2/2004 (con nube: liviano), un solo .html, MP4 o Rise 360. */
const TILES: Record<DownloadBatchInfo['format'], { icon: typeof Code2; tag: string; tone: string }> = {
  html: { icon: Code2, tag: 'HTML', tone: 'border-sky-400/30 bg-sky-400/10 text-sky-300' },
  scorm12: { icon: GraduationCap, tag: 'SCORM 1.2', tone: 'border-amber-400/30 bg-amber-400/10 text-amber-300' },
  scorm2004: { icon: GraduationCap, tag: 'SCORM 2004', tone: 'border-orange-400/30 bg-orange-400/10 text-orange-300' },
  single: { icon: FileCode2, tag: '.html', tone: 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300' },
  mp4: { icon: Film, tag: 'MP4', tone: 'border-violet-400/30 bg-violet-400/10 text-violet-300' },
  zip: { icon: Archive, tag: 'ZIP', tone: 'border-slate-400/30 bg-slate-400/10 text-slate-300' },
  'project-zip': { icon: FolderArchive, tag: 'PROYECTO', tone: 'border-slate-400/30 bg-slate-400/10 text-slate-300' },
  rise: { icon: Layers3, tag: 'RISE', tone: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' },
  // SCORM liviano (T4): el video en la nube.
  'scorm12-light': { icon: CloudCog, tag: 'SCORM 1.2', tone: 'border-amber-400/30 bg-amber-400/10 text-amber-300' },
  'scorm2004-light': { icon: CloudCog, tag: 'SCORM 2004', tone: 'border-orange-400/30 bg-orange-400/10 text-orange-300' },
};

export function FormatTile({ format, className }: { format: DownloadBatchInfo['format']; className?: string }) {
  const t = TILES[format] ?? TILES.html;
  return (
    <div className={cn('flex w-14 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border py-2', t.tone, className)} aria-hidden>
      <t.icon className="size-5" />
      <span className="text-[9px] leading-none font-semibold tracking-wide whitespace-nowrap">{t.tag}</span>
    </div>
  );
}
