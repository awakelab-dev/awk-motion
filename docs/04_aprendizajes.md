# 04 · Aprendizajes

## Texto y erratas
- **MiniMax comete erratas en textos largos en minúscula**: "durante **a** estancia" (dark y light, clip05), "transmisí**m**" (light, clip07) y "Definiciones cla**va**" dos veces (pastel, clip04). Fueron 3 de 17 clips con texto largo.
- Mitigaciones que funcionaron:
  - Partir el texto en líneas explícitas: `line 1: "…" line 2: "…"`.
  - Deletrear la palabra crítica: `CLAVE (C-L-A-V-E, last letter is E, never CLAVA)`.
  - **Pasar las leyendas largas a MAYÚSCULAS**. Así salió bien a la primera.
  - Usar la frase literal de la locución ("durante **su** estancia").
- El texto corto (1–4 palabras por elemento) sale casi siempre bien.
- **GPT Image 2.5 generó 18 de 18 fotogramas con mucho texto sin ninguna errata.** Por eso, en la variante B el texto final queda garantizado y revisable antes de gastar en video.

## Encadenado vs imágenes primero (piloto 23-09-2026)
| | Encadenado (A) | Imágenes primero (B) |
|---|---|---|
| Tiempo, bloque de 30 s | ~40 min + regeneraciones (~60 min) | ~14 min en total |
| Costo, bloque de 30 s | 40 + regeneraciones (60 en la práctica) | 53,75 (40 video + 13,75 imágenes); ~42 con imágenes 1k medium |
| Erratas | 3 de 17 clips | 0 |
| Continuidad | perfecta (frame real) | SSIM ≥0,984 en los bordes, sin salto visible |
| Creatividad | algo más osada (p. ej., la enfermera caminando) | muy profesional; tiende a dejar las fotos fijas |
| Regenerar un clip | rompe la cadena de los siguientes | independiente |
- Veredicto de Leonardo: **A es un poco más creativo, pero B merece la pena por velocidad y por el costo de editar. Se adopta B.**
- En B hay que generar **todas** las imágenes al inicio en un solo lote, incluida la intro K0. En el piloto, el clip01 esperó 2 min por P00.
- En B, los clips suelen quedar estables el último ~1,5 s, lo que sirve de colchón para la voz.
- Las fotos realistas pueden variar sutilmente entre el fotograma y el video (SSIM 0,94 en el clip01 por la enfermera), sin que se note.

## Criterio de medios en marcos (ADOPTADO, 23-09-2026)
Problema detectado en B: los marcos con fotos reales se quedaron como imagen fija, cuando en A eran mini-videos con acción.
Regla de Leonardo: "Una imagen por cada video". Cuando una composición tiene marcos con medios reales, se alternan **empezando por video**:
| Nº de marcos | Asignación |
|---|---|
| 1 | video |
| 2 | video + imagen |
| 3 | video + imagen + video |
| 4 | video + imagen + video + imagen (se extiende la alternancia) |
- En el prompt de MiniMax, cada marco se etiqueta explícitamente: `frame 1: LIVE-ACTION VIDEO — the nurse keeps walking down the corridor the whole clip, camera slowly tracking` o `frame 2: STILL PHOTO (subtle parallax only)`.
- En la imagen GPT, los marcos de video se componen "a mitad de acción" (una pose en movimiento) para sugerir continuidad.
- El resultado tiene algo de azar. Si un clip clave sale sin acción, se puede lanzar una segunda variante en paralelo (+10 créditos, sin coste de tiempo).
- La tabla de 4 marcos es una extensión de la regla que conviene confirmar con Leonardo.

## Otros
- La locución manda: primero la voz, luego la línea de tiempo y después los clips.
- Cada congelado debe salir de un END STATE calmo. Hay que pedirlo explícitamente en el prompt.
- En los estilos Glossy, los números sueltos ("1, 2, 3, 4") se sustituyeron por **íconos 3D glossy + texto del bloque**. Se ve más rico.
- Glossy Light: a Leonardo le gusta su tipografía y tamaño (menos recargado). Glossy Dark es su preferido en general. Pastel Kinetic le encantó.
- Los SFX sintetizados funcionan bien a volumen 0.3. La música va al 0.1 para no competir con la voz.

## Entorno Cowork (solo si se vuelve a trabajar en Cowork)
- En la VM local no se puede `rm`: hay que sobrescribir o mover a `_versiones/`.
- Los procesos en segundo plano (`nohup`) mueren; hay que ejecutar en primer plano. Los renders tardan 13–50 s.
- La carpeta con tilde se referencia con `$(ls -d "$HOME"/mnt/*Micro*)`.
- El render debe llevar `settb=1/24,setpts=N,fps=24,trim=end_frame=N` y `-r 24` para evitar la deriva de frames.
