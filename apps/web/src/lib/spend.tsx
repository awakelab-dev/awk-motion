import { AlertTriangle, Coins } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { CostUnit, CostUnits } from '@wilox/shared';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';

/**
 * Aviso con confirmación antes de cada operación que gasta dinero en los proveedores (hito 6, ADR-069): crear un
 * video, aprobar fotogramas (genera clips), regenerar un fotograma o un clip, rehacer audio, cambiar el texto,
 * reintentar, reanudar y las pruebas del Estudio. Se llama con `await confirmSpend({...})` y devuelve true si se
 * confirma. El costo es una estimación en USD: el promedio de los trabajos reales en modo API (GET /api/costs/units).
 * Hito 11 (ADR-145): sin créditos (se trabaja solo con API).
 */

/** Qué se va a generar (las cantidades pueden ser aproximadas). */
export interface SpendWork {
  images?: number;
  clips?: number;
  /** Caracteres de locución. */
  ttsChars?: number;
  /** Llamadas a Opus. */
  llm?: number;
}

export interface SpendRequest {
  title: string;
  /** Qué pasa al confirmar (una o dos frases). */
  body?: ReactNode;
  work?: SpendWork;
  /** Si las cantidades son aproximadas (p. ej. antes del storyboard) o el gasto depende de lo pendiente. */
  approx?: boolean;
  /** Texto en lugar del detalle de la estimación (p. ej. "Lo que quede pendiente del video"). */
  workNote?: string;
  /** Texto del botón de confirmar. */
  action: string;
}

let units: Promise<CostUnits> | undefined;
/** Costos unitarios (una vez por sesión; se vuelven a pedir si falla). */
export function costUnits(): Promise<CostUnits> {
  units ??= api.costUnits().catch((e) => {
    units = undefined;
    throw e;
  });
  return units;
}

const nf = (n: number, d = 2) => n.toLocaleString('es-CL', { maximumFractionDigits: d });

/** Estimación en texto: "≈ US$ 0,40". */
export function estimate(u: CostUnits, w: SpendWork): { text?: string; missing: string[] } {
  let usd = 0;
  const missing: string[] = [];
  const add = (unit: CostUnit | undefined, qty: number | undefined, label: string) => {
    if (!qty) return;
    if (!unit) return missing.push(label);
    usd += (unit.usd ?? 0) * qty;
  };
  add(u.image, w.images, 'imágenes');
  add(u.clip, w.clips, 'clips');
  add(u.tts1k, w.ttsChars ? w.ttsChars / 1000 : 0, 'locución');
  add(u.llm, w.llm, 'Opus');
  return { text: usd > 0 ? `≈ US$ ${nf(usd)}` : undefined, missing };
}

/**
 * Costo estimado de un trabajo en texto («≈ US$ 0,67»), para las notas junto a un botón; undefined mientras carga, en
 * MOCK o sin trabajos medidos.
 */
export function useCostText(w: SpendWork): string | undefined {
  const [u, setU] = useState<CostUnits>();
  useEffect(() => {
    costUnits().then(setU, () => undefined);
  }, []);
  if (!u || u.mode === 'mock') return undefined;
  return estimate(u, w).text;
}

/** Detalle de lo que se genera: "3 imágenes · 2 clips · locución de 450 caracteres · Opus". */
function workText(w: SpendWork, approx?: boolean) {
  const a = approx ? '≈ ' : '';
  return [
    w.images ? `${a}${w.images} imagen${w.images === 1 ? '' : 'es'}` : '',
    w.clips ? `${a}${w.clips} clip${w.clips === 1 ? '' : 's'} de video` : '',
    w.ttsChars ? `locución de ${nf(w.ttsChars, 0)} caracteres` : '',
    w.llm ? `Opus${w.llm > 1 ? ` (${w.llm} llamadas)` : ''}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

type Pending = SpendRequest & { resolve: (ok: boolean) => void };
let show: ((p: Pending) => void) | undefined;

/** Pide confirmación antes de gastar. Sin el host montado (no debería pasar), usa el confirm del navegador. */
export function confirmSpend(r: SpendRequest): Promise<boolean> {
  if (!show) return Promise.resolve(window.confirm(`${r.title}\n\nEsta operación tiene costo. ¿Continuar?`));
  return new Promise((resolve) => show!({ ...r, resolve }));
}

/** Monta el diálogo de confirmación (una vez, en la raíz de la app). */
export function SpendConfirmHost() {
  const [p, setP] = useState<Pending>();
  const [u, setU] = useState<CostUnits>();
  const [err, setErr] = useState(false);
  useEffect(() => {
    show = (x) => {
      setP(x);
      costUnits().then(setU, () => setErr(true));
    };
    return () => {
      show = undefined;
    };
  }, []);
  if (!p) return null;
  const close = (ok: boolean) => {
    p.resolve(ok);
    setP(undefined);
  };
  const w = p.work ?? {};
  const est = u ? estimate(u, w) : undefined;
  return (
    <Modal title={p.title} onClose={() => close(false)} className="max-w-lg">
      <div className="grid gap-4 text-sm">
        {p.body && <div className="text-muted-foreground">{p.body}</div>}
        <div className="border-warning/30 bg-warning/10 grid gap-1.5 rounded-lg border p-3">
          <div className="text-warning flex items-center gap-1.5 font-medium">
            <Coins className="size-4" /> Esta operación tiene costo
          </div>
          {p.workNote ? <div className="text-xs">{p.workNote}</div> : workText(w, p.approx) && <div className="text-xs">{workText(w, p.approx)}</div>}
          <div className="text-xs">
            {u?.mode === 'mock' ? (
              'Modo MOCK: en esta instalación no se gasta nada (proveedores de prueba).'
            ) : est?.text ? (
              <>
                Costo estimado: <b>{est.text}</b>
                {est.missing.length > 0 && <span className="text-muted-foreground"> (sin datos para estimar {est.missing.join(', ')})</span>}
                <span className="text-muted-foreground"> · promedio de los trabajos reales en modo API</span>
              </>
            ) : err ? (
              <span className="text-muted-foreground inline-flex items-center gap-1">
                <AlertTriangle className="size-3.5" /> No se pudo calcular el costo estimado.
              </span>
            ) : !u ? (
              <span className="text-muted-foreground">Calculando el costo…</span>
            ) : (
              <span className="text-muted-foreground">Aún no hay trabajos medidos para estimar el costo.</span>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => close(false)}>
            Cancelar
          </Button>
          <Button onClick={() => close(true)} autoFocus>
            <Coins /> {p.action}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Palabras de un texto (para estimar clips antes del storyboard: ≈ 20 palabras por clip, medido en el hito 6). */
export const words = (t: string) => t.split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)).length;
export const clipsFor = (t: string) => Math.max(1, Math.round(words(t) / 20));
