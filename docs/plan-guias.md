# Propuesta: guías de pistas y soluciones

Plan consolidado y validado contra la arquitectura de Viciódromo (`0.44.0` → `0.48.0`), manteniendo intacto el núcleo de biblioteca, lanzadores, sesiones, capturas y novedades.

## Resumen

Sumar a cada juego una pestaña **Guía** con ayuda en dos niveles: **Pistas** que se revelan de a una (de la más vaga a la más concreta) y **Solución** completa del tramo. Se construye en cuatro fases encadenadas (`0.45.0` a `0.48.0`) y una quinta opcional, sin tocar ni inyectar nada en los procesos de los juegos.

Tres ventajas propias de un launcher:

1. **Sabe qué estás jugando.** La guía aparece en la ficha de cualquier juego (PC o Arcade) y en el desplegable de **Jugar**, sin buscar.
2. **Sabe dónde la vas a leer.** Reutiliza el monitor por juego: la guía se abre sola en la otra pantalla (o en ventana flotante / celular en fases posteriores).
3. **Recuerda dónde ibas.** Marca el tramo actual («Acá estoy») y oculta lo que viene después para evitar spoilers.

Regla de licencias: Viciódromo **no copia guías con derechos reservados**. Enlaza los sitios externos (GameFAQs, Guías de Steam, YouTube, IGN), descarga sólo guías de licencia libre (StrategyWiki, CC BY-SA) y trabaja con archivos `.txt`, `.md`, `.html` y notas propias del jugador. La IA, opcional y bajo demanda, arma pistas a partir de un texto ya cargado; nunca inventa soluciones de memoria.

## Modelo de dos niveles

Cada guía se organiza en **tramos** (capítulo, zona, nivel o jefe):

- **Nivel 1 · Pistas (por defecto la primera vez; después recuerda el último nivel usado en ese juego):** lista preguntas con títulos sin spoiler y 3 o 4 pistas progresivas por pregunta, cerrando con el fragmento citado de la solución.
- **Nivel 2 · Solución completa:** texto completo del tramo con búsqueda y salto entre tramos, con confirmación breve para evitar spoilers accidentales.

## Fuentes y tratamiento por licencia

| Fuente | Licencia | Qué hace Viciódromo |
| --- | --- | --- |
| **GameFAQs** | Derechos de autor; términos prohíben scraping | Sólo enlace directo de búsqueda abierto en visor interno o navegador. |
| **Guías de Steam, YouTube, IGN** | Contenido de terceros | Sólo enlaces directos (`steamcommunity.com/app/<appid>/guides/` cuando hay `appid`, búsqueda armada en YouTube e IGN). |
| **StrategyWiki** | Texto CC BY-SA 4.0 / 3.0 | Fase 2: consulta por API de MediaWiki, guardado local sin conexión, división en tramos, atribución y enlace. Las imágenes se cargan desde el sitio por HTTPS. |
| **Archivos propios (`.txt`, `.md`, `.html`)** | Uso personal | Fase 2: importación local en Node sin dependencias externas; no se exportan. (No se incluye `.pdf` para mantener las dependencias mínimas). |
| **Wikis de Fandom** | Verificar wiki por wiki | Fase 5 (opcional): sólo wikis con licencia libre comprobada. |

## Decisiones aprobadas

- [x] **Nivel al abrir:** **Pistas** la primera vez en un juego; después recuerda lo último usado en ese juego.
- [x] **IA sin fuente:** deshabilitada. La IA sólo trabaja sobre una guía cargada y cita el fragmento de origen.
- [x] **Guía en el celular:** sí en Fase 4, mediante micro-servidor efímero en red local separado de `127.0.0.1`, apagado por defecto y con token de un solo uso canjeable por cookie de sesión mientras dure la partida.
- [x] **Traducción:** a pedido, por tramo (con «Ver original»), reutilizando la clave de Anthropic ya cifrada con DPAPI.
- [x] **Nombre en la interfaz:** pestaña **Guía**, con niveles **Pistas** y **Solución**.
- [x] **Fase 5 comunitaria:** se decide después de usar las fases 1 a 4.

## Ajustes técnicos respecto del borrador original

1. **Visor interno seguro (Fase 1):** el servidor principal fija `frame-src 'none'` y Electron bloquea `<webview>`. El visor interno se implementa como una **`BrowserWindow` auxiliar aislada** (`sandbox: true`, `contextIsolation: true`, partición `persist:guides`, sin acceso a `127.0.0.1`), con botón/enlace alternativo al navegador del sistema.
2. **Almacenamiento separado y versionado:** todos los archivos viven en `guides/` dentro de la carpeta de datos (`%APPDATA%\Viciódromo\guides\` o junto al `.exe` en modo portable) con `createVersionedFile` (`schemaVersion: 1`), usando `game.key` (`steam:…`, `arcade:…`, etc.):
   - `guides/progress.json` (Fase 1+): «Acá estoy», nivel activo, último enlace abierto, pistas reveladas y notas por tramo (con IDs de capturas de `screenshots.mjs`, sin rutas locales).
   - `guides/index.json` y `guides/items/<id>.json` (Fase 2+): índice y contenido descargado/importado, separados de `progress.json` para que actualizar una fuente no borre el avance.
3. **Formato interno y referencias de respuesta:** formato interno Markdown/bloques estructurados (sin inyectar HTML externo en la interfaz) y `answerRef` basado en bloque + cita exacta de respaldo, en lugar de desplazamientos rígidos de caracteres.
4. **Sin `.pdf` ni dependencias nuevas:** la importación de Fase 2 soporta `.txt`, `.md` y `.html` de forma nativa.
5. **IA compartida (Fase 3):** cliente común `src/ai.mjs` reutilizado por Novedades y Guías, con límite de tokens ampliado y validación estricta de JSON.
6. **Seguridad del modo celular y pantalla única (Fase 4):** `src/guide-lan.mjs` en servidor efímero aparte (nunca exponiendo el servidor principal de `127.0.0.1`), desplegable `Jugar ▾` también con un monitor para ventana flotante, integración en la fila **Continuar** existente en Inicio y registro validado de atajos globales.

## Plan por fases

| Fase | Versión y rama | Alcance | Estado |
| --- | --- | --- | --- |
| **1. La guía en la ficha** | `0.45.0` · `guias` | Pestaña **Guía** con enlaces armados (GameFAQs, Steam, StrategyWiki, YouTube, IGN) en visor auxiliar aislado o navegador; **«Acá estoy»** manual persistente; **Notas de partida por tramo** con adjuntos de *Tus capturas*; **«Jugar con la guía»** en el otro monitor desde `Jugar ▾`. | Implementada |
| **2. Guías sin conexión** | `0.46.0` · `guias-fase-2` | StrategyWiki por API MediaWiki con atribución; importador nativo de `.txt`, `.md` y `.html`; modo **Solución** con índice de tramos, búsqueda y antispoiler; filtro «Con guía»; consulta de disponibilidad en búsqueda nocturna. | Implementada |
| **3. Pistas escalonadas** | `0.47.0` · `guias-fase-3` | Modo **Pistas** con preguntas, «Otra pista» y «Ver la respuesta»; editor manual de pistas; `src/ai.mjs` opcional para pistear, preguntar y traducir por tramo con cita de origen. | Implementada |
| **4. Jugar con la guía al lado** | `0.48.0` · `guias-fase-4` | Ventana flotante siempre visible con transparencia y aviso de pantalla completa exclusiva; atajos globales; guía en el celular por QR (`src/guide-lan.mjs`); navegación con mando en modo sala; tramo guardado en la fila **Continuar** de Inicio. | Implementada |
| **5. Guías compartidas (opcional)** | A definir | Exportar/importar `.vicioguia.json`, carpeta comunitaria CC BY-SA y wikis de Fandom verificadas. | Por decidir tras Fase 4 |

## Módulos de la arquitectura de guías

- **Fase 1 (`0.45.0`):** `src/guide-sources/links.mjs`, `src/guides.mjs`, `src/routes/guides.mjs`, `public/js/guides.js`, `test/guides.test.mjs` + ganchos mínimos en `electron-main.mjs` (`openGuideWindow`), `server.mjs`, `details.js`, `displays.js`, `icons.js` y `screens.css`.
- **Fase 2 (`0.46.0`):** `src/guide-sources/strategywiki.mjs`, `src/guide-import.mjs`, `src/guide-sanitize.mjs`.
- **Fase 3 (`0.47.0`):** `src/ai.mjs`, `src/guide-hints.mjs`.
- **Fase 4 (`0.48.0`):** `src/guide-lan.mjs`, `public/guide-overlay.html`, `public/js/guide-overlay.js`.
