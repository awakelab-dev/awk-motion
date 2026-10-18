#!/bin/bash
# uso: freeze.sh <carpeta> <clipNNex> <frame.png> <nframes>
cd "$(ls -d "$HOME"/mnt/*Micro*)/$1"
d=$(python3 -c "print(f'{$4/24:.6f}')")
ffmpeg -v error -y -loop 1 -framerate 24 -t $d -i "$3" -f lavfi -t $d -i anullsrc=r=48000:cl=stereo -c:v libx264 -preset slow -crf 14 -tune stillimage -pix_fmt yuv420p -c:a aac -b:a 192k $2.mp4
echo "$2 $(ffprobe -v error -select_streams v -show_entries stream=nb_frames -of csv=p=0 $2.mp4)f"
