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
