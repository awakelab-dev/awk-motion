import { AlertTriangle, FileUp, FolderOpen, Loader2, Pause, Play, RefreshCw, ScrollText, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppInfo, GenerationScript, MusicTrackInfo, ProjectSummary, RunState, SoundMode, ThemeId, ThemeInfo, VoiceOption } from '@wilox/shared';
import { ImportDialog } from '@/components/ImportDialog';
import { MusicPicker } from '@/components/MusicPicker';
import { SoundPicker } from '@/components/SoundPicker';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, projectsApi } from '@/lib/api';
import { clipsFor, confirmSpend } from '@/lib/spend';
import { cn } from '@/lib/utils';
import { useSeeAll } from '@/lib/see-all';
import { userLabel } from '@/components/projects/ProjectAccessDialog';

export interface RecreatePrefill {
  /** Cambia en cada "Recrear" para volver a aplicar el relleno. */
  key: number;
  parentId: string;
  text: string;
  theme: ThemeId;
  voiceId: string;
  /** Música del video que se recrea (null = "Sin música"). */
  musicTrack?: string | null;
  /** Sonido del video que se recrea (hito 6). */
  soundMode?: SoundMode;
  /** Guion del video que se recrea (hito 5). */
  script?: GenerationScript;
}

/** Párrafos del texto (como la API: separados por líneas en blanco). */
const paragraphCount = (t: string) => t.replace(/\r\n?/g, '\n').trim().split(/\n\s*\n+/).filter((p) => p.trim()).length;

/** Vista previa de cada tema (fondo + acento), sin imágenes externas. */
const THEME_PREVIEW: Record<string, { bg: string; ink: string; accent: string }> = {
  dark: { bg: 'radial-gradient(120% 120% at 20% 0%, #003670 0%, #011932 70%)', ink: '#ffffff', accent: '#19F7F1' },
  light: { bg: 'radial-gradient(120% 120% at 70% 0%, #ffffff 0%, #E2E6F2 55%, #D9FBFF 100%)', ink: '#01264C', accent: '#0B93AA' },
  pastel: { bg: 'linear-gradient(135deg, #F7F4EE 0%, #F0F3FC 100%)', ink: '#01264C', accent: '#EE8C7A' },
};

/** Temas del Estudio: vista previa con sus swatches (fondo = primero, acento = último). */
function previewFor(id: string, swatches: string[]) {
  if (THEME_PREVIEW[id]) return THEME_PREVIEW[id];
  const [a = '#1f1f24', b = a] = swatches;
  const accent = swatches[swatches.length - 1] ?? '#8b5cf6';
  const lum = (hex: string) => {
    const m = hex.replace('#', '').match(/.{2}/g)?.map((x) => parseInt(x, 16)) ?? [0, 0, 0];
    return (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255;
  };
  return { bg: `linear-gradient(135deg, ${a} 0%, ${b} 100%)`, ink: lum(a) > 0.6 ? '#1b1b22' : '#ffffff', accent };
}

const WORDS_PER_SEC = 2.4;

export function Composer({
  info,
  infoError,
  disabled,
  onCreated,
  projectId,
  onProjects,
  prefill,
  onPrefillClear,
  onStudio,
}: {
  info?: AppInfo;
  infoError?: string;
  disabled: boolean;
  onCreated: (s: RunState) => void;
  /** Proyecto del video (el abierto en Proyectos); null o uno que ya no vale = "Sin clasificar" (ADR-036). */
  projectId: string | null;
  /** Para cambiar de proyecto se vuelve a Proyectos (ADR-053): aquí no hay selector. */
  onProjects: () => void;
  /** Recrear (ADR-033): texto, tema y voz de un video anterior, editables. */
  prefill?: RecreatePrefill;
  onPrefillClear: () => void;
  onStudio: () => void;
}) {
  const [text, setText] = useState('');
  const [theme, setTheme] = useState<ThemeId>('dark');
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voiceId, setVoiceId] = useState<string>('');
  const [voiceError, setVoiceError] = useState<string>();
  const [loadingVoices, setLoadingVoices] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  /** Música de fondo (hito 5): undefined mientras carga (la API usa entonces la de MUSIC_PATH). */
  const [tracks, setTracks] = useState<MusicTrackInfo[]>([]);
  const [music, setMusic] = useState<string | null | undefined>(undefined);
  const [musicError, setMusicError] = useState<string>();
  /** Sonido de los clips (hito 6, ADR-059): el del modelo por defecto. */
  const [sound, setSound] = useState<SoundMode>('model');
  const initialMusic = useRef<string | null>(null);
  useEffect(() => {
    api.music().then(
      (r) => {
        setTracks(r.tracks);
        initialMusic.current = r.initial;
        // Empieza en el track del último video (o en MUSIC_PATH), salvo que se esté recreando un video.
        setMusic((cur) => (cur === undefined ? r.initial : cur));
      },
      (e: Error) => setMusicError(e.message),
    );
  }, []);
  /** Importar desde un PDF o un Word (hito 5): el guion acompaña al texto mientras sus filas coincidan con los párrafos. */
  const [importing, setImporting] = useState(false);
  const [script, setScript] = useState<GenerationScript>();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [unclassifiedId, setUnclassifiedId] = useState<string>();
  // Hito 11 (ADR-142): también los compartidos y públicos; con «Ver los de todos», el admin, los de todos.
  const seeAll = useSeeAll();
  useEffect(() => {
    projectsApi.list(true, seeAll).then(
      (r) => (setProjects(r.projects), setUnclassifiedId(r.unclassifiedId)),
      () => setProjects([]),
    );
  }, [seeAll]);
  /** En un proyecto archivado no se generan videos nuevos: solo se ofrecen los activos ("Sin clasificar" primero). */
  const active = projects.filter((p) => !p.archived);
  /** El proyecto guardado sigue existiendo y no está archivado. */
  const projectOk = !!projectId && active.some((p) => p.id === projectId);
  /** Recrear un video de un proyecto archivado (o volver a uno que se archivó): aviso y "Sin clasificar". */
  const archivedTarget = projectId ? projects.find((p) => p.id === projectId && p.archived) : undefined;
  /** Siempre hay proyecto (hito 4, ADR-035): el elegido o, si no vale, "Sin clasificar". */
  const effectiveProject = projectOk && projectId ? projectId : unclassifiedId;

  useEffect(() => {
    if (!prefill) return;
    setText(prefill.text);
    setTheme(prefill.theme);
    setVoiceId(prefill.voiceId);
    if (prefill.musicTrack !== undefined) setMusic(prefill.musicTrack);
    setSound(prefill.soundMode ?? 'model');
    setScript(prefill.script);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.key]);

  /**
   * Valores por defecto del proyecto (ADR-053): tema, voz y música de su último video. Se aplican una vez
   * por proyecto; al recrear un video mandan los de ese video.
   */
  const target = projects.find((p) => p.id === effectiveProject);
  /**
   * Temas (hito 11, ADR-142): en un proyecto de otro dueño, además de los míos, los de su dueño (se usan, no se editan).
   */
  const [projectThemes, setProjectThemes] = useState<ThemeInfo[]>();
  useEffect(() => {
    if (!target || target.access.role === 'owner') return setProjectThemes(undefined);
    let alive = true;
    projectsApi.themes(target.id).then(
      (t) => alive && setProjectThemes(t),
      () => alive && setProjectThemes(undefined),
    );
    return () => {
      alive = false;
    };
  }, [target?.id, target?.access.role]);
  const themes = projectThemes ?? info?.themes ?? [];
  const defaultsFor = useRef<string>(undefined);
  useEffect(() => {
    if (!target || defaultsFor.current === target.id) return;
    defaultsFor.current = target.id;
    const d = target.defaults;
    if (prefill || !d) return;
    if (!info || themes.some((t) => t.id === d.theme) || target.access.role !== 'owner') setTheme(d.theme);
    if (d.voiceId) setVoiceId(d.voiceId);
    setMusic(d.musicTrack);
    setSound(d.soundMode ?? 'model');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id]);
  // Un track que ya no está en la carpeta de música: se usa el inicial.
  useEffect(() => {
    if (tracks.length && typeof music === 'string' && !tracks.some((t) => t.name === music)) setMusic(initialMusic.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, music]);

  const loadVoices = (refresh = false) => {
    setLoadingVoices(true);
    api
      .voices(refresh)
      .then((v) => {
        setVoices(v);
        setVoiceError(undefined);
        setVoiceId((cur) => (cur && v.some((x) => x.id === cur) ? cur : v.some((x) => x.id === info?.defaultVoiceId) ? info!.defaultVoiceId : (v[0]?.id ?? '')));
      })
      .catch((e: Error) => setVoiceError(e.message))
      .finally(() => setLoadingVoices(false));
  };

  const hfReady = !info?.higgsfield || info.higgsfield.connected;
  useEffect(() => {
    if (info && hfReady) loadVoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.mode, hfReady]);

  const words = useMemo(() => text.trim().split(/\s+/).filter(Boolean).length, [text]);
  const estSec = words / WORDS_PER_SEC;
  const voice = voices.find((v) => v.id === voiceId);

  const togglePreview = () => {
    if (!voice?.previewUrl) return;
    if (playing) {
      audio.current?.pause();
      setPlaying(false);
      return;
    }
    audio.current?.pause();
    audio.current = new Audio(voice.previewUrl);
    audio.current.onended = () => setPlaying(false);
    void audio.current.play().then(() => setPlaying(true), () => setPlaying(false));
  };

  const submit = async () => {
    // Aviso antes de gastar (ADR-069): locución, storyboard y fotogramas; los clips, al aprobar (otro aviso).
    const ok = await confirmSpend({
      title: 'Crear el video',
      body: 'Se locuta el texto, Opus arma el storyboard y se generan los fotogramas clave para que los revises. Los clips de video se generan después, al aprobar los fotogramas (con otro aviso).',
      work: { ttsChars: text.trim().length, llm: 3, images: clipsFor(text) + 1 },
      approx: true,
      action: 'Crear video',
    });
    if (!ok) return;
    setSending(true);
    setError(undefined);
    try {
      onCreated(
        await api.create({
          text,
          theme,
          voiceId: voiceId || undefined,
          projectId: effectiveProject!,
          parentId: prefill?.parentId ?? null,
          ...(music !== undefined ? { musicTrack: music } : {}),
          soundMode: sound,
          ...(script ? { script } : {}),
        }),
      );
      onPrefillClear();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const scriptMismatch = !!script && paragraphCount(text) !== script.rows.length;
  const canSubmit = !disabled && !sending && words >= 5 && !!voiceId && hfReady && !!info && !!effectiveProject && !scriptMismatch;

  return (
    <Card className="h-fit lg:sticky lg:top-6">
      <CardHeader>
        <CardTitle>Nuevo video</CardTitle>
        <CardDescription>Pega el texto de la locución. Cada párrafo se narra por separado.</CardDescription>
        <div className="bg-background/40 mt-2 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <FolderOpen className="text-primary size-3.5 shrink-0" />
            <span className="truncate">
              En <span className="font-medium">{target?.name ?? 'Cargando…'}</span>
              {target && target.access.role !== 'owner' && <span className="text-muted-foreground"> · de {userLabel(target.access.owner)}</span>}
            </span>
          </span>
          <button type="button" onClick={onProjects} className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer" title="Para cambiar de proyecto, vuelve a Proyectos y elige allí «Nuevo video aquí»">
            Cambiar en Proyectos
          </button>
        </div>
        {archivedTarget && (
          <p className="text-warning mt-1 text-[11px]">
            «{archivedTarget.name}» está archivado: el video irá a «Sin clasificar». Desarchívalo en Proyectos para generar allí.
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {infoError && (
          <div className="text-destructive flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs">
            <AlertTriangle className="size-4 shrink-0" /> No hay conexión con la API: {infoError}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <div className="-mb-0.5 flex justify-end">
            <button
              type="button"
              onClick={() => setImporting(true)}
              disabled={disabled}
              className="text-primary inline-flex cursor-pointer items-center gap-1 text-[11px] hover:underline"
            >
              <FileUp className="size-3.5" /> Importar PDF o Word
            </button>
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Bienvenido al Módulo 1 del curso…"
            className="min-h-64 resize-y"
            disabled={disabled}
          />
          <div className="text-muted-foreground flex justify-between text-[11px] tabular-nums">
            <span>{words} palabras</span>
            <span>≈ {estSec < 60 ? `${Math.round(estSec)} s` : `${Math.floor(estSec / 60)} min ${Math.round(estSec % 60)} s`} de video</span>
          </div>
          {script && (
            <div className={cn('flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs', scriptMismatch ? 'border-warning/40 bg-warning/10' : 'border-primary/30 bg-primary/10')}>
              <span className="flex min-w-0 items-center gap-1.5">
                <ScrollText className="size-3.5 shrink-0" />
                <span className="truncate">
                  {scriptMismatch
                    ? `El guion tiene ${script.rows.length} filas y el texto ${paragraphCount(text)} párrafos: deben coincidir (uno por fila).`
                    : `Guion${script.source ? ` de «${script.source}»` : ''}: ${script.rows.length} filas · ${script.rows.filter((r) => r.scene).length} con escena`}
                </span>
              </span>
              <button type="button" onClick={() => setScript(undefined)} className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer">
                Quitar guion
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium">Tema</div>
          <div className="grid grid-cols-3 gap-2">
            {themes.map((t) => {
              const pv = previewFor(t.id, t.swatches);
              const active = theme === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => setTheme(t.id)}
                  className={cn(
                    'group flex cursor-pointer flex-col overflow-hidden rounded-lg border text-left transition-all disabled:cursor-not-allowed',
                    active ? 'border-primary ring-2 ring-primary/30' : 'hover:border-white/20',
                  )}
                  title={t.description}
                >
                  <div
                    className="relative aspect-video"
                    style={{ background: t.thumbnailUrl ? `center / cover no-repeat url("${t.thumbnailUrl}")` : pv.bg }}
                  >
                    {!t.thumbnailUrl && (
                      <div className="absolute inset-x-2.5 top-1/2 -translate-y-1/2">
                        <div className="h-1.5 w-10 rounded-full" style={{ background: pv.ink }} />
                        <div className="mt-1 h-1 w-7 rounded-full opacity-70" style={{ background: pv.ink }} />
                        <div className="mt-1.5 h-0.5 w-6 rounded-full" style={{ background: pv.accent }} />
                      </div>
                    )}
                    <div className="absolute right-2 bottom-2 flex gap-0.5">
                      {t.swatches.slice(0, 4).map((c) => (
                        <span key={c} className="size-1.5 rounded-full ring-1 ring-black/10" style={{ background: c }} />
                      ))}
                    </div>
                  </div>
                  <div className="truncate px-2 py-1.5 text-xs font-medium" title={t.ownerName ? `Tema de ${t.ownerName}, dueño del proyecto` : undefined}>
                    {t.name}
                    {t.ownerName && <span className="text-muted-foreground font-normal"> · de {t.ownerName}</span>}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="text-muted-foreground flex items-start justify-between gap-3 text-[11px]">
            <span>{themes.find((t) => t.id === theme)?.description}</span>
            <button type="button" onClick={onStudio} className="text-primary shrink-0 cursor-pointer hover:underline">
              + Crear tema
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium">Voz</div>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-[11px]"
              onClick={() => loadVoices(true)}
              disabled={loadingVoices || !hfReady}
            >
              <RefreshCw className={cn('size-3', loadingVoices && 'animate-spin')} /> Actualizar
            </button>
          </div>
          <div className="flex gap-2">
            <Select value={voiceId} onValueChange={setVoiceId} disabled={disabled || !voices.length}>
              <SelectTrigger>
                <SelectValue placeholder={!hfReady ? 'Conecta Higgsfield para ver las voces' : loadingVoices ? 'Cargando voces…' : 'Elige una voz'} />
              </SelectTrigger>
              <SelectContent>
                {voices.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.name}
                    {v.description ? <span className="text-muted-foreground"> · {v.description}</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="secondary" size="icon" onClick={togglePreview} disabled={!voice?.previewUrl} title="Escuchar muestra">
              {playing ? <Pause /> : <Play />}
            </Button>
          </div>
          {voiceError && <div className="text-destructive text-[11px]">{voiceError}</div>}
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-xs font-medium">Música de fondo</div>
            <div className="text-muted-foreground text-[11px]">Las correcciones y los re-render usan la misma.</div>
          </div>
          <MusicPicker tracks={tracks} value={music ?? null} onChange={setMusic} disabled={disabled || music === undefined} />
          {musicError && <div className="text-destructive text-[11px]">{musicError}</div>}
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-xs font-medium">Sonido de los clips</div>
          <SoundPicker value={sound} onChange={setSound} disabled={disabled} />
        </div>

        {prefill && (
          <div className="border-primary/30 bg-primary/10 flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs">
            <span className="min-w-0 truncate">
              Recreando <span className="font-mono">{prefill.parentId}</span>: edita lo que quieras y pulsa GENERAR.
            </span>
            <button type="button" onClick={onPrefillClear} className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer">
              Quitar
            </button>
          </div>
        )}

        {importing && (
          <ImportDialog
            projectId={effectiveProject}
            onClose={() => setImporting(false)}
            onImported={(r) => {
              setText(r.text);
              setScript(r.script);
            }}
          />
        )}

        {error && <div className="text-destructive rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs">{error}</div>}

        <Button size="lg" onClick={submit} disabled={!canSubmit} className="w-full tracking-wide">
          {sending ? <Loader2 className="animate-spin" /> : <Sparkles />} GENERAR
        </Button>
        <p className="text-muted-foreground -mt-2 text-center text-[11px]">
          Primero se generan los fotogramas clave para tu aprobación; el video empieza cuando los apruebas.
        </p>
      </CardContent>
    </Card>
  );
}
