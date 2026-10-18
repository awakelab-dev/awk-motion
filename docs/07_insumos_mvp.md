# 07 · Insumos para diseñar el MVP (no son decisiones)

Leonardo define la arquitectura, el stack y el alcance en la próxima sesión. Este documento solo reúne lo que el pipeline exige, para tenerlo a la vista al diseñar.

## Flujo funcional que la app tendría que cubrir (variante B)
1. Crear un proyecto o curso y elegir estilo y música.
2. Cargar la fuente (PDF o texto) y separarla en párrafos y escenas.
3. Generar la locución por párrafo (TTS con la voz "Chilena") y montar la pista global.
4. Obtener los tiempos por palabra (whisper) y proponer PFC, que el usuario puede editar.
5. Calcular el plan de la línea de tiempo alineado a frames (clips IA de 124 f + congelados).
6. Generar los prompts de los fotogramas (GPT Image) y de las transiciones (MiniMax) desde plantillas por estilo, aplicando el criterio imagen/video. Se guardan todos los prompts.
7. Lanzar el lote de fotogramas y dar un **checkpoint de aprobación humana** (texto y composición), con opción de regenerar cada imagen.
8. Lanzar el lote de clips en paralelo (≤12 por lote, con `declined_preset_id`) y seguir su estado.
9. Verificación automática (SSIM de los bordes, hoja de contacto) + **checkpoint humano** por clip, con regeneración individual y versionado.
10. SFX automáticos a partir de la curva de movimiento, congelados, voz por clip y render final.
11. Descargar entregables: final, clips, mp3 y prompts.
12. Ver el costo real frente al estimado, por escena y por proyecto (créditos).

## Entidades que aparecen de forma natural
Proyecto/Curso · Estilo (bible de video + bible de imagen + perfil de SFX) · Fuente · Escena · Párrafo/Locución (audio + timestamps) · PFC · Segmento (clip IA o congelado, frames de inicio y fin) · Fotograma clave · Prompt (versionado) · Trabajo de generación (proveedor, modelo, job_id, estado, costo, URL) · Asset (archivo local o remoto) · Render.

## Requisitos no funcionales que se desprenden
- **Trabajos asíncronos y largos**: clips de ~9 min, polling y lotes de 12. Hace falta una cola o workers y reintentos.
- **Paralelismo controlado** según el límite de la cuenta.
- **ffmpeg en el servidor** para freeze, mux, SSIM y render de 2K; cada render tarda decenas de segundos.
- **Python con numpy** para `sfx.py` y el análisis de movimiento; faster-whisper para los timestamps. Se puede reutilizar `referencia/scripts/`.
- **Almacenamiento** de medios pesados: cada clip 2K pesa unos MB y cada final de 30 s ~20 MB.
- **Trazabilidad de costos**: guardar el costo por trabajo y conciliarlo con `transactions`.
- **Idempotencia y versionado**: una regeneración no debe pisar la versión aprobada.

## Preguntas abiertas para la próxima sesión
1. Integración con Higgsfield: ¿API oficial con API key o conector MCP? ¿La API expone `minimax_h3`, `gpt_image_2_5` y la voz "Chilena" con los mismos costos y roles `start_image` / `end_image`?
2. ¿El MVP corre en local (Mac mini) o en la nube (AWS Lightsail, como la infraestructura de Aspasia)?
3. ¿Monousuario (Leonardo) o multiusuario (equipo de Awakelab o clientes)?
4. ¿Qué parte del hito 1 es lo mínimo? Por ejemplo: de PDF a fotogramas aprobados, o el pipeline completo para una escena.
5. ¿La elección de PFC y la redacción de prompts se asisten con un LLM (Claude API) o son manuales con plantillas?
6. ¿Identidad visual de la app: Awakelab 2026 o marca "Wilox" propia?
7. ¿Se soporta también la variante A (encadenado) como modo "creativo" para clips clave?
8. ¿Formato de entrega al cliente: MP4 final, paquete de clips editables, o ambos?
