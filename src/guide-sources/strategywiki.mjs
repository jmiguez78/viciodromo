// Fuente libre StrategyWiki (CC BY-SA 4.0 / 3.0) vía API de MediaWiki: búsqueda, comprobación en lotes para la
// búsqueda nocturna y descarga por subpáginas o encabezados con atribución visible.
import { htmlToMarkdown, sanitizeSectionTitle, splitHtmlIntoSections } from '../guide-sanitize.mjs';

export const STRATEGYWIKI_API = 'https://strategywiki.org/w/api.php';
export const STRATEGYWIKI_BASE = 'https://strategywiki.org';
const USER_AGENT = 'Viciodromo/0.46 (lanzador de juegos para Windows; https://github.com/jmiguez78/viciodromo)';
const CC4_CUTOFF_MS = Date.parse('2024-10-01T00:00:00.000Z');
const IGNORED_SUBPAGES = new Set(['table of contents', 'table_of_contents', 'special', 'category', 'file']);

export function normalizeTitle(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[®™©]/g, '')
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function candidateNames(game) {
  const raw = [game?.name, game?.originalName, game?.arcade?.description];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const clean = item.replace(/\s*\([^)]*\)\s*$/g, '').trim();
    const norm = normalizeTitle(clean);
    if (norm.length >= 2 && !seen.has(norm)) {
      seen.add(norm);
      out.push(clean);
    }
  }
  return out;
}

export const wikiPageUrl = (pageTitle) =>
  `${STRATEGYWIKI_BASE}/wiki/${encodeURIComponent(String(pageTitle ?? '').replace(/ /g, '_')).replace(/%2F/g, '/')}`;

export function licenseForRevision(timestamp) {
  const ms = Date.parse(String(timestamp ?? ''));
  if (Number.isFinite(ms) && ms < CC4_CUTOFF_MS) return 'CC BY-SA 3.0';
  return 'CC BY-SA 4.0';
}

export function pickSearchMatch(results = [], candidates = []) {
  const norms = candidates.map(normalizeTitle).filter(Boolean);
  if (!norms.length || !Array.isArray(results)) return null;
  let best = null;
  for (const item of results) {
    const title = String(item?.title ?? '').trim();
    if (!title || /^(Talk|User|Template|Category|File|Help|StrategyWiki):/i.test(title)) continue;
    const normTitle = normalizeTitle(title);
    const normWalk = normalizeTitle(title.replace(/\/Walkthrough$/i, ''));
    let score = 0;
    for (const cand of norms) {
      if (normTitle === normalizeTitle(`${cand}/Walkthrough`) || (title.endsWith('/Walkthrough') && normWalk === cand))
        score = Math.max(score, 100);
      else if (normTitle === cand) score = Math.max(score, 90);
      else if (normTitle.startsWith(cand + ' ')) score = Math.max(score, 60);
    }
    if (score > 0 && (!best || score > best.score)) {
      best = {
        score,
        pageTitle: title,
        title,
        url: wikiPageUrl(title)
      };
    }
  }
  if (!best) return null;
  return { pageTitle: best.pageTitle, title: best.title, url: best.url };
}

export function extractWalkthroughSubpages(html, baseTitle, { max = 25 } = {}) {
  const cleanBase = String(baseTitle ?? '')
    .replace(/\/Walkthrough$/i, '')
    .replace(/ /g, '_');
  if (!cleanBase) return [];
  const prefix = '/wiki/' + cleanBase.toLowerCase() + '/';
  const seen = new Set();
  const pages = [];
  for (const match of String(html ?? '').matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi)) {
    let href = match[1];
    try {
      href = decodeURIComponent(href);
    } catch {
      continue;
    }
    if (!href.toLowerCase().startsWith(prefix)) continue;
    const rel = href.slice('/wiki/'.length).replace(/ /g, '_');
    const tail = rel.slice(cleanBase.length + 1);
    if (!tail || tail.includes(':') || IGNORED_SUBPAGES.has(tail.toLowerCase())) continue;
    if (!seen.has(rel)) {
      seen.add(rel);
      pages.push(rel.replace(/_/g, ' '));
      if (pages.length >= max) break;
    }
  }
  return pages;
}

function slugId(text) {
  return normalizeTitle(text).replace(/\s+/g, '-').slice(0, 48) || 'guia';
}

export function buildStrategyWikiGuide({
  gameKey,
  title,
  pageTitle,
  revision = null,
  timestamp = null,
  sections = [],
  retrievedAt = new Date().toISOString()
}) {
  return {
    id: 'sw-' + slugId(gameKey + '-' + pageTitle),
    gameKey,
    title: String(title || pageTitle).trim(),
    lang: 'en',
    source: {
      type: 'strategywiki',
      pageTitle,
      url: wikiPageUrl(pageTitle),
      authors: 'Colaboradores de StrategyWiki',
      license: licenseForRevision(timestamp),
      revision: Number.isFinite(Number(revision)) ? Number(revision) : null,
      retrievedAt
    },
    sections: sections.map((section, index) => ({
      id: section.id || 's' + String(index + 1).padStart(2, '0'),
      order: index + 1,
      title: sanitizeSectionTitle(section.title, `Tramo ${index + 1}`),
      solution: String(section.solution ?? '').trim()
    }))
  };
}

async function apiGet(params, { fetchImpl = globalThis.fetch, offline = false } = {}) {
  if (offline) throw new Error('Sin conexión (modo de prueba).');
  const url = `${STRATEGYWIKI_API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`;
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`StrategyWiki respondió ${response.status}.`);
  return response.json();
}

export async function searchStrategyWiki(game, { fetchImpl = globalThis.fetch, offline = false } = {}) {
  const candidates = candidateNames(game);
  if (!candidates.length) return { found: false };
  const data = await apiGet(
    { action: 'query', list: 'search', srnamespace: '0', srlimit: '10', srsearch: candidates[0] },
    { fetchImpl, offline }
  );
  const match = pickSearchMatch(data?.query?.search ?? [], candidates);
  return match ? { found: true, ...match } : { found: false };
}

export async function checkStrategyWikiBatch(games = [], { fetchImpl = globalThis.fetch, offline = false } = {}) {
  const result = new Map();
  if (offline || !games.length) return result;
  for (let i = 0; i < games.length; i += 20) {
    const slice = games.slice(i, i + 20);
    const titles = [];
    const lookup = new Map();
    for (const game of slice) {
      const name = candidateNames(game)[0];
      if (!name) continue;
      const base = name.replace(/ /g, '_');
      const walk = `${base}/Walkthrough`;
      titles.push(walk, base);
      lookup.set(walk.toLowerCase(), game.key);
      lookup.set(base.toLowerCase(), game.key);
    }
    if (!titles.length) continue;
    const data = await apiGet({ action: 'query', titles: titles.join('|'), redirects: '1' }, { fetchImpl, offline });
    const normalized = new Map((data?.query?.normalized ?? []).map((n) => [n.to, n.from]));
    const redirects = new Map((data?.query?.redirects ?? []).map((r) => [r.to, r.from]));
    for (const page of data?.query?.pages ?? []) {
      if (page.missing) continue;
      const original = redirects.get(page.title) ?? normalized.get(page.title) ?? page.title;
      const key =
        lookup.get(original.replace(/ /g, '_').toLowerCase()) ??
        lookup.get(page.title.replace(/ /g, '_').toLowerCase());
      if (!key) continue;
      const prev = result.get(key);
      if (!prev || page.title.endsWith('/Walkthrough')) {
        result.set(key, { available: true, pageTitle: page.title, url: wikiPageUrl(page.title) });
      }
    }
    for (const game of slice) {
      if (!result.has(game.key)) result.set(game.key, { available: false, pageTitle: null, url: null });
    }
  }
  return result;
}

async function parsePage(pageTitle, { fetchImpl, offline }) {
  const data = await apiGet(
    { action: 'parse', page: pageTitle, prop: 'text|revid|displaytitle', redirects: '1' },
    { fetchImpl, offline }
  );
  if (data?.error || !data?.parse?.text) {
    throw new Error(data?.error?.info || 'No se pudo descargar la página de StrategyWiki.');
  }
  return data.parse;
}

async function revisionTimestamp(pageTitle, { fetchImpl, offline }) {
  try {
    const data = await apiGet(
      { action: 'query', titles: pageTitle, prop: 'revisions', rvprop: 'timestamp', rvlimit: '1' },
      { fetchImpl, offline }
    );
    return data?.query?.pages?.[0]?.revisions?.[0]?.timestamp ?? null;
  } catch {
    return null;
  }
}

export async function downloadStrategyWikiGuide(
  game,
  {
    pageTitle = null,
    fetchImpl = globalThis.fetch,
    offline = false,
    pauseMs = 200,
    maxSubpages = 20,
    now = Date.now
  } = {}
) {
  let target = pageTitle;
  if (!target) {
    const search = await searchStrategyWiki(game, { fetchImpl, offline });
    if (!search.found) throw new Error('No se encontró una guía para este juego en StrategyWiki.');
    target = search.pageTitle;
  }
  const main = await parsePage(target, { fetchImpl, offline });
  const resolvedTitle = main.title || target;
  const timestamp = await revisionTimestamp(resolvedTitle, { fetchImpl, offline });
  const subpages = extractWalkthroughSubpages(main.text, resolvedTitle, { max: maxSubpages });
  let sections = [];
  if (subpages.length >= 2) {
    const pause = () => (pauseMs ? new Promise((resolve) => setTimeout(resolve, pauseMs)) : null);
    for (const sub of subpages) {
      try {
        await pause();
        const parsed = await parsePage(sub, { fetchImpl, offline });
        const md = htmlToMarkdown(parsed.text, { baseUrl: STRATEGYWIKI_BASE });
        if (!md) continue;
        const rawName = sub.includes('/') ? sub.split('/').slice(1).join(' · ') : sub;
        sections.push({ title: rawName.replace(/_/g, ' '), solution: md });
      } catch {
        /* una subpágina rota no frena el resto de la guía */
      }
    }
  }
  if (!sections.length) {
    sections = splitHtmlIntoSections(main.text, game.name, { baseUrl: STRATEGYWIKI_BASE });
  }
  if (!sections.length) throw new Error('La página de StrategyWiki no tenía contenido legible.');
  return buildStrategyWikiGuide({
    gameKey: game.key,
    title: game.name,
    pageTitle: resolvedTitle,
    revision: main.revid ?? null,
    timestamp,
    sections,
    retrievedAt: new Date(now()).toISOString().slice(0, 10)
  });
}
