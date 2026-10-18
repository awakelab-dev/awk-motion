import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** Nombres de las voces de ElevenLabs (id → nombre), pedidos una vez por sesión de la app. */
let cache: Promise<Map<string, string>> | undefined;
const load = () =>
  (cache ??= api.voices().then(
    (vs) => new Map(vs.map((v) => [v.id, v.name])),
    () => {
      cache = undefined;
      return new Map<string, string>();
    },
  ));

/** Nombre de una voz por su id; mientras carga (o si ya no está en la cuenta), el id abreviado. */
export function useVoiceName(id: string | undefined): string | undefined {
  const [names, setNames] = useState<Map<string, string>>();
  useEffect(() => {
    let alive = true;
    if (id) void load().then((m) => alive && setNames(m));
    return () => {
      alive = false;
    };
  }, [id]);
  if (!id) return undefined;
  return names?.get(id) ?? (names ? `voz ${id.slice(0, 6)}…` : '…');
}
