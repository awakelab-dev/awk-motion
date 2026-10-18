# Piloto "imágenes primero" · Pastel Kinetic 30 s (experimental)

Resultado: piloto_pastel_kinetic_30s.mp4 (720 f, 30.0 s, 2560×1440). Misma voz, SFX y mezcla que escena01_pastel.

## Método
1. GPT Image 2.5 (2k high) genera los fotogramas clave P00–P04 con todo el texto ya escrito.
2. MiniMax H3 anima cada par en paralelo (start_image → end_image): C01 P00→P01, C02 P01→P02, C03 P02→P03, C04 P03→P04.
3. Los congelados salen del último frame de cada clip. Después: SFX, voz y render.

## Tiempos (UTC, 23-09-2026)
- Inicio del piloto: 14:48. P00 listo en ~2 min. P01–P04 ya existían (lote paralelo de ~1 min).
- C02–C04 enviados a las 14:49 y listos a las 14:57 (~8,5 min los tres juntos). C01 se envió a las 14:51 porque esperaba a P00, y terminó antes de las 15:00.
- Postproducción (descarga, SFX, congelados, render): ~2 min. Render final a las 15:02.
- Total: ~14 min. Con el flujo secuencial actual serían ~40 min (4 × ~10 min encadenados) más las regeneraciones por errata (clip04 se rehízo 2 veces, ~+20 min).

## Costos (créditos)
- MiniMax H3: 4 × 10 = 40.
- GPT Image 2.5 2k high: 5 × 2,75 = 13,75 (P00 nuevo + P01–P04).
- Total: 53,75 por 30 s. El pastel secuencial costó 60 (4 clips + 2 regeneraciones).
- En producción, una cadena de N clips necesita N+1 imágenes: ~51 créditos por 30 s con imágenes 2k high, o ~42 con imágenes 1k medium.

## Calidad
- Similitud (SSIM) primer frame vs imagen inicial: 0,984–0,992. Último frame vs imagen final: 0,986 en C02–C04. En C01 da 0,94 porque la foto de la enfermera varía levemente, pero se ve idéntico.
- Las animaciones son morphs reales (blobs, confeti, tarjetas que se transforman), no fundidos.
- Sin erratas: el texto final viene de GPT Image, que acertó en 18 de 18 fotogramas.
- Los clips terminan con ~1,5 s estables, lo que sirve de colchón para la voz.

## Ventajas
- Paralelismo: hasta 12 clips a la vez. El tiempo deja de crecer por cada clip.
- El texto queda garantizado y revisable antes de gastar créditos de video.
- Cada fotograma clave se aprueba como un storyboard real (control creativo).
- Si un clip falla, se regenera solo ese, sin romper la cadena.

## Riesgos y ajustes
- Todas las imágenes, incluida la de intro (P00), deben generarse al inicio y en un solo lote.
- Hay que pasar siempre declined_preset_id: el lote se bloqueó una vez por el preset recomendado.
- Las fotos realistas pueden variar sutilmente entre el fotograma clave y el video.
- La cámara es menos libre: el movimiento queda acotado entre dos estados.
- Exige más planificación previa de los fotogramas clave.

## Proyección a 2 h (240 bloques de 30 s)
- Créditos: ~12.200 (imágenes 2k high) o ~10.100 (imágenes 1k medium). El secuencial con ~25 % de regeneraciones da ~12.000.
- Tiempo de generación: ~20 tandas de 12 clips × ~9 min ≈ 3 h. El secuencial serían ~40 h o más.
- Saldo actual: 2.512 créditos, que alcanzan para ~25 min de video.
