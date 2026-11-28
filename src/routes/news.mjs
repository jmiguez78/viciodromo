// Novedades de los juegos que seguís (ver news.mjs): resumen para las tarjetas, la pestaña de cada juego, seguir y
// dejar de seguir, fuentes y consultas.
import { badRequest, check, notFound } from '../http.mjs';

const ITEM_ID = /^[\w:.-]{1,80}$/;
const SOURCE_ID = /^[\w-]{1,40}$/;

export function newsRoutes(router, d) {
  router.get('/api/news', () => d.news.summary());
  router.post('/api/news/refresh', () => d.news.refresh());
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
