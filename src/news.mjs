// Novedades de los juegos que seguís (ver docs/arquitectura.md, src/news.mjs).
// Al seguir un juego se buscan sus canales en Wikidata (sitio oficial, Bluesky, YouTube y Steam); cada consulta trae
// lo nuevo de esos canales, de los medios de prensa elegidos (filtrado por nombre) y, en Steam, avisa si el juego
// instalado cambió de versión. Sin servidor propio ni claves: todo se consulta desde esta PC y se guarda en news.json.
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
  parseGdelt,
  plainText,
  pressMatcher,
  safeUrl,
  titleKey
} from './feeds.mjs';

const USER_AGENT = 'Viciodromo/0.43 (lanzador de juegos para Windows; https://github.com/jmiguez78/viciodromo)';
// Medios de prensa. Los de base (en español) vienen activados; el resto se activa en Configuración → Novedades.
// Cada feed se baja una vez por consulta y se filtra para todos los juegos.
export const PRESS_FEEDS = [
  { id: '3djuegos', label: '3DJuegos', lang: 'es', base: true, url: 'https://www.3djuegos.com/feedburner.xml' },
  { id: 'vandal', label: 'Vandal', lang: 'es', base: true, url: 'https://vandal.elespanol.com/xml.cgi' },
  { id: 'ign-latam', label: 'IGN Latinoamérica', lang: 'es', base: true, url: 'https://latam.ign.com/feed.xml' },
  { id: 'eurogamer-es', label: 'Eurogamer.es', lang: 'es', base: true, url: 'https://www.eurogamer.es/feed' },
  { id: 'ign', label: 'IGN', lang: 'en', url: 'https://feeds.feedburner.com/ign/all' },
  { id: 'pcgamer', label: 'PC Gamer', lang: 'en', url: 'https://www.pcgamer.com/rss/' },
  { id: 'gamespot', label: 'GameSpot', lang: 'en', url: 'https://www.gamespot.com/feeds/mashup/' },
  { id: 'vgc', label: 'VGC', lang: 'en', url: 'https://www.videogameschronicle.com/feed/' },
  { id: 'eurogamer', label: 'Eurogamer', lang: 'en', url: 'https://www.eurogamer.net/feed' },
  { id: 'rps', label: 'Rock Paper Shotgun', lang: 'en', url: 'https://www.rockpapershotgun.com/feed' }
];
// Qué entra de cada juego: sólo lo oficial, lo oficial y la prensa (por defecto) o todo (también las ofertas, lo
// más votado del subreddit y el buscador abierto de noticias, GDELT).
export const MODES = ['official', 'press', 'all'];
const BLUESKY = 'Q78194383';
// Las versiones nuevas de MAME se guardan como si fueran un juego más, con esta clave.
export const MAME_KEY = 'mame';
const MAME_NAME = 'MAME (emulador)';
// Tiendas donde se puede leer la versión instalada.
const LOCAL_LABELS = {
  Steam: ['Steam, en esta PC', 'Steam'],
  'Epic Games': ['Epic Games, en esta PC', 'Epic Games'],
  'Xbox / Microsoft Store': ['Xbox, en esta PC', 'La app Xbox']
};
// GDELT pide como mucho una búsqueda cada cinco segundos.
const OPEN_SEARCH_MS = 5500;
const LANGUAGES = { es: 'spanish', en: 'english' };
const FIRST_ITEMS = 5;
const MAX_ITEMS = 50;
const MAX_KNOWN = 400;
const MAX_ALSO = 6;
const MAX_BYTES = 6_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const REFRESH_MS = 6 * HOUR;
const REDISCOVER_MS = 30 * DAY;
// La bandeja muestra lo de los últimos 60 días; la pestaña de cada juego, todo lo guardado.
const INBOX_MS = 60 * DAY;
export const MUTE_DAYS = 30;
// Seguir solo (si se activa en Configuración): los juegos abiertos en los últimos 30 días, de a cinco por consulta.
const AUTO_FOLLOW_MS = 30 * DAY;
const AUTO_FOLLOW_MAX = 5;
// Lo publicado poco antes de seguir el juego (un día) todavía cuenta como nuevo en la consulta siguiente.
const GRACE_MS = DAY;
const SOURCE_LABELS = {
  steam: 'Steam',
  site: 'Sitio oficial',
  bluesky: 'Bluesky',
  youtube: 'YouTube',
  reddit: 'Reddit',
  feed: 'Feed propio',
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

// Fuentes oficiales de un juego a partir de su entidad de Wikidata y de la tienda donde lo tenés. La prensa no es
// una fuente del juego: la decide el modo (ver MODES) y los medios elegidos en Configuración.
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
  const subreddit = claimStrings(entity, 'P3984').find((value) => /^[A-Za-z0-9_]{2,21}$/.test(value));
  if (subreddit)
    add({
      id: 'reddit',
      kind: 'reddit',
      label: 'Reddit (r/' + subreddit + ')',
      url: `https://www.reddit.com/r/${subreddit}/top/.rss?t=week`
    });
  if (LOCAL_LABELS[game.platform] && game.location) add({ id: 'local', kind: 'local' });
  return sources;
}

// Modo de un juego. Antes de la 0.42 la prensa era una fuente más: destildada equivale a «sólo oficial».
export function modeOf(follow) {
  if (MODES.includes(follow?.mode)) return follow.mode;
  return follow?.sources?.some((source) => source.kind === 'press' && !source.enabled) ? 'official' : 'press';
}
const officialSources = (follow) => (follow?.sources ?? []).filter((source) => source.kind !== 'press');

// Manifiesto de Steam del juego instalado: versión (buildid) y fecha de la última actualización.
export function parseSteamBuild(text) {
  const value = (name) => new RegExp(`"${name}"\\s+"([^"]*)"`, 'i').exec(String(text ?? ''))?.[1] ?? null;
  const buildid = value('buildid');
  const updated = Number(value('LastUpdated'));
  return buildid ? { buildid, updatedAt: updated > 0 ? new Date(updated * 1000).toISOString() : null } : null;
}
// Epic: el manifiesto .item del juego (por CatalogItemId, AppName o carpeta) trae AppVersionString.
export function parseEpicManifest(text, game) {
  let item;
  try {
    item = JSON.parse(text);
  } catch {
    return null;
  }
  const same =
    item?.CatalogItemId === game.id ||
    item?.AppName === game.id ||
    (item?.InstallLocation &&
      game.location &&
      path.resolve(item.InstallLocation).toLowerCase() === path.resolve(game.location).toLowerCase());
  return same && item.AppVersionString ? { buildid: String(item.AppVersionString), updatedAt: null } : null;
}
// Xbox: la versión del paquete, en <Identity Version="…"> de MicrosoftGame.config o appxmanifest.xml.
export function parseXboxVersion(text) {
  const version = /<Identity\b[^>]*\bVersion="([^"]+)"/i.exec(String(text ?? ''))?.[1];
  return version ? { buildid: version, updatedAt: null } : null;
}
// Los archivos de Xbox pueden venir en UTF-16.
async function readText(file) {
  const bytes = await fs.readFile(file);
  return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le') : bytes.toString('utf8');
}
// Versión instalada en esta PC: Steam (buildid del manifiesto), Epic (AppVersionString) y Xbox (versión del paquete).
async function readInstalledVersion(game) {
  if (!game.location) return null;
  try {
    if (game.platform === 'Steam' && /^\d+$/.test(String(game.id)))
      return parseSteamBuild(
        await readText(path.join(path.dirname(path.dirname(game.location)), `appmanifest_${game.id}.acf`))
      );
    if (game.platform === 'Epic Games') {
      const dir = path.join(
        process.env.ProgramData ?? 'C:\\ProgramData',
        'Epic',
        'EpicGamesLauncher',
        'Data',
        'Manifests'
      );
      for (const name of (await fs.readdir(dir)).filter((file) => file.endsWith('.item'))) {
        const found = parseEpicManifest(await readText(path.join(dir, name)), game);
        if (found) return found;
      }
      return null;
    }
    if (game.platform === 'Xbox / Microsoft Store')
      for (const file of [
        path.join(game.location, 'Content', 'MicrosoftGame.config'),
        path.join(game.location, 'Content', 'appxmanifest.xml'),
        path.join(game.location, 'MicrosoftGame.config'),
        path.join(game.location, 'appxmanifest.xml')
      ]) {
        const found = await readText(file).then(parseXboxVersion, () => null);
        if (found) return found;
      }
  } catch {
    /* sin manifiesto legible: no hay versión que comparar */
  }
  return null;
}

// «0.270 (mame0270)» o «mame0271» → 270 / 271, para comparar versiones de MAME.
export function parseMameVersion(text) {
  const value = String(text ?? '');
  const match = /(\d+)\.(\d+)/.exec(value) ?? /mame(\d)(\d{3})/i.exec(value);
  return match ? Number(match[1]) * 1000 + Number(match[2]) : null;
}
const mameLabel = (number) => Math.floor(number / 1000) + '.' + String(number % 1000).padStart(3, '0');

const emptyStore = () => ({
  follows: {},
  items: {},
  known: {},
  read: {},
  hidden: {},
  builds: {},
  unfollowed: [],
  settings: {},
  refreshedAt: null
});

// Ajustes con sus valores por defecto: medios de base activados, sin ofertas y sin seguir solo.
export function settingsOf(store) {
  const saved = store?.settings ?? {};
  const press = Object.fromEntries(
    PRESS_FEEDS.map((feed) => [
      feed.id,
      typeof saved.press?.[feed.id] === 'boolean' ? saved.press[feed.id] : Boolean(feed.base)
    ])
  );
  return {
    press,
    offers: saved.offers === true,
    autoFollow: saved.autoFollow === true,
    mameReleases: saved.mameReleases !== false
  };
}

export function createNews({
  dataDir,
  games = async () => [],
  fetchImpl = globalThis.fetch,
  offline = false,
  log = () => {},
  now = () => Date.now(),
  pauseMs = 1200,
  installedVersion = readInstalledVersion,
  // Versión del MAME configurado («0.270 (mame0270)»), para avisar cuando sale una nueva.
  mameVersion = async () => null,
  openSearchMs = OPEN_SEARCH_MS,
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
  const iso = () => new Date(now()).toISOString();
  let lastOpenSearch = 0;
  const isMuted = (follow) => Boolean(follow?.mutedUntil) && Date.parse(follow.mutedUntil) > now();

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
  // había visto y se publicó después de seguirlo (con un día de margen). La misma historia en otro medio (mismo
  // título) no se repite: se suma a la que ya está como «también en».
  function merge(store, key, incoming, { initial = false } = {}) {
    const follow = store.follows[key];
    const known = new Set(store.known[key] ?? []);
    const current = store.items[key] ?? [];
    const byTitle = new Map(current.map((item) => [titleKey(item.title), item]));
    const since = Date.parse(follow.since) - GRACE_MS;
    const fresh = [];
    for (const item of incoming.sort((a, b) => b.date.localeCompare(a.date))) {
      if (known.has(item.id)) continue;
      known.add(item.id);
      const same = byTitle.get(titleKey(item.title));
      if (same) {
        if (same.url !== item.url && same.sourceLabel !== item.sourceLabel)
          same.also = [...(same.also ?? []), { sourceLabel: item.sourceLabel, url: item.url }]
            .filter((entry, index, list) => list.findIndex((other) => other.url === entry.url) === index)
            .slice(0, MAX_ALSO);
        continue;
      }
      if (!initial && Date.parse(item.date) < since) continue;
      byTitle.set(titleKey(item.title), item);
      fresh.push(item);
    }
    const added = initial ? fresh.slice(0, FIRST_ITEMS) : fresh;
    store.items[key] = [...added, ...current].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_ITEMS);
    store.known[key] = [...known].slice(-MAX_KNOWN);
    return added.length;
  }

  // Buscador abierto (GDELT): notas de los últimos siete días que nombran el juego, en los idiomas de los medios
  // elegidos. Respeta la pausa que pide el servicio entre búsquedas.
  async function openSearch(follow, languages) {
    const name = String(follow.game?.name ?? follow.names?.[0] ?? '')
      .replace(/["()]/g, ' ')
      .trim();
    if (name.length < 3 || !languages.length) return [];
    const langs = languages.map((lang) => 'sourcelang:' + LANGUAGES[lang]);
    const query = `"${name}" ${langs.length > 1 ? '(' + langs.join(' OR ') + ')' : langs[0]}`;
    const wait = lastOpenSearch + openSearchMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastOpenSearch = Date.now();
    const data = await get(
      `https://api.gdeltproject.org/api/v2/doc/doc?${new URLSearchParams({
        query,
        mode: 'ArtList',
        format: 'json',
        maxrecords: '25',
        timespan: '7d',
        sort: 'DateDesc'
      })}`,
      'json'
    );
    return parseGdelt(data);
  }

  // Lo de un juego: sus fuentes oficiales y, según su modo, la prensa ya descargada; con «todo», también el
  // subreddit y el buscador abierto (languages: los idiomas de los medios elegidos).
  async function collect(game, follow, press, at, { languages = [] } = {}) {
    const incoming = [];
    const mode = modeOf(follow);
    const sources = officialSources(follow).map((source) => ({ ...source }));
    for (const source of sources) {
      if (!source.enabled || source.kind === 'local') continue;
      if (source.kind === 'reddit' && mode !== 'all') continue;
      try {
        const raw = await fetchSource(source);
        const layer = source.kind === 'reddit' ? 'community' : 'official';
        incoming.push(...raw.map((item) => toItem(item, source, layer, at)));
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
    const matches = pressMatcher({ names: follow.names, studios: follow.studios });
    if (mode !== 'official' && press.length) {
      for (const { feed, items } of press)
        for (const item of items)
          if (matches(item))
            incoming.push(
              toItem({ ...item, id: 'press:' + hash(item.url) }, { id: 'press', label: feed.label }, 'press', at)
            );
    }
    if (mode === 'all' && !offline)
      try {
        // Sólo el título: GDELT no trae el texto, y un nombre ambiguo necesita también el estudio.
        for (const item of await openSearch(follow, languages))
          if (matches({ title: item.title }))
            incoming.push(
              toItem({ ...item, id: 'press:' + hash(item.url) }, { id: 'open', label: item.source }, 'press', at)
            );
      } catch (error) {
        log('info', 'novedades', `${game.key} · buscador abierto: ${error.message}`);
      }
    return { incoming, sources };
  }
  // La tienda instaló otra versión desde la última consulta: una novedad local.
  async function localUpdate(store, game, at) {
    const follow = store.follows[game.key];
    if (!follow.sources.some((source) => source.kind === 'local' && source.enabled)) return [];
    const build = await installedVersion(game);
    if (!build) return [];
    const before = store.builds[game.key];
    store.builds[game.key] = build;
    if (!before || before.buildid === build.buildid) return [];
    const date = build.updatedAt ?? at;
    const played = game.lastLaunchedAt && Date.parse(game.lastLaunchedAt) < Date.parse(date);
    const [label, shop] = LOCAL_LABELS[game.platform] ?? ['En esta PC', 'La tienda'];
    return [
      {
        id: 'local:' + build.buildid,
        layer: 'local',
        type: 'update',
        source: 'local',
        sourceLabel: label,
        title: played ? 'Se actualizó desde la última vez que jugaste' : shop + ' instaló una versión nueva',
        url: game.platform === 'Steam' ? `https://store.steampowered.com/news/app/${game.id}` : null,
        date,
        text: `Versión ${build.buildid} (antes ${before.buildid}).`,
        image: null,
        foundAt: at
      }
    ];
  }

  async function fetchPress(settings) {
    const results = [];
    for (const feed of PRESS_FEEDS.filter((item) => settings.press[item.id]))
      try {
        const page = await get(feed.url);
        results.push({ feed, items: parseFeed(page.text, page.url) });
      } catch (error) {
        log('info', 'novedades', `Prensa · ${feed.label}: ${error.message}`);
      }
    return results;
  }

  // ── Seguir ────────────────────────────────────────────────────
  // Arma la entrada de un juego y trae su primera tanda (las cinco más recientes). press(): la prensa descargada.
  async function begin(game, press) {
    const found = offline
      ? { wikidata: null, names: [game.name], studios: [], sources: sourcesFor(game, null) }
      : await discover(game);
    const at = iso();
    const entry = {
      since: at,
      discoveredAt: at,
      mode: 'press',
      game: { name: game.name, platform: game.platform, id: game.id },
      ...found
    };
    await update((store) => {
      store.follows[game.key] = entry;
      store.items[game.key] = [];
      store.known[game.key] = [];
      store.unfollowed = store.unfollowed.filter((key) => key !== game.key);
      return store;
    });
    log('info', 'novedades', `Siguiendo ${game.key}: ${found.sources.map((source) => source.id).join(', ')}`);
    const { incoming, sources } = offline
      ? { incoming: [], sources: entry.sources }
      : await collect(game, entry, await press(), at);
    const build = await installedVersion(game);
    await update((store) => {
      if (!store.follows[game.key]) return store;
      store.follows[game.key] = { ...store.follows[game.key], sources, checkedAt: at };
      if (build) store.builds[game.key] = build;
      merge(store, game.key, incoming, { initial: true });
      store.read[game.key] = iso();
      return store;
    });
  }

  async function follow(game) {
    if (game.platform === 'Arcade')
      throw Object.assign(new Error('Los juegos de Arcade no tienen novedades.'), { status: 400 });
    const settings = settingsOf(await read());
    await begin(game, async () => (offline ? [] : fetchPress(settings)));
    onChange(await summary());
    return forGame(game.key);
  }

  // Juegos abiertos en los últimos 30 días que todavía no seguís (ni dejaste de seguir a propósito).
  async function autoFollow(store, list, press) {
    if (!settingsOf(store).autoFollow) return 0;
    const skip = new Set([...Object.keys(store.follows), ...store.unfollowed]);
    const recent = list
      .filter((game) => game.platform !== 'Arcade' && !skip.has(game.key) && game.lastLaunchedAt)
      .filter((game) => now() - Date.parse(game.lastLaunchedAt) < AUTO_FOLLOW_MS)
      .sort((a, b) => b.lastLaunchedAt.localeCompare(a.lastLaunchedAt))
      .slice(0, AUTO_FOLLOW_MAX);
    for (const game of recent) await begin(game, press);
    if (recent.length) log('info', 'novedades', `Seguidos solos: ${recent.map((game) => game.key).join(', ')}`);
    return recent.length;
  }

  // Versión nueva de MAME: la última publicada en GitHub, si es más nueva que la configurada. Se guarda como las
  // novedades de un juego (MAME_KEY), una por versión.
  async function checkMame() {
    let installed;
    try {
      installed = parseMameVersion(await mameVersion());
      if (!installed) return 0;
      const release = await get('https://api.github.com/repos/mamedev/mame/releases/latest', 'json');
      const latest = parseMameVersion(release?.tag_name);
      if (!latest || latest <= installed) return 0;
      const id = 'mame:' + release.tag_name;
      const at = iso();
      let added = 0;
      await update((store) => {
        const known = new Set(store.known[MAME_KEY] ?? []);
        if (known.has(id)) return store;
        known.add(id);
        store.known[MAME_KEY] = [...known].slice(-MAX_KNOWN);
        const notes = plainText(release.body, 280);
        store.items[MAME_KEY] = [
          {
            id,
            layer: 'official',
            type: 'update',
            source: 'mame',
            sourceLabel: 'MAME en GitHub',
            title: `MAME ${mameLabel(latest)} ya está disponible`,
            url: safeUrl(release.html_url) ?? 'https://www.mamedev.org/release.html',
            date: Number.isFinite(Date.parse(release.published_at)) ? new Date(release.published_at).toISOString() : at,
            text: `Tenés la ${mameLabel(installed)}.` + (notes ? ' ' + notes : ''),
            image: null,
            foundAt: at
          },
          ...(store.items[MAME_KEY] ?? [])
        ].slice(0, 10);
        added = 1;
        return store;
      });
      if (added) log('info', 'novedades', `MAME ${mameLabel(latest)} disponible (instalada ${mameLabel(installed)})`);
      return added;
    } catch (error) {
      log('info', 'novedades', `MAME: ${error.message}`);
      return 0;
    }
  }
  // Claves que no son juegos seguidos pero tienen novedades (hoy, sólo MAME).
  const extraKeys = (store) => (settingsOf(store).mameReleases && store.items[MAME_KEY]?.length ? [MAME_KEY] : []);

  // ── Consultas ─────────────────────────────────────────────────
  let running = null;
  // Todas las novedades (o las de un juego con only): una sola consulta a la vez. Los juegos silenciados no se
  // consultan.
  function refresh({ only = null } = {}) {
    if (running) return running.then(() => (only ? refresh({ only }) : summary()));
    running = (async () => {
      try {
        let store = await read();
        const settings = settingsOf(store);
        const list = await games();
        // La prensa se baja una sola vez por consulta y sólo si algún juego la usa.
        let pressCache = null;
        const press = async () => (pressCache ??= offline ? [] : await fetchPress(settings));
        if (!only && (await autoFollow(store, list, press))) store = await read();
        let added = 0;
        if (!only && !offline && settings.mameReleases) added += await checkMame();
        const keys = Object.keys(store.follows).filter((key) => (only ? key === only : !isMuted(store.follows[key])));
        if (!keys.length) {
          if (added) onChange(await summary());
          return summary();
        }
        // Idiomas del buscador abierto: los de los medios elegidos (si no hay ninguno, español).
        const languages = [...new Set(PRESS_FEEDS.filter((feed) => settings.press[feed.id]).map((feed) => feed.lang))];
        if (!languages.length) languages.push('es');
        const byKey = new Map(list.map((game) => [game.key, game]));
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
              discoveredAt: iso()
            };
          }
          const at = iso();
          const mode = modeOf(follow);
          const { incoming, sources } = offline
            ? { incoming: [], sources: officialSources(follow) }
            : await collect(game, follow, mode === 'official' ? [] : await press(), at, { languages });
          await update(async (current) => {
            if (!current.follows[key]) return current;
            current.follows[key] = { ...current.follows[key], ...follow, mode, sources, checkedAt: at };
            const local = await localUpdate(current, game, at);
            added += merge(current, key, [...incoming, ...local]);
            return current;
          });
        }
        await update((current) => ({ ...current, refreshedAt: iso() }));
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

  async function unfollow(key) {
    await update((store) => {
      for (const part of ['follows', 'items', 'known', 'read', 'hidden', 'builds']) delete store[part][key];
      // Que «seguir solo» no lo vuelva a seguir.
      store.unfollowed = [...new Set([...store.unfollowed, key])].slice(-MAX_KNOWN);
      return store;
    });
    onChange(await summary());
    return forGame(key);
  }

  // ── Lo que se muestra ─────────────────────────────────────────
  const visible = (store, key) => {
    const hidden = new Set(store.hidden[key] ?? []);
    // Las ofertas se guardan siempre, pero se muestran sólo si se activaron o el juego está en «todo».
    const offers = settingsOf(store).offers || modeOf(store.follows[key]) === 'all';
    return (store.items[key] ?? []).filter((item) => !hidden.has(item.id) && (offers || item.type !== 'offer'));
  };
  const unreadOf = (store, key) => {
    if (isMuted(store.follows[key])) return 0;
    const since = store.read[key] ?? '';
    return visible(store, key).filter((item) => item.foundAt > since).length;
  };

  async function summary() {
    const store = await read();
    const unread = {};
    for (const key of [...Object.keys(store.follows), ...extraKeys(store)]) {
      const count = unreadOf(store, key);
      if (count) unread[key] = count;
    }
    return {
      follows: Object.keys(store.follows),
      muted: Object.keys(store.follows).filter((key) => isMuted(store.follows[key])),
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
      mode: modeOf(follow),
      mutedUntil: isMuted(follow) ? follow.mutedUntil : null,
      since: follow.since,
      wikidata: follow.wikidata ?? null,
      checkedAt: follow.checkedAt ?? null,
      sources: officialSources(follow).map(({ id, kind, label, url, enabled, status, error, checkedAt }) => ({
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

  // Bandeja: las novedades de los últimos 60 días de todos los juegos seguidos (sin los silenciados), con filtros
  // por tipo y por juego.
  async function inbox({ type = null, key = null, limit = 200 } = {}) {
    const store = await read();
    const names = new Map((await games()).map((game) => [game.key, game.name]));
    const after = new Date(now() - INBOX_MS).toISOString();
    const follows = Object.entries(store.follows).map(([gameKey, follow]) => ({
      key: gameKey,
      name: names.get(gameKey) ?? follow.game?.name ?? gameKey,
      mode: modeOf(follow),
      mutedUntil: isMuted(follow) ? follow.mutedUntil : null,
      unread: unreadOf(store, gameKey)
    }));
    for (const extra of extraKeys(store))
      follows.push({ key: extra, name: MAME_NAME, mode: 'official', mutedUntil: null, unread: unreadOf(store, extra) });
    let items = follows
      .filter((follow) => !follow.mutedUntil)
      .flatMap((follow) => {
        const since = store.read[follow.key] ?? '';
        return visible(store, follow.key)
          .filter((item) => item.date >= after)
          .map((item) => ({ ...item, unread: item.foundAt > since, game: { key: follow.key, name: follow.name } }));
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    const types = [...new Set(items.map((item) => item.type))];
    if (key) items = items.filter((item) => item.game.key === key);
    if (type) items = items.filter((item) => item.type === type);
    return {
      items: items.slice(0, limit),
      total: items.length,
      types,
      follows: follows.sort((a, b) => a.name.localeCompare(b.name, 'es')),
      unread: follows.reduce((sum, follow) => sum + follow.unread, 0),
      refreshedAt: store.refreshedAt,
      refreshing: Boolean(running)
    };
  }

  async function markRead(key) {
    await update((store) => {
      if (store.follows[key] || key === MAME_KEY) store.read[key] = iso();
      return store;
    });
    onChange(await summary());
    return { ok: true };
  }

  async function markAllRead() {
    await update((store) => {
      for (const key of [...Object.keys(store.follows), ...extraKeys(store)]) store.read[key] = iso();
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
    onChange(await summary());
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

  async function setMode(key, mode) {
    if (!MODES.includes(mode)) throw Object.assign(new Error('Modo no válido.'), { status: 400 });
    await update((store) => {
      const follow = store.follows[key];
      if (!follow) return store;
      follow.mode = mode;
      follow.sources = officialSources(follow);
      return store;
    });
    onChange(await summary());
    return forGame(key);
  }

  // Silenciar: no se consulta ni cuenta como sin leer hasta la fecha; days 0 lo reactiva.
  async function mute(key, days = MUTE_DAYS) {
    await update((store) => {
      const follow = store.follows[key];
      if (!follow) return store;
      if (days > 0) follow.mutedUntil = new Date(now() + days * DAY).toISOString();
      else delete follow.mutedUntil;
      return store;
    });
    onChange(await summary());
    return forGame(key);
  }

  async function settings() {
    const current = settingsOf(await read());
    return {
      press: PRESS_FEEDS.map(({ id, label, lang, base, url }) => ({
        id,
        label,
        lang,
        base: Boolean(base),
        url,
        enabled: current.press[id]
      })),
      offers: current.offers,
      autoFollow: current.autoFollow,
      mameReleases: current.mameReleases
    };
  }
  async function saveSettings(patch) {
    await update((store) => {
      const current = settingsOf(store);
      if (patch.press && typeof patch.press === 'object')
        for (const [id, enabled] of Object.entries(patch.press))
          if (id in current.press && typeof enabled === 'boolean') current.press[id] = enabled;
      if (typeof patch.offers === 'boolean') current.offers = patch.offers;
      if (typeof patch.autoFollow === 'boolean') current.autoFollow = patch.autoFollow;
      if (typeof patch.mameReleases === 'boolean') current.mameReleases = patch.mameReleases;
      store.settings = current;
      return store;
    });
    onChange(await summary());
    return settings();
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
          { status: 400 }
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
  function startTimers({ delayMs = 30000 } = {}) {
    if (offline) return () => {};
    const due = async () => {
      const store = await read();
      if (!Object.keys(store.follows).length && !settingsOf(store).autoFollow) return;
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

  return {
    summary,
    forGame,
    inbox,
    follow,
    unfollow,
    refresh,
    markRead,
    markAllRead,
    hide,
    setSource,
    setMode,
    mute,
    settings,
    saveSettings,
    addSource,
    start: startTimers,
    discover
  };
}

// Búsqueda nocturna (electron-main --scan): consulta las novedades sin abrir la ventana, con el inventario guardado.
export async function nightlyNews(dataDir, log = () => {}, options = {}) {
  const readJson = async (name, fallback) => {
    try {
      return JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8'));
    } catch {
      return fallback;
    }
  };
  const news = createNews({
    ...options,
    dataDir,
    log,
    games: async () => {
      const [catalog, prefs] = await Promise.all([readJson('library.json', {}), readJson('preferences.json', {})]);
      return (catalog.games ?? []).map((game) => ({
        ...game,
        lastLaunchedAt: prefs.games?.[game.key]?.lastLaunchedAt ?? null
      }));
    }
  });
  const result = await news.refresh();
  log('info', 'tarea', `Novedades: ${result.follows.length} juegos seguidos`);
  return result;
}
