# Laboratorio de Viciódromo

## Alcance y límites

- Este laboratorio trabaja en `experimento/multiagente` o ramas derivadas. Antes de editar, comprobar `git status --short --branch` y el commit base.
- No modificar ni fusionar a `main`. No publicar releases, subir etiquetas, desplegar ni cambiar secretos o credenciales.
- No cambiar versión, configuración de publicación, workflows, actualizador ni tareas programadas salvo una solicitud específica del usuario.
- No leer, copiar ni mostrar valores de `.env`, credenciales, datos del perfil real, inventarios, capturas personales o registros reales. No conectar Steam, IGDB u otras cuentas durante las pruebas.
- La separación de ramas y estas instrucciones no impiden efectos externos. En la computadora del usuario, no iniciar la aplicación con el perfil habitual, escanear unidades, instalar el producto ni registrar tareas de Windows. Esto no prohíbe las pruebas de instalación aisladas del runner de CI descritas más abajo.
- Usar un solo escritor por carpeta. Para trabajo simultáneo, usar carpetas y ramas propias. Los revisores entregan hallazgos sin editar por defecto.
- Las suscripciones disponibles son ChatGPT Plus, Claude Pro y Google AI Pro. Preferir inicio de sesión con esas cuentas; no activar APIs de pago, compras, recargas ni nuevos servicios automáticamente. No inspeccionar archivos de autenticación.

## Proyecto

Aplicación local para Windows, Electron y Node con módulos ES. La interfaz es HTML/CSS/JavaScript sin compilación. Mantener el idioma español y las convenciones existentes.

- `src/`: servidor local, Electron, indexación e integraciones.
- `src/routes/`: API organizada por dominio.
- `public/js/`: módulos de interfaz; `public/styles/`: estilos por capas.
- `test/`: pruebas con `node:test`; `test/ui/`: Playwright, flujos, accesibilidad y capturas.
- `docs/arquitectura.md`, `docs/operacion.md` y `docs/sistema-de-diseno.md`: referencias antes de cambiar comportamiento.
- `tools/`: comprobaciones, empaquetado y operaciones de Windows.
- `data/`: datos privados locales excluidos de Git, salvo el ejemplo versionado.

## Verificación

CI utiliza Node 22. Revisar scripts antes de instalar dependencias. No instalar herramientas ni cambiar configuración global incidentalmente.

- Documentación e instrucciones: revisar contenido, enlaces locales y `git diff --check`; no requiere instalar dependencias ni probar Electron.
- Código: `npm run check` y `npm test`, con dependencias disponibles y tras verificar que las pruebas afectadas usan datos temporales o ficticios.
- Interfaz: añadir `npm run test:ui`. La configuración existente usa `GML_OFFLINE=1`, datos en `test/ui/.data` y carpetas ficticias para Steam y videos. No reutilizar un servidor del perfil real.
- Estas variables configuran las pruebas; no son una barrera de seguridad del sistema. Antes de ejecutarlas, revisar cómo las consumen el servidor, las fixtures y los módulos afectados. No asumir que bloquean por sí solas toda red, lectura de `.env` o acceso al perfil real.
- Capturas de referencia: CI usa Ubuntu 24.04; no regenerarlas en Windows para ocultar diferencias del sistema.
- No ejecutar localmente empaquetado, pruebas de humo de Electron, prueba de instalación, escaneo o lanzamiento de juegos durante esta etapa del laboratorio. Para habilitar cualquiera de esas operaciones se necesita una solicitud específica y definir primero el aislamiento de datos y efectos externos. CI conserva sus comprobaciones automáticas descritas más abajo.
- `npm run verify` no incluye todas las comprobaciones de CI. Informar exactamente qué se ejecutó, qué pasó y qué falta.

El workflow de CI está configurado para pushes a cualquier rama, eventos de pull request (incluidos los borradores) y ejecución manual. Un push a una rama con pull request abierto puede originar ejecuciones por ambos eventos. Cuando pasan los trabajos previos, el job de ejecutables construye, instala y abre el producto en el runner de Windows de GitHub, separado del perfil local del usuario. Esto consume recursos de Actions y genera artefactos de prueba; no publica una release. La prohibición de instalación local no elimina estos efectos automáticos. La publicación de versiones se activa con etiquetas `v*.*.*`.

No incluir `[capturas]` en mensajes de commit ni lanzar manualmente el workflow de capturas durante el laboratorio, salvo solicitud específica para actualizar las referencias. Ese marcador puede activar el job en ramas distintas de main. Si las imágenes cambian, el bot crea un commit, lo sube a la misma rama y relanza CI completo, incluidas las pruebas de instalación. La regla de un escritor por carpeta evita conflictos locales; el bot es un escritor remoto adicional. Si se autoriza ese flujo, esperar a que termine y traer sus cambios antes de continuar editando o subiendo commits.

## Colaboración

Codex implementa; Claude revisa; Gemini analiza arquitectura y casos límite. Estos roles son el punto de partida, no sesiones conectadas automáticamente.

`AGENTS.md` es la guía del proyecto para Codex y la base compartida que las guías de Claude y Gemini piden leer. No hace falta crear un archivo `CODEX.md` adicional para este laboratorio.

Cada entrega identifica objetivo, rama, commit base, archivos afectados, validación y limitaciones. Revisar siempre el mismo commit o el mismo parche; no asumir que otra herramienta comparte historial o archivos.

No afirmar que Claude o Gemini revisaron algo si no se ejecutaron esas herramientas. No simular sus respuestas. Ver `docs/laboratorio-multiagente.md` para el primer ejercicio.
