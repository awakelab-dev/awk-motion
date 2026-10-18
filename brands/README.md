# Marcas (hito 12, ADR-150)

Cada instalación elige su marca con `BRAND=<carpeta>` en el `.env` (sin la línea: la identidad neutra de ADR-008, en el código, `NEUTRAL_BRAND`). La API lee `brands/<BRAND>/brand.json` al arrancar y **no arranca** si falta o no es válido; la web la recibe por `/api/brand.js` antes de pintar.

| Campo | Para qué |
|---|---|
| `id` | Igual al nombre de la carpeta. |
| `name` | Nombre del producto: título del navegador, avisos, textos de la app y de los paquetes (SCORM liviano, Rise, LEEME). |
| `tagline`, `loginTagline` | Línea bajo el nombre (cabecera; inicio de sesión). Vacías: sin línea. |
| `colors` | Cambios sobre las variables de `apps/web/src/index.css` (`background`, `primary`, `glow-1`…; lista en `BRAND_COLOR_KEYS`). |
| `font` | `sans` (familia CSS), `mono` (opcional) y `href` (hoja de Google Fonts). |
| `logo` | `full` (logo completo para fondo oscuro: cabecera e inicio de sesión), `fullHeight` (px), `mark` (isotipo) y `label` (texto junto al logo; sin logo completo, va junto al isotipo en lugar de `name`). Un archivo de esta carpeta (`logo.png`) o una URL https. |
| `favicon` | Archivo o URL https. |
| `nav` | Pestañas de la cabecera, en orden (`proyectos` siempre). |
| `features` | Opciones que la marca apaga (`"clave": false`); lo que no aparece, encendido (`hasFeature` en la web). |
