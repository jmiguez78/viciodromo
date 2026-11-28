// Recorridos completos: buscar, marcar favorito, paleta, modo sala, arranque instantáneo y diagnóstico.
import fs from 'node:fs';
import { expect, openApp, openGame, show, test } from './helpers.mjs';

test('buscar filtra la biblioteca y quitar la búsqueda la restaura', async ({ page }) => {
  await openApp(page);
  await show(page, 'library');
  const counter = page.locator('#counter');
  const before = await counter.textContent();
  await page.fill('#search', 'Glaciar II');
  await expect(page.locator('#library .poster')).toHaveCount(1);
  await page.fill('#search', '');
  await expect(counter).toHaveText(before);
});

test('marcar un favorito se guarda y sobrevive a recargar', async ({ page }) => {
  await openApp(page);
  await openGame(page, 'epic games:prueba1');
  const before = await page.evaluate(() => GML.state.games.find((g) => g.key === 'epic games:prueba1').favorite);
  await page.locator('#game-page [data-action=favorite]').click();
  await expect
    .poll(() => page.evaluate(() => GML.state.games.find((g) => g.key === 'epic games:prueba1').favorite))
    .toBe(!before);
  await openApp(page);
  expect(await page.evaluate(() => GML.state.games.find((g) => g.key === 'epic games:prueba1').favorite)).toBe(!before);
});

test('la paleta encuentra un juego y lo inicia', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Zafiro');
  await expect(page.locator('#palette [role=option]').first()).toContainText('Zafiro');
  // Elegir un juego en la paleta lo inicia.
  const [launch] = await Promise.all([page.waitForRequest(/\/api\/launch\//), page.keyboard.press('Enter')]);
  expect(decodeURIComponent(launch.url())).toContain('ubisoft:prueba23');
});

test('el modo sala se maneja con teclado y alterna instalados y todos', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => GMLGamepad.setBigScreen(true));
  const couch = page.locator('#couch');
  await expect(couch).toBeVisible();
  await expect(page.locator('.couch-scope-label')).toContainText('Listos para jugar');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.couch-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.couch-sheet')).toBeHidden();
  await page.keyboard.press('v');
  await expect(page.locator('.couch-scope-label')).toContainText('Toda la colección');
  await page.keyboard.press('ContextMenu');
  await page.locator('.couch-menu .couch-action', { hasText: 'Salir del modo sala' }).click();
  await expect(couch).toBeHidden();
});

test('al volver a abrir, la biblioteca aparece antes de que responda el servidor', async ({ page }) => {
  await openApp(page);
  await page.waitForTimeout(800);
  await page.route('**/api/library', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    await route.continue();
  });
  await page.reload();
  await page.waitForFunction(() => window.GML && GML.state.games.length > 40, null, { timeout: 2500 });
  await expect(page.locator('#home-shelves .poster').first()).toBeVisible({ timeout: 2500 });
  await page.unroute('**/api/library');
});

test('exportar el diagnóstico descarga un archivo sin datos personales', async ({ page }) => {
  await openApp(page);
  await show(page, 'settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-diagnostics')]);
  expect(download.suggestedFilename()).toMatch(/^viciodromo-diagnostico-\d{4}-\d\d-\d\d\.json$/);
  const report = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  expect(report.library.total).toBe(54);
  expect(report.files.find((file) => file.name === 'preferences.json').schema).toBe(1);
  expect(JSON.stringify(report)).not.toMatch(/"(apiKey|clientSecret|secret)"\s*:/);
});

test('Configuración avisa una versión nueva y ofrece ver las novedades', async ({ page }) => {
  await page.route('**/api/updates*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        current: '0.29.0',
        available: true,
        latest: '0.30.0',
        newer: true,
        url: 'https://github.com/x/y/releases/tag/v0.30.0'
      })
    })
  );
  await openApp(page);
  await show(page, 'settings');
  await expect(page.locator('#update-status')).toHaveText('Versión 0.29.0. Hay una versión nueva: 0.30.0.');
  await expect(page.locator('#check-updates')).toHaveText('Ver novedades');
});

test('la versión instalada descarga la versión nueva y ofrece reiniciar para instalarla', async ({ page }) => {
  // Lo que respondería la versión instalada: nada pedido → descargando → lista.
  let phase = 'idle';
  const posts = [];
  await page.route('**/api/updates*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        enabled: true,
        current: '0.38.0',
        available: true,
        latest: '0.39.0',
        newer: true,
        url: 'https://github.com/x/y/releases/tag/v0.39.0',
        install: { supported: true, phase, percent: phase === 'ready' ? 100 : 40, version: '0.39.0', error: null }
      })
    })
  );
  await page.route('**/api/updates/*', (route) => {
    posts.push(new URL(route.request().url()).pathname);
    if (route.request().url().endsWith('/download')) phase = 'downloading';
    return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await openApp(page);
  await show(page, 'settings');
  const button = page.locator('#check-updates');
  await expect(button).toHaveText('Actualizar');
  await button.click();
  await expect(page.locator('#update-status')).toHaveText('Versión 0.38.0. Descargando la versión nueva… 40 %.');
  await expect(button).toBeDisabled();
  phase = 'ready';
  await expect(page.locator('#update-status')).toHaveText(
    'Versión 0.38.0. La versión 0.39.0 está lista para instalar.'
  );
  await expect(button).toHaveText('Reiniciar y actualizar');
  await button.click();
  await expect.poll(() => posts).toEqual(['/api/updates/download', '/api/updates/install']);
});

test('listas propias: crear desde un juego, verla en Inicio y en la Biblioteca, y una automática', async ({ page }) => {
  await openApp(page);
  await openGame(page, 'steam:900000');
  await page.locator('#game-aside [data-action=lists]').click();
  const picker = page.locator('#list-picker');
  await expect(picker).toBeVisible();
  await picker.locator('#list-picker-name').fill('Para el finde');
  await picker.getByRole('button', { name: 'Crear y agregar' }).click();
  await expect(picker.getByRole('checkbox', { name: 'Para el finde' })).toBeChecked();
  await picker.getByRole('button', { name: 'Cerrar' }).click();

  await show(page, 'home');
  const shelf = page.locator('.shelf', { has: page.getByRole('heading', { name: 'Para el finde' }) });
  await expect(shelf.locator('.tile')).toHaveCount(1);
  await shelf.getByRole('button', { name: 'Ver toda la lista Para el finde' }).click();
  await expect(page.locator('#library .tile')).toHaveCount(1);
  await expect(page.locator('#active-filters')).toContainText('Lista: Para el finde');

  // Una idea de lista automática: los arcades para dos jugadores.
  await page.locator('#open-lists').click();
  await page.locator('#list-ideas').getByRole('button', { name: 'Arcade de a dos' }).click();
  await expect(page.locator('#lists-manage .list-row')).toHaveCount(2);
  await expect(page.locator('#lists-manage')).toContainText('Automática · 6 juegos');
  // Borrar las dos (y deshacer una) deja el resto de las pruebas como estaba.
  await page.getByRole('button', { name: 'Borrar «Arcade de a dos»' }).click();
  await expect(page.locator('#lists-manage .list-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Borrar «Para el finde»' }).click();
  await expect(page.locator('#lists-empty')).toBeVisible();
  await page.locator('#lists-dialog').getByRole('button', { name: 'Cerrar' }).click();
  await expect(page.locator('#active-filters')).not.toContainText('Lista:');
});

test('tus capturas y videos: en la ficha del juego, en el visor y en Inicio', async ({ page }) => {
  await openApp(page);
  const shelf = page.locator('#home-captures');
  await expect(shelf).toBeVisible();
  await expect(shelf.locator('.capture-thumbnail')).toHaveCount(4);
  await openGame(page, 'steam:900000');
  await page.locator('#game-page [role=tab]', { hasText: 'Tus capturas' }).click();
  const panel = page.locator('#game-page [role=tabpanel]:not([hidden])');
  await expect(panel.locator('.capture-summary')).toContainText('4 capturas y 1 video');
  await expect(panel.locator('.capture-summary')).toContainText('Xbox Game Bar y Steam');
  await expect(panel.locator('.capture-thumbnail')).toHaveCount(5);
  // El video va primero (es el más nuevo), con su duración sobre la miniatura.
  const clip = panel.locator('.capture-thumbnail.is-video');
  await expect(clip.locator('.capture-badge')).toHaveText('0:02');
  await clip.click();
  const viewer = page.locator('#media-viewer');
  await expect(viewer.locator('video')).toBeVisible();
  await expect(viewer.locator('img')).toBeHidden();
  await expect(viewer.locator('.media-position')).toHaveText('1 / 5');
  await viewer.locator('[data-gallery=next]').click();
  await expect(viewer.locator('img')).toBeVisible();
  await expect(viewer.locator('video')).toBeHidden();
  await expect(viewer.locator('[data-gallery=folder]')).toBeVisible();
  await page.keyboard.press('Escape');
  // Un juego sin capturas explica cómo sacarlas.
  await openGame(page, 'steam:900006');
  await page.locator('#game-page [role=tab]', { hasText: 'Tus capturas' }).click();
  await expect(page.locator('#game-page [role=tabpanel]:not([hidden]) .capture-summary')).toContainText('F12');
});

test('novedades: seguir un juego desde la ficha, elegir qué entra, silenciarlo y verlo en la sección', async ({
  page
}) => {
  await openApp(page);
  await openGame(page, 'steam:900006');
  const follow = page.locator('#game-aside [data-action=follow]');
  await expect(follow).toHaveText('Seguir');
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await page.locator('#game-page [role=tab]', { hasText: 'Novedades' }).click();
  const panel = page.locator('#game-page [role=tabpanel]:not([hidden])');
  await expect(panel).toContainText('Seguí este juego');
  // Sin conexión (pruebas), seguir arma las fuentes que se conocen por la tienda: Steam y la versión instalada.
  await panel.locator('button', { hasText: 'Seguir' }).click();
  await expect(follow).toHaveText('Siguiendo');
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('.capture-summary')).toContainText('Todavía no hay novedades');
  await panel.locator('.news-sources summary').click();
  await expect(panel.locator('.news-source strong')).toHaveText(['Steam', 'Versión instalada']);
  // Destildar una fuente se guarda.
  await panel
    .locator('.news-source')
    .filter({ has: page.locator('strong', { hasText: /^Steam$/ }) })
    .locator('input')
    .uncheck();
  await expect(panel.locator('.news-sources summary')).toHaveText('Fuentes oficiales (0 activas)');
  // Qué entra: «Oficial y prensa» por defecto.
  await expect(panel.locator('.news-mode [aria-pressed=true]')).toHaveText('Oficial y prensa');
  await panel.locator('.news-mode button', { hasText: 'Solo oficial' }).click();
  await expect(panel.locator('.news-mode [aria-pressed=true]')).toHaveText('Solo oficial');
  await panel.locator('button', { hasText: 'Silenciar 30 días' }).click();
  await expect(panel.locator('.news-muted')).toContainText('Silenciado hasta');
  await expect(follow).toHaveText('Silenciado');
  // La sección Novedades lista los juegos que seguís.
  await page.locator('.nav-item[data-page=news]').click();
  await expect(page.locator('#news-game option')).toHaveCount(2);
  await expect(page.locator('#news-inbox')).toContainText('Sin novedades en los últimos 60 días');
  // «Buscar de nuevo» avisa qué pasó al terminar.
  await page.locator('#news-refresh').click();
  await expect(page.locator('#toasts')).toContainText('Sin novedades nuevas');
  await expect(page.locator('#news-refresh')).toHaveText('Buscar de nuevo');
  await expect(page.locator('#news-refresh')).toBeEnabled();
  // Configuración → Novedades: los medios en español vienen activados; los de inglés, no.
  await page.locator('.nav-item[data-page=settings]').click();
  await expect(page.locator('#news-settings [data-press=vandal]')).toBeChecked();
  await expect(page.locator('#news-settings [data-press=pcgamer]')).not.toBeChecked();
  await expect(page.locator('#news-settings [data-setting=offers]')).not.toBeChecked();
  await expect(page.locator('#news-settings [data-setting=mameReleases]')).toBeChecked();
  await expect(page.locator('#news-settings [data-setting=notify]')).not.toBeChecked();
  // La clave de la IA se valida antes de guardarla.
  await page.fill('#news-ai-key', 'no es una clave');
  await page.locator('.news-ai button[type=submit]').click();
  await expect(page.locator('#toasts')).toContainText('sk-ant-');
  // Dejar de seguir.
  await openGame(page, 'steam:900006');
  await page.locator('#game-page [role=tab]', { hasText: 'Novedades' }).click();
  await follow.click();
  await expect(follow).toHaveText('Seguir');
  await expect(panel).toContainText('Seguí este juego');
  // Arcade no tiene novedades: ni botón ni pestaña.
  await openGame(page, 'arcade:laber');
  await expect(page.locator('#game-aside [data-action=follow]')).toHaveCount(0);
  await expect(page.locator('#game-page [role=tab]', { hasText: 'Novedades' })).toHaveCount(0);
});

test('guía fase 1: enlaces, Acá estoy, notas con captura y Jugar con la guía', async ({ page }) => {
  await openApp(page);
  await openGame(page, 'steam:900000');
  await page.locator('#game-page [role=tab]', { hasText: 'Guía' }).click();
  const panel = page.locator('#game-page [role=tabpanel]:not([hidden])');
  await expect(panel.locator('.guide-link-row')).toHaveCount(5);
  await expect(panel.locator('.guide-links')).toContainText('GameFAQs');
  await expect(panel.locator('.guide-links')).toContainText('Guías de Steam');

  // Guardar «Acá estoy» y comprobar persistencia al recargar.
  await panel.locator('.guide-section-form input').fill('Capítulo 4 · El puente');
  await panel.locator('.guide-section-form button[type=submit]').click();
  await expect(panel.locator('.guide-progress-card .helper-text')).toContainText('Capítulo 4 · El puente');

  await openApp(page);
  await openGame(page, 'steam:900000');
  await page.locator('#game-page [role=tab]', { hasText: 'Guía' }).click();
  const reloaded = page.locator('#game-page [role=tabpanel]:not([hidden])');
  await expect(reloaded.locator('.guide-section-form input')).toHaveValue('Capítulo 4 · El puente');

  // Crear nota de partida adjuntando una captura real del juego.
  await reloaded.locator('.guide-note-form textarea').fill('Revisar la palanca roja antes de cruzar.');
  await reloaded.locator('.guide-note-form button', { hasText: 'Adjuntar captura' }).click();
  const firstPick = reloaded.locator('.guide-picker-item').first();
  await expect(firstPick).toBeVisible();
  await firstPick.click();
  await expect(reloaded.locator('.guide-selected-chip')).toHaveCount(1);
  await reloaded.locator('.guide-note-form button[type=submit]').click();

  const note = reloaded.locator('.guide-note-item').first();
  await expect(note).toContainText('Capítulo 4 · El puente');
  await expect(note).toContainText('Revisar la palanca roja antes de cruzar.');
  await expect(note.locator('.guide-capture-thumb')).toHaveCount(1);

  // La miniatura abre la galería ampliada.
  await note.locator('.guide-capture-thumb').click();
  await expect(page.locator('#media-viewer img')).toBeVisible();
  await page.keyboard.press('Escape');

  // Editar nota, borrarla y limpiar el tramo guardado para no afectar otras pruebas.
  await note.locator('button', { hasText: 'Editar' }).click();
  await note.locator('.guide-note-edit textarea').fill('Palanca roja activada.');
  await note.locator('.guide-note-edit button[type=submit]').click();
  await expect(note).toContainText('Palanca roja activada.');
  await note.locator('button', { hasText: 'Borrar' }).click();
  await expect(reloaded.locator('.guide-note-item')).toHaveCount(0);
  await reloaded.locator('.guide-section-form button', { hasText: 'Limpiar' }).click();
  await expect(reloaded.locator('.guide-section-form input')).toHaveValue('');

  // Arcade también tiene pestaña Guía (sin Guías de Steam).
  await openGame(page, 'arcade:laber');
  await page.locator('#game-page [role=tab]', { hasText: 'Guía' }).click();
  const arcadePanel = page.locator('#game-page [role=tabpanel]:not([hidden])');
  await expect(arcadePanel.locator('.guide-link-row')).toHaveCount(4);
  await expect(arcadePanel.locator('.guide-links')).toContainText('StrategyWiki');

  // Con dos monitores, Jugar ▾ ofrece «Jugar con la guía» en el monitor acompañante.
  const openCalls = [];
  await page.route('**/api/displays', (route) =>
    route.fulfill({
      json: {
        supported: true,
        identify: true,
        displays: [
          {
            id: '1',
            label: 'Odyssey G5',
            detected: 'Odyssey G5',
            alias: '',
            name: 'Odyssey G5',
            number: 1,
            primary: true,
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            games: 0
          },
          {
            id: '2',
            label: 'LG TV SSCR2',
            detected: 'LG TV SSCR2',
            alias: '',
            name: 'LG TV SSCR2',
            number: 2,
            primary: false,
            x: 1920,
            y: 0,
            width: 1920,
            height: 1080,
            games: 0
          }
        ],
        known: []
      }
    })
  );
  await page.route('**/api/guides/game/**/open', async (route) => {
    openCalls.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({
      json: {
        ok: true,
        opened: 'viewer',
        url: 'https://gamefaqs.gamespot.com',
        display: { id: '2', name: 'LG TV SSCR2' }
      }
    });
  });
  await openApp(page);
  await openGame(page, 'steam:900000');
  await page.locator('#game-aside [data-play-menu]').click();
  const playWithGuide = page.locator('#game-aside [data-play-guide]');
  await expect(playWithGuide).toContainText('Jugar con la guía');
  await expect(playWithGuide).toContainText('LG TV SSCR2');
  const [launchReq] = await Promise.all([page.waitForRequest(/\/api\/launch\//), playWithGuide.click()]);
  expect(decodeURIComponent(launchReq.url())).toContain('steam:900000');
  await expect.poll(() => openCalls.length).toBe(1);
  expect(openCalls[0].inactive).toBe(true);
  expect(openCalls[0].display?.id).toBe('2');
});

test('guía fase 2: importar archivo, lectura por tramos, antispoiler y filtro Con guía', async ({ page }) => {
  await openApp(page);
  await openGame(page, 'steam:900000');
  await page.locator('#game-page [role=tab]', { hasText: 'Guía' }).click();
  const panel = page.locator('#game-page [role=tabpanel]:not([hidden])');

  const faqText = [
    'Capítulo 1: El bosque',
    '======================',
    'Activá la palanca oculta detrás de la cascada.',
    '',
    'Capítulo 2: La torre',
    '====================',
    'Subí hasta el último piso con la llave plateada.',
    '',
    'Capítulo 3: El jefe final',
    '=========================',
    'Esquivá el ataque circular tres veces.'
  ].join('\n');

  await panel.locator('.guide-offline-card input[type=file]').setInputFiles({
    name: 'guia-ambar.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(faqText, 'utf8')
  });

  await expect(panel.locator('.guide-toc-item')).toHaveCount(3);
  await expect(panel.locator('.guide-attribution')).toContainText('guia-ambar.txt');

  // La primera vez abre en Pistas; pasamos a Solución confirmando para probar el lector completo.
  await expect(panel.locator('[data-guide-mode=hints]')).toHaveAttribute('aria-pressed', 'true');
  await panel.locator('[data-guide-mode=solution]').click();
  await panel.locator('.guide-confirm-inline button', { hasText: 'Ver solución completa' }).click();
  await expect(panel.locator('[data-guide-mode=solution]')).toHaveAttribute('aria-pressed', 'true');

  // Búsqueda dentro de la guía.
  await panel.locator('.guide-search-row input[type=search]').fill('palanca');
  await expect(panel.locator('.guide-search-row')).toContainText('1 coincidencia');
  await panel.locator('.guide-search-row input[type=search]').fill('');

  // Marcar tramo 1 como «Acá estoy» oculta los tramos futuros.
  await panel.locator('.guide-solution-actions button', { hasText: 'Marcar «Acá estoy» aquí' }).click();
  await expect(panel.locator('.guide-toc-item').nth(1)).toContainText('Tramo 2');
  await expect(panel.locator('.guide-toc-item').nth(1)).toContainText('Oculto');

  // Abrir Tramo 2 muestra la puerta antispoiler y permite revelarlo.
  await panel.locator('.guide-toc-item').nth(1).click();
  await expect(panel.locator('.guide-spoiler-gate')).toBeVisible();
  await panel.locator('.guide-spoiler-gate button', { hasText: 'Ver este tramo' }).click();
  await expect(panel.locator('.guide-solution-body')).toContainText('llave plateada');

  // Mostrar títulos futuros revela el nombre de Tramo 3 en el índice.
  await panel.locator('.guide-toc .guide-future-toggle input').check();
  await expect(panel.locator('.guide-toc-item').nth(2)).toContainText('Capítulo 3: El jefe final');

  // En Biblioteca: insignia de guía en la portada y filtro «Con guía».
  await show(page, 'library');
  await expect(page.locator('#library .poster[data-key="steam:900000"] .guide-poster-badge')).toBeVisible();
  await page.click('#toggle-filters');
  await page.click('#guides-only');
  await expect(page.locator('#library .poster')).toHaveCount(1);
  await expect(page.locator('#active-filters')).toContainText('Con guía');
  await page.click('#guides-only');
  await page.click('#toggle-filters');

  // Limpiar guía importada, volver a Pistas y quitar marca de tramo para dejar el fixture intacto.
  await openGame(page, 'steam:900000');
  await page.locator('#game-page [role=tab]', { hasText: 'Guía' }).click();
  await panel.locator('[data-guide-mode=hints]').click();
  await expect(panel.locator('[data-guide-mode=hints]')).toHaveAttribute('aria-pressed', 'true');
  await panel.locator('.guide-offline-actions button', { hasText: 'Quitar guía' }).click();
  await expect(panel.locator('.guide-reader')).toHaveCount(0);
  await panel.locator('.guide-section-form button', { hasText: 'Limpiar' }).click();
  await expect(panel.locator('.guide-section-form input')).toHaveValue('');
});

test('guía fase 3: modo Pistas por defecto, revelado paso a paso, editor manual e IA opcional', async ({ page }) => {
  await openApp(page);
  await openGame(page, 'steam:900006');
  await page.locator('#game-page [role=tab]', { hasText: 'Guía' }).click();
  const panel = page.locator('#game-page [role=tabpanel]:not([hidden])');

  await panel.locator('.guide-offline-card input[type=file]').setInputFiles({
    name: 'pistas-juego.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Sala del reloj\n==============\nGirá la aguja mayor hacia las doce y abrí el cofre.', 'utf8')
  });

  // Agregar pregunta manual con dos pistas y respuesta.
  await expect(panel.locator('[data-guide-mode=hints]')).toHaveAttribute('aria-pressed', 'true');
  await panel.locator('.guide-hints-toolbar button', { hasText: 'Agregar pregunta' }).click();
  const qForm = panel.locator('.guide-question-form');
  await qForm.locator('input').nth(0).fill('¿Cómo abro el cofre del reloj?');
  await qForm.locator('input').nth(1).fill('Mirá las agujas del reloj.');
  await qForm.locator('input').nth(2).fill('Poné la aguja mayor arriba de todo.');
  await qForm.locator('textarea').fill('Girá la aguja mayor hacia las doce y abrí el cofre.');
  await qForm.locator('button[type=submit]').click();

  const card = panel.locator('.guide-question-card').first();
  await expect(card).toContainText('¿Cómo abro el cofre del reloj?');
  await expect(card).toContainText('Manual');

  // Revelar pista 1 y pista 2, y comprobar persistencia al recargar.
  await card.locator('button', { hasText: 'Ver pista 1' }).click();
  await expect(card.locator('.guide-hint-list li')).toHaveCount(1);
  await card.locator('button', { hasText: 'Otra pista' }).click();
  await expect(card.locator('.guide-hint-list li')).toHaveCount(2);
  await card.locator('button', { hasText: 'Ver la respuesta' }).click();
  await card.locator('.guide-confirm-inline button', { hasText: 'Mostrar respuesta' }).click();
  await expect(card.locator('.guide-answer-box')).toContainText('doce');

  await openApp(page);
  await openGame(page, 'steam:900006');
  await page.locator('#game-page [role=tab]', { hasText: 'Guía' }).click();
  await expect(panel.locator('.guide-question-card .guide-answer-box')).toContainText('doce');

  // Editar pregunta manual.
  await panel.locator('.guide-question-card button', { hasText: 'Editar' }).click();
  await panel.locator('.guide-question-form input').nth(0).fill('¿Qué hago con el reloj?');
  await panel.locator('.guide-question-form button[type=submit]').click();
  await expect(panel.locator('.guide-question-card')).toContainText('¿Qué hago con el reloj?');

  // Limpiar guía importada para dejar el fixture intacto.
  await panel.locator('.guide-offline-actions button', { hasText: 'Quitar guía' }).click();
  await expect(panel.locator('.guide-reader')).toHaveCount(0);
});
