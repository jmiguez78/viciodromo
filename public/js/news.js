// Novedades de los juegos que seguís (ver src/news.mjs): botón Seguir de la ficha, pestaña «Novedades» y el punto
// con las novedades sin leer en las portadas.
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
  offer: 'Oferta'
};
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
  feed: 'Un feed que agregaste a mano.',
  press: '3DJuegos, Vandal, IGN Latinoamérica y Eurogamer.es: sólo las notas que nombran el juego.',
  local: 'Avisa cuando Steam instala una versión nueva en esta PC.'
};

let summary = { follows: new Set(), unread: {}, refreshedAt: null };
const gameUrl = (key) => '/api/news/game/' + encodeURIComponent(key);
export const isFollowed = (key) => summary.follows.has(key);
export const unreadFor = (key) => summary.unread[key] ?? 0;
const canFollow = (game) => game && game.platform !== 'Arcade';

const dateText = (value) =>
  new Date(value).toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' });

function applySummary(data) {
  if (!data) return;
  summary = { follows: new Set(data.follows ?? []), unread: data.unread ?? {}, refreshedAt: data.refreshedAt ?? null };
  paintBadges();
  paintFollowButtons();
}

export async function loadSummary() {
  try {
    applySummary(await request('/api/news'));
  } catch {
    /* sin servidor: las portadas quedan sin punto */
  }
}

// ── Punto en las portadas ─────────────────────────────────────────
let painting = 0;
export function paintBadges() {
  cancelAnimationFrame(painting);
  painting = requestAnimationFrame(() => {
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
        dot.textContent = count > 9 ? '9+' : String(count);
        dot.title = text;
        dot.setAttribute('aria-label', text);
        dot.setAttribute('role', 'img');
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
    button.setAttribute('aria-pressed', String(followed));
    button.querySelector('span').textContent = followed ? 'Siguiendo' : 'Seguir';
    button.querySelector('.icon').setAttribute('fill', followed ? 'currentColor' : 'none');
    button.title = followed
      ? 'Dejar de seguir las novedades de ' + game.name
      : 'Seguir las novedades de ' + game.name + ': parches, anuncios y prensa';
  });
}
function paintFollowButtons() {
  const aside = document.querySelector('#game-aside');
  const game = state.games.find((item) => item.key === aside?.dataset.key);
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
          (data.items.length
            ? data.items.length + (data.items.length === 1 ? ' novedad' : ' novedades')
            : 'todavía sin novedades') +
          ' de ' +
          sourceCount(data) +
          (sourceCount(data) === 1 ? ' fuente.' : ' fuentes.'),
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

// ── Pestaña Novedades ────────────────────────────────────────────
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function itemCard(item, game, body) {
  const article = el('article', 'news-item' + (item.unread ? ' unread' : ''));
  article.dataset.layer = item.layer;
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
  meta.append(el('span', '', item.sourceLabel + ' · ' + dateText(item.date)));
  const title = el('h4', 'news-title');
  const link = el('a', '', item.title);
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  title.append(link);
  content.append(meta, title);
  if (item.text && item.text !== item.title) content.append(el('p', 'news-excerpt', item.text));
  const hide = el('button', 'text-button news-hide', 'Ocultar');
  hide.type = 'button';
  hide.setAttribute('aria-label', 'Ocultar «' + item.title + '»');
  hide.onclick = async () => {
    try {
      render(
        body,
        game,
        await request(gameUrl(game.key) + '/items/' + encodeURIComponent(item.id) + '/hide', { method: 'POST' })
      );
    } catch (error) {
      notifyError(error);
    }
  };
  content.append(hide);
  article.append(content);
  return article;
}

function sourcesPanel(data, game, body) {
  const details = el('details', 'news-sources');
  const active = sourceCount(data);
  details.append(el('summary', '', 'Fuentes (' + active + (active === 1 ? ' activa)' : ' activas)')));
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
          await request(gameUrl(game.key) + '/sources/' + encodeURIComponent(source.id), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: box.checked })
          }),
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
    if (source.url && source.kind !== 'press') {
      const open = el('a', 'text-button', 'Abrir');
      open.href = source.kind === 'bluesky' ? source.url.replace(/\/rss$/, '') : source.url;
      open.target = '_blank';
      open.rel = 'noopener noreferrer';
      open.setAttribute('aria-label', 'Abrir ' + source.label);
      item.append(open);
    }
    list.append(item);
  }
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
      render(
        body,
        game,
        await request(gameUrl(game.key) + '/sources', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ url: input.value })
        }),
        { sourcesOpen: true }
      );
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
  body.setAttribute('aria-busy', 'false');
  if (!data.followed) {
    const empty = el('div', 'news-empty');
    empty.append(
      el(
        'p',
        'detail-empty',
        'Seguí este juego para juntar acá sus parches, anuncios y notas de prensa. Viciódromo busca en Wikidata ' +
          'dónde publica novedades (sitio oficial, Bluesky, YouTube, Steam) y las suma a lo que dicen 3DJuegos, ' +
          'Vandal, IGN Latinoamérica y Eurogamer.es.'
      )
    );
    const follow = el('button', 'button primary');
    follow.type = 'button';
    follow.innerHTML = icon('pin') + '<span>Seguir ' + '</span>';
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
    (data.items.length
      ? data.items.length + (data.items.length === 1 ? ' novedad' : ' novedades')
      : 'Todavía no hay novedades') +
      ' · ' +
      sourceCount(data) +
      (sourceCount(data) === 1 ? ' fuente activa' : ' fuentes activas') +
      (data.checkedAt
        ? ' · revisado el ' +
          new Date(data.checkedAt).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })
        : '')
  );
  status.setAttribute('role', 'status');
  const again = el('button', 'button');
  again.type = 'button';
  again.innerHTML = icon('refresh') + ' Buscar de nuevo';
  again.onclick = async () => {
    again.disabled = true;
    again.classList.add('busy');
    try {
      render(body, game, await request(gameUrl(game.key) + '/refresh', { method: 'POST' }));
      loadSummary();
    } catch (error) {
      again.disabled = false;
      again.classList.remove('busy');
      notifyError(error);
    }
  };
  const stop = el('button', 'text-button', 'Dejar de seguir');
  stop.type = 'button';
  stop.onclick = () => toggleFollow(game);
  toolbar.append(status, again, stop);
  body.append(toolbar, sourcesPanel(data, game, body));
  if (sourcesOpen) body.querySelector('.news-sources').open = true;
  if (!data.items.length) {
    body.append(
      el(
        'p',
        'detail-empty',
        'Cuando el estudio publique algo o la prensa hable del juego, aparece acá. Viciódromo revisa al abrirse y cada seis horas.'
      )
    );
    return;
  }
  const list = el('div', 'news-list');
  data.items.forEach((item) => list.append(itemCard(item, game, body)));
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

export function setup() {
  loadSummary();
  window.addEventListener('gml-news', (event) => applySummary(event.detail));
  // Portadas nuevas (Inicio, Biblioteca, listas): el punto se pinta cuando aparecen.
  new MutationObserver((changes) => {
    if (Object.keys(summary.unread).length && changes.some((change) => change.addedNodes.length)) paintBadges();
  }).observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true });
}
