// Rutas HTTP para guías de pistas y soluciones (Fases 1 a 4): enlaces, progreso («Acá estoy» y pistas vistas),
// notas, StrategyWiki, importación de archivos, editor manual de preguntas, IA opcional, visor auxiliar,
// ventana flotante siempre visible, atajos globales y micro-servidor LAN por código QR.
import { badGateway, badRequest, check, notFound, withStatus } from '../http.mjs';
import { guideLinksFor, safeGuideUrl } from '../guide-sources/links.mjs';

const NOTE_ID = /^[\w-]{1,64}$/;
const GUIDE_ID = /^[a-z0-9][a-z0-9_-]{1,80}$/i;
const SECTION_ID = /^[\w-]{1,40}$/;
const QUESTION_ID = /^[\w-]{1,40}$/;

export function guidesRoutes(router, d) {
  router.get('/api/guides', () => d.guides.summary());

  router.get('/api/guides/companion', () => d.guideCompanion.status());
  router.put('/api/guides/companion/settings', async ({ body }) => d.guideCompanion.updateSettings(await body()));
  router.post('/api/guides/companion/next-hint', async ({ body }) => d.guideCompanion.nextHint(await body()));
  router.delete('/api/guides/overlay', () => d.guideCompanion.closeOverlay());

  router.get('/api/guides/lan', () => d.guideLan.status());
  router.post('/api/guides/lan/start', async ({ body }) => {
    const payload = await body();
    const key = check.string(payload.key, 'Falta indicar el juego.', { max: 200 });
    const game = await d.findGame(key);
    if (!game) throw notFound('Juego no encontrado.');
    return withStatus(201, await d.guideLan.start(game.key));
  });
  router.post('/api/guides/lan/stop', () => d.guideLan.stop());

  router.post('/api/guides/game/:key/overlay', async ({ params, body }) => {
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    return d.guideCompanion.openOverlay(game, {
      inactive: payload.inactive === true,
      toggle: payload.toggle === true
    });
  });

  router.get('/api/guides/ai', () => d.ai.status());
  router.put('/api/guides/ai', async ({ body }) => {
    const { key } = await body();
    return d.ai.setKey(check.string(key, 'Pegá tu clave de API de Anthropic.', { max: 300 }));
  });
  router.delete('/api/guides/ai', () => d.ai.setKey(null));

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
      'resetRevealed',
      'setHintCount',
      'revealAnswer',
      'hideQuestion'
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

  router.get('/api/guides/game/:key/items/:id/sections/:sectionId/questions/:qid', async ({ params }) => {
    if (!GUIDE_ID.test(params.id) || !SECTION_ID.test(params.sectionId) || !QUESTION_ID.test(params.qid)) {
      throw badRequest('Pregunta no válida.');
    }
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    return d.guides.getQuestion(game.key, params.id, params.sectionId, params.qid);
  });

  router.post('/api/guides/game/:key/items/:id/sections/:sectionId/questions', async ({ params, body }) => {
    if (!GUIDE_ID.test(params.id) || !SECTION_ID.test(params.sectionId)) throw badRequest('Tramo no válido.');
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    const created = await d.guides.addQuestion(game.key, params.id, params.sectionId, payload);
    return withStatus(201, created);
  });

  router.put('/api/guides/game/:key/items/:id/sections/:sectionId/questions/:qid', async ({ params, body }) => {
    if (!GUIDE_ID.test(params.id) || !SECTION_ID.test(params.sectionId) || !QUESTION_ID.test(params.qid)) {
      throw badRequest('Pregunta no válida.');
    }
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    return d.guides.updateQuestion(game.key, params.id, params.sectionId, params.qid, await body());
  });

  router.delete('/api/guides/game/:key/items/:id/sections/:sectionId/questions/:qid', async ({ params }) => {
    if (!GUIDE_ID.test(params.id) || !SECTION_ID.test(params.sectionId) || !QUESTION_ID.test(params.qid)) {
      throw badRequest('Pregunta no válida.');
    }
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    await d.guides.deleteQuestion(game.key, params.id, params.sectionId, params.qid);
    return withStatus(204);
  });

  router.post('/api/guides/game/:key/items/:id/sections/:sectionId/hints/generate', async ({ params }) => {
    if (!GUIDE_ID.test(params.id) || !SECTION_ID.test(params.sectionId)) throw badRequest('Tramo no válido.');
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const questions = await d.guides.generateHints(game, params.id, params.sectionId);
    return withStatus(201, { questions });
  });

  router.post('/api/guides/game/:key/items/:id/sections/:sectionId/translate', async ({ params }) => {
    if (!GUIDE_ID.test(params.id) || !SECTION_ID.test(params.sectionId)) throw badRequest('Tramo no válido.');
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    return d.guides.translateGuideSection(game, params.id, params.sectionId);
  });

  router.post('/api/guides/game/:key/items/:id/ask', async ({ params, body }) => {
    if (!GUIDE_ID.test(params.id)) throw badRequest('Guía no válida.');
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    const payload = await body();
    return d.guides.askGuide(game, params.id, {
      sectionId: typeof payload.sectionId === 'string' ? payload.sectionId : null,
      question: payload.question ?? '',
      revealAnswer: payload.revealAnswer === true
    });
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
