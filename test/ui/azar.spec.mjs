import { expect, openApp, show, test } from './helpers.mjs';

for (const key of ['Enter', 'Space']) {
  test(`elegir al azar con ${key} abre la ficha sin jugar y conserva búsqueda y vista`, async ({ page }) => {
    const actions = [];
    page.on('request', (request) => {
      if (/\/api\/(launch|install)\//.test(request.url())) actions.push(request.url());
    });
    await openApp(page);
    await show(page, 'library');
    await page.locator('[data-view=explorer]').click();
    await page.locator('#search').fill('Glaciar II');
    await expect(page.locator('#library .tile')).toHaveCount(1);
    const random = page.getByRole('button', { name: 'Elegir al azar', exact: true });
    await random.focus();
    await random.press(key);
    await expect(page.locator('#game-title')).toHaveText('Glaciar II');
    await expect(page.locator('#game-title')).toBeFocused();
    expect(actions).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(random).toBeFocused();
    await expect(page.locator('#search')).toHaveValue('Glaciar II');
    await expect(page.locator('[data-view=explorer]')).toHaveAttribute('aria-pressed', 'true');
  });
}

test('sin resultados, cargando o con error no permite sortear y explica el motivo', async ({ page }) => {
  await openApp(page);
  await show(page, 'library');
  const random = page.locator('#random-game');
  await page.locator('#search').fill('zzzz-sin-coincidencias');
  await expect(random).toBeVisible();
  await expect(random).toBeDisabled();
  await expect(page.locator('#random-help')).toContainText('No hay resultados');
  await page.evaluate(async () => {
    GML.state.query = '';
    GML.state.loading = true;
    (await import('/js/library.js')).renderLibrary();
  });
  await expect(random).toBeDisabled();
  await expect(page.locator('#random-help')).toContainText('Cargando');
  await page.evaluate(async () => {
    GML.state.loading = false;
    GML.state.loadError = 'Error simulado';
    (await import('/js/library.js')).renderLibrary();
  });
  await expect(random).toBeDisabled();
  await expect(page.locator('#random-help')).toContainText('debe cargarse');
});

test('respeta la lista activa y favoritos sin perderlos al volver', async ({ page }) => {
  await openApp(page);
  await page.evaluate(async () => {
    GML.state.lists = [
      { id: 'lista-azar', name: 'Prueba de azar', kind: 'manual', games: ['steam:900000', 'epic games:prueba1'] }
    ];
    (await import('/js/lists.js')).openList('lista-azar');
  });
  await page.locator('#toggle-filters').click();
  await page.locator('#favorites-only').click();
  await expect(page.locator('#library .tile')).toHaveCount(1);
  await page.locator('#random-game').click();
  await expect(page.locator('#game-title')).toHaveText('Ámbar');
  await page.locator('#game-back').click();
  await expect(page.locator('#random-game')).toBeFocused();
  await expect(page.locator('#active-filters')).toContainText('Lista: Prueba de azar');
  await expect(page.locator('#favorites-only')).toHaveAttribute('aria-pressed', 'true');
});

test('respeta la colección Arcade y sólo elige sus resultados', async ({ page }) => {
  await openApp(page);
  await show(page, 'library');
  await page.locator('[data-collection=arcade]').click();
  await page.locator('#search').fill('Laberinto');
  await page.locator('#random-game').click();
  await expect(page.locator('#game-title')).toHaveText('Laberinto Hambriento');
  await page.locator('#game-back').click();
  await expect(page.locator('[data-collection=arcade]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#search')).toHaveValue('Laberinto');
});

test('elige también resultados que todavía no se dibujaron por lotes', async ({ page }) => {
  await openApp(page);
  await show(page, 'library');
  await page.evaluate(async () => {
    const base = GML.state.games[0];
    GML.state.games = Array.from({ length: 200 }, (_, i) => ({
      ...base,
      key: 'azar:' + i,
      id: String(900000 + i),
      name: 'Prueba ' + String(i).padStart(3, '0')
    }));
    Math.random = () => 0.999999;
    (await import('/js/library.js')).renderLibrary();
  });
  await expect(page.locator('#library .tile[data-key="azar:199"]')).toHaveCount(0);
  await page.locator('#random-game').click();
  await expect(page.locator('#game-title')).toHaveText('Prueba 199');
});

test('abrir desde una tarjeta sigue devolviendo el foco a esa tarjeta', async ({ page }) => {
  await openApp(page);
  await show(page, 'library');
  const first = page.locator('#library .tile').first();
  await first.focus();
  await first.press('Space');
  await expect(page.locator('#game-page')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(first).toBeFocused();
});

test('el título conserva el foco cuando carga el logo del juego', async ({ page }) => {
  await page.route('**/api/art/wordmark/**', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="0" y="40">Glaciar II</text></svg>'
    })
  );
  await openApp(page);
  await show(page, 'library');
  await page.evaluate(() => {
    GML.state.games.find((game) => game.name === 'Glaciar II').artwork.wordmark = true;
  });
  await page.locator('#search').fill('Glaciar II');
  await page.locator('#random-game').click();
  await expect(page.locator('#game-wordmark')).toBeVisible();
  await expect(page.locator('#game-title')).toHaveClass(/visually-hidden/);
  await expect(page.locator('#game-title')).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Glaciar II', exact: true })).toHaveCount(1);
});

test('si el resultado deja de cumplir favoritos, volver ofrece foco en la búsqueda', async ({ page }) => {
  await openApp(page);
  await show(page, 'library');
  await page.locator('#search').fill('Ámbar');
  await page.locator('#toggle-filters').click();
  await page.locator('#favorites-only').click();
  await page.locator('#random-game').click();
  await expect(page.locator('#game-title')).toHaveText('Ámbar');
  // Simula una actualización de la biblioteca mientras la ficha está abierta, sin escribir preferencias.
  await page.evaluate(async () => {
    GML.state.games.find((game) => game.key === 'steam:900000').favorite = false;
    (await import('/js/library.js')).renderLibrary();
  });
  await page.locator('#game-back').click();
  await expect(page.locator('#random-game')).toBeDisabled();
  await expect(page.locator('#search')).toBeFocused();
  await expect(page.locator('#search')).toHaveValue('Ámbar');
});

test('el sorteo respeta instalados y toda la cuenta y conserva ese alcance', async ({ page }) => {
  await openApp(page);
  await show(page, 'library');
  await page.evaluate(async () => {
    const base = GML.state.games[0];
    GML.state.games = [
      { ...base, key: 'azar:local', name: 'A local', installed: true },
      { ...base, key: 'azar:cuenta', name: 'Z cuenta', installed: false, launch: null, status: 'not-installed' }
    ];
    GML.state.installation = 'installed';
    Math.random = () => 0.999999;
    const library = await import('/js/library.js');
    library.renderScope();
    library.renderLibrary();
  });
  await page.locator('#random-game').click();
  await expect(page.locator('#game-title')).toHaveText('A local');
  await page.locator('#game-back').click();
  await expect(page.locator('[data-scope=installed]')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('[data-scope=""]').click();
  await page.locator('#random-game').click();
  await expect(page.locator('#game-title')).toHaveText('Z cuenta');
  await page.locator('#game-back').click();
  await expect(page.locator('[data-scope=""]')).toHaveAttribute('aria-pressed', 'true');
});
