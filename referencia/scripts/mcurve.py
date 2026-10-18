import sys,subprocess,numpy as np
f=sys.argv[1]
raw=subprocess.run(['ffmpeg','-v','error','-i',f,'-vf','scale=160:90,format=gray','-f','rawvideo','-'],capture_output=True).stdout
a=np.frombuffer(raw,np.uint8).reshape(-1,90,160).astype(float)
d=np.abs(np.diff(a,axis=0)).mean(axis=(1,2))
# per 0.25s buckets
b=[d[i:i+6].mean() for i in range(0,len(d),6)]
print(' '.join(f'{i*0.25:.2f}:{v:.1f}' for i,v in enumerate(b)))
# peaks
pk=[i for i in range(1,len(d)-1) if d[i]>d[i-1] and d[i]>=d[i+1] and d[i]>max(1.5,np.percentile(d,80))]
print('peaks',[round((i+1)/24,2) for i in pk])
