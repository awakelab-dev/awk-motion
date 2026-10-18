# 09 · Producción por lotes (hito 5)

Cómo se comporta la cola global (ADR-045 a ADR-047) y cómo comprobarlo. `pnpm queue:bench` corre contra la API en marcha (`pnpm dev`), en el modo que tenga.

## Cómo se prueba
```bash
pnpm queue:bench --single --correct            # modo API: 1 video de referencia y después 6 en 2 proyectos
pnpm queue:bench --ref-min 8.7 --correct       # igual, sin el video de referencia (8,7 min = docs/08)
pnpm queue:bench --ref-min 1 --correct --fail  # mock: el video 3 falla una vez y se reintenta
```
- Pide el email y la contraseña (o `BENCH_EMAIL` / `BENCH_PASSWORD`). Crea 2 proyectos "Lote <hora> A/B", lanza los videos seguidos y aprueba cada uno en cuanto queda esperando.
- Con `--correct`, cuando el video 1 queda esperando aprobación corrige su K01 mientras los demás siguen, y al final comprueba en `QueueTask` que la corrección pasó antes que los trabajos pendientes de los videos posteriores.
- Se puede reiniciar la API a mitad del lote (Ctrl+C y `pnpm dev`): el script espera y sigue. Al final informa si algún trabajo se pagó dos veces.

## Resultados en mock (02-10-2026, entorno de Claude)
Con `MOCK_SPEED=3`: un video solo tarda ≈ 1 min (con la aprobación al instante).

| Prueba | Resultado |
|---|---|
| 6 videos en 2 proyectos, sin esperar | 2,9 min frente a ≈ 6 min uno tras otro (≈ 49 %) |
| Reinicio de la API a mitad del lote | todo siguió solo; 10 envíos de clips para 10 clips; ningún trabajo pagado dos veces |
| Video con fallo forzado (`[mock:fallar]`) | solo ese video quedó con error; se reintentó y terminó; los demás no se frenaron |
| Corrección de K01 del video 1 (`QUEUE_ANTHROPIC_CONCURRENCY=1`, `QUEUE_OPENAI_CONCURRENCY=2`) | la reescritura pasó antes que 2 trabajos de Opus pendientes de videos posteriores y la imagen antes que 1; ninguno la adelantó |
| Duración | los 6 finales duran exactamente lo que su locución |

## Resultado en modo API
**13-10-2026 (ADR-127)**: Leonardo ya lo corrió en uso real en producción, con decenas de clips: todo funcionó y lo que no estaba optimizado se fue optimizando en los hitos 6 a 9 (p. ej. `MINIMAX_CONCURRENCY=20`). No se corre `queue:bench` con claves reales; la tabla queda como guía si algún día se quiere medir.

Tabla original (sin completar):

| Prueba | Resultado |
|---|---|
| 6 videos en 2 proyectos | |
| Uno tras otro (referencia) | |
| Corrección del video 1 | |
| Reinicio a mitad del lote | |
| Pagados dos veces | |
| Capacidad real de cada cuenta (`pnpm api:limits`) | |

## Notas
- La aprobación sigue siendo manual (ADR-004). Un video que espera aprobación no ocupa capacidad; el bench aprueba al instante para medir solo la máquina.
- Con la capacidad por defecto, el cuello de botella en API son los clips de MiniMax (6 a la vez, ~4–5 min cada uno): 6 videos de ~4 clips son 24 clips ≈ 4 tandas.
- Si el proveedor responde con límites, la vista "Cola" muestra la capacidad reducida (p. ej. "3 / 6 · máx. 6") y los trabajos "reintentando tras un límite del proveedor"; se recupera solo.
