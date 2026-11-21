# Elegir al azar: ciclo funcional multiagente

## UX y alcance aprobado

El usuario eligió esta mejora para recorrer un ciclo completo: propuesta de UX, implementación, revisión, iteración y pruebas. La Biblioteca permite buscar y filtrar; el nuevo botón ayuda a elegir entre esos resultados.

«Elegir al azar», junto al contador, abre la ficha de un título sin iniciarlo ni instalarlo. Respeta búsqueda, filtros, favoritos, listas, colección y alcance. Sortea entre títulos ya agrupados, sin favorecer copias entre tiendas, e incluye resultados todavía no dibujados por lotes.

Con cero resultados, carga o error queda deshabilitado con explicación visible. Con uno, abre ese título. Enter y Espacio funcionan como en un botón nativo. El foco pasa al título y vuelve al control de origen o al buscador si ese control ya no está disponible. Desde una tarjeta se conserva el retorno habitual. El azar puede repetir: no agrega historial, ruleta ni dependencias de aplicación.

## Iteraciones

- Codex inspeccionó el producto, propuso la función y el usuario aprobó su alcance.
- Gemini revisó la UX antes de programar. Se incorporaron ayuda visible y foco contextual. Es una revisión heurística, no un estudio con participantes.
- Codex reutilizó botones y tokens del proyecto. La consulta de referencias de 21st no requirió importar componentes de otro framework ni generación alojada.
- Claude Pro alcanzó el límite antes de entregar la revisión. No se compraron créditos ni se pasó a API.
- Gemini revisó el parche y planteó un posible fallo con el logo del juego. El código conserva el título con `visually-hidden`; una nueva prueba con el logo cargado confirmó que mantiene el foco. Se añadieron pruebas de alcance y retorno cuando cambian los resultados.

## Criterios y verificación

Se comprueban sorteo sin mutar resultados, respeto de filtros y agrupación, apertura sin solicitudes de lanzamiento/instalación, estados bloqueados, contexto conservado, foco con y sin logo y participación de resultados fuera del primer lote.

Validación local: 141 unitarias y 10 pruebas Playwright específicas aprobadas. La suite de interfaz completa pasó inicialmente 53 pruebas sin comparación de imágenes en Windows; las tres pruebas posteriores se aprobaron dentro de las 10 específicas. Sintaxis, módulos, estilos y formato aprobados. La revisión determinista de UI reportó cero errores y cero advertencias; las sugerencias informativas correspondían a código previo.

La UI cambia intencionalmente las pantallas de Biblioteca. Las referencias se actualizan y revisan en Ubuntu 24.04 mediante el flujo existente de la rama experimental; no se regeneran desde Windows. El estado final de CI debe comprobarse por separado.

No cambia el backend, la versión del producto, los secretos ni la publicación. Este ejercicio no fusiona a main.
