// Novedades de los juegos que seguís (ver src/news.mjs): botón Seguir de la ficha, pestaña «Novedades», la sección
// Novedades (bandeja con filtros), la fila de Inicio, Configuración → Novedades y el punto con las novedades sin leer
// en las portadas y en la barra lateral.
import { request } from './api.js';
import { notify, notifyError } from './feedback.js';
import { icon } from './icons.js';
import { state } from './state.js';

const TYPES = {
  update: 'Actualización',
  content: 'Contenido',
  announcement: 'Anuncio',
  event: 'Evento',
  press: 'Prensa',
  community: 'Comunidad',
  offer: 'Oferta'
};
const MODES = [
  ['official', 'Solo oficial', 'Lo que publica el estudio: Steam, su sitio, Bluesky y YouTube.'],
  ['press', 'Oficial y prensa', 'Además, las notas de los medios elegidos que nombran el juego.'],
  ['all', 'Todo', 'También las ofertas, lo más votado del subreddit y el buscador abierto de noticias (GDELT).']
];
const STATUS = {
  ok: '',
  error: 'No respondió en la última consulta.',
  'no-feed': 'El sitio no publica un feed.'
};
const KIND_HELP = {
  steam: 'Anuncios y notas de parche que el estudio publica en Steam.',
  site: 'El blog o las noticias del sitio oficial.',
  bluesky: 'Lo que publica la cuenta del estudio.',
  youtube: 'Tráilers y videos del canal del estudio.',
  reddit: 'Lo más votado de la semana en el subreddit. Entra con «Todo».',
  feed: 'Un feed que agregaste a mano.',
  local: 'Avisa cuando la tienda instala una versión nueva en esta PC.'
};

let summary = { follows: new Set(), muted: new Set(), unread: {}, refreshedAt: null };
const gameUrl = (key) => '/api/news/game/' + encodeURIComponent(key);
const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
export const isFollowed = (key) => summary.follows.has(key);
export const unreadFor = (key) => summary.unread[key] ?? 0;
export const totalUnread = () => Object.values(summary.unread).reduce((sum, count) => sum + count, 0);
const canFollow = (game) => game && game.platform !== 'Arcade';
const gameByKey = (key) => state.games.find((item) => item.key === key);

const dateText = (value) =>
  new Date(value).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });
const plural = (count, one, many) => count.toLocaleString('es-AR') + ' ' + (count === 1 ? one : many);

function applySummary(data) {
  if (!data) return;
  summary = {
    follows: new Set(data.follows ?? []),
    muted: new Set(data.muted ?? []),
    unread: data.unread ?? {},
    refreshedAt: data.refreshedAt ?? null
  };
  paintBadges();
  paintFollowButtons();
  window.dispatchEvent(new CustomEvent('gml-news-summary'));
}

export async function loadSummary() {
  try {
    applySummary(await request('/api/news'));
  } catch {
    /* sin servidor: las portadas quedan sin punto */
  }
}

// ── Punto en las portadas y en la barra lateral ─────────────────────
let painting = 0;
export function paintBadges() {
  cancelAnimationFrame(painting);
  painting = requestAnimationFrame(() => {
    const total = totalUnread();
    const nav = document.querySelector('#news-count');
    if (nav) {
      nav.textContent = total ? (total > 99 ? '99+' : String(total)) : '';
      nav
        .closest('.nav-item')
        ?.setAttribute('aria-label', total ? 'Novedades: ' + plural(total, 'sin leer', 'sin leer') : 'Novedades');
    }
    document.querySelectorAll('.news-dot').forEach((dot) => {
      const key = dot.closest('[data-key]')?.dataset.key;
      if (!unreadFor(key)) dot.remove();
    });
    for (const [key, count] of Object.entries(summary.unread)) {
      document.querySelectorAll('.poster[data-key="' + CSS.escape(key) + '"] .poster-art').forEach((art) => {
        let dot = art.querySelector('.news-dot');
        if (!dot) {
          dot = document.createElement('span');
          dot.className = 'news-dot';
          art.append(dot);
        }
        const text = count === 1 ? '1 novedad sin leer' : count + ' novedades sin leer';
        const label = count > 9 ? '9+' : String(count);
        if (dot.textContent !== label) dot.textContent = label;
        if (dot.title !== text) {
          dot.title = text;
          dot.setAttribute('aria-label', text);
          dot.setAttribute('role', 'img');
        }
      });
    }
  });
}

// ── Botón Seguir ─────────────────────────────────────────────────
export function followButtonHtml(game) {
  if (!canFollow(game)) return '';
  return (
    '<button type="button" class="button" data-action="follow">' +
    icon('pin', isFollowed(game.key)) +
    '<span></span></button>'
  );
}
export function decorateFollow(root, game) {
  root.querySelectorAll('[data-action=follow]').forEach((button) => {
    const followed = isFollowed(game.key);
    const muted = summary.muted.has(game.key);
    button.setAttribute('aria-pressed', String(followed));
    button.querySelector('span').textContent = followed ? (muted ? 'Silenciado' : 'Siguiendo') : 'Seguir';
    button.querySelector('.icon').setAttribute('fill', followed ? 'currentColor' : 'none');
    button.title = followed
      ? 'Dejar de seguir las novedades de ' + game.name
      : 'Seguir las novedades de ' + game.name + ': parches, anuncios y prensa';
  });
}
function paintFollowButtons() {
  const aside = document.querySelector('#game-aside');
  const game = gameByKey(aside?.dataset.key);
  if (game) decorateFollow(aside, game);
}

const sourceCount = (data) => data.sources.filter((source) => source.enabled && source.kind !== 'local').length;

export async function toggleFollow(game) {
  if (!canFollow(game)) return;
  const buttons = document.querySelectorAll(
    '#game-aside[data-key="' + CSS.escape(game.key) + '"] [data-action=follow]'
  );
  buttons.forEach((button) => (button.disabled = true));
  try {
    if (isFollowed(game.key)) {
      await request(gameUrl(game.key) + '/follow', { method: 'DELETE' });
      summary.follows.delete(game.key);
      delete summary.unread[game.key];
      notify('Dejaste de seguir ' + game.name + '.', { type: 'success' });
    } else {
      const notice = notify('Buscando dónde publica novedades ' + game.name + '…', { type: 'loading' });
      const data = await request(gameUrl(game.key) + '/follow', { method: 'POST' });
      summary.follows.add(game.key);
      notice.update(
        'Seguís ' +
          game.name +
          ': ' +
          (data.items.length ? plural(data.items.length, 'novedad', 'novedades') : 'todavía sin novedades') +
          ' de ' +
          plural(sourceCount(data), 'fuente oficial', 'fuentes oficiales') +
          (data.mode === 'official' ? '.' : ' y la prensa.'),
        { type: 'success', action: { label: 'Ver', run: () => openNewsTab() } }
      );
    }
  } catch (error) {
    notifyError(error);
  } finally {
    buttons.forEach((button) => (button.disabled = false));
    paintBadges();
    paintFollowButtons();
    refreshOpenTab(game);
  }
}
function openNewsTab() {
  document.querySelector('#game-main [role=tab][data-tab=news]')?.click();
}
function refreshOpenTab(game) {
  const body = document.querySelector('#game-main [data-news-panel]');
  if (body && !body.hidden) loadNewsTab(body, game, { force: true });
  else if (body) delete body.dataset.loaded;
}

// ── «Buscar de nuevo» ───────────────────────────────────────────────
// Mientras dura la consulta el ícono gira y el botón dice «Buscando…» (como mínimo un instante, para que se note
// aunque responda enseguida); al terminar, un aviso dice qué pasó y el botón vuelve a su estado.
const MIN_BUSY_MS = 700;
async function runRefresh(button, task) {
  if (button.classList.contains('busy')) return null;
  const label = button.querySelector('.label');
  button.classList.add('busy');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (label) label.textContent = 'Buscando…';
  const started = Date.now();
  try {
    const result = await task();
    const wait = MIN_BUSY_MS - (Date.now() - started);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return result;
  } finally {
    button.classList.remove('busy');
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (label) label.textContent = 'Buscar de nuevo';
  }
}
// «2 novedades nuevas.», «Sin novedades nuevas: ya tenés lo último.» y, si alguna fuente falló, cuántas.
export function refreshMessage(result) {
  const added = result?.added;
  const failed = result?.failed ?? 0;
  const text =
    added == null
      ? 'Búsqueda terminada.'
      : added
        ? plural(added, 'novedad nueva', 'novedades nuevas') + '.'
        : 'Sin novedades nuevas: ya tenés lo último.';
  return text + (failed ? ' ' + plural(failed, 'fuente no respondió', 'fuentes no respondieron') + '.' : '');
}
function refreshButton() {
  const button = el('button', 'button');
  button.type = 'button';
  button.innerHTML = icon('refresh') + '<span class="label">Buscar de nuevo</span>';
  return button;
}

// ── Tarjeta de una novedad (pestaña y sección) ───────────────────────
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const externalLink = (text, url, className = '') => {
  const link = el('a', className, text);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
};

// options.withGame: suma el nombre del juego (abre su página). options.onHide: después de ocultarla.
function itemCard(item, { withGame = false, onHide } = {}) {
  const article = el('article', 'news-item' + (item.unread ? ' unread' : ''));
  article.dataset.layer = item.layer;
  article.dataset.id = item.id;
  if (item.image) {
    const img = el('img', 'news-image');
    img.src = item.image;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => img.remove();
    article.append(img);
  }
  const content = el('div', 'news-content');
  const meta = el('p', 'news-meta');
  const type = el('span', 'news-type', TYPES[item.type] ?? 'Novedad');
  type.dataset.type = item.type;
  meta.append(type);
  if (item.unread) meta.append(el('span', 'news-new', 'Nueva'));
  // El nombre del juego abre su página; MAME (que no es un juego) va como texto.
  if (withGame && item.game && gameByKey(item.game.key)) {
    const game = el('button', 'text-button news-game', item.game.name);
    game.type = 'button';
    game.setAttribute('aria-label', 'Abrir la página de ' + item.game.name);
    game.onclick = () => window.GML?.openGamePage?.(gameByKey(item.game.key));
    meta.append(game);
  } else if (withGame && item.game) meta.append(el('strong', 'news-game', item.game.name));
  meta.append(el('span', '', item.sourceLabel + ' · ' + dateText(item.date)));
  const title = el('h4', 'news-title');
  // Las novedades locales de Epic y Xbox no tienen nota que abrir.
  title.append(item.url ? externalLink(item.title, item.url) : document.createTextNode(item.title));
  content.append(meta, title);
  if (item.text && item.text !== item.title) content.append(el('p', 'news-excerpt', item.text));
  const actions = el('div', 'news-actions');
  // La misma historia en otros medios: «También en Vandal y IGN».
  if (item.also?.length) {
    const also = el('p', 'news-also');
    also.append('También en ');
    item.also.forEach((entry, index) => {
      if (index) also.append(index === item.also.length - 1 ? ' y ' : ', ');
      also.append(externalLink(entry.sourceLabel, entry.url));
    });
    actions.append(also);
  }
  const hide = el('button', 'text-button news-hide', 'Ocultar');
  hide.type = 'button';
  hide.setAttribute('aria-label', 'Ocultar «' + item.title + '»');
  hide.onclick = async () => {
    const key = item.game?.key ?? article.closest('[data-news-key]')?.dataset.newsKey;
    try {
      const data = await request(gameUrl(key) + '/items/' + encodeURIComponent(item.id) + '/hide', {
        method: 'POST'
      });
      onHide?.(data);
    } catch (error) {
      notifyError(error);
    }
  };
  actions.append(hide);
  content.append(actions);
  article.append(content);
  return article;
}

// ── Pestaña Novedades de la ficha ─────────────────────────────────
function modeControl(data, onChange) {
  const group = el('div', 'segmented news-mode');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Qué novedades entran');
  for (const [mode, label, help] of MODES) {
    const button = el('button', '', label);
    button.type = 'button';
    button.title = help;
    button.dataset.mode = mode;
    button.setAttribute('aria-pressed', String(data.mode === mode));
    button.onclick = () => data.mode !== mode && onChange(mode);
    group.append(button);
  }
  return group;
}

function sourcesPanel(data, game, body) {
  const details = el('details', 'news-sources');
  const active = sourceCount(data);
  details.append(el('summary', '', 'Fuentes oficiales (' + plural(active, 'activa', 'activas') + ')'));
  const list = el('ul', 'news-source-list');
  for (const source of data.sources) {
    const item = el('li');
    const label = el('label', 'news-source');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = source.enabled;
    box.onchange = async () => {
      box.disabled = true;
      try {
        render(
          body,
          game,
          await request(
            gameUrl(game.key) + '/sources/' + encodeURIComponent(source.id),
            json('PUT', { enabled: box.checked })
          ),
          { sourcesOpen: true }
        );
      } catch (error) {
        box.checked = !box.checked;
        box.disabled = false;
        notifyError(error);
      }
    };
    const text = el('span', 'news-source-text');
    text.append(el('strong', '', source.label));
    const help = [KIND_HELP[source.kind], STATUS[source.status]].filter(Boolean).join(' ');
    if (help) text.append(el('small', '', help));
    label.append(box, text);
    item.append(label);
    if (source.url) {
      const open = externalLink(
        'Abrir',
        source.kind === 'bluesky' ? source.url.replace(/\/rss$/, '') : source.url,
        'text-button'
      );
      open.setAttribute('aria-label', 'Abrir ' + source.label);
      item.append(open);
    }
    list.append(item);
  }
  if (!data.sources.length)
    list.append(el('li', 'news-source-none', 'Wikidata no tiene canales de este juego. Agregá uno abajo.'));
  const form = el('form', 'news-add');
  const field = el(
    'label',
    'news-add-label',
    'Agregar una fuente: el blog del juego, su canal de YouTube, un perfil de Bluesky o la ficha de Steam'
  );
  const input = document.createElement('input');
  input.type = 'url';
  input.required = true;
  input.placeholder = 'https://';
  input.spellcheck = false;
  input.id = 'news-add-' + Math.random().toString(36).slice(2, 8);
  field.htmlFor = input.id;
  const add = el('button', 'button', 'Agregar');
  add.type = 'submit';
  form.append(field, input, add);
  form.onsubmit = async (event) => {
    event.preventDefault();
    add.disabled = true;
    add.textContent = 'Buscando…';
    try {
      render(body, game, await request(gameUrl(game.key) + '/sources', json('POST', { url: input.value })), {
        sourcesOpen: true
      });
      notify('Fuente agregada.', { type: 'success' });
    } catch (error) {
      add.disabled = false;
      add.textContent = 'Agregar';
      notifyError(error);
    }
  };
  details.append(list, form);
  return details;
}

function render(body, game, data, { sourcesOpen = false } = {}) {
  body.replaceChildren();
  body.dataset.newsKey = game.key;
  body.setAttribute('aria-busy', 'false');
  if (!data.followed) {
    const empty = el('div', 'news-empty');
    empty.append(
      el(
        'p',
        'detail-empty',
        'Seguí este juego para juntar acá sus parches, anuncios y notas de prensa. Viciódromo busca en Wikidata ' +
          'dónde publica novedades (sitio oficial, Bluesky, YouTube, Steam) y las suma a lo que dicen los medios ' +
          'que elegiste en Configuración → Novedades.'
      )
    );
    const follow = el('button', 'button primary');
    follow.type = 'button';
    follow.innerHTML = icon('pin') + '<span></span>';
    follow.querySelector('span').textContent = 'Seguir ' + game.name;
    follow.onclick = () => toggleFollow(game);
    empty.append(follow);
    body.append(empty);
    return;
  }
  const toolbar = el('div', 'capture-toolbar news-toolbar');
  const status = el(
    'p',
    'capture-summary',
    (data.items.length ? plural(data.items.length, 'novedad', 'novedades') : 'Todavía no hay novedades') +
      ' · ' +
      plural(sourceCount(data), 'fuente activa', 'fuentes activas') +
      (data.checkedAt
        ? ' · revisado el ' +
          new Date(data.checkedAt).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })
        : '')
  );
  status.setAttribute('role', 'status');
  const again = refreshButton();
  again.onclick = async () => {
    try {
      const next = await runRefresh(again, () => request(gameUrl(game.key) + '/refresh', { method: 'POST' }));
      if (!next) return;
      render(body, game, next);
      loadSummary();
      notify(refreshMessage(next), { type: next.failed ? 'info' : 'success' });
    } catch (error) {
      notifyError(error, () => again.click());
    }
  };
  toolbar.append(status, again);
  const controls = el('div', 'news-controls');
  controls.append(
    modeControl(data, async (mode) => {
      try {
        render(body, game, await request(gameUrl(game.key) + '/mode', json('PUT', { mode })));
      } catch (error) {
        notifyError(error);
      }
    })
  );
  const mute = el('button', 'text-button', data.mutedUntil ? 'Reactivar' : 'Silenciar 30 días');
  mute.type = 'button';
  mute.title = data.mutedUntil
    ? 'Silenciado hasta el ' + dateText(data.mutedUntil)
    : 'No consultar ni avisar novedades de este juego por 30 días';
  mute.onclick = async () => {
    try {
      render(body, game, await request(gameUrl(game.key) + '/mute', json('POST', { days: data.mutedUntil ? 0 : 30 })));
    } catch (error) {
      notifyError(error);
    }
  };
  const stop = el('button', 'text-button', 'Dejar de seguir');
  stop.type = 'button';
  stop.onclick = () => toggleFollow(game);
  controls.append(mute, stop);
  body.append(toolbar, controls);
  if (data.mutedUntil)
    body.append(
      el(
        'p',
        'news-muted',
        'Silenciado hasta el ' + dateText(data.mutedUntil) + ': no se consulta ni suma novedades sin leer.'
      )
    );
  body.append(sourcesPanel(data, game, body));
  if (sourcesOpen) body.querySelector('.news-sources').open = true;
  if (!data.items.length) {
    body.append(
      el(
        'p',
        'detail-empty',
        'Cuando el estudio publique algo o la prensa hable del juego, aparece acá. Viciódromo revisa al abrirse, ' +
          'cada seis horas y en la búsqueda nocturna.'
      )
    );
    return;
  }
  const list = el('div', 'news-list');
  data.items.forEach((item) => list.append(itemCard(item, { onHide: (next) => render(body, game, next) })));
  body.append(list);
}

// Se carga al abrir la pestaña; abrirla marca las novedades como leídas (las nuevas quedan resaltadas hasta salir).
export async function loadNewsTab(body, game, { force = false } = {}) {
  body.dataset.newsPanel = '';
  if (body.dataset.loaded === game.key && !force) return;
  body.dataset.loaded = game.key;
  body.setAttribute('aria-busy', 'true');
  if (!body.childElementCount) body.append(el('p', 'detail-empty', 'Buscando novedades…'));
  let data;
  try {
    data = await request(gameUrl(game.key));
  } catch (error) {
    delete body.dataset.loaded;
    body.replaceChildren(el('p', 'detail-empty', error.message));
    body.setAttribute('aria-busy', 'false');
    return;
  }
  render(body, game, data);
  if (data.followed && data.unread) {
    request(gameUrl(game.key) + '/read', { method: 'POST' })
      .then(() => {
        delete summary.unread[game.key];
        paintBadges();
      })
      .catch(() => {});
  }
}

// ── Sección Novedades (bandeja) ────────────────────────────────────
const inboxFilter = { type: '', game: '' };
export async function loadInbox() {
  const page = document.querySelector('#news-page');
  const list = page.querySelector('#news-inbox');
  list.setAttribute('aria-busy', 'true');
  let data;
  try {
    const query = new URLSearchParams();
    if (inboxFilter.type) query.set('type', inboxFilter.type);
    if (inboxFilter.game) query.set('game', inboxFilter.game);
    data = await request('/api/news/inbox' + (query.size ? '?' + query : ''));
  } catch (error) {
    list.setAttribute('aria-busy', 'false');
    list.replaceChildren(el('p', 'detail-empty', error.message));
    return;
  }
  list.setAttribute('aria-busy', 'false');
  // Filtros por tipo: sólo los tipos que hay, más «Todas».
  const types = page.querySelector('#news-types');
  types.replaceChildren();
  for (const [type, label] of [['', 'Todas'], ...Object.entries(TYPES).filter(([type]) => data.types.includes(type))]) {
    const chip = el('button', 'chip' + (inboxFilter.type === type ? ' active' : ''), label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(inboxFilter.type === type));
    chip.onclick = () => {
      inboxFilter.type = type;
      loadInbox();
    };
    types.append(chip);
  }
  const select = page.querySelector('#news-game');
  select.replaceChildren(el('option', '', 'Todos los juegos (' + data.follows.length + ')'));
  select.firstChild.value = '';
  for (const follow of data.follows) {
    const option = el(
      'option',
      '',
      follow.name + (follow.mutedUntil ? ' (silenciado)' : follow.unread ? ' · ' + follow.unread + ' sin leer' : '')
    );
    option.value = follow.key;
    select.append(option);
  }
  select.value = data.follows.some((follow) => follow.key === inboxFilter.game) ? inboxFilter.game : '';
  page.querySelector('#news-read-all').disabled = !data.unread;
  const status = page.querySelector('#news-status');
  status.textContent =
    (data.total ? plural(data.total, 'novedad', 'novedades') + ' de los últimos 60 días' : '') +
    (data.unread ? ' · ' + data.unread + ' sin leer' : '') +
    (data.refreshedAt
      ? (data.total ? ' · ' : '') +
        'revisado el ' +
        new Date(data.refreshedAt).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })
      : '');
  list.replaceChildren();
  if (!data.follows.length) {
    list.append(
      el(
        'p',
        'detail-empty',
        'Todavía no seguís ningún juego. Abrí la página de un juego y tocá Seguir: acá se juntan sus parches, ' +
          'anuncios y lo que dice la prensa.'
      )
    );
    return;
  }
  if (!data.items.length) {
    list.append(
      el(
        'p',
        'detail-empty',
        inboxFilter.type || inboxFilter.game
          ? 'No hay novedades con estos filtros en los últimos 60 días.'
          : 'Sin novedades en los últimos 60 días. Viciódromo revisa al abrirse, cada seis horas y en la búsqueda nocturna.'
      )
    );
    return;
  }
  data.items.forEach((item) => list.append(itemCard(item, { withGame: true, onHide: () => loadInbox() })));
}

// ── Fila de Inicio ─────────────────────────────────────────────────
let recent = { at: 0, items: [] };
export async function renderNewsShelf(host, visible = true) {
  if (!host) return;
  if (!visible || !summary.follows.size) {
    host.hidden = true;
    return;
  }
  if (Date.now() - recent.at > 60_000) {
    try {
      recent = { at: Date.now(), items: (await request('/api/news/inbox')).items.slice(0, 12) };
    } catch {
      recent = { at: Date.now(), items: [] };
    }
  }
  host.hidden = !recent.items.length;
  if (!recent.items.length) return host.replaceChildren();
  host.className = 'shelf news-shelf';
  host.setAttribute('aria-labelledby', 'shelf-news');
  host.innerHTML =
    '<header class="shelf-heading"><div><h2 id="shelf-news">Novedades de tus juegos</h2><p></p></div>' +
    '<button type="button" class="text-button" data-news-all>Ver todas</button></header>' +
    '<div class="news-track"></div>';
  const unread = recent.items.filter((item) => item.unread).length;
  host.querySelector('.shelf-heading p').textContent = unread
    ? plural(unread, 'novedad sin leer', 'novedades sin leer') + ' de los juegos que seguís.'
    : 'Lo último de los juegos que seguís.';
  host.querySelector('[data-news-all]').onclick = () => window.GML?.showPage?.('news');
  const track = host.querySelector('.news-track');
  for (const item of recent.items) {
    const target = gameByKey(item.game.key);
    let card;
    if (item.url) card = externalLink('', item.url, 'news-card' + (item.unread ? ' unread' : ''));
    else {
      card = el('button', 'news-card' + (item.unread ? ' unread' : ''));
      card.type = 'button';
      card.onclick = () => target && window.GML?.openGamePage?.(target);
    }
    card.setAttribute('aria-label', item.game.name + ': ' + item.title + ' (' + item.sourceLabel + ')');
    const art = el('span', 'news-card-art');
    if (item.image) {
      const img = el('img');
      img.src = item.image;
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => img.remove();
      art.append(img);
    }
    const type = el('span', 'news-type', TYPES[item.type] ?? 'Novedad');
    type.dataset.type = item.type;
    art.append(type);
    const text = el('span', 'news-card-text');
    text.append(
      el('strong', 'news-card-title', item.title),
      el('small', '', item.game.name + ' · ' + dateText(item.date))
    );
    card.append(art, text);
    track.append(card);
  }
}
const forgetShelf = () => (recent = { at: 0, items: [] });

// ── Configuración → Novedades ──────────────────────────────────────
export async function loadNewsSettings() {
  const host = document.querySelector('#news-settings');
  if (!host) return;
  let data;
  try {
    data = await request('/api/news/settings');
  } catch (error) {
    host.replaceChildren(el('p', 'form-error', error.message));
    return;
  }
  host.replaceChildren();
  const save = async (patch, input) => {
    input.disabled = true;
    try {
      await request('/api/news/settings', json('PUT', patch));
      forgetShelf();
    } catch (error) {
      input.checked = !input.checked;
      notifyError(error);
    } finally {
      input.disabled = false;
    }
  };
  for (const [lang, title] of [
    ['es', 'Medios en español'],
    ['en', 'Medios en inglés']
  ]) {
    const fieldset = el('fieldset', 'news-press');
    fieldset.append(el('legend', '', title));
    for (const feed of data.press.filter((item) => item.lang === lang)) {
      const label = el('label', 'news-check');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = feed.enabled;
      box.dataset.press = feed.id;
      box.onchange = () => save({ press: { [feed.id]: box.checked } }, box);
      label.append(box, el('span', '', feed.label));
      fieldset.append(label);
    }
    host.append(fieldset);
  }
  for (const [key, text] of [
    ['offers', 'Mostrar ofertas y descuentos'],
    ['autoFollow', 'Seguir solos los juegos que abrís (los del último mes)'],
    ['mameReleases', 'Avisar cuando sale una versión nueva de MAME']
  ]) {
    const label = el('label', 'switch');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.setAttribute('role', 'switch');
    box.checked = data[key];
    box.dataset.setting = key;
    box.onchange = () => save({ [key]: box.checked }, box);
    const track = el('span', 'switch-track');
    track.setAttribute('aria-hidden', 'true');
    label.append(box, track, el('span', '', text));
    host.append(label);
  }
}

export function setup() {
  loadSummary();
  window.addEventListener('gml-news', (event) => {
    applySummary(event.detail);
    forgetShelf();
    if (state.page === 'news') loadInbox();
  });
  const page = document.querySelector('#news-page');
  page?.querySelector('#news-game')?.addEventListener('change', (event) => {
    inboxFilter.game = event.target.value;
    loadInbox();
  });
  page?.querySelector('#news-read-all')?.addEventListener('click', async () => {
    try {
      await request('/api/news/read-all', { method: 'POST' });
      summary.unread = {};
      paintBadges();
      loadInbox();
    } catch (error) {
      notifyError(error);
    }
  });
  page?.querySelector('#news-refresh')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
      const result = await runRefresh(button, () => request('/api/news/refresh', { method: 'POST' }));
      if (!result) return;
      applySummary(result);
      forgetShelf();
      await loadInbox();
      notify(refreshMessage(result), { type: result.failed ? 'info' : 'success' });
    } catch (error) {
      notifyError(error, () => button.click());
    }
  });
  // Los cambios del propio punto no cuentan (si no, se pintaría sin fin).
  const isTile = (node) => node.nodeType === 1 && !node.classList.contains('news-dot') && !node.closest('.news-dot');
  new MutationObserver((changes) => {
    if (!Object.keys(summary.unread).length) return;
    if (changes.some((change) => [...change.addedNodes].some(isTile))) paintBadges();
  }).observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true });
}
