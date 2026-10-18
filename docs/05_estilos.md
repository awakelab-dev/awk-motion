# 05 · Estilos

Style bibles de video (MiniMax) listas para pegar; se copian literalmente en cada clip. Las versiones para fotogramas GPT Image 2.5 ("Single still frame from…") están en `referencia/prompts/piloto_imagenes_primero/superprompts_gpt_image_2_5.md`. Las rutas `../` son relativas a la carpeta de producción `Micro Cápsulas IAAS/estilos/`.

> **Hito 2 (ADR-017):** estas bibles son las de los 3 temas base (`BASE_THEMES`). Los temas nuevos se crean en la pestaña Estudio y viven en `storage/themes/<id>/theme.json`.

Preferencias de Leonardo: Glossy Dark es su favorito; de Glossy Light le gustan la tipografía y el tamaño (menos recargado); Pastel Kinetic le encantó y es el estilo del piloto adoptado.

---

## Estilo · Glossy Dark

**Estado:** aprobado (escena01, 23-09-2026) · **Referencia:** `../finales/escena01_final_dark.mp4` · **Clips/prompts:** `../escena01/`

### Identidad
Motion graphics premium tipo keynote / explainer médico de alta gama. Tipografía cinética plana sobre elementos 3D de vidrio glossy semitransparente, fondo oscuro profundo y acentos cian luminosos.

### Paleta
- Fondo: degradado azul medianoche #011932 → #003670, con micro-rejilla hexagonal tenue y partículas de luz.
- Acento: cian eléctrico #19F7F1 / #0FCED3. Secundario: hielo #D9FBFF. Texto: blanco.

### Elementos
- Tipografía plana 2D, sans geométrica bold (Poppins / Roboto).
- Objetos 3D de vidrio esmerilado semitransparente e iridiscente con borde cian, refracción y cáusticas: bacterias cápsula, células, paneles, escudos.
- Íconos 3D glossy dentro de baldosas de vidrio.
- Efectos: barridos de luz, partículas, estallidos de vidrio, ondas expansivas, glow y bloom.
- SFX sintetizados (whoosh, impactos, campanitas de vidrio, pulsos). Sin música ni voz en los clips.

### Style bible (EN, pegar al inicio de cada prompt)
```
STYLE BIBLE (keep identical across all clips): premium educational motion graphics with kinetic typography, 16:9, 2K, ultra-crisp. Modern Apple-keynote / high-end medical explainer look: clean FLAT 2D white typography (bold geometric sans-serif like Roboto / Poppins) composited over glossy semi-transparent 3D glass elements, shallow depth of field, subtle volumetric light and bloom. Background: deep midnight-navy gradient (#011932 to #003670) with a faint hexagonal micro-grid and slow drifting light particles. Accent color vivid electric cyan (#19F7F1 / #0FCED3), secondary ice blue (#D9FBFF); no other colors. 3D elements: floating frosted, semi-transparent iridescent glass objects (capsule-shaped bacteria, spherical cells with soft inner glow) with cyan rim light, refraction and caustics, slow rotation and parallax.
```
Cierre recomendado de cada prompt: bloque END STATE (último segundo quieto para el congelado) + SOUND (sfx only, no music, no voice) + TYPOGRAPHY RULES + AVOID.

---

## Estilo · Glossy Light

> **Actualización 24-09-2026 (ADR-015):** en la app Wilox Motion, Glossy Light ya no usa cielo ni nubes: es el gemelo claro de Glossy Dark (fondo luminoso de casi blanco a azul hielo, micro-rejilla hexagonal y partículas suaves). La bible vigente está en `packages/styles/src/index.ts`.

**Estado:** aprobado (escena01, 23-09-2026) · **Referencia:** `../finales/escena01_final_light.mp4` · **Clips/prompts:** `../escena01_light/`

### Identidad
El mismo lenguaje que Glossy Dark (vidrio glossy, íconos 3D, tipografía cinética), pero con fondo claro nebuloso de cielo y humo. Se ve menos cargado; la tipografía se lee más liviana.

### Paleta
- Fondo: cielo luminoso con nubes y humo claro #F0F3FC / #E2E6F2 / #D9FBFF, con rayos de sol suaves.
- Texto: azul marino #01264C / #003670. Acento: teal oscuro #0ABCC9 / #0B93AA. Secundario: azul acero #4E7EA5.

### Elementos
- Tipografía plana, sans humanista/geométrica en azul marino; subtítulos en azul acero de peso medio.
- Vidrio glossy semitransparente teñido de azul, con borde teal oscuro y sombras suaves para contrastar con el fondo claro.
- Íconos 3D glossy, escudos, paneles y bacterias de vidrio.
- Mismos SFX y el mismo enfoque de congelados que Glossy Dark.

### Style bible (EN)
```
STYLE BIBLE LIGHT (keep identical across all clips): premium educational motion graphics with kinetic typography, 16:9, 2K, ultra-crisp. Bright, airy, high-end medical explainer look: clean FLAT 2D typography (bold geometric sans-serif like Roboto / Poppins) in deep navy blue (#01264C / #003670) composited over glossy semi-transparent 3D glass elements, shallow depth of field, soft diffused daylight. Background: luminous dreamy sky blended with soft light smoke and mist: pale white and ice-blue clouds (#F0F3FC, #E2E6F2, #D9FBFF) slowly drifting and swirling, soft volumetric sunbeams, very gentle atmospheric motion; overall bright and clean, never grey or dirty. Accent color deep teal-cyan (#0ABCC9 / #0B93AA) for lines, glows and highlights; secondary steel blue (#4E7EA5); no warm colors. 3D elements: floating glossy semi-transparent glass objects (capsule-shaped bacteria, spherical cells) tinted soft blue with crisp dark-teal rim light, clear refraction, subtle soft shadows so they stand out against the bright sky; slow rotation and parallax. All text and icons must have strong contrast against the light background.
```
Añadir en AVOID: "dark backgrounds, grey dirty smoke".

---

## Style bible · Pastel Kinetic (en prueba)

```
STYLE BIBLE "PASTEL KINETIC" (keep identical across all clips): vibrant editorial motion design with bold kinetic typography, 16:9, 2K, ultra-crisp, energetic but friendly, NOT futuristic, no glass, no neon, no sci-fi. Background: full-screen softly moving particle field of round bokeh dots and small confetti-like circles in saturated pastel tones (dusty coral #EE8C7A, mint teal #5FBFA8, lavender #9B8FD9, butter yellow #F2C45A, powder blue #72A3C4) drifting slowly over a warm off-white to pale powder-blue gradient (#F0F3FC). Typography: FLAT 2D text only, clean geometric sans-serif (Poppins / Roboto style, bold and medium weights) in deep navy #01264C, with key words highlighted in an elegant contrasting serif italic (Playfair Display italic style); words in the same phrase alternate colors (navy, coral, mint, lavender) and some words are split half one color, half another. Imagery: REAL photorealistic footage and photos living INSIDE the animation, framed in soft rounded shapes (circles, pills, rounded rectangles) with thin pastel outlines, the footage moving subtly inside its mask. Transitions: fluid MORPHS only (shapes morph into other shapes, image masks morph from circle to rounded rectangle, letters stretch and morph into the next word), smooth elastic easing, playful overshoot.
```
AVOID de este estilo: glass, chrome, glossy 3D objects, neon glows, dark backgrounds, sci-fi HUD, 3D icons, faces looking at camera, distorted hands.

### Notas de la prueba (escena01_pastel, 23-09-2026)
- Referencia: `../finales/escena01_test_pastel_kinetic.mp4` (11,9 s, 2 clips IA encadenados + 1,5 s congelado).
- MiniMax generó en un solo prompt el video real dentro de los marcos (pasillo de hospital, bacterias al microscopio, placa de Petri, sala de hospitalización), los morphs líquidos y el texto bicolor sin erratas.
- Recursos tipográficos que funcionaron: palabra partida en dos colores ("IAAS" coral/lavanda, "EPIDEMIOLÓGICOS" lavanda/mint) y palabra destacada en serif itálica ("reconocer", "a la Atención de Salud").
- SFX: se añadieron pop, bubble y tick a `herramientas/sfx.py` para un tono más lúdico.

### Versión 30 s (23-09-2026)
- Referencia: `../finales/escena01_pastel_kinetic_30s.mp4` (párrafo 1 completo, 4 clips IA + congelados).
- Leyendas largas en tarjetas: en MAYÚSCULAS MiniMax las escribió bien; en minúsculas escribió "Definiciones clava" dos veces seguidas.


### Piloto "imágenes primero" (23-09-2026)
- Referencia: `Micro Cápsulas IAAS/prueba_frames_gpt_image/piloto_pastel/piloto_pastel_kinetic_30s.mp4`. Informe en `referencia/prompts/piloto_imagenes_primero/informe_piloto.md`.
- Las fotos dentro de los marcos tendieron a quedarse fijas. De ahí sale el criterio de medios en marcos de 04_aprendizajes.md.
