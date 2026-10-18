# Despliegue en el servidor · instalación de Awakelab (motion.wiloxagency.com)

> Desde el hito 12 esta instalación es **Awakelab** y sigue la rama `awakelab` (`git pull` en el servidor baja esa rama).

Primer despliegue: 07-10-2026. Desde esa fecha, **los datos reales (BD y `storage/`) viven en el servidor**. El Mac queda para desarrollo; lo que se genere allí no pasa al servidor.

## 1. Cómo está montado

| Pieza | Valor |
|---|---|
| Servidor | Lightsail Paris, Ubuntu 24.04, t3.2xlarge (8 vCPU, 32 GB, CPU burstable). Alias SSH desde el Mac: `AWK-Dev`. Usuario `ubuntu`. Comparte máquina con ~10 webs y ~30 procesos PM2. |
| Repo | `/projects/wilox-motion`, **rama `awakelab`** (desde el hito 12). Remoto `github-wilox:Wiloxagency/willox-motion.git`, con deploy key de solo lectura `~/.ssh/wilox_deploy` (host `github-wilox` en `~/.ssh/config`). |
| Marca | `BRAND=awakelab` en el `.env` (ADR-150): sin esa línea la API no arranca, porque usa `wilox-motion/prod/` (ADR-151). |
| Node | 24.21.0 con nvm, **solo para Wilox**. El `default` de nvm sigue en 20, que es el que usan PM2 y las demás apps. pnpm 10.34.5 vía corepack. |
| API | Proceso PM2 `wilox-motion-api` → `apps/api/dist/main.js`, con cwd `apps/api` y puerto **3040** (el 3001 lo usa `video-manager-api`). Corre con `nice -n 10`, y ffmpeg hereda esa prioridad baja. |
| Web | Estáticos de `apps/web/dist` servidos por nginx; `/api/` hace de proxy a `127.0.0.1:3040`. Sitio: `/etc/nginx/sites-available/motion.wiloxagency.com`. HTTPS con certbot, con renovación automática. |
| BD | PostgreSQL 18.6 gestionado de Lightsail, `awk-epica` (Paris), compartido con Épica. Base `wilox`, usuario `wilox` (dueño de la base) y extensión `unaccent`. La clave está en el gestor de contraseñas, **nunca en el repo**. |
| Endpoint de la BD | `ls-683fa66f22db41568a9b96f947bf54152764f008.cda4040msrzs.eu-west-3.rds.amazonaws.com:5432` |
| TLS de la BD | El driver `pg` verifica el certificado, así que la API arranca con `NODE_EXTRA_CA_CERTS=/home/ubuntu/.wilox/rds-global-bundle.pem`, guardado en la configuración de PM2. |
| Medios | `/projects/wilox-motion/storage`, fuera de git. |
| ffmpeg | 6.1.1 de apt (`/usr/bin/ffmpeg` y `/usr/bin/ffprobe`). |

### `.env` del servidor (`/projects/wilox-motion/.env`, permisos 600)

Es el `.env` del Mac con estos cambios:

```
GENERATION_MODE=api
PORT=3040
WEB_ORIGIN=https://motion.wiloxagency.com
STORAGE_DIR=/projects/wilox-motion/storage
COOKIE_SECURE=true
FFMPEG_PATH=/usr/bin/ffmpeg
FFPROBE_PATH=/usr/bin/ffprobe
QUEUE_FFMPEG_CONCURRENCY=1
DATABASE_URL=postgresql://wilox:<CLAVE>@<ENDPOINT>:5432/wilox?sslmode=require
```

Al arrancar, `pg` muestra un `SECURITY WARNING` sobre `sslmode`. Es solo informativo: hoy `require` equivale a `verify-full`, y se deja así porque el CLI de Prisma no acepta `verify-full`.

## 2. Actualizar (rutina habitual)

Ejecuta los pasos en orden; cada uno depende del anterior.

### Paso 1 · Subir el código a GitHub
Dónde: Terminal del Mac. Sube la rama `awakelab` al repositorio de siempre y su exportación (sin los documentos internos) al de Awakelab (remoto `awakelab`, `awakelab-dev/awk-motion`).
```bash
cd ~/projects/wilox-motion && git push origin awakelab && bash scripts/exportar-awakelab.sh && git push awakelab awakelab-export:main
```
Qué debe salir: el primer `push` sin error, `Exportado: <commit>` (o `Sin cambios`) y el segundo `push` sin error.

### Paso 2 · Mirar la cola
Dónde: navegador → `https://motion.wiloxagency.com` → **Cola**.
Lo ideal es reiniciar sin trabajos en marcha. Si los hay, también es seguro: la API espera hasta 90 s (`SHUTDOWN_GRACE_SEC`) y, al volver, la cola retoma lo pendiente sin pagar dos veces (los clips de MiniMax no se pierden). Lo único que se repite es un render de ffmpeg que estuviera a medias.

### Paso 3 · Bajar, instalar y compilar
Dónde: SSH en el servidor.
```bash
cd /projects/wilox-motion && source ~/.nvm/nvm.sh && nvm use 24 >/dev/null && export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 && git pull --ff-only && pnpm --filter @wilox/shared build >/dev/null && pnpm install --frozen-lockfile >/dev/null && if pnpm build > ~/wilox-build.log 2>&1; then tail -4 ~/wilox-build.log; git log --oneline -1; echo "BUILD OK"; else tail -30 ~/wilox-build.log; echo "BUILD FALLÓ: no reinicies la API"; fi
```
Qué debe salir: `Tasks: N successful, N total`, el commit nuevo y `BUILD OK`. Si sale `BUILD FALLÓ`, no sigas con el paso 6: la API en marcha sigue con la versión anterior (el log completo queda en `~/wilox-build.log`).
La web nueva queda publicada en cuanto termina el build; la API nueva, después del paso 6.

### Paso 4 · ¿Hay migraciones nuevas?
Dónde: SSH en el servidor.
```bash
cd /projects/wilox-motion && source ~/.nvm/nvm.sh && nvm use 24 >/dev/null && pnpm db:status 2>&1 | tail -4
```
Qué debe salir: `Database schema is up to date!` → salta al paso 6. Si lista migraciones pendientes → paso 5.

### Paso 5 · Copia de la BD y migración (solo si el paso 4 lo pide)
Dónde: SSH en el servidor. Pide la clave de `wilox`. No uses `pnpm db:migrate` en el servidor; usa `migrate deploy`.
```bash
cd /projects/wilox-motion && source ~/.nvm/nvm.sh && nvm use 24 >/dev/null && mkdir -p ~/backups && F=~/backups/wilox-$(date +%F-%H%M).dump && read -rsp "Clave wilox: " PGPASSWORD && echo && export PGPASSWORD && /usr/lib/postgresql/18/bin/pg_dump -Fc --no-owner --no-acl -f "$F" -d "host=ls-683fa66f22db41568a9b96f947bf54152764f008.cda4040msrzs.eu-west-3.rds.amazonaws.com port=5432 dbname=wilox user=wilox sslmode=require" && ls -lh "$F" && pnpm --filter @wilox/db exec prisma migrate deploy; unset PGPASSWORD
```
Qué debe salir: el tamaño de la copia y `All migrations have been successfully applied.`

### Paso 6 · Reiniciar la API
Dónde: SSH en el servidor. Usa siempre el Node `default` (ahí está instalado PM2) y pasa siempre `NODE_EXTRA_CA_CERTS`.
```bash
source ~/.nvm/nvm.sh && nvm use default >/dev/null && NODE_EXTRA_CA_CERTS=$HOME/.wilox/rds-global-bundle.pem pm2 restart wilox-motion-api --update-env && sleep 10 && pm2 save && pm2 describe wilox-motion-api | grep -E "status|restarts" && curl -s -o /dev/null -w "público %{http_code}\n" https://motion.wiloxagency.com/api/auth/me
```
Qué debe salir: `online`, un contador de `restarts` que no sigue subiendo y `público 401`.

### Paso 7 · Comprobar en el navegador
Recarga forzada (Cmd+Shift+R) en `https://motion.wiloxagency.com`. Entra, abre un proyecto y reproduce un video.

## 3. Cambiar una variable del `.env`

Dónde: SSH en el servidor.
```bash
nano /projects/wilox-motion/.env
```
Después, haz el paso 6. Si cambias `PORT`, cambia también `proxy_pass` en el sitio de nginx y ejecuta `sudo nginx -t && sudo systemctl reload nginx`.

## 4. Montarlo desde cero (servidor nuevo)

Bloques en orden, todos por SSH en el servidor salvo que se indique otra cosa.

**4.1 Requisitos.** El paquete `postgresql-client` debe ser 18 (repo PGDG), porque el `pg_restore` 16 no lee volcados de la 18.
```bash
source ~/.nvm/nvm.sh && nvm install 24 && corepack enable pnpm && nvm alias default 20 && sudo apt update && sudo apt install -y ffmpeg postgresql-client && ls /usr/lib/postgresql/
```

**4.2 Deploy key.** Añade la clave pública en GitHub → repo → Settings → Deploy keys, sin acceso de escritura.
```bash
ssh-keygen -t ed25519 -f ~/.ssh/wilox_deploy -N "" -C wilox-motion-deploy && printf '\nHost github-wilox\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/wilox_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config && cat ~/.ssh/wilox_deploy.pub
```

**4.3 Clonar.**
```bash
cd /projects && git clone github-wilox:Wiloxagency/willox-motion.git wilox-motion
```

**4.4 `.env`.** Copia el del Mac (`scp ~/projects/wilox-motion/.env AWK-Dev:/projects/wilox-motion/.env`, desde el Mac), aplica los cambios de la sección 1 y ejecuta `chmod 600 .env`.

**4.5 CA de RDS.**
```bash
mkdir -p ~/.wilox && curl -fsSL -o ~/.wilox/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

**4.6 Instalar y compilar.** Es el mismo comando del paso 3, sin `git pull`. `@wilox/shared` se compila primero porque, en un clon limpio, el `postinstall` de `packages/db` falla con TS2307 si no existe `packages/shared/dist`.

**4.7 Base de datos.** Con el usuario maestro de `awk-epica` (`dbmasteruser`):
```bash
WILOX_PW=$(openssl rand -hex 24); echo "CLAVE WILOX (guárdala): $WILOX_PW"; psql "host=<ENDPOINT> port=5432 dbname=postgres user=dbmasteruser sslmode=require" -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE wilox LOGIN PASSWORD '$WILOX_PW';
GRANT wilox TO CURRENT_USER;
CREATE DATABASE wilox OWNER wilox;
\c wilox
CREATE EXTENSION IF NOT EXISTS unaccent;
SQL
```
Luego, una de dos:
- **Restaurar un volcado:** `/usr/lib/postgresql/18/bin/pg_restore --single-transaction --exit-on-error --no-owner --no-acl --no-comments -d "<conexión wilox>" archivo.dump`
- **Base vacía:** `pnpm --filter @wilox/db exec prisma migrate deploy` y después `pnpm db:admin`.

**4.8 `storage/`.** Si hay que traerlo desde el Mac (5+ GB; el comando se reanuda solo si se corta). Dónde: Terminal del Mac.
```bash
caffeinate -i bash -c 'until rsync -a --exclude .DS_Store -e "ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=8" ~/projects/wilox-motion/storage/ AWK-Dev:/projects/wilox-motion/storage/; do echo "Cortado, reintento en 10 s"; sleep 10; done; echo SINCRONIZADO'
```

**4.9 Arrancar con PM2.** Este comando aplica el Node 24, la prioridad baja y la CA de RDS.
```bash
source ~/.nvm/nvm.sh && nvm use default >/dev/null && cd /projects/wilox-motion/apps/api && NODE_ENV=production NODE_EXTRA_CA_CERTS=$HOME/.wilox/rds-global-bundle.pem pm2 start dist/main.js --name wilox-motion-api --cwd /projects/wilox-motion/apps/api --interpreter /usr/bin/nice --interpreter-args "-n 10 /home/ubuntu/.nvm/versions/node/v24.21.0/bin/node" && pm2 save
```
Si cambia la versión de Node 24, actualiza la ruta de `--interpreter-args`: borra el proceso (`pm2 delete wilox-motion-api`) y vuelve a crearlo con este comando.

**4.10 nginx y HTTPS.** Contenido de `/etc/nginx/sites-available/motion.wiloxagency.com` antes de certbot:
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name motion.wiloxagency.com;

    root /projects/wilox-motion/apps/web/dist;
    index index.html;
    client_max_body_size 200m;

    location /api/ {
        proxy_pass http://127.0.0.1:3040;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```
```bash
sudo ln -sf /etc/nginx/sites-available/motion.wiloxagency.com /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx && sudo certbot --nginx -d motion.wiloxagency.com --redirect
```

## 4b. Medios en S3 (hito 8, ADR-093 y ADR-096)

Desde el hito 8 los medios (videos, imágenes, audios, ZIP) se guardan en el bucket `awakelab-videos` (eu-west-3), bajo el prefijo propio `wilox-motion/prod/` (`videos/`, `temas/`, `proyectos/`, `lotes/`, `fuentes/`). El disco del servidor (`storage/`) es la caché de trabajo de ffmpeg: lo nuevo se sube solo y lo que falta se baja solo.

Líneas del `.env` del servidor:
```
MEDIA_DRIVER=s3
MEDIA_ENV=prod
AWS_REGION=eu-west-3
AWS_S3_BUCKET=awakelab-videos
MEDIA_EVICT=true
MEDIA_PUBLIC_BASE=https://media.awakelab.world
```
`MEDIA_PUBLIC_BASE` desde el hito 9 (ADR-101): lo que se publica (código para Rise 360, SCORM liviano) va a `wilox-motion/prod/publico/<token>/` y se sirve desde esa dirección de CloudFront, con `Cache-Control: max-age=300` (`MEDIA_PUBLIC_MAX_AGE_SEC`): un final nuevo o una despublicación se ven en ≤ 5 min. Sin la línea, lo publicado lo sirve la API (`/api/publico/…`).
`MEDIA_EVICT=true` desde el cierre del hito 8 (09-10-2026, ADR-099); con `false`, nada sale del disco.
Credenciales: `AWS_ACCESS_KEY_ID` y `AWS_SECRET_ACCESS_KEY` en el `.env`, copiadas del `.env` de video-manager (usuario IAM `awakelab-video-uploader`); el perfil de `~/.aws` del servidor no tiene permiso en el bucket. Nunca se muestran en pantalla: para usarlas con `aws` en la terminal, `( set -a; . <(grep -E '^AWS_' .env); set +a; aws s3 ls s3://awakelab-videos/wilox-motion/ )`. Pendiente para otro hito: un usuario IAM propio limitado a `wilox-motion/*` y cerrar ese prefijo a CloudFront (`media.awakelab.world` sirve el bucket).

- **Subir y verificar** (no borra nada): `pnpm storage:migrate --dry-run` (cuánto falta), `pnpm storage:migrate` (sube; se puede repetir, sigue donde quedó) y `pnpm storage:migrate --verify` (cada archivo del disco contra S3; informe en `storage/_migracion/`).
- **Sacar una carpeta del disco a mano** (prueba o urgencia): `pnpm storage:migrate --evict runs/<id>`; solo si todo lo suyo está en S3. Al usarla, cada archivo se baja solo.
- **Liberar la caché**: con `MEDIA_EVICT=true`, cada hora salen del disco las carpetas de videos sin usar hace `MEDIA_CACHE_DAYS` (14) días y los lotes tras `MEDIA_BATCH_CACHE_HOURS` (24), solo si todo está subido. Se vuelven a bajar solas al usarlas.
- **Estado** (admin, en la app con sesión): `GET /api/storage`.

## 5. Operación

- **Logs:** `pm2 logs wilox-motion-api --lines 100` (errores: `--err`). Antes, ejecuta `source ~/.nvm/nvm.sh && nvm use default`.
- **Arranque tras reiniciar el servidor:** lo hace `pm2-ubuntu` (systemd) con la lista guardada por `pm2 save`. Ejecuta `pm2 save` después de cada cambio en PM2.
- **Copias de la BD:** snapshots automáticos de `awk-epica` en Lightsail (comprueba que estén activos), más la copia manual del paso 5 en `~/backups/`.
- **Copias de `storage/`:** desde el hito 8 está en S3 (sección 4b); antes, solo en el disco de la instancia.
- **Restos de la migración inicial:** `~/wilox.dump` (volcado del Mac, 07-10-2026). Bórralo cuando ya no haga falta.

## 6. Problemas conocidos

| Síntoma | Causa | Solución |
|---|---|---|
| `pnpm install` falla con `TS2307: Cannot find module '@wilox/shared'` | El `postinstall` de `packages/db` necesita `packages/shared/dist`, que no existe en un clon limpio | `pnpm --filter @wilox/shared build` y repetir `pnpm install` (ya incluido en el paso 3) |
| La API se reinicia en bucle; en el log, `self-signed certificate in certificate chain` | Falta `NODE_EXTRA_CA_CERTS` | Paso 6, que siempre lo pasa |
| `pg_restore: unsupported version (1.16) in file header` | El `pg_restore` por defecto es el de la 16 | Usar `/usr/lib/postgresql/18/bin/pg_restore` |
| `pnpm: command not found` | La shell está en Node 20 | `source ~/.nvm/nvm.sh && nvm use 24` |
| `pm2: command not found` | La shell está en Node 24 | `nvm use default` |
| `502` en `/api/` | La API está caída o en otro puerto | Ver `pm2 logs wilox-motion-api --err` y que `PORT` coincida con nginx |
| `rsync` se corta (`Operation timed out`) | Conexión SSH inactiva en una copia larga | El bucle con `caffeinate` y `ServerAliveInterval` de 4.8 |

## 7. Pendiente en el repo

- Que un clon limpio instale a la primera, sin compilar `@wilox/shared` a mano.
- Un bloque "Servidor" en `.env.example`; hoy está pensado para el Mac (Docker, puerto 3001, rutas de Homebrew, comentario "ffmpeg en el Mac").

## ElevenLabs: permisos de la clave
La clave de ElevenLabs (`ELEVENLABS_API_KEY`) necesita, además de Text to Speech y Voices, **History con lectura y escritura** (`speech_history_read` y `speech_history_write`): sin eso las locuciones quedan en el historial de la cuenta (ADR-040, ADR-120). Para borrar las que hayan quedado: `NODE_EXTRA_CA_CERTS=$HOME/.wilox/rds-global-bundle.pem pnpm elevenlabs:purge` (cuenta) y lo mismo con `--borrar` (sin el certificado de RDS falla con «self-signed certificate in certificate chain»).

Para limpiar el historial **de una voz** (de Wilox y lo hecho a mano en la web), conservando las N locuciones más recientes (hito 10, ADR-128): `NODE_EXTRA_CA_CERTS=$HOME/.wilox/rds-global-bundle.pem pnpm elevenlabs:purge --voz "Karla Chilena" --conservar 40` (solo lista) y lo mismo con `--borrar`. Si la voz ya no está entre las voces de la cuenta, el comando lista los `voice_id` del historial para pasarlo con `--voz <voice_id>`.

Prueba de voz (hito 10, ADR-129): la variante «pedidos enlazados» usa `ELEVENLABS_V4_MODEL` (por defecto `eleven_v4`; no hace falta ponerlo en el `.env` salvo que ElevenLabs le cambie el nombre).
