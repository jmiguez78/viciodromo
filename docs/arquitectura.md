# Arquitectura

## Objetivo

Viciódromo es una biblioteca y lanzador local, con conexiones opcionales a Steam e IGDB. El escaneo de instalaciones permanece local; cada integración consulta su servicio con los identificadores necesarios.

```mermaid
flowchart LR
  A[Datos locales de Steam, Epic, Xbox, Ubisoft, EA y GOG] --> B[Indexador local]
  B --> C[data/library.json]
  C --> D[Servidor local]
  D --> E[Interfaz de escritorio Electron]
  E --> F[URI, AppsFolder o ejecutable local]
  F --> G[Launcher inicia el juego]
```

## Componentes

- `src/indexer.mjs`: busca los juegos instalados en todas las unidades de la PC y en el registro de Windows (leído con PowerShell en UTF-8) y genera un catálogo normalizado. `scanLibrary({ env })` recibe las unidades y el registro, así las pruebas simulan otra PC (ver [Operación](operacion.md#cómo-se-encuentran-los-juegos-instalados)).
- `src/server.mjs`: servicios de la biblioteca (inventario, preferencias, arte, lanzamiento) y servidor local. Las rutas de la API están en `src/routes/`, una por dominio: `library.mjs` (biblioteca, jugar, instalar, imágenes), `preferences.mjs` (preferencias, respaldo, portadas, ajustes), `integrations.mjs` (Steam, IGDB, Arcade), `system.mjs` (tarea nocturna, registro, diagnóstico, versiones nuevas) y `screenshots.mjs` (tus capturas y videos).
- `src/http.mjs`: enrutador declarativo (`router.get('/api/steam/games/:appid(\d+)/:kind', …)`), lectura y validación del cuerpo y errores con código: 400 datos inválidos, 404 inexistente, 405 método no permitido, 409 falta conectar o configurar algo, 413 demasiado grande, 502 un servicio externo falló. Sólo los errores inesperados responden 500 y van al registro como error.
- `src/updates.mjs`: consulta la última publicación en GitHub (como mucho una vez por día) para avisar una versión nueva en Configuración y con un aviso al abrir.
- `src/auto-update.mjs`: actualización automática de la versión instalada, sobre `electron-updater`. Nada se descarga hasta que se pide; estados `idle`, `downloading`, `ready` y `error`. `electron-main.mjs` la crea sólo en el ejecutable instalado (ni portable ni desarrollo) y la pasa al servidor: `GET /api/updates` suma `install`, `POST /api/updates/download` empieza la descarga y `POST /api/updates/install` cierra, instala y vuelve a abrir. Fuera de la versión instalada, esas dos rutas responden 409.
- `src/jump-list.mjs`: Jump List de Windows (los últimos juegos jugados en el clic derecho del ícono de la barra de tareas). Funciones puras: qué juegos van, el argumento `--launch=<clave>` con el que cada entrada vuelve a ejecutar la aplicación y qué accesos directos necesitan el identificador de la aplicación (`com.jorgemiguez.viciodromo`). `electron-main.mjs` las aplica con `app.setJumpList`, inicia el juego pedido (`server.games.play`, también cuando llega por `second-instance`) y actualiza la lista con cada aviso `onLibraryChange` del servidor.
- `src/displays.mjs`: monitor de cada juego. Elige el monitor (el elegido sólo para esta vez en Jugar ▾; si no, el predeterminado del juego; si tampoco, ninguno y Windows lo abre en el principal) entre los que informa Electron (`listDisplays` en `electron-main.mjs`, con el rectángulo en píxeles físicos de `screen.dipToScreenRect`). En Windows, un ayudante de PowerShell (se escribe en la carpeta temporal y corre con `-File`) busca las ventanas de los procesos que corren desde la carpeta del juego (`gameRoots`) y las mueve al monitor; a MAME se le pasa `-screen \\.\DISPLAYn`. Con un solo monitor no se hace nada.
- `src/electron-main.mjs`: abre la ventana de escritorio y ejecuta la indexación programada sin mostrarla. Una sola instancia (abrir el .exe otra vez trae la ventana al frente), `sandbox`, sin navegación fuera de la interfaz (los enlaces https se abren en el navegador), sólo el permiso de pantalla completa y puerto fijo 47321 (con otro libre si está ocupado), para que la interfaz conserve lo que guarda en el navegador entre aperturas.
- `src/json-file.mjs`: lectura y escritura de los JSON del perfil. Las lecturas quedan en memoria mientras el archivo no cambie (fecha y tamaño); las escrituras son atómicas (temporal y renombre, con reintentos en Windows) y van en fila por archivo, así dos cambios seguidos nunca se pisan. `createVersionedFile` agrega versión de esquema y migraciones, con copia `nombre.vN.bak.json` antes de migrar.
- `src/log.mjs`: registro de diagnóstico en `logs/gml.log` del perfil (rota al pasar 1 MB, se conservan tres). `GET /api/diagnostics` arma el diagnóstico que exporta Configuración; `POST /api/log` recibe los errores de la interfaz (como mucho 30 por minuto).
- `src/es.mjs`: géneros, temáticas, modos y perspectivas de IGDB y categorías de MAME en español. Los datos guardan los nombres originales; la traducción se aplica al armar `/api/library`.
- `src/igdb.mjs`: integración opcional con Twitch/IGDB. Descarga fichas ampliadas y tiempos estimados, conserva las coincidencias conocidas y guarda una caché local compacta en `metadata.json` (esquema 3, sin la respuesta original de IGDB).
- `src/secrets.mjs`: cifra el secreto de Twitch con DPAPI de Windows para el usuario actual. `integrations.json` no se versiona.
- `public/`: interfaz HTML, CSS y JavaScript sin dependencias ni compilación. `index.html` carga tres scripts clásicos con lógica pura y pruebas (`catalog.js`: búsqueda, filtros, orden y duplicados; `shelves.js`: filas de Inicio; `gamepad.js`: mando y pantalla grande) y el punto de entrada `js/main.js` como módulo ES. `styles.css` ordena los estilos en capas (`@layer`) e importa una hoja por capa desde `styles/`: tokens, base, componentes, pantallas, modo sala y utilidades. Tipografías y marca en `fonts/` y `brand/` (ver [Sistema de diseño](sistema-de-diseno.md)).
- `public/js/`: la interfaz en módulos ES, uno por responsabilidad. Cada módulo exporta sus funciones y, si tiene enlaces de eventos, una función `setup()` que `main.js` llama una sola vez, después de que todos los módulos se cargaron (así ningún módulo usa a otro antes de tiempo).

| Módulo                                                | Responsabilidad                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `main.js`                                             | Navegación entre páginas, carga de la biblioteca, atajos globales y arranque               |
| `state.js`                                            | Estado de la interfaz y preferencias de este equipo                                        |
| `api.js`, `icons.js`, `feedback.js`                   | Pedidos a la API, íconos, avisos y errores de formulario                                   |
| `art.js`, `cards.js`                                  | Portadas, imagen principal, color ambiental; tarjetas y navegación por teclado             |
| `home.js`, `library.js`, `game-page.js`, `details.js` | Inicio, Biblioteca, página del juego y contenido de la ficha                               |
| `launch.js`, `editor.js`, `palette.js`                | Jugar, editar un juego y paleta de comandos                                                |
| `couch.js`                                            | Modo sala para TV y mando (con `styles/couch.css`)                                         |
| `settings.js`, `diagnostics.js`, `steam.js`           | Configuración, Para revisar y todo lo de Steam                                             |
| `snapshot.js`, `report.js`                            | Arranque instantáneo (última biblioteca en IndexedDB) y errores de la interfaz al registro |
| `events.js`                                           | Eventos del servidor: fila de tareas, biblioteca cambiada y sesiones medidas               |
| `activity.js`, `onboarding.js`                        | Tu actividad y Primeros pasos                                                              |
| `lists.js`                                            | Listas propias: filas de Inicio, filtro de la Biblioteca y diálogos                        |
| `displays.js`                                         | Monitor de cada juego: Jugar ▾, selector de Editar y Configuración → Monitores             |
| `news.js`                                             | Novedades: Seguir, pestaña y sección Novedades, fila de Inicio, ajustes y punto de portadas |

`npm run check` comprueba la sintaxis de todo `src/` y de los scripts de la interfaz (`tools/check-syntax.mjs`), que cada `import` exista en su módulo de origen (`tools/check-modules.mjs`) y las reglas de los estilos (`tools/check-styles.mjs`). `window.GML` expone el estado y la navegación para depurar desde la consola.

- `src/mame.mjs`: Arcade. Lee `-listxml` en flujo, verifica sets por CRC, aplica filtros y agrupa versiones (funciones puras con pruebas en `test/mame.test.mjs`); `createArcade` orquesta la indexación en segundo plano, el arte y el lanzamiento con medición de la sesión. Rutas: `GET/PUT /api/integrations/mame`, `POST /api/mame/scan`. Los juegos llegan a `/api/library` con `platform: 'Arcade'`, `key: 'arcade:<set>'`, `launch.type: 'mame'` y un objeto `arcade` (fabricante, jugadores, controles, orientación, saga, ranking, versiones).
- `src/sessions.mjs`: sesiones de juego. `createSessionTracker` vigila la carpeta de instalación de un juego iniciado (procesos de Windows vía `Get-CimInstance Win32_Process`) y avisa al cerrarse; `createSessionLog` guarda `sessions.json`.
- `src/activity.mjs`: resumen para «Tu actividad» (semanas, racha, más jugados, últimas sesiones). `GET /api/activity?now=`.
- `src/tasks.mjs`: fila única de tareas en segundo plano por prioridad y `GET /api/events` (text/event-stream: `tasks`, `library`, `session`). `GET /api/tasks` devuelve el estado de la fila.
- `src/portable.mjs`: carpeta de datos del portable (junto al `.exe` o en AppData), copia de los datos y paso de los datos del nombre anterior (Games Meta Launcher) al actual. Copia con `copyTree` y no con `fs.cp`: en Windows, `fs.cp` no copia carpetas hacia rutas con tildes. `GET /api/portable`, `POST /api/portable/copy`.
- `src/screenshots.mjs`: tus capturas y videos, leídos de Steam, MAME, Xbox Game Bar, NVIDIA, Videos y las carpetas propias, y asociados a cada juego por número, set, carpeta o nombre de archivo. El índice vive en memoria (se rehace como mucho una vez por minuto). La interfaz nunca recibe rutas, sólo identificadores: `GET /api/screenshots/game/:key`, `GET /api/screenshots/recent`, `GET/PUT /api/screenshots/folders`, `GET /api/screenshots/file/:id`, `GET /api/screenshots/video/:id` (por partes, con `Range`) y `POST /api/screenshots/file/:id/open`.
- `src/lists.mjs`: listas propias en `preferences.json` (validación y cambios). `POST /api/lists`, `PUT/DELETE /api/lists/:id`, `PUT /api/lists/:id/games` (`{ key, member }`). Llegan a la interfaz dentro de `/api/library` (`lists`); los juegos de una lista automática los calcula `GMLCatalog.listGames`.
- `GET /api/onboarding`: datos de «Primeros pasos» (juegos por tienda, avance de la búsqueda, conexiones y claves que hay que reconectar).
- `src/news.mjs`: novedades de los juegos que seguís. Al seguir uno, `discover` busca su entidad en Wikidata (por la ficha de Steam P1733 o de GOG P2725 y, si no, por nombre) y arma las fuentes: sitio oficial (P856, con el feed que declara la portada), Bluesky (P553 + P554, RSS público por perfil), YouTube (P2397, feed por canal), noticias de Steam (`ISteamNews/GetNewsForApp`, sin clave, sólo los anuncios del juego), prensa (`PRESS_FEEDS`, filtrada por nombre y, si es ambiguo, por estudio) y la versión instalada (`installedVersion`: `buildid` del manifiesto de Steam, `AppVersionString` del `.item` de Epic y `Identity Version` de `MicrosoftGame.config` o `appxmanifest.xml` en Xbox). Las versiones nuevas de MAME (última publicación de `mamedev/mame` en GitHub contra la del MAME configurado) se guardan con la clave `MAME_KEY` y aparecen en la bandeja como «MAME (emulador)». La primera consulta deja las últimas cinco; después entra sólo lo no visto y publicado después de seguirlo (con un día de margen); la misma historia en otro medio (mismo título) se suma a la existente en `also`. Cada juego tiene un modo (`MODES`: `official`, `press` por defecto, `all` con ofertas, el subreddit —P3984, lo más votado de la semana por RSS, tipo `community`— y el buscador abierto GDELT DOC 2.0, una búsqueda cada 5,5 s, filtrada por título con `pressMatcher`) y puede estar silenciado (`mutedUntil`: no se consulta ni cuenta). Los ajustes (`settingsOf`: medios activos, ofertas, seguir solos los juegos abiertos en el último mes) viven en `news.json`. Consulta al abrir si pasaron seis horas, cada seis horas y en la búsqueda nocturna (`nightlyNews`, desde `electron-main.mjs --scan`); con `GML_OFFLINE=1`, nunca. Avisa a la interfaz con el evento `news`. Rutas en `src/routes/news.mjs`: `GET /api/news` (seguidos y sin leer), `POST /api/news/refresh`, `GET /api/news/game/:key`, `POST/DELETE /api/news/game/:key/follow`, `POST /api/news/game/:key/refresh`, `POST /api/news/game/:key/read`, `POST /api/news/game/:key/items/:id/hide`, `PUT /api/news/game/:key/mode` (`{ mode }`), `POST /api/news/game/:key/mute` (`{ days }`, 0 reactiva), `GET /api/news/inbox` (`?type=&game=`, últimos 60 días), `POST /api/news/read-all`, `GET/PUT /api/news/settings`, `PUT /api/news/game/:key/sources/:id` (`{ enabled }`) y `POST /api/news/game/:key/sources` (`{ url }`).
- `src/feeds.mjs`: lectura de RSS y Atom sin dependencias, noticias de Steam, descubrimiento del feed de una página, texto plano sin HTML, tipo de cada novedad y filtro de prensa (funciones puras, `test/feeds.test.mjs`). Los enlaces son sólo http/https y las imágenes, sólo https.
- `src/wiki.mjs`: Wikipedia en inglés → Wikidata (videojuego, año, IGDB P5794, artículo en español) → introducción en español. Rutas de datos: `arcade-info.json`.
- `src/mame-commands.mjs`: lee `command.dat` y convierte sus códigos en flechas y botones legibles. `GET /api/arcade/:set/commands`.
- `src/zip-index.mjs`: lee el directorio central de un `.zip` (nombre, tamaño, CRC) sin descomprimir.
- `src/steam-assets.mjs`: rutas vigentes del arte de la tienda de Steam (servicio GetItems), con caché en `steam-assets.json`.
- `src/names.mjs`: nombres para mostrar sin sufijos de tienda. El servidor entrega `name` limpio y conserva `originalName`.
- `GET /api/art/wordmark/:key`: logo transparente del juego, desde la caché de Steam o su CDN.
- `GET/PUT /api/settings`: tema y `minimizeOnLaunch`. Al lanzar un juego con esa opción activa, el servidor avisa a Electron (`onLaunch`) para minimizar la ventana.
- `tools/package.mjs`: arma el instalador (NSIS, por usuario) y el portable, y deja en `releases/` las dos últimas versiones completas, con `latest.yml` y el `.blockmap` de la actualización automática.
- `tools/smoke.mjs`: prueba de humo de un ejecutable. Lo abre con `--smoke=<carpeta>`: `electron-main.mjs` usa esa carpeta para los datos, levanta el servidor sin la tarea nocturna ni consultas a internet, abre la ventana sin mostrarla y anota en `smoke.json` si la interfaz arrancó, recibió la biblioteca y no dejó errores.
- `data/library.json`: inventario local generado; se excluye del control de versiones.
- `test/`: pruebas automáticas con `node:test` de la API, los módulos y las herramientas.
- `test/ui/`: pruebas de interfaz con Playwright sobre una biblioteca inventada (`fixture.mjs`, sin imágenes ni datos reales y sin descargas: `GML_OFFLINE=1`). Pantallas, flujos (buscar, favoritos, paleta, modo sala, arranque instantáneo, diagnóstico, aviso de versión), accesibilidad WCAG 2.1 AA con axe en ambos temas y capturas de referencia en `test/ui/capturas/`.
- `.github/workflows/`: integración continua (`ci.yml`: pruebas en Windows, interfaz en Linux, y el instalador y el portable armados y abiertos en modo de prueba) y publicación al subir una etiqueta (`release.yml`).

## Datos del perfil

| Archivo                        | Versión            | Contenido                                                      |
| ------------------------------ | ------------------ | -------------------------------------------------------------- |
| `preferences.json`             | `schemaVersion: 1` | Favoritos, etiquetas, notas, progreso, tiempo jugado y ajustes |
| `metadata.json`                | `schemaVersion: 3` | Fichas de IGDB, compactas                                      |
| `library.json`                 | `schema: 2`        | Inventario de la última búsqueda (se regenera)                 |
| `arcade-*.json`, `mame-*.json` | `schema` propio    | Índice de Arcade (se regenera)                                 |
| `sessions.json`                | `schemaVersion: 1` | Sesiones medidas por el launcher (hasta 5.000)                 |
| `news.json`                    | `schemaVersion: 1` | Juegos seguidos, sus fuentes y novedades (hasta 50 por juego)  |
| `logs/gml.log`                 | —                  | Registro de diagnóstico                                        |

El servidor calcula `/api/library` una vez por versión de sus entradas: si ningún archivo cambió, reutiliza el resultado (y su JSON). La interfaz guarda la última biblioteca en IndexedDB y la pinta al abrir mientras pide la actual (`public/js/snapshot.js`).

La interfaz se sirve con una política de contenido estricta: sólo sus scripts, conexiones sólo a este servidor e imágenes por https.

## Decisiones iniciales

- El servidor escucha sólo en `127.0.0.1` y rechaza solicitudes con otro origen o `Host`, para que ningún sitio web ni equipo de la red pueda modificar rutas de lanzamiento.
- Los juegos se inician con `explorer.exe` o con su ejecutable, nunca a través de `cmd.exe`.
- Las imágenes se resuelven en este orden: portada manual, imagen local del launcher (`appcache/librarycache` de Steam, logos declarados en `MicrosoftGame.config`) y, sólo para Steam, la CDN pública `cdn.cloudflare.steamstatic.com`. Las descargas se guardan en `art-cache/`; una imagen inexistente no se vuelve a pedir durante 7 días. Las rutas locales nunca se envían a la interfaz.
- El catálogo usa ID de plataforma cuando está disponible, evitando depender únicamente del nombre del juego.
- Las rutas de lanzamiento se resuelven con URI, AppsFolder o ejecutable local según la plataforma y la información encontrada.
- La fecha de última vez jugado se conserva únicamente para los inicios solicitados desde la aplicación.
- IGDB requiere una aplicación de Twitch y conexión explícita desde Configuración. Sólo se envían nombres e identificadores de juegos. Steam consulta la biblioteca de la cuenta conectada mediante su integración opcional.
- La ficha presenta información disponible en secciones desplegables. La historia permanece plegada por posibles spoilers. Las duraciones son estimaciones de IGDB (segundos convertidos a horas); los idiomas y modos pueden variar entre ediciones y plataformas.
- Tus capturas y videos se leen en su lugar, sin copiarlos ni modificarlos; sólo se sirven archivos del índice, por identificador. Los videos se sirven por partes para no leer archivos de varios GB enteros, y la fila de Inicio muestra sólo imágenes.
- Las capturas e ilustraciones de IGDB se cargan de forma diferida desde su CDN en la pestaña Multimedia y se amplían en un diálogo nativo con navegación por teclado; los videos y enlaces se abren externamente. La información textual descargada permanece disponible sin conexión; las imágenes pueden requerir internet.

## Steam desde 0.14.0

`src/steam.mjs` ejecuta el MCP incluido como proceso hijo con el runtime de Electron y `ELECTRON_RUN_AS_NODE`. Las credenciales sólo viajan en el entorno del proceso; nunca en argumentos o diagnósticos. Las claves usan DPAPI en un archivo separado de IGDB.

Biblioteca y logros completos usan APIs oficiales para evitar recortes del MCP. Cuenta, inventario local y preferencias permanecen separados; `mergeSteamLibrary` cruza Steam por App ID. Las respuestas incompletas no sustituyen la cuenta guardada. Cada consulta tiene caché por cuenta, argumentos y región; las fallas de red mantienen datos anteriores con aviso. Un resultado explícito de privacidad reemplaza la caché de esa consulta.

La fecha de Steam se muestra separada de la última apertura desde el launcher. Desconectar elimina credenciales y oculta la cuenta; las cachés permanecen locales. Los DLC publicados no se consideran poseídos. Las consultas sociales son de lectura y pueden devolver resultados parciales.
