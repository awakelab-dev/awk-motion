# Test 01 · Superprompt MiniMax H3 (2K) · Micro Cápsula IAAS

- **Modelo:** MiniMax H3 (Higgsfield) · 2K · 16:9 · 5 s · text-to-video
- **Fuente:** `Bienvenida y Definiciones Clave.pdf`
- **Frases extraídas:** "IAAS" (Infecciones Asociadas a la Atención de Salud) · "Seguridad del paciente"
- **Objetivo:** muestra de estilo — tipografía kinética plana + elementos 3D glass glossy semitransparentes + efectos (light sweep, partículas, whip transition, shockwave)
- **Paleta:** Awakelab 2026 — fondo azul profundo #011932 → #003670, acento cian #19F7F1 / #0FCED3, secundario #D9FBFF
- **Video:** `test01_minimax-h3_2k_5s.mp4`

## Prompt (EN)

```
5-second premium educational motion graphics opener with kinetic typography, 16:9, 2K, ultra-crisp, 60fps feel. Style: modern Apple-keynote / high-end medical explainer, clean flat 2D typography composited over glossy semi-transparent 3D elements, shallow depth of field, subtle volumetric light and bloom.

BACKGROUND: deep midnight-navy gradient (#011932 to #003670), with a faint hexagonal micro-grid and slow drifting light particles. Accent color vivid electric cyan (#19F7F1 / #0FCED3), secondary soft ice blue (#D9FBFF). No other colors.

3D ELEMENTS: floating glossy translucent glass objects in the foreground and midground: rounded capsule-shaped bacteria, spherical cells with soft inner glow, and a clear glass shield icon, all made of frosted, semi-transparent iridescent glass with cyan rim light, refraction and caustics. They rotate slowly and parallax with the camera.

TIMELINE:
0.0-0.6s: dark screen, a thin cyan light line sweeps horizontally across the center and flashes.
0.6-2.4s: the big bold word "IAAS" snaps in letter by letter from the light line, flat white sans-serif (Roboto / Poppins bold, clean geometric), each letter overshooting with elastic ease, a cyan glow pulse and a small particle burst behind it. Glass bacteria capsules drift in from the edges.
2.4-3.2s: fast whip-pan / zoom-through transition: camera pushes forward through the "A" of IAAS, glass cells blur past with motion trails and light streaks.
3.2-5.0s: the phrase "Seguridad del paciente" types on in clean flat white sans-serif, medium weight, centered, with a cyan underline bar that draws from left to right; the translucent glass shield rotates into place behind the text and emits a soft cyan shockwave ring. Hold on a clean, balanced final frame.

TYPOGRAPHY RULES: flat 2D text only, perfectly legible, correct Spanish spelling exactly as written: "IAAS" and "Seguridad del paciente". No extra words, no gibberish text, no subtitles, no watermark, no logos.

CAMERA: smooth slow dolly-in with subtle parallax, one energetic whip transition in the middle.
AVOID: people, faces, hands, realistic hospital footage, clutter, distorted or misspelled letters, warm colors.
```

## Notas para iterar
- Mantener pocas palabras por plano (1–3): el modelo renderiza mejor texto corto.
- Variables a ajustar tras revisar: densidad de elementos 3D, velocidad de la tipografía, intensidad del glow/bloom, tipo de transición.
