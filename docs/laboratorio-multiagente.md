# Primer ciclo del laboratorio multiagente

## Estado y objetivo

Rama experimental: `experimento/multiagente`, creada desde `main` en `2b7558edf8933652b62a6ec11501e2b417992006`.

El primer ejercicio incorpora únicamente instrucciones de colaboración: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` y este documento. No cambia el comportamiento de Viciódromo ni activa herramientas externas.

Suscripciones declaradas: ChatGPT Plus, Claude Pro y Google AI Pro. Utilizar las cuentas existentes y comprobar en cada herramienta el acceso y consumo aplicables. Al alcanzar un límite, pausar ese tramo; no activar facturación adicional automáticamente.

## Circuito manual

1. Codex prepara las instrucciones en la rama experimental, revisa su coherencia con los archivos reales y ejecuta `git diff --check`.
2. Claude recibe el mismo commit o parche completo y revisa claridad, contradicciones y límites. Inicialmente no edita ni instala nada.
3. Gemini recibe ese mismo material y analiza aislamiento, efectos externos, supuestos de costo y casos límite. Inicialmente no edita ni instala nada.
4. Codex incorpora los hallazgos aceptados, vuelve a revisar las diferencias y registra qué cambió y qué quedó pendiente.
5. El usuario decide cuándo continuar con una mejora funcional. No fusionar a main ni publicar versiones como parte de este circuito.

No hay coordinación automática ni sesiones de Claude/Gemini iniciadas por estos archivos. La lectura de la guía debe comprobarse al comenzar cada sesión: pedir a la herramienta que identifique sus límites antes de asignarle trabajo.

## Encargo para Claude

Leer `AGENTS.md` y revisar el parche de instrucciones del laboratorio. Comprobar que las reglas concuerdan con `package.json`, los workflows y `test/ui/playwright.config.mjs`. No editar, instalar, publicar ni acceder a datos del perfil. Entregar hallazgos con archivo y línea, diferenciando defectos de preferencias. Indicar el commit o parche revisado y el alcance pendiente.

## Encargo para Gemini

Leer `AGENTS.md` y analizar el mismo parche de instrucciones. Buscar supuestos incorrectos sobre aislamiento de ramas, perfil de Windows, integraciones, CI, publicación y uso de suscripciones. No editar, instalar ni acceder a credenciales. Entregar riesgos con evidencia y proponer el menor ajuste necesario. Indicar el commit o parche analizado.

## Criterio de cierre

- Los cuatro documentos son coherentes con el proyecto y no introducen cambios funcionales.
- No hay cambios en main, secretos, etiquetas, publicación ni configuración global.
- Las comprobaciones ejecutadas están registradas sin atribuir revisiones a herramientas que todavía no participaron.
- Las observaciones reales de Claude y Gemini se incorporan o se justifican antes de considerar terminado el ciclo entre las tres herramientas.

Las instrucciones son orientación, no un bloqueo técnico. Antes de trabajo simultáneo o automatización, preparar carpetas por agente y evaluar permisos efectivos. No compartir datos personales ni copiar credenciales al laboratorio.

## Primera revisión de Claude

El usuario aportó la salida de Claude Code sobre el commit inicial `b9305f3`. La revisión informó dos hallazgos y una duda; Codex contrastó los hallazgos con los workflows antes de ajustar las instrucciones:

- Aclarar que la prohibición de instalar el producto corresponde a la computadora del usuario. CI puede instalarlo y abrirlo en su runner aislado, con consumo de recursos de Actions.
- Documentar el marcador que activa la actualización de capturas y la cadena condicional: imágenes modificadas, commit del bot, push y relanzamiento de CI. Un escritor por carpeta no impide escrituras remotas del bot.
- Explicar que `AGENTS.md` cumple la función de guía para Codex; no agregar otra copia de las reglas.

Se aceptan como mejoras de claridad. No se identificó una ejecución accidental de publicación o una modificación del perfil real. El usuario aportó después una segunda revisión de Claude sobre `f5e819d`: consideró resueltos los dos hallazgos y aclarada la duda, sin observaciones nuevas.

## Revisión independiente de Gemini

El usuario aportó el análisis de Gemini del paquete de nueve archivos correspondiente a `f5e819d`. No reportó defectos críticos, altos o medios. Codex contrastó su observación menor con `ci.yml` e incorporó estas aclaraciones:

- CI también se activa mediante eventos de pull request y ejecución manual, además de pushes.
- Durante esta etapa, las operaciones locales de empaquetado, humo, instalación, escaneo o lanzamiento de juegos requieren una solicitud específica y aislamiento definido, incluso al validar código.
- Las variables de las pruebas no prueban por sí mismas que esté bloqueado todo acceso al perfil o a la red. La inspección de sus consumidores sigue pendiente antes de ejecutar pruebas locales que puedan tener esos efectos.

El primer ciclo manual entre las tres herramientas queda completado para la documentación: preparación de Codex, revisión de Claude, correcciones, segunda revisión de Claude y análisis independiente de Gemini con ajustes menores incorporados. Claude y Gemini no revisaron todavía este último ajuste de redacción. No se certifica el comportamiento funcional, los permisos remotos, las cuotas o un aislamiento técnico completo. Próximo ejercicio recomendado: inspección de sólo lectura del aislamiento de las pruebas, antes de ejecutar la aplicación o instalar dependencias.
