// Rutas HTTP para guías de pistas y soluciones (Fases 1 y 2): enlaces, progreso («Acá estoy»), notas,
// StrategyWiki, importación de archivos y visor auxiliar.
import { badGateway, badRequest, notFound, withStatus } from '../http.mjs';
import { guideLinksFor, safeGuideUrl } from '../guide-sources/links.mjs';

const NOTE_ID = /^[\w-]{1,64}$/;
const GUIDE_ID = /^[a-z0-9][a-z0-9_-]{1,80}$/i;
const SECTION_ID = /^[\w-]{1,40}$/;

export function guidesRoutes(router, d) {
  router.get('/api/guides', () => d.guides.summary());

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
    for (const field of [
      'activeGuideId',
      'currentSectionId',
      'currentSection',
      'mode',
      'lastUrl',
      'showFutureTitles',
      'skipSpoilerConfirm',
      'revealSectionId',
      'resetRevealed'
    ]) {
      if (field in payload) patch[field] = payload[field];
    }
    if (!Object.keys(patch).length) throw badRequest('No hay cambios de progreso para guardar.');
    return { progress: await d.guides.updateProgress(game.key, patch) };
  });

  router.post('/api/guides/game/:key/strategywiki/search', async ({ params }) => {
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    try {
      return await d.guides.searchStrategyWikiForGame(game);
    } catch (error) {
      throw badGateway(error.message);
    }
  });

  router.post('/api/guides/game/:key/strategywiki/download', async ({ params, body }) => {
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    const pageTitle =
      typeof payload.pageTitle === 'string' && payload.pageTitle.trim() ? payload.pageTitle.trim() : null;
    try {
      const result = await d.guides.downloadStrategyWiki(game, { pageTitle });
      return withStatus(201, result);
    } catch (error) {
      throw badGateway(error.message);
    }
  });

  router.post('/api/guides/game/:key/import', async ({ params, body }) => {
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    if (typeof payload.filename !== 'string' || !payload.filename.trim()) {
      throw badRequest('Falta el nombre del archivo.');
    }
    if (typeof payload.content !== 'string') {
      throw badRequest('Falta el contenido del archivo.');
    }
    const result = await d.guides.importFile(game, {
      filename: payload.filename,
      content: payload.content,
      title: typeof payload.title === 'string' ? payload.title : ''
    });
    return withStatus(201, result);
  });

  router.delete('/api/guides/game/:key/items/:id', async ({ params }) => {
    if (!GUIDE_ID.test(params.id)) throw badRequest('Guía no válida.');
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    await d.guides.deleteGuide(game.key, params.id);
    return withStatus(204);
  });

  router.put('/api/guides/game/:key/items/:id/sections/:sectionId', async ({ params, body }) => {
    if (!GUIDE_ID.test(params.id)) throw badRequest('Guía no válida.');
    if (!SECTION_ID.test(params.sectionId)) throw badRequest('Tramo no válido.');
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    const sections = await d.guides.editSection(game.key, params.id, params.sectionId, {
      title: payload.title,
      mergeWithPrevious: payload.mergeWithPrevious === true
    });
    return { sections };
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
