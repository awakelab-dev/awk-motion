# 06 · Recetas ffmpeg y verificación (probadas)

Todas asumen 24 fps, 2560×1440 y audio a 48 kHz estéreo.

## Último frame de un clip
```bash
ffmpeg -v error -y -sseof -0.05 -i _raw/clip01_ia.mp4 -frames:v 1 -update 1 frames/frame_C01_end.png
```

## Hoja de contacto (revisión rápida del texto y del movimiento)
```bash
ffmpeg -v error -y -i _raw/clip01_ia.mp4 -vf "select=not(mod(n\,11)),scale=480:-1,tile=4x3" -frames:v 1 frames/_sheet_C01.jpg
```

## Mux de SFX sobre el clip IA (se descarta el audio nativo)
```bash
python3 sfx.py _raw/clip01_ia.mp4 _raw/clip01_sfx.wav 'riser@0.1,bubble@0.55,pop@0.75,whoosh@1.3,sparkle@3.5'
ffmpeg -v error -y -i _raw/clip01_ia.mp4 -i _raw/clip01_sfx.wav -map 0:v -map 1:a -c:v copy -af apad -c:a aac -b:a 192k -t 5.166667 clip01.mp4
```

## Congelado de N frames (con pista silenciosa)
```bash
d=$(python3 -c "print(f'{28/24:.6f}')")
ffmpeg -v error -y -loop 1 -framerate 24 -t $d -i frames/frame_C02_end.png -f lavfi -t $d -i anullsrc=r=48000:cl=stereo \
  -c:v libx264 -preset slow -crf 14 -tune stillimage -pix_fmt yuv420p -c:a aac -b:a 192k clip02ex.mp4
```
Si la fuente es una imagen GPT de 2688×1520, se añade `-vf scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440`.

## SSIM entre un frame del video y el fotograma clave
```bash
S=scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440
# último frame vs Ki
ffmpeg -i frames/_last_C01.png -i frames/K01.png -lavfi "[1:v]$S[r];[0:v][r]ssim" -f null - 2>&1 | grep -o "All:[0-9.]*"
# primer frame vs K(i-1)
ffmpeg -i _raw/clip01_ia.mp4 -i frames/K00.png -lavfi "[0:v]select=eq(n\,0)[a];[1:v]$S[r];[a][r]ssim" -frames:v 1 -f null - 2>&1 | grep -o "All:[0-9.]*"
```
Umbral observado: ≥0,98 para texto y gráficos. Con fotos realistas puede bajar a ~0,94 sin que se note.

## Curva de movimiento (para colocar SFX)
`python3 referencia/scripts/mcurve.py clip.mp4` imprime el movimiento medio cada 0,25 s y los picos en segundos.

## Render final (ejemplo de 7 segmentos, 30 s = 720 frames)
```bash
ffmpeg -y -i clip01.mp4 -i clip02.mp4 -i clip02ex.mp4 -i clip03.mp4 -i clip03ex.mp4 -i clip04.mp4 -i clip04ex.mp4 \
  -i _raw/voz_30s.wav -i Inspiring.mp3 -filter_complex "\
[0:v][0:a][1:v][1:a][2:v][2:a][3:v][3:a][4:v][4:a][5:v][5:a][6:v][6:a]concat=n=7:v=1:a=1[v][sfx];\
[sfx]volume=0.3[s];\
[7:a]aresample=48000,aformat=channel_layouts=stereo,apad[t];\
[8:a]aresample=48000,atrim=0:30,asetpts=N/SR/TB,afade=t=in:d=0.5,afade=t=out:st=28:d=2,volume=0.1[m];\
[t][s][m]amix=inputs=3:duration=first:normalize=0,atrim=0:30,alimiter=limit=0.95[a];\
[v]settb=1/24,setpts=N,fps=24,trim=end_frame=720,setpts=PTS-STARTPTS[vo]" \
  -map "[vo]" -map "[a]" -r 24 -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 256k final.mp4
```
- `settb/setpts=N/fps/trim=end_frame` + `-r 24` evitan la deriva de frames. Sin esto el total salía con frames de más o de menos.
- Versión parametrizada para 14 segmentos: `referencia/scripts/render.sh`.

## Hito 6 · Segmentos con la calidad del final y unión sin recodificar (ADR-055)
Mismos parámetros de H.264 en clips y congelados (`apps/api/src/media/encode.ts`):
```bash
ENC="-c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -profile:v high -level:v 5.1 -r 24 -video_track_timescale 12288"
FIT="scale=2560:1440:force_original_aspect_ratio=increase,crop=2560:1440"
# clip: N frames exactos, con su sonido en AAC (solo para el ZIP)
ffmpeg -y -i _raw/clip01_ia.mp4 -i segments/clip01_sound.wav -filter_complex \
  "[0:v]$FIT,fps=24,settb=1/24,setpts=N,trim=end_frame=124,setpts=PTS-STARTPTS,format=yuv420p[v];[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:5.166667[a]" \
  -map "[v]" -map "[a]" $ENC -c:a aac -b:a 192k -ar 48000 segments/clip01.mp4
# congelado: desde el frame en bruto (el último que muestra el clip), sin -tune stillimage
ffmpeg -y -i _raw/clip01_ia.mp4 -vf "$FIT,fps=24,settb=1/24,setpts=N,select=eq(n\,123)" -frames:v 1 -update 1 segments/clip01ex_frame.png
ffmpeg -y -loop 1 -framerate 24 -i segments/clip01ex_frame.png -f lavfi -t 1.875 -i anullsrc=r=48000:cl=stereo -filter_complex \
  "[0:v]$FIT,format=yuv420p,trim=end_frame=45,setpts=N/24/TB[v];[1:a]anull[a]" -map "[v]" -map "[a]" $ENC -c:a aac -b:a 192k -ar 48000 segments/clip01ex.mp4
```
Final: unir sin recodificar el video y mezclar el audio (voz, sonido de cada clip en su frame, música):
```bash
printf "file 'segments/clip01.mp4'\nfile 'segments/clip01ex.mp4'\nfile 'segments/clip02.mp4'\n" > segments/concat.txt
ffmpeg -y -f concat -safe 0 -i segments/concat.txt -i voice/voz_completa.wav \
  -i segments/clip01_sound.wav -i segments/clip02_sound.wav -stream_loop -1 -i Inspiring.mp3 -filter_complex "\
[1:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:10.5[t];\
[2:a]aresample=48000,aformat=channel_layouts=stereo,adelay=delays=0S:all=1[c0];\
[3:a]aresample=48000,aformat=channel_layouts=stereo,adelay=delays=338000S:all=1[c1];\
[c0][c1]amix=inputs=2:duration=longest:normalize=0,volume=0.3[s];\
[4:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:10.5,asetpts=N/SR/TB,afade=t=in:d=0.5,afade=t=out:st=8:d=2.5,volume=0.1[m];\
[t][s][m]amix=inputs=3:duration=first:normalize=0,atrim=0:10.5,alimiter=limit=0.95[a]" \
  -map 0:v -map "[a]" -c:v copy -bsf:v "setts=pts=PTS-STARTPTS:dts=DTS-STARTPTS" -frames:v 252 -c:a aac -b:a 256k -ar 48000 -movflags +faststart final.mp4
```
- `setts` lleva el video a empezar en 0: sin él, el AAC de los segmentos (priming de −1024 muestras) hace que concat desplace el video +21 ms y el primer instante se ve en negro (ADR-058).
- `adelay` en muestras: frame de inicio × 2000. La unión tarda segundos (2,3 s para 29 s de video en el entorno de Claude).
- Comprobar: `countFrames` del final = frames de la locución, y que todos los segmentos declaren lo mismo: `ffprobe -v error -select_streams v -show_entries stream=profile,level,time_base,pix_fmt -of csv=p=0 segments/clip01.mp4`.
- Antes y después con un video real, sin créditos: `pnpm render:bench <id>`.

## Hito 6 · Sonido nativo de MiniMax (ADR-059)
```bash
D=5.166667
# sonoridad del audio del clip en la parte que se usa
ffmpeg -hide_banner -nostats -t $D -i _raw/clip01_ia.mp4 -vn -af ebur128 -f null - 2>&1 | grep -E "^\s+I:" | tail -1
# ganancia = −18,4 − LUFS (tope ±12 dB) + ajuste del video; limitador a −1 dBFS y fundidos 20 ms / 250 ms
ffmpeg -y -i _raw/clip01_ia.mp4 -vn -af "atrim=0:$D,asetpts=N/SR/TB,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=-5.2dB,alimiter=limit=0.891:level=0,afade=t=in:d=0.02,afade=t=out:st=4.917:d=0.25,apad,atrim=0:$D" \
  -c:a pcm_s16le -ar 48000 segments/clip01_sound.wav
# cambiar solo la pista de un segmento (sin recodificar el video)
ffmpeg -y -i segments/clip01.mp4 -i segments/clip01_sound.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -ar 48000 segments/clip01.tmp.mp4
```

## Voz cortada por clip
Cortar por muestras: 1 frame = 2000 muestras a 48 kHz. Por ejemplo, con `atrim=start_sample=…:end_sample=…`, exportando a `clipNN.mp3`. El MP3 añade ~40 ms de padding.
