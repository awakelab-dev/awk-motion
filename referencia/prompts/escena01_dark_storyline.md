# Escena 01 · Bienvenida + Definiciones clave (párrafos 1 y 2)

**Duración total:** 70,17 s (1684 frames a 24 fps) · **Video IA:** 7 clips × 5,167 s = 36,2 s (52 %) · **Congelados:** 34,0 s
**Locución:** voz "Chilena" (ElevenLabs V3 en Higgsfield)
- `escena01_tts_completo.mp3`: párrafo 1, 29,23 s. Empieza en 0,00.
- `escena01_tts_parte2.mp3`: párrafo 2, 40,12 s. Empieza en 30,00 s globales, tras 0,77 s de pausa.
- `_raw/voz_completa.wav`: ambas partes montadas en la línea de tiempo global. Es la pista que usan los finales.

**Finales:** `../finales/escena01_final_dark.mp4` y `../finales/escena01_final_light.mp4` (voz 1.0 · SFX 0.3 · música `Inspiring.mp3` 0.1, con fade in/out).
**Versión light:** carpeta `../escena01_light/`, con los mismos nombres de clips, los mismos tiempos y los mismos `.mp3`.

## PFC (palabras/frases clave)
| # | PFC | Momento en la voz |
|---|---|---|
| 1 | MÓDULO 1 · IAAS | inicio del párrafo 1 |
| 2 | PATOGENIA · MAGNITUD · IMPACTO | "patogenia" 12,30 s |
| 3 | 4 BLOQUES (Definiciones clave / Magnitud e impacto junto a la patogenia / Factores epidemiológicos / Medidas de prevención) | "cuatro bloques" 19,02 s |
| 4 | LENGUAJE COMÚN · Base de la vigilancia epidemiológica | inicio del párrafo 2 (30,0 s) |
| 5 | IAAS: se adquiere durante la estancia en atención cerrada / no presente ni en incubación al ingreso | "IAAS" 37,78 s |
| 6 | 2 NIVELES DE PROTECCIÓN · Precauciones Estándar (con todos los pacientes) | "dos niveles" 50,54 s |
| 7 | Precauciones Específicas · gotitas / vía aérea / contacto | "precauciones específicas" 60,86 s |

## Plan de clips (global, alineado a frame)
| Archivo | Tipo | Inicio | Fin | Dur. |
|---|---|---|---|---|
| clip01 | IA | 0,000 | 5,167 | 5,167 |
| clip01ex | congelado | 5,167 | 10,792 | 5,625 |
| clip02 | IA | 10,792 | 15,958 | 5,167 |
| clip02ex | congelado | 15,958 | 18,000 | 2,042 |
| clip03 | IA | 18,000 | 23,167 | 5,167 |
| clip03ex | congelado | 23,167 | 30,000 | 6,833 |
| clip04 | IA | 30,000 | 35,167 | 5,167 |
| clip04ex | congelado | 35,167 | 36,792 | 1,625 |
| clip05 | IA | 36,792 | 41,958 | 5,167 |
| clip05ex | congelado | 41,958 | 49,500 | 7,542 |
| clip06 | IA | 49,500 | 54,667 | 5,167 |
| clip06ex | congelado | 54,667 | 60,000 | 5,333 |
| clip07 | IA | 60,000 | 65,167 | 5,167 |
| clip07ex | congelado | 65,167 | 70,167 | 5,000 |

Cada clip IA parte del último frame del anterior (start_image), también en el paso de la parte 1 a la 2 (clip04 sale de "4 BLOQUES").

## Incidencias
- clip05 (dark y light): MiniMax escribió "durante **a** estancia". Se regeneró; las versiones malas están en `_versiones/clip05_v1_errata/`. En light se cambió a "durante **su** estancia", que es literal de la locución.
- La transcripción automática oye "IAS" donde la voz dice "IAAS". Conviene revisarlo al escuchar.

## Herramientas (`../herramientas/`)
`fetch.sh` descarga el clip, extrae el último frame, hace la hoja de contacto y la curva de movimiento · `sfx.py` sintetiza los SFX · `freeze.sh` genera los congelados · `plan.py` tiene la tabla de frames · `render.sh` hace el render final con las mezclas.
