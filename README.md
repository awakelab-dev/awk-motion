# Wilox Motion · MVP (hitos 1 a 6)

Pega un texto, elige el tema (Dark, Light o Pastel) y la voz, y pulsa **GENERAR**. La app ejecuta el pipeline de Micro Cápsulas, variante B ("imágenes primero"):

1. **Locución**: TTS por párrafo y montaje de `voz_completa.wav`, con cada párrafo empezando en un frame redondo.
2. **Tiempos por palabra**: faster-whisper en el sandbox de Higgsfield (MCP) o `/with-timestamps` de ElevenLabs (API). El texto fuente manda.
3. **Storyboard**: Opus 5.5 (effort high) elige las PFC y escribe las escenas. El código arma los superprompts con la estructura probada: bible + shot + END STATE + SOUND + TYPOGRAPHY + AVOID.
4. **Plan de la línea de tiempo**: determinista, alineado a frames. Clip de 124 f, 1 s antes de cada PFC, con congelados.
5. **Fotogramas clave K0…Kn** con GPT Image 2.5 en un solo lote → **aprobación en la UI**, con opción de regenerar cada imagen con una nota.
6. **Clips** MiniMax H3 2K en paralelo, con `start = K(i-1)` y `end = Ki`.
7. **Post**: SFX sintetizados en los picos de movimiento, normalización a 2560×1440 y 24 fps, congelados y SSIM de los bordes.
8. **Render final**: voz 1.0, SFX 0.3, música 0.1. Dura **exactamente** lo mismo que la locución, y se verifica por frames.

## Estudio de temas (hito 2)
En la pestaña **Estudio**: describe un estilo y sube imágenes de referencia; Opus propone el tema completo (bibles, notas, AVOID, SFX, paleta). Lo editas, lo pruebas con el contenido estándar (frame A de portada, frame B con 3 elementos y la transición A→B con SFX, en 2K y 24 fps), aplicas las sugerencias de la revisión de Opus y lo guardas en **Mis temas**. Los temas guardados aparecen en el selector de Generar. Todo queda en `storage/themes/<id>/` (tema, referencias, propuestas y pruebas con sus superprompts).

## Proyectos, usuarios y base de datos (hito 3)
- **Usuarios**: login con email y contraseña; el admin crea y gestiona usuarios en **Usuarios**; cada uno ve solo sus temas y sus videos.
- **Proyectos**: contenedores de videos con historial, búsqueda en la locución, filtros, totales de créditos, mover, archivar y descarga ZIP del video o del proyecto. Desde el hito 4 todo video vive en un proyecto; los que no tienen uno propio están en "Sin clasificar", que es fijo (ADR-035).
- **Corregir y recrear**: reabrir un video terminado para regenerar fotogramas (se rehacen solo los clips afectados y queda `final_v2.mp4`…), regenerar un clip con una indicación, cambiar el texto (versión nueva enlazada) o recrear.
- **Base de datos**: PostgreSQL 18 en el contenedor `wilox-db` (`docker-compose.yml`, `127.0.0.1:5434`) con Prisma 7.9.1 (`packages/db`). Los medios y los superprompts siguen en `storage/runs/<id>/` y `storage/themes/<id>/`; la BD guarda el estado, los prompts, las versiones y el costo de cada trabajo.

## Requisitos (Mac)
- Node 22 o superior, con corepack (pnpm 10).
- ffmpeg y ffprobe (`brew install ffmpeg`).
- Docker Desktop (para la base de datos).

## Arranque
```bash
corepack enable
pnpm install
cp .env.example .env    # rellenar claves y elegir GENERATION_MODE (DATABASE_URL ya apunta a wilox-db)
pnpm db:up              # levanta wilox-db (Docker Desktop)
pnpm db:migrate         # aplica las migraciones
pnpm db:admin           # crea el administrador (pide la contraseña)
pnpm dev                # API http://localhost:3001 · Web http://localhost:5173
```
Otros: `pnpm db:status`, `pnpm db:drift` (debe salir vacío), `pnpm db:check`, `pnpm db:import:check` / `pnpm db:import` (carga `storage/` en la BD, idempotente), `pnpm db:studio`.

## Modos (`GENERATION_MODE`)
| Modo | Voz | Tiempos | Imágenes | Video | Superprompts |
|---|---|---|---|---|---|
| `mcp` | Higgsfield `text2speech_v2` (ElevenLabs), voz "Chilena" | faster-whisper en `sandbox_exec` | Higgsfield `gpt_image_2_5` 2k high | Higgsfield `minimax_h3` 2K | Anthropic |
| `api` | ElevenLabs `eleven_v3` | ElevenLabs `/with-timestamps` | OpenAI `gpt-image-2.5-sunburst` 2560×1440 | MiniMax `/v2/video_generation` | Anthropic |
| `mock` | tono sintético | uniformes | rectángulos de color | fundido entre fotogramas | storyboard fijo |

Pruebas cortas del modo `api` con claves reales, sin cambiar de modo: `pnpm api:probe elevenlabs|openai|minimax|anthropic` (resultados en `storage/probes/`, ADR-037).

En modo `mcp`, la primera vez aparece **Conectar Higgsfield** en la cabecera. Abre el login OAuth y vuelve a la app; el token se guarda en `~/.wilox/higgsfield-oauth.json`.

## Estructura
```
apps/api        NestJS 12 (ESM): auth/, users/, projects/, generations/, themes/ (Estudio), persistence/, jobs/, downloads/, pipeline/, providers/{api,mcp,mock}, media/
apps/web        React 19 + Vite 8 + Tailwind 4 + shadcn/ui
packages/shared tipos, esquemas zod (storyboard, ThemeStyle, Estudio), constantes de tiempo
packages/styles los 3 temas base (BASE_THEMES), semilla de solo lectura
packages/prompts system prompt de Opus, ensamblado de superprompts y prompts del Estudio (studio.ts)
packages/db     esquema y migraciones de Prisma, cliente, contraseñas (argon2id), búsqueda y scripts (admin, check)
docs/           contexto del pipeline y despliegue
```

## Pruebas
```bash
pnpm test         # planificador, alineación, texto, golden de prompts base, sesiones, persistencia y contraseñas
pnpm typecheck
```
