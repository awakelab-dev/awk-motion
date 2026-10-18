/** Tipo y versión de un prompt guardado a partir del nombre de su archivo (K01_superprompt_v2.md → keyframe, 2). */
export function promptMeta(name: string): { kind: string; version: number } {
  const base = name.split('/').pop() ?? name;
  const version = Number(base.match(/_v(\d+)(?:\.|_|$)/)?.[1] ?? 1);
  const n = base.toLowerCase();
  let kind = 'other';
  if (/^k\d+|imagen|image|fotograma|keyframe/.test(n)) kind = 'keyframe';
  if (/^clip|clip_/.test(n)) kind = 'clip';
  if (/revision|review/.test(n)) kind = 'review';
  if (/storyboard/.test(n)) kind = 'storyboard';
  if (/tiempos|timing|words/.test(n)) kind = 'timing';
  if (/plan\.json$/.test(n)) kind = 'plan';
  if (/_system\.md$|_user\.md$|_respuesta\.json$/.test(n) && !/revision/.test(n)) kind = 'proposal';
  return { kind, version };
}
