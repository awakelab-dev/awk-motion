#!/bin/bash
# uso: fetch.sh <carpeta_escena> <clipNN> <url>
set -e
cd "$(ls -d "$HOME"/mnt/*Micro*)/$1"; mkdir -p _raw frames
n=$2; N=$(echo $n | sed 's/clip/C/')
curl -sSfL -o _raw/${n}_ia.mp4 "$3"
echo "frames: $(ffprobe -v error -select_streams v -show_entries stream=nb_frames -of csv=p=0 _raw/${n}_ia.mp4)"
ffmpeg -v error -y -sseof -0.05 -i _raw/${n}_ia.mp4 -update 1 -q:v 1 frames/frame_${N}_end.png
ffmpeg -v error -y -i _raw/${n}_ia.mp4 -vf "fps=2,scale=480:-1,tile=5x2" -frames:v 1 frames/_sheet_${N}.jpg
ffmpeg -v error -y -i frames/frame_${N}_end.png -vf scale=1280:-1 frames/_end_${N}.jpg
ffmpeg -v error -y -i _raw/${n}_ia.mp4 -vn -c:a pcm_s16le _raw/${n}_audio-ia-nativo.wav 2>/dev/null || true
python3 - "_raw/${n}_ia.mp4" <<'PY'
import subprocess,numpy as np,sys
v=sys.argv[1]; w,h=160,90
raw=subprocess.run(['ffmpeg','-v','error','-i',v,'-vf',f'scale={w}:{h},format=gray','-f','rawvideo','-'],capture_output=True).stdout
fr=np.frombuffer(raw,np.uint8).reshape(-1,h,w).astype(np.float32)
d=np.r_[0,np.abs(np.diff(fr,axis=0)).mean(axis=(1,2))]
print('motion:',' '.join(f'{i/24:.2f}:{x:.1f}' for i,x in enumerate(d) if i%3==0))
PY
