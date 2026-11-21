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
