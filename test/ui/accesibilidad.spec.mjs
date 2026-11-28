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
    test('Guía en la ficha del juego', async ({ page }) => {
      await page.route('**/api/guides/game/**', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              json: {
                key: 'steam:900000',
                name: 'Ámbar',
                links: [
                  {
                    id: 'gamefaqs',
                    label: 'GameFAQs',
                    description: 'El catálogo más grande de guías y preguntas frecuentes.',
                    url: 'https://gamefaqs.gamespot.com/search?game=%C3%81mbar',
                    kind: 'link'
                  }
                ],
                progress: {
                  currentSection: 'Capítulo 4',
                  currentSectionId: 's01',
                  activeGuideId: 'file-a11y',
                  mode: 'hints',
                  lastUrl: null,
                  showFutureTitles: false,
                  skipSpoilerConfirm: false,
                  revealedSections: [],
                  updatedAt: null
                },
                guides: [
                  {
                    id: 'file-a11y',
                    gameKey: 'steam:900000',
                    title: 'Guía de prueba',
                    source: { type: 'file', filename: 'guia.txt', license: 'Uso personal' }
                  }
                ],
                activeGuide: {
                  id: 'file-a11y',
                  gameKey: 'steam:900000',
                  title: 'Guía de prueba',
                  source: { type: 'file', filename: 'guia.txt', license: 'Uso personal' },
                  sections: [
                    {
                      id: 's01',
                      order: 1,
                      displayTitle: 'Capítulo 4',
                      solution: 'Buscá la **llave** en el cofre.',
                      questions: [
                        {
                          id: 'q1',
                          title: '¿Cómo abro el cofre?',
                          origin: 'ai',
                          edited: false,
                          totalHints: 2,
                          revealedCount: 1,
                          visibleHints: ['Mirá detrás de la columna.'],
                          answerRevealed: false,
                          answerQuote: ''
                        }
                      ],
                      isFuture: false,
                      locked: false
                    },
                    {
                      id: 's02',
                      order: 2,
                      displayTitle: 'Tramo 2',
                      solution: '',
                      questions: [],
                      isFuture: true,
                      locked: true
                    }
                  ]
                },
                ai: { configured: true, source: 'guides', model: 'claude-haiku-5-5' },
                hintsEstimate: { sections: 2, inputTokens: 400, outputTokens: 900, estimatedUsd: 0.0039 },
                notes: [
                  {
                    id: 'n-test',
                    section: 'Capítulo 4',
                    text: 'Nota de prueba para auditoría de accesibilidad.',
                    captures: [],
                    updatedAt: '2026-11-28T12:00:00.000Z'
                  }
                ],
                viewerSupported: true,
                companionDisplay: { id: '2', name: 'LG TV', number: 2, primary: false }
              }
            })
          : route.continue()
      );
      await openApp(page);
      await openGame(page, 'steam:900000');
      await page.locator('#game-page [role=tab]', { hasText: 'Guía' }).click();
      await page.waitForSelector('#game-page .guide-note-item');
      expect(await audit(page)).toEqual([]);
    });
    test('Guía flotante', async ({ page }) => {
      await page.route('**/api/guides/game/**', (route) =>
        route.request().method() === 'GET'
          ? route.fulfill({
              json: {
                key: 'steam:900000',
                name: 'Ámbar',
                links: [],
                progress: {
                  currentSection: 'Capítulo 4',
                  currentSectionId: 's01',
                  activeGuideId: 'file-a11y',
                  mode: 'hints',
                  lastUrl: null,
                  showFutureTitles: false,
                  skipSpoilerConfirm: false,
                  revealedSections: [],
                  updatedAt: null
                },
                guides: [],
                activeGuide: {
                  id: 'file-a11y',
                  gameKey: 'steam:900000',
                  title: 'Guía flotante',
                  sections: [
                    {
                      id: 's01',
                      order: 1,
                      displayTitle: 'Capítulo 4',
                      solution: 'Texto de solución.',
                      questions: [
                        {
                          id: 'q1',
                          title: '¿Cómo abro el cofre?',
                          origin: 'manual',
                          edited: false,
                          totalHints: 2,
                          revealedCount: 1,
                          visibleHints: ['Mirá detrás de la columna.'],
                          answerRevealed: false,
                          answerQuote: ''
                        }
                      ],
                      isFuture: false,
                      locked: false
                    }
                  ]
                },
                notes: []
              }
            })
          : route.continue()
      );
      await page.goto('/guide-overlay.html?key=steam%3A900000');
      await page.waitForSelector('.guide-overlay-head h1');
      if (theme === 'light') {
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'light';
        });
      }
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
