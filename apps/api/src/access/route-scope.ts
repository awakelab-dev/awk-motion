/**
 * Qué protege una ruta (hito 11, ADR-142): toda ruta con sesión bajo `projects/:id…` exige acceso a ese proyecto y toda
 * ruta bajo `generations/:id…`, acceso al proyecto del video. Lo comprueba el guard global antes del controlador, así
 * ningún servicio necesita filtrar por el dueño para autorizar. Las demás rutas (lotes, publicaciones, observaciones,
 * papelera) comprueban lo suyo en el servicio.
 */
export type RouteScope = { kind: 'project' | 'generation'; id: string; trashed?: boolean } | undefined;

export function routeScope(path: string | undefined, params: Record<string, string | undefined>): RouteScope {
  if (!path || !params.id) return undefined;
  const m = /^(?:\/api)?\/(projects|generations)\/:id(?=\/|$)(\/[^/]+)?/.exec(path);
  if (!m) return undefined;
  if (m[1] === 'projects') {
    // Cambiar el dueño (admin) también de un proyecto que está en la papelera.
    return { kind: 'project', id: params.id, ...(m[2] === '/owner' ? { trashed: true } : {}) };
  }
  return { kind: 'generation', id: params.id };
}
