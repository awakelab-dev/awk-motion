# 01 · Contexto del proyecto

## Qué es
- **Micro Cápsulas**: videos educativos cortos, en español de Chile, para el curso de **IAAS** (Infecciones Asociadas a la Atención de Salud) del cliente **Mutual**. Los produce Awakelab.
- Lenguaje visual: Motion Graphics con tipografía cinética, moderno e innovador. Tres estilos definidos (ver 05_estilos.md).
- Objetivo de producción: **~2 horas de video** con presupuesto y plazo ajustados.
- Motor: modelos de **Higgsfield** a través de su conector. Video con MiniMax H3 2K, imágenes con GPT Image 2.5 y voz con ElevenLabs V3 (voz "Chilena").
- **Wilox Motion** es el MVP que convierte este proceso manual en una app (frontend + backend).

## Principio económico
Solo una parte de cada escena es video IA (~50–70 %). El resto son **congelados**: el último frame de un clip se mantiene fijo mientras la voz sigue. La locución manda sobre la línea de tiempo; los clips se acomodan a las palabras clave (PFC).

## Historial (22–23 de septiembre de 2026)
1. **test01**: primer clip MiniMax H3 2K de 5 s ("IAAS / Seguridad del paciente") a partir del PDF. Resultado excelente.
2. **Descargas automáticas**: se añadió `d8j0ntlcm91z4.cloudfront.net` a la allowlist de la organización.
3. **Pipeline completo, escena01 Glossy Dark**: párrafos 1 y 2 del PDF, 70,17 s, 7 clips IA encadenados con congelados, SFX sintetizados y música de fondo.
4. **Corrección**: en el clip de "4 bloques", los números se sustituyeron por íconos 3D glossy con el texto de cada bloque.
5. **Mezcla final**: voz 1.0, SFX 0.3, Inspiring.mp3 0.1.
6. **Glossy Light**: la misma escena01 sobre cielo con humo claro. A Leonardo le gusta su tipo y tamaño de letra (menos recargado), aunque prefiere el estilo dark.
7. **Pastel Kinetic**: primero una prueba de 12 s ("Guao") y después 30 s (párrafo 1, 4 clips). Lleva video real dentro de marcos redondeados, morphs y texto bicolor.
8. **Portadas**: una portada por estilo con GPT Image 2.5. Fue una actividad puntual y no forma parte del pipeline.
9. **Prueba de frames con GPT Image 2.5**: 18 fotogramas clave (D01–D07, L01–L07, P01–P04) generados en paralelo, sin ninguna errata de texto.
10. **Piloto "imágenes primero"** (Pastel, 30 s): 4 clips MiniMax lanzados en paralelo con imagen de inicio y fin de GPT Image. Tardó ~14 min en total, costó 53,75 créditos y no tuvo erratas. **Se adopta como approach del MVP**, con el criterio imagen/video de 04_aprendizajes.md.

## Cifras de referencia
| Concepto | Valor |
|---|---|
| Clip MiniMax H3 2K | 5 s pedidos → 5,167 s entregados (124 frames a 24 fps) · 10 créditos |
| GPT Image 2.5 | 2k high 2,75 · 2k medium 1 · 1k medium 0,5 créditos · salida 2688×1520 |
| escena01 (70 s) | 7 clips IA (36,2 s, 52 %) + 34 s de congelados |
| Pastel 30 s | 4 clips IA (20,7 s, 69 %) + congelados |
| Encadenado secuencial | ~9–10 min por clip (cada clip espera al anterior) |
| Imágenes primero | ~2 min las imágenes (en paralelo) + ~9 min una tanda de hasta 12 clips en paralelo |
| Proyección 2 h (240 bloques de 30 s) | ~10.100 créditos (imágenes 1k medium) a ~12.200 (2k high); ~3 h de generación en paralelo frente a ~40 h en secuencial |

## Carpetas
- Producción (referencia): `~/Proyectos/Videos Mutual/Micro Cápsulas IAAS/`
  - `tests/`: PDF fuente y test01.
  - `escena01/` (dark), `escena01_light/`, `escena01_pastel/`: clips, prompts, `_raw/` y `_versiones/`.
  - `finales/`: videos finales y portadas.
  - `estilos/`: fichas de estilo.
  - `herramientas/`: scripts. Hay copia en `referencia/scripts/`.
  - `prueba_frames_gpt_image/`: frames GPT y `piloto_pastel/`.
- MVP: `~/projects/wilox-motion/`, esta carpeta.
- Docs del proyecto en claude.ai (proyecto "Micro Cápsulas"): `claude/flujo-micro-capsulas.md`, `claude/estilos.md` y `claude/wilox-motion-traspaso.md`.
