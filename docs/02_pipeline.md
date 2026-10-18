# 02 · Pipeline de producción (lo que el MVP debe automatizar)

Unidades: **Curso → Lección (PDF) → Escena (1–2 párrafos) → Segmentos de la línea de tiempo (clip IA o congelado)**. Todo trabaja a 24 fps con cortes alineados a frame; el audio va a 48 kHz (2000 muestras por frame).

## Paso 0 · Entradas
- Texto fuente: un PDF de la lección (ejemplo: `tests/Bienvenida y Definiciones Clave.pdf`). Cada párrafo es una unidad de locución.
- Estilo: Glossy Dark, Glossy Light o Pastel Kinetic (05_estilos.md).
- Música de fondo (ejemplo: `Inspiring.mp3`).

## Paso 1 · Locución (TTS)
- Higgsfield `generate_audio`, modelo `text2speech_v2`, variante ElevenLabs V3, voz de tipo *element* **"Chilena"** (voice_id `97775303-f689-4cac-b904-fe7887d4899e`).
- Se genera un audio por párrafo. Después se monta la pista global `voz_completa.wav`. Ejemplo: el párrafo 1 dura 29,23 s; se deja una pausa de 0,77 s y el párrafo 2 empieza exactamente en 30,000 s. Conviene que cada párrafo arranque en un frame "redondo".
- No se usa música ni voz dentro de los clips de video.

## Paso 2 · Tiempos por palabra
- faster-whisper con timestamps por palabra. Se ejecutó en el sandbox de Higgsfield (`sandbox_exec`).
- Cuidado: transcribe "IAS" cuando la voz dice "IAAS". El texto fuente manda; whisper solo aporta los tiempos.

## Paso 3 · PFC (palabras/frases clave)
- Se eligen las ideas visuales de cada párrafo. La **primera PFC va obligatoriamente al inicio**.
- Cada PFC genera **un clip IA de 5 s**, que empieza **~1 s antes** de que la voz diga la PFC.
- Ejemplo real en `referencia/prompts/escena01_dark_storyline.md`: 7 PFC en 70 s.

## Paso 4 · Plan de la línea de tiempo
- Cada segmento se define como `(nombre, frame_inicio, frame_fin)`. Los clips IA miden 124 frames. El congelado `clipNNex` rellena desde el fin de un clip hasta el inicio del siguiente. El último congelado llega hasta el final de la voz.
- Ejemplo (`referencia/scripts/plan.py`): `clip01 0–124, clip01ex 124–259, clip02 259–383…`, total 1684 frames = 70,167 s.
- Si dos PFC quedan a menos de 5,167 s, se agrupan en un solo clip o se desplaza el inicio.

## Paso 5 · Superprompts (en inglés, textos en español)
La estructura probada, en este orden:
1. **STYLE BIBLE** del estilo, idéntica en todos los clips.
2. **SHOT NN - título (5 seconds)**, con una línea de tiempo por tramos: `0.0-0.8s: …`, `0.8-2.2s: …`.
3. **END STATE**: el último segundo debe quedar calmo, casi estático y balanceado, porque se congelará.
4. **SOUND**: solo efectos sincronizados, sin música ni voz. Hasta el hito 5 el audio nativo se descartaba; desde el hito 6 se usa (ADR-059).
5. **TYPOGRAPHY RULES**: texto 2D plano, ortografía exacta con tildes, lista literal de palabras permitidas y "no other words".
6. **AVOID**: lo que el estilo prohíbe, más letras deformadas y temblor de cámara al final.
- Hay que guardar cada superprompt usado (`prompts/clipNN_superprompt.md`, versionado si se regenera).

## Paso 6 · Generación de video
### Variante A · Encadenado (usada en escena01 y Pastel 30 s)
- El clip N+1 usa `start_image` = último frame del clip N, también al pasar de un párrafo al siguiente.
- Es secuencial: ~9–10 min por clip. MiniMax tiene más libertad creativa (más "osado"), pero el texto final depende de MiniMax y puede salir con erratas.

### Variante B · Imágenes primero (ADOPTADA para el MVP)
1. Se generan los fotogramas clave **K0…Kn** con GPT Image 2.5 en **un solo lote paralelo**. K0 es la imagen de intro (solo el fondo del estilo, sin texto) y Ki es el estado final del clip i, con todo el texto.
2. **Revisión humana de los fotogramas**: texto, composición y criterio imagen/video. Es barato corregir aquí.
3. Todos los clips se lanzan en paralelo (`generate_video_batch`, hasta 12): clip i con `start_image = K(i-1)` y `end_image = Ki`. El prompt describe la transición entre ambos estados y termina con "lands EXACTLY on the provided end frame composition".
4. **Criterio de medios en marcos** (04_aprendizajes.md): alternar video e imagen, empezando por video.
- Resultado del piloto: un bloque de 30 s en ~14 min, contra ~60 min en secuencial con regeneraciones. SSIM entre bordes y fotogramas de ≥0,984 (sin salto visible) y cero erratas.

## Paso 7 · Descarga y verificación de cada clip
- Descargar (`referencia/scripts/fetch.sh`). Genera el último frame, una hoja de contacto, el audio nativo y la curva de movimiento.
- **Revisar SIEMPRE el texto del último frame** antes de continuar, porque ese frame se congela.
- En la variante B, comparar con SSIM el primer y el último frame contra K(i-1) y Ki (06_ffmpeg_recetas.md).
- Si hay errata, regenerar solo ese clip (10 créditos) y mover el malo a `_versiones/`.

## Paso 8 · SFX
- Se sintetizan con `referencia/scripts/sfx.py` (numpy, sin samples externos). Hay eventos `nombre@segundo` colocados sobre los picos de la curva de movimiento (`mcurve.py`).
- Generadores: sweep, whoosh, impact, ping, riser, shatter, sparkle, pulse, pop, bubble, tick, air. Glossy usa sweep/whoosh/impact/shatter/ping; Pastel usa pop/bubble/whoosh/sparkle.
- Whoosh y riser se anticipan solos para que su pico coincida con el tiempo indicado.
- Se hace mux en `clipNN.mp4`: video IA + wav de SFX; el audio nativo de MiniMax se descarta.
- **Desde el hito 6 (ADR-059)** el sonido por defecto es el audio nativo de MiniMax, normalizado a −18,4 LUFS con fundidos (20 ms / 250 ms) y bajo la voz a 0.3; los SFX sintetizados quedan como opción por video o por clip.

## Paso 9 · Congelados
- `clipNNex.mp4` se crea desde el último frame del clip (o desde Ki escalado a 2560×1440), con la duración exacta en frames y una pista de audio silenciosa (`freeze.sh`).
- Desde el hito 6 (ADR-055) el frame sale del clip en bruto y clips y congelados se codifican ya con los parámetros del final (CRF 16), idénticos entre sí.

## Paso 10 · Locución por clip
- `clipNN.mp3` y `clipNNex.mp3` son la voz cortada por muestras según el plan. Sirven como entregable para editar. Ojo: el MP3 añade ~40 ms de padding al inicio.

## Paso 11 · Render final
- Concat de todos los segmentos con: voz 1.0, SFX 0.3, música 0.1 (fade in 0,5 s y fade out 2–2,5 s), `alimiter 0.95`.
- Video H.264 CRF 16 a 2560×1440 y 24 fps, `trim=end_frame=<total>`. Audio AAC 256k. Receta en 06_ffmpeg_recetas.md.
- Desde el hito 6 (ADR-055) el final une los segmentos sin recodificar el video (concat con copia) y solo mezcla el audio: voz 1.0, sonido de cada clip 0.3 en su frame (WAV aparte), música 0.1. Tarda segundos.
- Desde el hito 6 (ADR-056) el post de cada clip (paso 8–9) se hace en cuanto el clip llega, y un segmento ya hecho con la misma clave (versión del clip, frames, sonido) no se repite.

## Nomenclatura
`escenaNN[_estilo]/clipNN.mp4` (IA + SFX), `clipNNex.mp4` (congelado), `clipNN.mp3` / `clipNNex.mp3` (voz), `_raw/clipNN_ia.mp4`, `_raw/clipNN_sfx.wav`, `_raw/voz_completa.wav`, `frames/`, `prompts/`, `_versiones/`, `finales/escenaNN_final_<estilo>.mp4`.

## Paso 12 · Subtítulos (hito 6, ADR-061)
- Con cada final se escriben `final_vN.vtt` y `.srt` desde los tiempos por palabra y el texto del video tal cual está escrito: una línea de hasta 42 caracteres (ADR-062), de 1 a 6 s, cortes en la puntuación y sin solaparse. Nunca se incrustan en el video.

## Dividir un clip en dos (hito 10, ADR-130)
- A mano, desde «Editar clip», cuando un tramo (clip + congelado) dura 10,3 s o más: un fotograma intermedio en una palabra cerca de la mitad y dos clips (K(i-1)→Kmedio y Kmedio→Ki). Lo que sigue se renumera y el final se vuelve a unir.

## Locución en un solo pedido (hito 10, ADR-133)
- Desde el hito 10 los videos nuevos piden toda la locución a ElevenLabs v3 de una vez y la cortan por párrafos con la alineación (pausas naturales del propio pedido; bloques de párrafos enteros si pasa de 5.000 caracteres). «Rehacer audio» vuelve a pedir toda la locución. Los videos anteriores siguen por párrafo (paso 1 de arriba).

