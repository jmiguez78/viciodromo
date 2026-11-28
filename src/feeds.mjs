// Lectura de fuentes de novedades, sin dependencias: RSS 2.0, Atom (Bluesky, YouTube y blogs), las noticias de
// Steam y el enlace al feed que declara la portada de un sitio. También la clasificación por tipo y el filtro que
// decide si una nota de prensa habla de un juego. Todo son funciones puras (ver test/feeds.test.mjs).

const MAX_TEXT = 600;

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  laquo: '«',
  raquo: '»',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  iexcl: '¡',
  iquest: '¿',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  ntilde: 'ñ',
  uuml: 'ü',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  Ntilde: 'Ñ',
  ccedil: 'ç',
  trade: '™',
  reg: '®',
  copy: '©'
};

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : '';
    }
    return NAMED[code] ?? match;
  });
}

const unwrapCdata = (text) => String(text ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

// Texto plano de un fragmento HTML (o BBCode de Steam): sin etiquetas, scripts ni espacios de más.
export function plainText(html, max = MAX_TEXT) {
  let text = unwrapCdata(html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  // Las entidades se decodifican después de quitar etiquetas: «&lt;b&gt;» queda como texto, no como etiqueta.
  text = decodeEntities(decodeEntities(text).replace(/<[^>]*>/g, ' '))
    .replace(/\[img\][\s\S]*?\[\/img\]/gi, ' ')
    .replace(/\{STEAM_CLAN_IMAGE\}\S*/g, ' ')
    .replace(/\[\/?[a-z0-9*]+(?:=[^\]]*)?\]/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > max) {
    const cut = text.lastIndexOf(' ', max);
    text = text.slice(0, cut > max * 0.6 ? cut : max).replace(/[\s.,;:]+$/, '') + '…';
  }
  return text;
}

// Sólo direcciones web completas: nada de javascript:, data: ni rutas locales.
export function safeUrl(value, base) {
  try {
    const url = new URL(decodeEntities(String(value ?? '').trim()), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
// Las imágenes se muestran sólo por https (la interfaz no carga otras).
const httpsImage = (value, base) => {
  const url = safeUrl(value, base);
  return url?.startsWith('https://') ? url : null;
};

function isoDate(value) {
  const time = typeof value === 'number' ? value : Date.parse(String(value ?? '').trim());
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
}

// Primer elemento <nombre> de un bloque (con o sin atributos); su contenido sin CDATA.
function tag(block, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return match ? unwrapCdata(match[1]).trim() : '';
}
function attribute(element, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(element);
  return match ? decodeEntities(match[2] ?? match[3] ?? '') : '';
}
const elements = (block, name) => block.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];
const firstImageIn = (html, base) => {
  const match = /<img\b[^>]*>/i.exec(decodeEntities(unwrapCdata(html)));
  return match ? httpsImage(attribute(match[0], 'src'), base) : null;
};

function mediaImage(block, base) {
  for (const element of [...elements(block, 'media:thumbnail'), ...elements(block, 'media:content')]) {
    const type = attribute(element, 'type');
    const medium = attribute(element, 'medium');
    if (/^image\//.test(type) || medium === 'image' || element.startsWith('<media:thumbnail') || (!type && !medium)) {
      const url = httpsImage(attribute(element, 'url'), base);
      if (url) return url;
    }
  }
  for (const element of elements(block, 'enclosure'))
    if (/^image\//.test(attribute(element, 'type'))) {
      const url = httpsImage(attribute(element, 'url'), base);
      if (url) return url;
    }
  return null;
}

// RSS 2.0 o Atom → [{ id, title, url, date, text, image }]. Lo que no se entiende se descarta.
export function parseFeed(xml, base) {
  const source = String(xml ?? '');
  const atom = /<feed\b/i.test(source) && !/<rss\b/i.test(source);
  const blocks = source.match(atom ? /<entry\b[\s\S]*?<\/entry>/gi : /<item\b[\s\S]*?<\/item>/gi) ?? [];
  const items = [];
  for (const block of blocks) {
    let url;
    if (atom) {
      const links = elements(block, 'link');
      const link = links.find((item) => ['', 'alternate'].includes(attribute(item, 'rel'))) ?? links[0];
      url = safeUrl(link ? attribute(link, 'href') : '', base);
    } else url = safeUrl(tag(block, 'link') || attribute(elements(block, 'atom:link')[0] ?? '', 'href'), base);
    const body = atom
      ? tag(block, 'content') || tag(block, 'summary') || tag(block, 'media:description')
      : tag(block, 'content:encoded') || tag(block, 'description');
    const text = plainText(body);
    // Bluesky no pone título: se usa el comienzo del texto.
    const title = plainText(tag(block, 'title'), 200) || plainText(body, 140);
    const date = isoDate(
      atom ? tag(block, 'published') || tag(block, 'updated') : tag(block, 'pubDate') || tag(block, 'dc:date')
    );
    const id = tag(block, atom ? 'id' : 'guid') || url;
    if (!title || !url || !date) continue;
    items.push({ id, title, url, date, text, image: mediaImage(block, base) ?? firstImageIn(body, base) });
  }
  return items;
}

export const looksLikeFeed = (text) =>
  /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(text);

// Feeds que declara una página: <link rel="alternate" type="application/rss+xml" href="…">.
export function discoverFeeds(html, base) {
  const found = [];
  for (const element of String(html ?? '').match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attribute(element, 'rel').toLowerCase().split(/\s+/);
    const type = attribute(element, 'type').toLowerCase();
    if (!rel.includes('alternate') || !/^application\/(rss|atom)\+xml$/.test(type)) continue;
    const url = safeUrl(attribute(element, 'href'), base);
    // Los feeds de comentarios no son novedades.
    if (url && !/comments?\/feed|\/comments\b/i.test(url) && !found.includes(url)) found.push(url);
  }
  return found;
}

// Noticias de Steam (ISteamNews/GetNewsForApp). Sólo las del propio juego: feed_type 1 son los anuncios de la
// comunidad de Steam; el resto son notas de sitios externos que Steam mezcla en el mismo feed.
const STEAM_CLAN = 'https://clan.akamai.steamstatic.com/images';
export function parseSteamNews(json) {
  return (json?.appnews?.newsitems ?? [])
    .filter((item) => item && (item.feed_type === 1 || item.feedname === 'steam_community_announcements'))
    .map((item) => {
      const contents = String(item.contents ?? '');
      const clan = /\{STEAM_CLAN_IMAGE\}(\/[^\s"'[\]<>]+)/.exec(contents);
      const image = clan
        ? httpsImage(STEAM_CLAN + clan[1])
        : (httpsImage(/\[img\](https:[^[\]\s]+)\[\/img\]/i.exec(contents)?.[1]) ?? firstImageIn(contents));
      return {
        id: 'steam:' + item.gid,
        title: plainText(item.title, 200),
        url: safeUrl(item.url),
        date: isoDate(Number(item.date) * 1000),
        text: plainText(contents),
        image,
        tags: Array.isArray(item.tags) ? item.tags.map(String) : []
      };
    })
    .filter((item) => item.title && item.url && item.date);
}

// ── Tipo de novedad ──────────────────────────────────────────────
// Reglas simples sobre título y texto, en inglés y en español. El orden importa: una oferta que menciona un parche
// sigue siendo una oferta.
const RULES = [
  ['offer', /\b(on sale|discount|descuento|rebajad[oa]s?|rebajas?|ofertas?|\d+\s?% off|precio especial)\b/],
  [
    'update',
    /\b(patch(?:es)?|hotfix|update|updated|changelog|parches?|actualizaci[oó]n|notas del parche|patch notes|v\d+\.\d+|versi[oó]n \d)/
  ],
  ['content', /\b(dlc|expansi[oó]n|expansion|season \d|season pass|temporada|new mode|nuevo modo|free content)\b/],
  ['event', /\b(free weekend|fin de semana gratis|event|evento|tournament|torneo|playtest)\b/]
];
export const TYPES = {
  update: 'Actualización',
  content: 'Contenido',
  announcement: 'Anuncio',
  event: 'Evento',
  press: 'Prensa',
  community: 'Comunidad',
  offer: 'Oferta'
};
export function classify({ title = '', text = '', tags = [] }, layer = 'official') {
  if (layer === 'local') return 'update';
  if (layer === 'press') return 'press';
  if (layer === 'community') return 'community';
  if (tags.includes('patchnotes')) return 'update';
  const haystack = (title + ' ' + text.slice(0, 300)).toLowerCase();
  return RULES.find(([, rule]) => rule.test(haystack))?.[0] ?? 'announcement';
}

// ── ¿La nota habla del juego? ────────────────────────────────────
export const normalizeText = (text) =>
  ' ' +
  String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() +
  ' ';

// Un nombre corto o de una sola palabra («Control», «Prey», «Inside») se confunde con cualquier nota: además del
// nombre, la nota tiene que nombrar al estudio o a la distribuidora.
export const ambiguousName = (name) => {
  const clean = normalizeText(name).trim();
  return !clean.includes(' ') || clean.length <= 6;
};

// matcher({ names, studios }) → (item) => true si el título o el comienzo del texto nombran el juego.
export function pressMatcher({ names = [], studios = [] }) {
  const variants = [...new Set(names.map(normalizeText).filter((name) => name.trim().length >= 3))];
  const exact = variants.filter((name) => !ambiguousName(name));
  const loose = variants.filter((name) => ambiguousName(name));
  const studioNames = [...new Set(studios.map(normalizeText).filter((name) => name.trim().length >= 3))];
  return ({ title = '', text = '' }) => {
    const head = normalizeText(title + ' ' + text.slice(0, 400));
    if (exact.some((name) => head.includes(name))) return true;
    if (!loose.some((name) => head.includes(name))) return false;
    const wide = normalizeText(title + ' ' + text);
    return studioNames.some((name) => wide.includes(name));
  };
}

// Misma historia, distinto medio: títulos que normalizados quedan iguales.
export const titleKey = (title) => normalizeText(title).trim();

// Buscador abierto de noticias (GDELT DOC 2.0, modo ArtList): [{ id, title, url, date, text, image, source }].
export function parseGdelt(json) {
  return (json?.articles ?? [])
    .map((article) => {
      const seen = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(article?.seendate ?? ''));
      const url = safeUrl(article?.url);
      return {
        id: url,
        title: plainText(article?.title, 200),
        url,
        date: seen ? `${seen[1]}-${seen[2]}-${seen[3]}T${seen[4]}:${seen[5]}:${seen[6]}.000Z` : null,
        text: '',
        image: httpsImage(article?.socialimage),
        source: String(article?.domain ?? '').replace(/^www\./, '') || 'Prensa'
      };
    })
    .filter((item) => item.title && item.url && item.date);
}
