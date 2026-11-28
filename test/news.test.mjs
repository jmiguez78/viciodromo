import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blueskyHandle, createNews, modeOf, parseSteamBuild, sourcesFor } from '../src/news.mjs';

const silksong = {
  key: 'steam:1030300',
  platform: 'Steam',
  id: '1030300',
  name: 'Hollow Knight: Silksong',
  location: 'C:\\Steam\\steamapps\\common\\Hollow Knight Silksong'
};
const anno = { key: 'ubisoft connect:4553', platform: 'Ubisoft Connect', id: '4553', name: 'Anno 1800' };

const entity = {
  claims: {
    P31: [{ mainsnak: { datavalue: { value: { id: 'Q7889' } } } }],
    P1733: [{ mainsnak: { datavalue: { value: '1030300' } } }],
    P856: [{ mainsnak: { datavalue: { value: 'https://www.teamcherry.com.au/' } } }],
    P2397: [{ mainsnak: { datavalue: { value: 'UCabcdefghijklmnopqrstuv' } } }],
    P553: [
      {
        mainsnak: { datavalue: { value: { id: 'Q78194383' } } },
        qualifiers: { P554: [{ datavalue: { value: 'teamcherry.bsky.social' } }] }
      }
    ],
    P178: [{ mainsnak: { datavalue: { value: { id: 'Q20109040' } } } }]
  },
  labels: { en: { value: 'Hollow Knight: Silksong' }, es: { value: 'Hollow Knight: Silksong' } },
  aliases: { en: [{ value: 'Silksong' }] }
};

const day = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-28T12:00:00Z');
const rss = (items) =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${items
    .map(
      ([title, date, link]) =>
        `<item><title>${title}</title><link>${link}</link><guid>${link}</guid><pubDate>${new Date(date).toUTCString()}</pubDate><description>${title}</description></item>`
    )
    .join('')}</channel></rss>`;

function fakeWeb(overrides = {}) {
  const calls = [];
  const pages = {
    'list=search': { query: { search: [{ title: 'Q55616513' }] } },
    'ids=Q55616513': { entities: { Q55616513: entity } },
    'ids=Q20109040': { entities: { Q20109040: { labels: { en: { value: 'Team Cherry' } } } } },
    'teamcherry.com.au/':
      '<html><head><link rel="alternate" type="application/rss+xml" href="/blog/feed"></head></html>',
    'teamcherry.com.au/blog/feed': rss([
      ['Silksong 1.1 roadmap', NOW - 2 * day, 'https://www.teamcherry.com.au/blog/roadmap']
    ]),
    'bsky.app/profile/teamcherry.bsky.social/rss': rss([
      ['Patch 1.0.2 is live', NOW - 3 * day, 'https://bsky.app/profile/teamcherry.bsky.social/post/1']
    ]),
    'feeds/videos.xml': rss([['Silksong 1.1 roadmap', NOW - 2 * day, 'https://www.youtube.com/watch?v=1']]),
    GetNewsForApp: {
      appnews: {
        newsitems: Array.from({ length: 8 }, (_, index) => ({
          gid: String(index),
          title: 'Hotfix 1.0.' + index,
          url: 'https://store.steampowered.com/news/' + index,
          contents: 'Fixes',
          feed_type: 1,
          date: Math.round((NOW - (10 + index) * day) / 1000),
          tags: ['patchnotes']
        }))
      }
    },
    '3djuegos.com': rss([
      ['Hollow Knight Silksong vende 5 millones', NOW - 1 * day, 'https://www.3djuegos.com/silksong'],
      ['Otro juego cualquiera', NOW - 1 * day, 'https://www.3djuegos.com/otro']
    ]),
    'vandal.elespanol.com': rss([
      ['Hollow Knight: Silksong vende 5 millones', NOW - 1 * day, 'https://vandal.elespanol.com/x']
    ]),
    ...overrides
  };
  const fetchImpl = async (url) => {
    calls.push(url);
    const key = Object.keys(pages)
      .sort((a, b) => b.length - a.length)
      .find((part) => url.includes(part));
    if (!key) return { ok: false, status: 404, url, text: async () => '' };
    const body = pages[key];
    return { ok: true, status: 200, url, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { fetchImpl, calls, pages };
}

async function setup(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gml-news-'));
  let clock = NOW;
  const web = fakeWeb(options.pages);
  let build = { buildid: '100', updatedAt: '2026-11-20T00:00:00.000Z' };
  const news = createNews({
    dataDir,
    games: async () => [silksong, anno],
    fetchImpl: web.fetchImpl,
    now: () => clock,
    pauseMs: 0,
    steamBuild: async (game) => (game.platform === 'Steam' ? build : null)
  });
  return {
    news,
    web,
    dataDir,
    advance: (ms) => (clock += ms),
    setBuild: (value) => (build = value)
  };
}

test('sourcesFor arma las fuentes del juego desde Wikidata y su tienda', () => {
  assert.equal(blueskyHandle(entity), 'teamcherry.bsky.social');
  const sources = sourcesFor(silksong, entity);
  assert.deepEqual(
    sources.map((source) => source.id),
    ['steam', 'site', 'bluesky', 'youtube', 'local']
  );
  assert.equal(
    sources.find((s) => s.id === 'youtube').url,
    'https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv'
  );
  // Un juego de otra tienda también llega a las noticias de Steam si Wikidata conoce su ficha.
  assert.deepEqual(
    sourcesFor(anno, entity).map((source) => source.id),
    ['steam', 'site', 'bluesky', 'youtube']
  );
  assert.deepEqual(sourcesFor(anno, null), []);
  // Antes de la 0.42 la prensa era una fuente: destildada equivale a «sólo oficial».
  assert.equal(modeOf({ sources: [{ kind: 'press', enabled: false }] }), 'official');
  assert.equal(modeOf({ sources: [] }), 'press');
  assert.equal(modeOf({ mode: 'all' }), 'all');
});

test('parseSteamBuild lee la versión instalada del manifiesto de Steam', () => {
  assert.deepEqual(parseSteamBuild('"AppState"\n{\n\t"buildid"\t\t"20831105"\n\t"LastUpdated"\t\t"1764000000"\n}'), {
    buildid: '20831105',
    updatedAt: '2025-11-24T16:00:00.000Z'
  });
  assert.equal(parseSteamBuild('sin datos'), null);
});

test('seguir un juego descubre sus fuentes y trae sólo las últimas cinco novedades, ya leídas', async () => {
  const { news, web } = await setup();
  const data = await news.follow(silksong);
  assert.equal(data.followed, true);
  assert.equal(data.wikidata, 'Q55616513');
  assert.ok(web.calls.some((url) => url.includes('haswbstatement%3AP1733%3D1030300')));
  assert.equal(data.items.length, 5);
  // La prensa sumó la nota que nombra el juego, una sola vez aunque la publicaron dos medios; YouTube repetía el
  // título del blog y tampoco se duplica.
  const titles = data.items.map((item) => item.title);
  assert.equal(titles.filter((title) => /5 millones/.test(title)).length, 1);
  assert.equal(titles.filter((title) => /roadmap/.test(title)).length, 1);
  assert.ok(!titles.includes('Otro juego cualquiera'));
  // La misma historia en otro medio o canal queda como «también en».
  assert.equal(data.items.find((item) => /5 millones/.test(item.title)).also.length, 1);
  assert.equal(data.items.find((item) => /roadmap/.test(item.title)).also.length, 1);
  assert.deepEqual(
    data.items.map((item) => item.type),
    ['press', 'announcement', 'update', 'update', 'update']
  );
  assert.equal(data.unread, 0);
  assert.equal(data.sources.find((source) => source.id === 'site').status, 'ok');
  assert.deepEqual((await news.summary()).follows, [silksong.key]);
});

test('una consulta posterior suma sólo lo nuevo, lo marca sin leer y avisa si Steam cambió la versión', async () => {
  const { news, web, advance, setBuild } = await setup();
  await news.follow(silksong);
  advance(6 * 60 * 60 * 1000);
  web.pages['bsky.app/profile/teamcherry.bsky.social/rss'] = rss([
    ['Patch 1.0.3 is live', NOW + 60 * 60 * 1000, 'https://bsky.app/profile/teamcherry.bsky.social/post/2'],
    ['Patch 1.0.2 is live', NOW - 3 * day, 'https://bsky.app/profile/teamcherry.bsky.social/post/1']
  ]);
  setBuild({ buildid: '101', updatedAt: '2026-11-28T13:00:00.000Z' });
  const summary = await news.refresh();
  assert.deepEqual(summary.unread, { [silksong.key]: 2 });
  const data = await news.forGame(silksong.key);
  const fresh = data.items.filter((item) => item.unread);
  assert.deepEqual(
    fresh.map((item) => item.id).sort(),
    ['local:101', fresh.find((i) => i.layer === 'official').id].sort()
  );
  assert.equal(fresh.find((item) => item.layer === 'local').text, 'Versión 101 (antes 100).');
  await news.markRead(silksong.key);
  assert.deepEqual((await news.summary()).unread, {});
});

test('fuentes y modo: destildar una fuente o elegir «sólo oficial» dejan de consultarlas; ocultar y dejar de seguir', async () => {
  const { news, web } = await setup();
  const first = await news.follow(silksong);
  await news.setSource(silksong.key, 'youtube', false);
  const official = await news.setMode(silksong.key, 'official');
  assert.equal(official.mode, 'official');
  web.calls.length = 0;
  await news.refresh();
  assert.ok(!web.calls.some((url) => url.includes('3djuegos')));
  assert.ok(!web.calls.some((url) => url.includes('feeds/videos.xml')));
  await assert.rejects(news.setMode(silksong.key, 'cualquiera'), /Modo/);
  const hidden = await news.hide(silksong.key, first.items[0].id);
  assert.equal(hidden.items.length, first.items.length - 1);
  const gone = await news.unfollow(silksong.key);
  assert.equal(gone.followed, false);
  assert.deepEqual((await news.summary()).follows, []);
});

test('sin Wikidata ni ficha, un juego queda sin fuentes oficiales; se puede agregar un feed a mano', async () => {
  const { news } = await setup({
    pages: {
      'list=search': { query: { search: [] } },
      wbsearchentities: { search: [] },
      'annoblog.example/': '<link rel="alternate" type="application/atom+xml" href="/atom.xml">',
      'annoblog.example/atom.xml': `<feed><entry><id>1</id><title>Anno 1800: nueva DLC</title><link href="https://annoblog.example/dlc"/><published>${new Date(NOW + 1000).toISOString()}</published></entry></feed>`
    }
  });
  const data = await news.follow(anno);
  assert.deepEqual(data.sources, []);
  assert.equal(data.mode, 'press');
  const added = await news.addSource(anno.key, 'https://annoblog.example/');
  assert.ok(
    added.sources.some((source) => source.kind === 'feed' && source.url === 'https://annoblog.example/atom.xml')
  );
  assert.equal(added.items[0].title, 'Anno 1800: nueva DLC');
  assert.equal(added.items[0].type, 'content');
  await assert.rejects(news.addSource(anno.key, 'javascript:alert(1)'), /https/);
});

test('sin conexión (pruebas) seguir funciona sin pedir nada a internet', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gml-news-'));
  const news = createNews({
    dataDir,
    offline: true,
    fetchImpl: () => assert.fail('no debería consultar internet'),
    steamBuild: async () => null
  });
  const data = await news.follow(silksong);
  assert.equal(data.followed, true);
  assert.deepEqual(data.items, []);
  await assert.rejects(news.follow({ key: 'arcade:sf2', platform: 'Arcade', name: 'Street Fighter II' }), /Arcade/);
});

test('silenciar: no se consulta ni suma sin leer hasta reactivarlo', async () => {
  const { news, web, advance } = await setup();
  await news.follow(silksong);
  const muted = await news.mute(silksong.key);
  assert.equal(muted.mutedUntil, new Date(NOW + 30 * day).toISOString());
  assert.deepEqual((await news.summary()).muted, [silksong.key]);
  advance(60 * 60 * 1000);
  web.calls.length = 0;
  await news.refresh();
  assert.equal(web.calls.length, 0);
  assert.deepEqual((await news.inbox()).items, []);
  assert.equal((await news.mute(silksong.key, 0)).mutedUntil, null);
});

test('bandeja: novedades de los últimos 60 días de todos los juegos, con filtros y «marcar todo como leído»', async () => {
  const { news, web, advance } = await setup();
  await news.follow(silksong);
  advance(60 * 60 * 1000);
  web.pages['bsky.app/profile/teamcherry.bsky.social/rss'] = rss([
    ['Nueva expansión: Mareas', NOW + 30 * 60 * 1000, 'https://bsky.app/profile/teamcherry.bsky.social/post/9']
  ]);
  await news.refresh();
  const all = await news.inbox();
  // Los hotfixes de Steam tienen más de 10 días pero menos de 60: entran; nada más viejo de 60 días.
  assert.ok(all.items.every((item) => item.date >= new Date(NOW - 60 * day).toISOString()));
  assert.equal(all.unread, 1);
  assert.deepEqual(
    all.follows.map((follow) => [follow.key, follow.unread]),
    [[silksong.key, 1]]
  );
  assert.equal(all.items[0].game.name, 'Hollow Knight: Silksong');
  assert.ok(all.types.includes('content') && all.types.includes('press'));
  const content = await news.inbox({ type: 'content' });
  assert.deepEqual(
    content.items.map((item) => item.title),
    ['Nueva expansión: Mareas']
  );
  assert.equal((await news.inbox({ key: anno.key })).items.length, 0);
  await news.markAllRead();
  assert.equal((await news.inbox()).unread, 0);
});

test('ajustes: medios elegidos, ofertas y seguir solo los juegos abiertos en el último mes', async () => {
  const { news, web } = await setup({
    pages: {
      GetNewsForApp: {
        appnews: {
          newsitems: [
            {
              gid: 'o1',
              title: '50% off this week',
              url: 'https://store.steampowered.com/news/o1',
              feed_type: 1,
              date: Math.round((NOW - day) / 1000)
            }
          ]
        }
      }
    }
  });
  const defaults = await news.settings();
  assert.deepEqual(
    defaults.press.filter((feed) => feed.enabled).map((feed) => feed.id),
    ['3djuegos', 'vandal', 'ign-latam', 'eurogamer-es']
  );
  assert.equal(defaults.offers, false);
  await news.saveSettings({ press: { vandal: false, ign: true, inventado: true } });
  await news.follow(silksong);
  assert.ok(!web.calls.some((url) => url.includes('vandal')));
  assert.ok(web.calls.some((url) => url.includes('feedburner.com/ign')));
  // La oferta se guarda, pero se ve sólo con «ofertas» activado o el juego en «todo».
  assert.ok(!(await news.forGame(silksong.key)).items.some((item) => item.type === 'offer'));
  await news.saveSettings({ offers: true });
  assert.ok((await news.forGame(silksong.key)).items.some((item) => item.type === 'offer'));
  await news.saveSettings({ offers: false });
  await news.setMode(silksong.key, 'all');
  assert.ok((await news.forGame(silksong.key)).items.some((item) => item.type === 'offer'));
});

test('seguir solo: suma los juegos abiertos hace menos de un mes, salvo los que dejaste de seguir', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gml-news-'));
  const recent = (key, days) => ({
    key,
    platform: 'Epic Games',
    id: key,
    name: 'Juego ' + key,
    lastLaunchedAt: new Date(NOW - days * day).toISOString()
  });
  const news = createNews({
    dataDir,
    offline: true,
    now: () => NOW,
    steamBuild: async () => null,
    games: async () => [recent('a', 2), recent('b', 10), recent('c', 45), { ...recent('d', 1), platform: 'Arcade' }]
  });
  await news.refresh();
  assert.deepEqual((await news.summary()).follows, []);
  await news.saveSettings({ autoFollow: true });
  await news.refresh();
  assert.deepEqual((await news.summary()).follows.sort(), ['a', 'b']);
  await news.unfollow('a');
  await news.refresh();
  assert.deepEqual((await news.summary()).follows, ['b']);
});
