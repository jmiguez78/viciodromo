// Novedades de los juegos que seguís (ver news.mjs): resumen para las portadas, la bandeja, la pestaña de cada juego,
// seguir y dejar de seguir, modo, silencio, fuentes, ajustes y consultas.
import { badRequest, check, notFound } from '../http.mjs';
import { MODES, MUTE_DAYS } from '../news.mjs';

const ITEM_ID = /^[\w:.-]{1,80}$/;
const SOURCE_ID = /^[\w-]{1,40}$/;
const TYPES = ['update', 'content', 'announcement', 'event', 'press', 'community', 'offer'];

export function newsRoutes(router, d) {
  router.get('/api/news', () => d.news.summary());
  router.post('/api/news/refresh', () => d.news.refresh());
  router.get('/api/news/inbox', ({ query }) => {
    const type = query.get('type');
    if (type && !TYPES.includes(type)) throw badRequest('Tipo de novedad no válido.');
    return d.news.inbox({ type: type || null, key: query.get('game') || null });
  });
  router.post('/api/news/read-all', () => d.news.markAllRead());
  router.get('/api/news/settings', () => d.news.settings());
  router.put('/api/news/settings', async ({ body }) => {
    const { press, offers, autoFollow, mameReleases } = await body();
    if (press !== undefined && (typeof press !== 'object' || press === null || Array.isArray(press)))
      throw badRequest('Los medios van como { id: true/false }.');
    return d.news.saveSettings({
      press,
      offers: offers === undefined ? undefined : check.boolean(offers, 'Indicá si se muestran las ofertas.'),
      autoFollow:
        autoFollow === undefined ? undefined : check.boolean(autoFollow, 'Indicá si se siguen los juegos solos.'),
      mameReleases:
        mameReleases === undefined
          ? undefined
          : check.boolean(mameReleases, 'Indicá si se avisan las versiones nuevas de MAME.')
    });
  });
  router.get('/api/news/game/:key', ({ params }) => d.news.forGame(params.key));
  router.post('/api/news/game/:key/follow', async ({ params }) => {
    const game = await d.findGame(params.key);
    if (!game) throw notFound('Juego no encontrado.');
    if (game.platform === 'Arcade') throw badRequest('Los juegos de Arcade no tienen novedades.');
    return d.news.follow(game);
  });
  router.delete('/api/news/game/:key/follow', ({ params }) => d.news.unfollow(params.key));
  router.post('/api/news/game/:key/refresh', async ({ params }) => {
    await d.news.refresh({ only: params.key });
    return d.news.forGame(params.key);
  });
  router.post('/api/news/game/:key/read', ({ params }) => d.news.markRead(params.key));
  router.put('/api/news/game/:key/mode', async ({ params, body }) => {
    const { mode } = await body();
    return d.news.setMode(params.key, check.oneOf(mode, MODES, 'Elegí qué novedades entran.'));
  });
  router.post('/api/news/game/:key/mute', async ({ params, body }) => {
    const { days = MUTE_DAYS } = await body();
    if (!Number.isInteger(days) || days < 0 || days > 365) throw badRequest('Indicá por cuántos días.');
    return d.news.mute(params.key, days);
  });
  router.post('/api/news/game/:key/items/:id/hide', ({ params }) => {
    if (!ITEM_ID.test(params.id)) throw badRequest('Novedad no válida.');
    return d.news.hide(params.key, params.id);
  });
  router.put('/api/news/game/:key/sources/:id', async ({ params, body }) => {
    if (!SOURCE_ID.test(params.id)) throw badRequest('Fuente no válida.');
    const { enabled } = await body();
    return d.news.setSource(params.key, params.id, check.boolean(enabled, 'Indicá si la fuente queda activa.'));
  });
  router.post('/api/news/game/:key/sources', async ({ params, body }) => {
    const { url } = await body();
    return d.news.addSource(params.key, check.string(url, 'Pegá el enlace de la fuente.', { max: 500 }));
  });
}
