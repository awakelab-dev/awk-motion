# Style bible · Pastel Kinetic (en prueba)

```
STYLE BIBLE "PASTEL KINETIC" (keep identical across all clips): vibrant editorial motion design with bold kinetic typography, 16:9, 2K, ultra-crisp, energetic but friendly, NOT futuristic, no glass, no neon, no sci-fi. Background: full-screen softly moving particle field of round bokeh dots and small confetti-like circles in saturated pastel tones (dusty coral #EE8C7A, mint teal #5FBFA8, lavender #9B8FD9, butter yellow #F2C45A, powder blue #72A3C4) drifting slowly over a warm off-white to pale powder-blue gradient (#F0F3FC). Typography: FLAT 2D text only, clean geometric sans-serif (Poppins / Roboto style, bold and medium weights) in deep navy #01264C, with key words highlighted in an elegant contrasting serif italic (Playfair Display italic style); words in the same phrase alternate colors (navy, coral, mint, lavender) and some words are split half one color, half another. Imagery: REAL photorealistic footage and photos living INSIDE the animation, framed in soft rounded shapes (circles, pills, rounded rectangles) with thin pastel outlines, the footage moving subtly inside its mask. Transitions: fluid MORPHS only (shapes morph into other shapes, image masks morph from circle to rounded rectangle, letters stretch and morph into the next word), smooth elastic easing, playful overshoot.
```
AVOID de este estilo: glass, chrome, glossy 3D objects, neon glows, dark backgrounds, sci-fi HUD, 3D icons, faces looking at camera, distorted hands.

## Notas de la prueba (escena01_pastel, 23-09-2026)
- Referencia: `../finales/escena01_test_pastel_kinetic.mp4` (11,9 s, 2 clips IA encadenados + 1,5 s congelado).
- MiniMax generó en un solo prompt el video real dentro de los marcos (pasillo de hospital, bacterias al microscopio, placa de Petri, sala de hospitalización), los morphs líquidos y el texto bicolor sin erratas.
- Recursos tipográficos que funcionaron: palabra partida en dos colores ("IAAS" coral/lavanda, "EPIDEMIOLÓGICOS" lavanda/mint) y palabra destacada en serif itálica ("reconocer", "a la Atención de Salud").
- SFX: se añadieron pop, bubble y tick a `herramientas/sfx.py` para un tono más lúdico.

## Versión 30 s (23-09-2026)
- Referencia: `../finales/escena01_pastel_kinetic_30s.mp4` (párrafo 1 completo, 4 clips IA + congelados).
- Leyendas largas en tarjetas: en MAYÚSCULAS MiniMax las escribió bien; en minúsculas escribió "Definiciones clava" dos veces seguidas.
