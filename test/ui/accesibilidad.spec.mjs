// Auditoría automática de accesibilidad (WCAG 2.1 AA, incluido el contraste) en las pantallas principales.
import AxeBuilder from '@axe-core/playwright';
import { expect, openApp, openGame, show, test } from './helpers.mjs';

async function audit(page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const serious = result.violations.filter((item) => ['serious', 'critical'].includes(item.impact));
  return serious.map((item) => `${item.id}: ${item.nodes.length} elementos (${item.nodes[0]?.target.join(' ')})`);
}

for (const theme of ['dark', 'light']) {
  test.describe(`tema ${theme === 'dark' ? 'oscuro' : 'claro'}`, () => {
    test.use({ colorScheme: theme });
    test.beforeEach(async ({ page }) => {
      await page.route('**/api/settings', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({ contentType: 'application/json', body: JSON.stringify({ theme, minimizeOnLaunch: false }) })
          : route.continue()
      );
    });
    test('Inicio', async ({ page }) => {
      await openApp(page);
      expect(await audit(page)).toEqual([]);
    });
    test('Biblioteca con filtros', async ({ page }) => {
      await openApp(page);
      await show(page, 'library');
      await page.click('#toggle-filters');
      expect(await audit(page)).toEqual([]);
    });
    test('página del juego', async ({ page }) => {
      await openApp(page);
      await openGame(page, 'steam:900000');
      expect(await audit(page)).toEqual([]);
    });
    test('Configuración', async ({ page }) => {
      await openApp(page);
      await show(page, 'settings');
      expect(await audit(page)).toEqual([]);
    });
    test('Novedades: sección y pestaña del juego', async ({ page }) => {
      const item = (id, type, unread) => ({
        id,
        type,
        layer: type === 'press' ? 'press' : 'official',
        unread,
        title: 'Título de prueba ' + id,
        url: 'https://example.com/' + id,
        date: '2026-11-27T12:00:00.000Z',
        text: 'Un extracto de la novedad.',
        sourceLabel: 'Steam',
        image: null,
        also: [{ sourceLabel: 'Vandal', url: 'https://example.com/v' }],
        game: { key: 'steam:900000', name: 'Ámbar' }
      });
      const items = [item('a', 'press', true), item('b', 'update', false), item('c', 'content', false)];
      await page.route('**/api/news/inbox**', (route) =>
        route.fulfill({
          json: {
            items,
            total: 3,
            types: ['press', 'update', 'content'],
            follows: [{ key: 'steam:900000', name: 'Ámbar', unread: 1 }],
            unread: 1,
            refreshedAt: null
          }
        })
      );
      await page.route('**/api/news/game/**', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              json: {
                key: 'steam:900000',
                followed: true,
                mode: 'press',
                mutedUntil: null,
                checkedAt: null,
                sources: [{ id: 'steam', kind: 'steam', label: 'Steam', enabled: true, status: 'error' }],
                items,
                unread: 0
              }
            })
          : route.continue()
      );
      await openApp(page);
      await show(page, 'news');
      await page.waitForSelector('#news-inbox .news-item');
      expect(await audit(page)).toEqual([]);
      await openGame(page, 'steam:900000');
      await page.locator('#game-page [role=tab]', { hasText: 'Novedades' }).click();
      await page.locator('#game-page .news-sources summary').click();
      expect(await audit(page)).toEqual([]);
    });
    test('Tu actividad', async ({ page }) => {
      await openApp(page);
      await show(page, 'activity');
      await page.waitForSelector('#activity-recent li');
      expect(await audit(page)).toEqual([]);
    });
    test('Primeros pasos y listas', async ({ page }) => {
      await page.route('**/api/onboarding', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), dismissed: false } });
      });
      await openApp(page);
      await page.waitForSelector('#onboarding:not([hidden]) .onboarding-step');
      expect(await audit(page)).toEqual([]);
      await show(page, 'library');
      await page.click('#open-lists');
      expect(await audit(page)).toEqual([]);
    });
    test('error al cargar la biblioteca', async ({ page }) => {
      await page.route('**/api/library', (route) =>
        route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Falla de prueba."}' })
      );
      await page.goto('/');
      await show(page, 'library');
      await page.waitForSelector('#library-state:not(.hidden)');
      expect(await audit(page)).toEqual([]);
    });
  });
}
