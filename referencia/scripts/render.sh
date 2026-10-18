#!/bin/bash
# uso: render.sh <carpeta_escena> <salida.mp4>   (voz 1.0, SFX 0.3, música 0.1)
set -e
B="$(ls -d "$HOME"/mnt/*Micro*)"; cd "$B/$1"
L=clip01,clip01ex,clip02,clip02ex,clip03,clip03ex,clip04,clip04ex,clip05,clip05ex,clip06,clip06ex,clip07,clip07ex
IN=""; F=""; i=0; for c in ${L//,/ }; do IN="$IN -i $c.mp4"; F="$F[$i:v][$i:a]"; i=$((i+1)); done
D=70.166667; FO=$(python3 -c "print($D-2.5)")
ffmpeg -v error -y $IN -i _raw/voz_completa.wav -i ../Inspiring.mp3 -filter_complex "${F}concat=n=$i:v=1:a=1[v][sfx];[sfx]volume=0.3[s];[$i:a]aresample=48000,aformat=channel_layouts=stereo,apad[t];[$((i+1)):a]aresample=48000,atrim=0:$D,asetpts=N/SR/TB,afade=t=in:d=0.5,afade=t=out:st=$FO:d=2.5,volume=0.1[m];[t][s][m]amix=inputs=3:duration=first:normalize=0,atrim=0:$D,alimiter=limit=0.95[a];[v]settb=1/24,setpts=N,fps=24,trim=end_frame=1684,setpts=PTS-STARTPTS[vo]" -map "[vo]" -map "[a]" -r 24 -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 256k "$2"
ffprobe -v error -show_entries stream=codec_type,width,height,nb_frames,duration -of compact "$2"
