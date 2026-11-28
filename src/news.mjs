// Novedades de los juegos que seguís (fase 1, ver docs/arquitectura.md#novedades).
// Al seguir un juego se buscan sus canales en Wikidata (sitio oficial, Bluesky, YouTube y Steam); cada consulta trae
// lo nuevo de esos canales, de los medios de prensa (filtrado por nombre) y, en Steam, avisa si el juego instalado
// cambió de versión. Sin servidor propio ni claves: todo se consulta desde esta PC y se guarda en news.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createVersionedFile } from './json-file.mjs';
import { VIDEO_GAME } from './wiki.mjs';
import {
  classify,
  discoverFeeds,
  looksLikeFeed,
  normalizeText,
  parseFeed,
  parseSteamNews,
  pressMatcher,
  safeUrl,
  titleKey
} from './feeds.mjs';

const USER_AGENT = 'Viciodromo/0.41 (lanzador de juegos para Windows; https://github.com/jmiguez78/viciodromo)';
// Medios de prensa base, en español. Cada feed se baja una vez por consulta y se filtra para todos los juegos.
export const PRESS_FEEDS = [
  { id: '3djuegos', label: '3DJuegos', url: 'https://www.3djuegos.com/feedburner.xml' },
  { id: 'vandal', label: 'Vandal', url: 'https://vandal.elespanol.com/xml.cgi' },
  { id: 'ign-latam', label: 'IGN Latinoamérica', url: 'https://latam.ign.com/feed.xml' },
  { id: 'eurogamer-es', label: 'Eurogamer.es', url: 'https://www.eurogamer.es/feed' }
];
const BLUESKY = 'Q78194383';
const FIRST_ITEMS = 5;
const MAX_ITEMS = 50;
const MAX_KNOWN = 400;
const MAX_BYTES = 4_000_000;
const HOUR = 60 * 60 * 1000;
const REFRESH_MS = 6 * HOUR;
const REDISCOVER_MS = 30 * 24 * HOUR;
// Lo publicado poco antes de seguir el juego (un día) todavía cuenta como nuevo en la consulta siguiente.
const GRACE_MS = 24 * HOUR;
const SOURCE_LABELS = {
  steam: 'Steam',
  site: 'Sitio oficial',
  bluesky: 'Bluesky',
  youtube: 'YouTube',
  feed: 'Feed propio',
  press: 'Prensa especializada',
  local: 'Versión instalada'
};

const hash = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
const claimValues = (entity, property) =>
  (entity?.claims?.[property] ?? [])
    .filter((claim) => claim?.rank !== 'deprecated')
    .map((claim) => claim?.mainsnak?.datavalue?.value)
    .filter((value) => value != null);
const claimIds = (entity, property) =>
  claimValues(entity, property)
    .map((value) => value?.id)
    .filter(Boolean);
const claimStrings = (entity, property) => claimValues(entity, property).filter((value) => typeof value === 'string');
const labelsOf = (entity) =>
  [
    ...Object.values(entity?.labels ?? {}).map((item) => item?.value),
    ...Object.values(entity?.aliases ?? {}).flatMap((list) => (list ?? []).map((item) => item?.value))
  ].filter((value) => typeof value === 'string' && value.trim());

// Cuenta de Bluesky: la propiedad genérica «cuenta en» (P553 = Bluesky, con el usuario en P554) o cualquier
// identificador que termine en .bsky.social.
export function blueskyHandle(entity) {
  for (const claim of entity?.claims?.P553 ?? []) {
    if (claim?.mainsnak?.datavalue?.value?.id !== BLUESKY) continue;
    const user = claim.qualifiers?.P554?.[0]?.datavalue?.value;
    if (typeof user === 'string' && user.trim()) return user.trim().replace(/^@/, '');
  }
  for (const claims of Object.values(entity?.claims ?? {}))
    for (const claim of claims ?? []) {
      const value = claim?.mainsnak?.datavalue?.value;
      if (typeof value === 'string' && /^[a-z0-9-]+(\.[a-z0-9-]+)*\.bsky\.social$/i.test(value.trim()))
        return value.trim();
    }
  return null;
}

// Fuentes de un juego a partir de su entidad de Wikidata y de la tienda donde lo tenés.
export function sourcesFor(game, entity) {
  const sources = [];
  const add = (source) => {
    if (!sources.some((item) => item.id === source.id))
      sources.push({ label: SOURCE_LABELS[source.kind], enabled: true, ...source });
  };
  const steamId = game.platform === 'Steam' ? String(game.id) : claimStrings(entity, 'P1733')[0];
  if (steamId && /^\d+$/.test(steamId)) add({ id: 'steam', kind: 'steam', appid: steamId });
  const website = claimStrings(entity, 'P856')
    .map((value) => safeUrl(value))
    .find(Boolean);
  if (website) add({ id: 'site', kind: 'site', url: website });
  const handle = blueskyHandle(entity);
  if (handle)
    add({
      id: 'bluesky',
      kind: 'bluesky',
      label: 'Bluesky (@' + handle + ')',
      url: `https://bsky.app/profile/${encodeURIComponent(handle)}/rss`
    });
  const channel = claimStrings(entity, 'P2397').find((value) => /^UC[\w-]{22}$/.test(value));
  if (channel)
    add({ id: 'youtube', kind: 'youtube', url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel}` });
  add({ id: 'press', kind: 'press' });
  if (game.platform === 'Steam' && game.location) add({ id: 'local', kind: 'local' });
  return sources;
}

// Manifiesto de Steam del juego instalado: versión (buildid) y fecha de la última actualización.
export function parseSteamBuild(text) {
  const value = (name) => new RegExp(`"${name}"\\s+"([^"]*)"`, 'i').exec(String(text ?? ''))?.[1] ?? null;
  const buildid = value('buildid');
  const updated = Number(value('LastUpdated'));
  return buildid ? { buildid, updatedAt: updated > 0 ? new Date(updated * 1000).toISOString() : null } : null;
}
async function readSteamBuild(game) {
  if (game.platform !== 'Steam' || !game.location || !/^\d+$/.test(String(game.id))) return null;
  const manifest = path.join(path.dirname(path.dirname(game.location)), `appmanifest_${game.id}.acf`);
  try {
    return parseSteamBuild(await fs.readFile(manifest, 'utf8'));
  } catch {
    return null;
  }
}

const emptyStore = () => ({ follows: {}, items: {}, known: {}, read: {}, hidden: {}, builds: {}, refreshedAt: null });

export function createNews({
  dataDir,
  games = async () => [],
  fetchImpl = globalThis.fetch,
  offline = false,
  log = () => {},
  now = () => Date.now(),
  pauseMs = 1200,
  steamBuild = readSteamBuild,
  onChange = () => {}
} = {}) {
  const file = createVersionedFile(path.join(dataDir, 'news.json'), {
    version: 1,
    fallback: emptyStore,
    migrations: { 1: (saved) => ({ ...emptyStore(), ...saved }) }
  });
  const read = async () => ({ ...emptyStore(), ...((await file.read()) ?? {}) });
  const update = (change) =>
    file.update((store) => {
      const full = { ...emptyStore(), ...store };
      return change(full) ?? full;
    });
  const pause = () => (pauseMs ? new Promise((resolve) => setTimeout(resolve, pauseMs)) : null);

  async function get(url, type = 'text') {
    if (offline) throw new Error('Sin conexión (modo de prueba).');
    const target = safeUrl(url);
    if (!target) throw new Error('Dirección no válida.');
    const response = await fetchImpl(target, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept:
          type === 'json'
            ? 'application/json'
            : 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`respondió ${response.status}`);
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new Error('respuesta demasiado grande');
    return type === 'json' ? JSON.parse(text) : { text, url: response.url || target };
  }

  // ── Wikidata ──────────────────────────────────────────────────
  const wikidata = (params) =>
    get(`https://www.wikidata.org/w/api.php?${new URLSearchParams({ format: 'json', ...params })}`, 'json');
  async function entityById(statement) {
    const data = await wikidata({ action: 'query', list: 'search', srsearch: statement, srlimit: '1' });
    return data?.query?.search?.[0]?.title ?? null;
  }
  async function entityByName(name) {
    const target = normalizeText(name);
    for (const language of ['en', 'es']) {
      const data = await wikidata({
        action: 'wbsearchentities',
        search: name,
        language,
        type: 'item',
        limit: '7'
      });
      const ids = (data?.search ?? [])
        .filter((item) =>
          [item.label, item.match?.text, ...(item.aliases ?? [])].some((text) => normalizeText(text) === target)
        )
        .map((item) => item.id);
      if (!ids.length) continue;
      const entities = await wikidata({ action: 'wbgetentities', ids: ids.join('|'), props: 'claims' });
      const id = ids.find((item) => claimIds(entities?.entities?.[item], 'P31').some((kind) => VIDEO_GAME.has(kind)));
      if (id) return id;
    }
    return null;
  }
  // { wikidata, names, studios, sources } — sin Wikidata, las fuentes que se conocen por la tienda.
  async function discover(game) {
    let id = null;
    let entity = null;
    try {
      if (game.platform === 'Steam' && /^\d+$/.test(String(game.id)))
        id = await entityById(`haswbstatement:P1733=${game.id}`);
      else if (/^GOG/i.test(game.platform) && /^\d+$/.test(String(game.id)))
        id = await entityById(`haswbstatement:P2725=${game.id}`);
      id ??= await entityByName(game.name);
      if (id) {
        const data = await wikidata({
          action: 'wbgetentities',
          ids: id,
          props: 'claims|labels|aliases',
          languages: 'en|es'
        });
        entity = data?.entities?.[id] ?? null;
      }
    } catch (error) {
      log('warn', 'novedades', `Wikidata no respondió para ${game.key}: ${error.message}`);
    }
    let studios = [];
    const companies = [...new Set([...claimIds(entity, 'P178'), ...claimIds(entity, 'P123')])].slice(0, 8);
    if (companies.length)
      try {
        const data = await wikidata({
          action: 'wbgetentities',
          ids: companies.join('|'),
          props: 'labels|aliases',
          languages: 'en|es'
        });
        studios = companies.flatMap((company) => labelsOf(data?.entities?.[company]));
      } catch {
        /* sin nombres de estudio: los nombres ambiguos no se buscan en la prensa */
      }
    return {
      wikidata: entity ? id : null,
      names: [...new Set([game.name, game.originalName, ...labelsOf(entity)].filter(Boolean))],
      studios: [...new Set(studios)],
      sources: sourcesFor(game, entity)
    };
  }

  // ── Fuentes ───────────────────────────────────────────────────
  async function siteFeed(source) {
    if (source.feedUrl) return source.feedUrl;
    const page = await get(source.url);
    if (looksLikeFeed(page.text)) return page.url;
    const feed = discoverFeeds(page.text, page.url)[0];
    if (!feed) throw Object.assign(new Error('el sitio no publica un feed'), { code: 'no-feed' });
    source.feedUrl = feed;
    return feed;
  }
  // Lo que trae una fuente oficial: [{ id, title, url, date, text, image, tags }].
  async function fetchSource(source) {
    if (source.kind === 'steam') {
      const data = await get(
        `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${source.appid}&count=15&maxlength=1500&format=json`,
        'json'
      );
      return parseSteamNews(data);
    }
    const url = source.kind === 'site' || source.kind === 'feed' ? await siteFeed(source) : source.url;
    const page = await get(url);
    if (!looksLikeFeed(page.text)) throw new Error('no es un feed');
    return parseFeed(page.text, page.url).map((item) => ({ ...item, id: source.kind + ':' + hash(item.id) }));
  }

  const toItem = (raw, source, layer, at) => ({
    id: raw.id,
    layer,
    type: classify(raw, layer),
    source: source.id,
    sourceLabel: source.label,
    title: raw.title,
    url: raw.url,
    date: raw.date,
    text: raw.text ?? '',
    image: raw.image ?? null,
    foundAt: at
  });

  // Suma lo nuevo de un juego. La primera vez (initial) quedan sólo las últimas FIRST_ITEMS; después, lo que no se
  // había visto y se publicó después de seguirlo (con un día de margen).
  function merge(store, key, incoming, { initial = false } = {}) {
    const follow = store.follows[key];
    const known = new Set(store.known[key] ?? []);
    const current = store.items[key] ?? [];
    const titles = new Set(current.map((item) => titleKey(item.title)));
    const since = Date.parse(follow.since) - GRACE_MS;
    const fresh = [];
    for (const item of incoming.sort((a, b) => b.date.localeCompare(a.date))) {
      if (known.has(item.id)) continue;
      known.add(item.id);
      // La misma historia en otro medio (o repetida en dos canales) no se muestra dos veces.
      if (titles.has(titleKey(item.title))) continue;
      if (!initial && Date.parse(item.date) < since) continue;
      titles.add(titleKey(item.title));
      fresh.push(item);
    }
    const added = initial ? fresh.slice(0, FIRST_ITEMS) : fresh;
    store.items[key] = [...added, ...current].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_ITEMS);
    store.known[key] = [...known].slice(-MAX_KNOWN);
    return added.length;
  }

  // Lo de un juego: sus fuentes oficiales, la prensa ya descargada y su versión instalada.
  async function collect(game, follow, press, at) {
    const incoming = [];
    const sources = follow.sources.map((source) => ({ ...source }));
    for (const source of sources) {
      if (!source.enabled || ['press', 'local'].includes(source.kind)) continue;
      try {
        const raw = await fetchSource(source);
        incoming.push(...raw.map((item) => toItem(item, source, 'official', at)));
        source.status = 'ok';
        delete source.error;
      } catch (error) {
        source.status = error.code === 'no-feed' ? 'no-feed' : 'error';
        source.error = error.message;
        log('info', 'novedades', `${game.key} · ${source.id}: ${error.message}`);
      }
      source.checkedAt = at;
      await pause();
    }
    const pressSource = sources.find((source) => source.kind === 'press');
    if (pressSource?.enabled && press.length) {
      const matches = pressMatcher({ names: follow.names, studios: follow.studios });
      for (const { feed, items } of press)
        for (const item of items)
          if (matches(item))
            incoming.push(
              toItem({ ...item, id: 'press:' + hash(item.url) }, { ...pressSource, label: feed.label }, 'press', at)
            );
      pressSource.checkedAt = at;
      pressSource.status = 'ok';
    }
    return { incoming, sources };
  }
  // Steam cambió la versión instalada desde la última consulta: una novedad local.
  async function localUpdate(store, game, at) {
    const follow = store.follows[game.key];
    if (!follow.sources.some((source) => source.kind === 'local' && source.enabled)) return [];
    const build = await steamBuild(game);
    if (!build) return [];
    const before = store.builds[game.key];
    store.builds[game.key] = build;
    if (!before || before.buildid === build.buildid) return [];
    const date = build.updatedAt ?? at;
    const played = game.lastLaunchedAt && Date.parse(game.lastLaunchedAt) < Date.parse(date);
    return [
      {
        id: 'local:' + build.buildid,
        layer: 'local',
        type: 'update',
        source: 'local',
        sourceLabel: 'Steam, en esta PC',
        title: played ? 'Se actualizó desde la última vez que jugaste' : 'Steam instaló una versión nueva',
        url: `https://store.steampowered.com/news/app/${game.id}`,
        date,
        text: `Versión ${build.buildid} (antes ${before.buildid}).`,
        image: null,
        foundAt: at
      }
    ];
  }

  async function fetchPress() {
    const results = [];
    for (const feed of PRESS_FEEDS)
      try {
        const page = await get(feed.url);
        results.push({ feed, items: parseFeed(page.text, page.url) });
      } catch (error) {
        log('info', 'novedades', `Prensa · ${feed.label}: ${error.message}`);
      }
    return results;
  }

  // ── Consultas ─────────────────────────────────────────────────
  let running = null;
  // Todas las novedades (o las de un juego con only): una sola consulta a la vez.
  function refresh({ only = null } = {}) {
    if (running) return running.then(() => (only ? refresh({ only }) : summary()));
    running = (async () => {
      try {
        const store = await read();
        const keys = Object.keys(store.follows).filter((key) => !only || key === only);
        if (!keys.length) return summary();
        const byKey = new Map((await games()).map((game) => [game.key, game]));
        const wantsPress = keys.some((key) =>
          store.follows[key].sources.some((source) => source.kind === 'press' && source.enabled)
        );
        const press = wantsPress && !offline ? await fetchPress() : [];
        let added = 0;
        for (const key of keys) {
          const game = byKey.get(key) ?? { key, ...store.follows[key].game };
          let follow = store.follows[key];
          // Una vez por mes se vuelve a mirar Wikidata por canales nuevos (se respeta lo que destildaste).
          if (!offline && now() - Date.parse(follow.discoveredAt ?? 0) > REDISCOVER_MS) {
            const found = await discover(game);
            const saved = new Map(follow.sources.map((source) => [source.id, source]));
            follow = {
              ...follow,
              ...found,
              sources: [
                ...found.sources.map((source) => ({ ...source, ...(saved.get(source.id) ?? {}) })),
                ...follow.sources.filter((source) => source.kind === 'feed')
              ],
              discoveredAt: new Date(now()).toISOString()
            };
          }
          const at = new Date(now()).toISOString();
          const { incoming, sources } = offline
            ? { incoming: [], sources: follow.sources }
            : await collect(game, follow, press, at);
          await update(async (current) => {
            if (!current.follows[key]) return current;
            current.follows[key] = { ...current.follows[key], ...follow, sources, checkedAt: at };
            const local = await localUpdate(current, game, at);
            added += merge(current, key, [...incoming, ...local]);
            return current;
          });
        }
        await update((current) => ({ ...current, refreshedAt: new Date(now()).toISOString() }));
        if (added) log('info', 'novedades', `${added} novedades nuevas`);
        const result = await summary();
        onChange(result);
        return result;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  async function follow(game) {
    if (game.platform === 'Arcade')
      throw Object.assign(new Error('Los juegos de Arcade no tienen novedades.'), { status: 400 });
    const found = offline
      ? { wikidata: null, names: [game.name], studios: [], sources: sourcesFor(game, null) }
      : await discover(game);
    const at = new Date(now()).toISOString();
    const entry = {
      since: at,
      discoveredAt: at,
      game: { name: game.name, platform: game.platform, id: game.id },
      ...found
    };
    await update((store) => {
      store.follows[game.key] = entry;
      store.items[game.key] = [];
      store.known[game.key] = [];
      return store;
    });
    log('info', 'novedades', `Siguiendo ${game.key}: ${found.sources.map((source) => source.id).join(', ')}`);
    // Primera consulta: las últimas novedades de cada fuente, recortadas a las cinco más recientes.
    const press = offline || !found.sources.some((s) => s.kind === 'press') ? [] : await fetchPress();
    const { incoming, sources } = offline
      ? { incoming: [], sources: entry.sources }
      : await collect(game, entry, press, at);
    const build = await steamBuild(game);
    await update((store) => {
      if (!store.follows[game.key]) return store;
      store.follows[game.key] = { ...store.follows[game.key], sources, checkedAt: at };
      if (build) store.builds[game.key] = build;
      merge(store, game.key, incoming, { initial: true });
      store.read[game.key] = new Date(now()).toISOString();
      return store;
    });
    onChange(await summary());
    return forGame(game.key);
  }

  async function unfollow(key) {
    await update((store) => {
      for (const part of ['follows', 'items', 'known', 'read', 'hidden', 'builds']) delete store[part][key];
      return store;
    });
    onChange(await summary());
    return forGame(key);
  }

  const visible = (store, key) => {
    const hidden = new Set(store.hidden[key] ?? []);
    // Las ofertas quedan guardadas pero no se muestran (fase 2: se podrán activar en Ajustes).
    return (store.items[key] ?? []).filter((item) => !hidden.has(item.id) && item.type !== 'offer');
  };
  const unreadOf = (store, key) => {
    const since = store.read[key] ?? '';
    return visible(store, key).filter((item) => item.foundAt > since).length;
  };

  async function summary() {
    const store = await read();
    const unread = {};
    for (const key of Object.keys(store.follows)) {
      const count = unreadOf(store, key);
      if (count) unread[key] = count;
    }
    return {
      follows: Object.keys(store.follows),
      unread,
      refreshedAt: store.refreshedAt,
      refreshing: Boolean(running)
    };
  }

  async function forGame(key) {
    const store = await read();
    const follow = store.follows[key];
    if (!follow) return { key, followed: false, items: [], sources: [] };
    const since = store.read[key] ?? '';
    return {
      key,
      followed: true,
      since: follow.since,
      wikidata: follow.wikidata ?? null,
      checkedAt: follow.checkedAt ?? null,
      sources: follow.sources.map(({ id, kind, label, url, enabled, status, error, checkedAt }) => ({
        id,
        kind,
        label,
        url: url ?? null,
        enabled,
        status: status ?? null,
        error: error ?? null,
        checkedAt: checkedAt ?? null
      })),
      items: visible(store, key).map((item) => ({ ...item, unread: item.foundAt > since })),
      unread: unreadOf(store, key)
    };
  }

  async function markRead(key) {
    await update((store) => {
      if (store.follows[key]) store.read[key] = new Date(now()).toISOString();
      return store;
    });
    onChange(await summary());
    return { ok: true };
  }

  async function hide(key, id) {
    await update((store) => {
      store.hidden[key] = [...new Set([...(store.hidden[key] ?? []), id])].slice(-MAX_KNOWN);
      return store;
    });
    return forGame(key);
  }

  async function setSource(key, id, enabled) {
    await update((store) => {
      const source = store.follows[key]?.sources.find((item) => item.id === id);
      if (source) source.enabled = enabled;
      return store;
    });
    return forGame(key);
  }

  // Una fuente pegada a mano: una ficha de Steam, un perfil de Bluesky, un feed o una página que declare su feed
  // (los canales de YouTube lo hacen).
  async function addSource(key, input) {
    const url = safeUrl(input);
    if (!url) throw Object.assign(new Error('Pegá un enlace que empiece con https://'), { status: 400 });
    const store = await read();
    if (!store.follows[key]) throw Object.assign(new Error('Primero seguí el juego.'), { status: 409 });
    const parsed = new URL(url);
    let source;
    const steam = /store\.steampowered\.com\/(?:app|news\/app)\/(\d+)/.exec(url);
    const bluesky = /^\/profile\/([^/]+)\/?$/.exec(parsed.pathname);
    if (steam) source = { id: 'steam', kind: 'steam', appid: steam[1], label: SOURCE_LABELS.steam };
    else if (parsed.hostname === 'bsky.app' && bluesky)
      source = {
        id: 'bluesky',
        kind: 'bluesky',
        label: 'Bluesky (@' + decodeURIComponent(bluesky[1]) + ')',
        url: `https://bsky.app/profile/${bluesky[1]}/rss`
      };
    else {
      const page = await get(url).catch((error) => {
        throw Object.assign(new Error(`No se pudo abrir el enlace: ${error.message}`), { status: 502 });
      });
      const feedUrl = looksLikeFeed(page.text) ? page.url : discoverFeeds(page.text, page.url)[0];
      if (!feedUrl)
        throw Object.assign(
          new Error('Ese enlace no es un feed ni declara uno. Probá con el feed o el blog del juego.'),
          {
            status: 400
          }
        );
      source = {
        id: 'feed-' + hash(feedUrl).slice(0, 8),
        kind: 'feed',
        label: parsed.hostname.replace(/^www\./, ''),
        url: feedUrl,
        feedUrl
      };
    }
    await update((current) => {
      const follow = current.follows[key];
      if (!follow) return current;
      follow.sources = [...follow.sources.filter((item) => item.id !== source.id), { ...source, enabled: true }];
      return current;
    });
    return refresh({ only: key }).then(() => forGame(key));
  }

  // Consulta al abrir (si la última tiene más de seis horas) y cada seis horas mientras la aplicación está abierta.
  function start({ delayMs = 30000 } = {}) {
    if (offline) return () => {};
    const due = async () => {
      const store = await read();
      if (!Object.keys(store.follows).length) return;
      if (store.refreshedAt && now() - Date.parse(store.refreshedAt) < REFRESH_MS - 60000) return;
      await refresh();
    };
    const run = () => due().catch((error) => log('warn', 'novedades', error.message));
    const first = setTimeout(run, delayMs);
    const every = setInterval(run, REFRESH_MS);
    first.unref?.();
    every.unref?.();
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }

  return { summary, forGame, follow, unfollow, refresh, markRead, hide, setSource, addSource, start, discover };
}
