# 08 · Modo MCP frente a modo API (hito 4, 28-09-2026)

Mismo texto (el de la Dark de referencia, 455 caracteres), tema Dark, en el proyecto "Comparación MCP vs API". Ningún fotograma ni clip regenerado en ninguno de los dos; las sugerencias de Opus se dejaron como estaban en ambos. Tabla generada con `pnpm compare:runs` (ADR-039).

| | API | MCP |
|---|---|---|
| Generación | `20260928-120014-dark-f92b4d` | `20260928-123020-dark-70eb8d` |
| Proveedores | ElevenLabs v3 (voz Victoria) · OpenAI gpt-image-2.5-sunburst · MiniMax-H3 | Higgsfield: text2speech_v2 (voz Chilena) · whisper en sandbox · gpt_image_2_5 · minimax_h3 |
| Duración de la voz | 29,04 s | 27,46 s |
| Final = voz | sí (697 f) | sí (659 f) |
| Fotogramas / clips (regenerados) | 5 (0) / 4 (0) | 5 (0) / 4 (0) |
| Frames entregados por clip | 124 | 124 |
| SSIM inicio (media · mín) | 0,974 · 0,958 | 0,952 · 0,931 |
| SSIM fin (media · mín) | 0,939 · 0,850 | 0,922 · 0,860 |
| Fase 1 (hasta la aprobación) | 2,7 min | 3,6 min |
| Fase 2 (clips → final) | 5,5 min | 6,0 min |
| Total con la espera de aprobación | 8,7 min | 10,3 min |
| Locución | US$ 0,04 | 1,5 cr = US$ 0,08 |
| Opus (3 llamadas) | US$ 0,32 | US$ 0,34 |
| Fotogramas (5) | US$ 0,29 | 13,75 cr = US$ 0,69 |
| Clips (4) | US$ 2,60 | 40 cr = US$ 2,02 |
| **Total** | **US$ 3,24** | **US$ 3,12** (55,25 cr) |

Precios: planes de Awakelab (Higgsfield Ultra US$ 302,50 / 6.000 créditos; ElevenLabs US$ 250 / 1,8 M créditos) y precios públicos de septiembre de 2026 (Opus 4/20 por millón; GPT Image 5/8/30 por millón; MiniMax 0,13 por segundo en 2K). Detalle en ADR-038.

## Calidad (valoración de Leonardo)
- Los dos videos "quedaron fenomenal"; en API "la voz, la sincronía, todo OK". Texto de los fotogramas sin erratas en ambos modos.
- Voces distintas por diseño: la "Chilena" de Higgsfield frente a Victoria (ElevenLabs, chilena). La elección de voz en API se hace con `ELEVENLABS_DEFAULT_VOICE_ID` o en el selector.
- SSIM de los bordes por debajo del ≥0,98 del piloto en los **dos** modos (el mínimo, 0,85–0,86, en el fin de un clip): no es propio del modo API. Con los principios de riqueza (ADR-010) los fotogramas son más complejos y MiniMax aterriza menos exacto en Ki; no se vio salto en el video. A vigilar: el congelado sale de Ki, así que una diferencia grande sí se notaría.

## Conclusiones
1. **Costo prácticamente igual** por video (+4 % en API). Por partida: fotogramas −58 % y voz −50 % en API; clips +29 % en API (MiniMax cobra US$ 0,65 por clip frente a 10 créditos = US$ 0,50).
2. **API algo más rápido** (−16 % en total): la locución y los tiempos por palabra salen de una sola llamada de ElevenLabs (sin whisper) y los clips de MiniMax tardan ~4–5 min frente a 8–10 en Higgsfield.
3. **Capacidad**: con el plan Ultra, 6.000 créditos al mes dan para ~108 videos como este, unos **50 min de video al mes**. Las 2 h del curso (~14.500 créditos) no caben en un mes de MCP; en API no hay tope (se paga por uso; ojo con los límites por minuto de OpenAI según el nivel de la cuenta).
4. **Proyección 2 h** (≈ 250 bloques como este): ~US$ 800 en cualquiera de los dos modos.
5. Un modo **mixto** (imágenes y voz por API, clips por Higgsfield) costaría ~US$ 2,67 por video (−14 %). No está implementado; queda como idea para un hito posterior.

## Verificaciones del hito 3 hechas con créditos reales (MCP, 28-09-2026)
- Corregir un fotograma (K01) de un video terminado: solo se rehicieron clip01 y clip02 y quedó `final_v2.mp4` (ADR-033).
- Regenerar un clip suelto (clip03) con indicación: solo clip03 pasó a v2 y quedó `final_v3.mp4`.
- Recrear (`20260928-132246-dark-ee77fb`) y cambiar el texto: los dos videos nuevos quedaron en el proyecto del original y enlazados con "Versión de 20260928-123020-dark-70eb8d".
