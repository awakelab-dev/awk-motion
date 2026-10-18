# 03 · Higgsfield: modelos, parámetros, costos y trampas

Todo el trabajo se hizo con el **conector MCP de Higgsfield** desde Cowork. Para el MVP hay que decidir si el backend usa la **API oficial** (existe: https://cloud.higgsfield.ai y la guía https://open.higgsfield.ai/quick-start) o el conector. **Antes de diseñar, verificar** que la API expone los mismos modelos (`minimax_h3`, `gpt_image_2_5`, `text2speech_v2` con la voz "Chilena"), con los mismos roles de medios y los mismos costos.

## Modelos usados
| Uso | Modelo | Parámetros | Costo |
|---|---|---|---|
| Video | `minimax_h3` | 16:9, 2K, duración 5 s; medias con rol `start_image` y, opcionalmente, `end_image` | 10 créditos por clip (igual con o sin end_image) |
| Fotogramas | `gpt_image_2_5` | 16:9, resolution 2k, quality high | 2,75 (2k high) · 1 (2k medium) · 0,5 (1k medium) |
| Voz | `text2speech_v2` | variante ElevenLabs V3; voz de tipo *element* "Chilena", voice_id `97775303-f689-4cac-b904-fe7887d4899e` | ver `transactions` |

- MiniMax entrega **5,167 s** (124 frames a 24 fps), 2560×1440, con audio nativo (se descarta).
- GPT Image 2.5 entrega 2688×1520. Para usarlo como congelado se escala y recorta a 2560×1440.

## Herramientas del conector que se usaron
- `generate_video`, `generate_image`, `generate_audio` y sus versiones `_batch` (**hasta 12 trabajos por lote**).
- `jobs_wait` (long-poll de hasta 15 s; hay que repetirlo) y `show_generation_by_ids` para mostrar resultados.
- `media_upload` → PUT al presigned URL → `media_confirm`, para subir frames propios.
- `sandbox_exec`: sandbox con red de Higgsfield. Se usó para faster-whisper y para subir frames.
- `balance` y `transactions` para el control de costos. Saldo al 23-09-2026: 2.512,44 créditos, plan Ultra.

## Trampas conocidas
1. **Preset recomendado que bloquea el envío**: el conector recomienda el preset "IN THE DARK" y rechaza el trabajo. Hay que enviar **siempre** `declined_preset_id: "24bae836-2c4a-48e0-89b6-49fcc0b21612"` en MiniMax. Pasó incluso dentro de un lote. El preset recomendado cambia según el prompt (p. ej. "DROWN IN MUSIC", `f1821f84-945b-4cd1-9085-1f479db0028e`); la app reenvía el índice con el id que indica el error (ADR-024).
2. **El job_id sirve como medio**: el `job_id` de una imagen generada se puede pasar directamente como valor de `start_image` / `end_image`, sin descargar ni subir nada. Es clave para la variante B.
3. **Descargas**: los resultados salen de `https://d8j0ntlcm91z4.cloudfront.net/...`. Ese dominio está en la allowlist de la organización.
4. **Subidas**: el host S3 del presigned URL **no** está en la allowlist de Cowork, ni en la nube ni en la VM local. Solución: extraer el frame y hacer el PUT desde `sandbox_exec`. Un backend propio fuera de Cowork no debería tener este problema.
5. Un `generate_image` falló una vez por un error de parseo JSON de los parámetros. Reintentarlo con parámetros simples funcionó.
6. `jobs_wait` puede devolver `all_terminal: false`: se vuelve a llamar tras `poll_after_seconds`.

## Tiempos observados
- Clip MiniMax H3 2K: ~8–10 min, en secuencial o en paralelo. 4 clips en paralelo terminaron en ~8,5 min.
- GPT Image 2.5 (2k high): ~1–2 min. Un lote de 12 terminó en ~1 min.
