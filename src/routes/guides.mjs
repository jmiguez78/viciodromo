// Rutas HTTP para guías de pistas y soluciones (Fase 1): enlaces, progreso («Acá estoy»), notas y visor auxiliar.
import { badRequest, notFound, withStatus } from '../http.mjs';
import { guideLinksFor, safeGuideUrl } from '../guide-sources/links.mjs';

const NOTE_ID = /^[\w-]{1,64}$/;

export function guidesRoutes(router, d) {
  router.get('/api/guides/game/:key', async ({ params }) => {
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const companion = await d.companionDisplayFor(game);
    return d.guides.forGame(game, { viewerSupported: d.guideViewerSupported, companion });
  });

  router.put('/api/guides/game/:key/progress', async ({ params, body }) => {
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    const patch = {};
    if ('currentSection' in payload) patch.currentSection = payload.currentSection;
    if ('mode' in payload) patch.mode = payload.mode;
    if ('lastUrl' in payload) patch.lastUrl = payload.lastUrl;
    if (!Object.keys(patch).length) throw badRequest('No hay cambios de progreso para guardar.');
    return { progress: await d.guides.updateProgress(game.key, patch) };
  });

  router.post('/api/guides/game/:key/notes', async ({ params, body }) => {
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    const note = await d.guides.addNote(game.key, {
      section: payload.section ?? '',
      text: payload.text ?? '',
      captures: payload.captures ?? []
    });
    return withStatus(201, note);
  });

  router.put('/api/guides/game/:key/notes/:id', async ({ params, body }) => {
    if (!NOTE_ID.test(params.id)) throw badRequest('Nota no válida.');
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    const patch = {};
    if ('section' in payload) patch.section = payload.section;
    if ('text' in payload) patch.text = payload.text;
    if ('captures' in payload) patch.captures = payload.captures;
    return d.guides.updateNote(game.key, params.id, patch);
  });

  router.delete('/api/guides/game/:key/notes/:id', async ({ params }) => {
    if (!NOTE_ID.test(params.id)) throw badRequest('Nota no válida.');
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    await d.guides.deleteNote(game.key, params.id);
    return withStatus(204);
  });

  router.post('/api/guides/game/:key/open', async ({ params, body }) => {
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    let targetUrl = payload.url ? safeGuideUrl(payload.url) : null;
    if (payload.url && !targetUrl) throw badRequest('El enlace de la guía debe empezar con https://.');
    if (!targetUrl) {
      const state = await d.guides.forGame(game);
      targetUrl = state.progress.lastUrl ?? guideLinksFor(game)[0]?.url ?? null;
    }
    if (!targetUrl) throw badRequest('No hay un enlace de guía disponible para este juego.');
    await d.guides.rememberOpened(game.key, targetUrl);
    return d.openGuide({
      game,
      url: targetUrl,
      display: payload.display ?? null,
      inactive: payload.inactive === true
    });
  });
}
