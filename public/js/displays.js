// Monitor de cada juego: los monitores conectados, el botón Jugar ▾ de la página del juego (jugar en otro monitor
// sólo esta vez), el selector de Editar (monitor predeterminado) y Configuración → Monitores (nombres propios,
// Identificar y olvidar los que ya no están). Sólo en la aplicación de escritorio de Windows con más de un monitor
// (ver src/displays.mjs).
import { escapeHtml, plural, request } from './api.js';
import { notify, notifyError } from './feedback.js';
import { icon } from './icons.js';
import { playGame } from './launch.js';
import { openGuideForGame, openGuideOverlayForGame } from './guides.js';
import { showPage } from './main.js';
import { state } from './state.js';

export const displays = { supported: false, identify: false, list: [], known: [] };

// Avisa con «gml-displays» para que la página del juego muestre (o saque) el menú de monitores.
export async function loadDisplays() {
  const before = JSON.stringify(displays);
  try {
    const data = await request('/api/displays');
    applyDisplays(data);
  } catch {
    applyDisplays({});
  }
  renderDisplaySettings();
  if (JSON.stringify(displays) !== before) window.dispatchEvent(new Event('gml-displays'));
  return displays;
}

function applyDisplays(data) {
  displays.supported = data.supported === true;
  displays.identify = data.identify === true;
  displays.list = Array.isArray(data.displays) ? data.displays : [];
  displays.known = Array.isArray(data.known) ? data.known : [];
}

// Lo que se guarda de un monitor (ver cleanDisplayRef en src/displays.mjs).
export const displayRefOf = (display) => ({
  id: display.id,
  label: display.label || display.detected || display.name,
  x: display.x,
  y: display.y,
  width: display.width,
  height: display.height
});

// Por identificador o, si Windows lo cambió, por nombre; entre dos monitores iguales, por resolución y posición
// (lo mismo que findDisplay en src/displays.mjs).
export function findDisplay(ref) {
  if (!ref) return null;
  const byId = ref.id && displays.list.find((item) => item.id === ref.id);
  if (byId) return byId;
  if (!ref.label) return null;
  const named = displays.list.filter((item) => item.label === ref.label || item.detected === ref.label);
  if (named.length < 2) return named[0] ?? null;
  const size = named.filter((item) => item.width === ref.width && item.height === ref.height);
  const place = size.find((item) => item.x === ref.x && item.y === ref.y);
  return place ?? (size.length === 1 ? size[0] : named[0]);
}

const primaryDisplay = () => displays.list.find((item) => item.primary) ?? null;

// El monitor donde abre Jugar: el predeterminado del juego si está conectado; si no, el principal.
export function defaultDisplay(game) {
  return findDisplay(game.display) ?? primaryDisplay();
}

// Otro monitor conectado para abrir la guía al lado del juego.
export function companionFor(game) {
  const current = defaultDisplay(game);
  return displays.list.find((item) => item.id !== current?.id) ?? null;
}

export function displayLabel(display) {
  return (
    display.name +
    (display.primary ? ' · principal' : '') +
    (display.width && display.height ? ' · ' + display.width + '×' + display.height : '')
  );
}

// Opciones del selector de Editar: el principal (sin elección guardada) y los demás monitores conectados; si el
// guardado no está conectado, ese con su nombre (valor «saved»), así guardar la ficha no lo borra.
export function displayOptions(selected) {
  const current = findDisplay(selected);
  const primary = primaryDisplay();
  const options = [
    '<option value="">' + escapeHtml(primary ? displayLabel(primary) : 'Monitor principal') + '</option>'
  ];
  for (const display of displays.list)
    if (!display.primary || current === display)
      options.push(
        '<option value="' +
          escapeHtml(display.id) +
          '"' +
          (current === display ? ' selected' : '') +
          '>' +
          escapeHtml(displayLabel(display)) +
          '</option>'
      );
  if (selected && !current)
    options.push(
      '<option value="saved" selected>' +
        escapeHtml((selected.label || 'Monitor guardado') + ' · no conectado') +
        '</option>'
    );
  return options.join('');
}

// El valor del selector, como se guarda; `saved` es lo que había. El principal se guarda como «sin elección».
export function displayFromValue(value, saved = null) {
  if (value === 'saved') return saved;
  const display = displays.list.find((item) => item.id === value);
  return display && !display.primary ? displayRefOf(display) : null;
}

// ── Jugar ▾ ─────────────────────────────────────────────────────
// El botón Jugar suma una flecha para elegir otro monitor (si hay más de uno), abrir la guía en la otra
// pantalla o lanzar el juego junto a la ventana flotante de guía (1 o más pantallas).
export function playSplitHtml(game, playHtml) {
  if (game.installed === false || !game.launch?.available) return playHtml;
  const label = displays.supported ? 'Jugar en otro monitor o con guía' : 'Más opciones para jugar';
  return (
    '<div class="play-split">' +
    playHtml +
    '<button type="button" class="button play play-more" data-play-menu aria-haspopup="menu" aria-expanded="false"' +
    ' aria-label="' +
    label +
    '" title="' +
    label +
    '">' +
    icon('chevronDown') +
    '</button><div class="play-menu" role="menu" aria-label="Opciones para jugar" hidden></div></div>'
  );
}

// Debajo de «Jugar», el monitor donde abre si no es el principal.
export function decoratePlay(root, game) {
  const button = root.querySelector('.play-split [data-action=play]');
  if (!button) return;
  const target = findDisplay(game.display);
  if (!target || target.primary) return;
  const small = document.createElement('small');
  small.className = 'play-target';
  small.textContent = target.name;
  button.querySelector('.label')?.append(small);
  button.setAttribute('aria-label', 'Jugar a ' + game.name + ' en ' + target.name);
}

function fillMenu(menu, game) {
  const current = defaultDisplay(game);
  const monitorItems = displays.supported
    ? displays.list.map(
        (display) =>
          '<button type="button" role="menuitemradio" class="play-menu-item" data-display="' +
          escapeHtml(display.id) +
          '" aria-checked="' +
          String(display === current) +
          '" tabindex="-1"><span>' +
          escapeHtml(display.name) +
          '</span><small>' +
          escapeHtml(
            [display.primary ? 'principal' : '', display === current ? 'predeterminado' : '']
              .filter(Boolean)
              .join(' · ')
          ) +
          '</small>' +
          icon('check') +
          '</button>'
      )
    : [];
  menu.innerHTML = monitorItems.join('');
  const companion = displays.supported ? companionFor(game) : null;
  if (companion)
    menu.insertAdjacentHTML(
      'beforeend',
      '<button type="button" role="menuitem" class="play-menu-item play-menu-link" data-play-guide tabindex="-1">' +
        '<span>Jugar con la guía</span><small>Guía en ' +
        escapeHtml(companion.name) +
        '</small></button>'
    );
  menu.insertAdjacentHTML(
    'beforeend',
    '<button type="button" role="menuitem" class="play-menu-item play-menu-link" data-play-overlay tabindex="-1">' +
      '<span>Jugar con ventana flotante</span><small>' +
      (displays.supported ? 'Siempre visible · ventana sin bordes' : 'Siempre visible · 1 pantalla') +
      '</small></button>'
  );
  // Mientras ningún monitor tenga nombre propio, el menú invita a ponérselo.
  if (displays.supported && !displays.list.some((display) => display.alias))
    menu.insertAdjacentHTML(
      'beforeend',
      '<button type="button" role="menuitem" class="play-menu-item play-menu-link" data-name-displays tabindex="-1">' +
        '<span>Ponerles nombre…</span></button>'
    );
}

let openMenu = null;

function closeMenu({ focus = false } = {}) {
  if (!openMenu) return;
  const { menu, toggle } = openMenu;
  openMenu = null;
  menu.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  if (focus) toggle.focus();
}

function showMenu(toggle) {
  const split = toggle.closest('.play-split');
  const key = toggle.closest('[data-key]')?.dataset.key;
  const game = state.games.find((item) => item.key === key);
  if (!split || !game) return;
  const menu = split.querySelector('.play-menu');
  fillMenu(menu, game);
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  openMenu = { menu, toggle, game };
  const focusItem = menu.querySelector('[aria-checked=true]') ?? menu.querySelector('[role^=menuitem]');
  focusItem?.focus();
}

export function setup() {
  document.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-play-menu]');
    if (toggle) {
      event.stopPropagation();
      if (openMenu?.toggle === toggle) closeMenu();
      else {
        closeMenu();
        showMenu(toggle);
      }
      return;
    }
    if (event.target.closest('[data-name-displays]')) {
      closeMenu();
      goToDisplays();
      return;
    }
    if (event.target.closest('[data-play-guide]') && openMenu) {
      const { game } = openMenu;
      const companion = companionFor(game);
      closeMenu();
      playGame(game);
      if (companion) openGuideForGame(game, { display: displayRefOf(companion), inactive: true });
      return;
    }
    if (event.target.closest('[data-play-overlay]') && openMenu) {
      const { game } = openMenu;
      closeMenu();
      playGame(game);
      openGuideOverlayForGame(game, { inactive: true });
      return;
    }
    const item = event.target.closest('.play-menu-item');
    if (item && openMenu) {
      const { game } = openMenu;
      const display = displays.list.find((entry) => entry.id === item.dataset.display);
      closeMenu();
      if (display) playGame(game, undefined, { display });
      return;
    }
    if (openMenu && !event.target.closest('.play-menu')) closeMenu();
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (!openMenu) return;
      const items = [...openMenu.menu.querySelectorAll('[role^=menuitem]')];
      const index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu({ focus: true });
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        items[(index + step + items.length) % items.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
      } else if (event.key === 'Tab') closeMenu();
    },
    true
  );
  setupDisplaySettings();
  // Al volver a la ventana, un monitor pudo conectarse o desconectarse.
  window.addEventListener('focus', () => {
    if (state.page === 'game') loadDisplays();
  });
}

// ── Configuración → Monitores ───────────────────────────────────
export function goToDisplays() {
  showPage('settings', { focus: false });
  const row = document.querySelector('#displays-row');
  row?.scrollIntoView({ block: 'center' });
  row?.querySelector('input, button')?.focus({ preventScroll: true });
}

function gamesText(count) {
  return count ? plural(count, 'juego abre acá', 'juegos abren acá') : '';
}

export function renderDisplaySettings() {
  const row = document.querySelector('#displays-row');
  if (!row) return;
  row.hidden = !displays.supported && !displays.known.length;
  if (row.contains(document.activeElement) && document.activeElement.matches('[data-alias]')) return;
  const connected = displays.list.map(
    (display) =>
      '<li class="display-item" data-id="' +
      escapeHtml(display.id) +
      '"><span class="display-number" aria-hidden="true">' +
      display.number +
      '</span><div class="display-fields"><input type="text" maxlength="40" data-alias value="' +
      escapeHtml(display.alias || '') +
      '" placeholder="' +
      escapeHtml(display.detected) +
      '" aria-label="Nombre del monitor ' +
      display.number +
      ' (' +
      escapeHtml(display.detected) +
      ')" /><small>' +
      escapeHtml(
        [
          display.alias ? display.detected : '',
          display.width && display.height ? display.width + '×' + display.height : '',
          display.primary ? 'principal' : '',
          gamesText(display.games)
        ]
          .filter(Boolean)
          .join(' · ')
      ) +
      '</small></div></li>'
  );
  const offline = displays.known.map(
    (display, index) =>
      '<li class="display-item offline" data-known="' +
      index +
      '"><span class="display-number" aria-hidden="true">–</span><div class="display-fields"><strong>' +
      escapeHtml(display.name) +
      '</strong><small>' +
      escapeHtml(['No conectado', gamesText(display.games)].filter(Boolean).join(' · ')) +
      '</small></div><button type="button" class="button small" data-forget aria-label="Olvidar ' +
      escapeHtml(display.name) +
      '">Olvidar</button></li>'
  );
  document.querySelector('#display-list').innerHTML = [...connected, ...offline].join('');
  document.querySelector('#display-identify').hidden = !displays.identify;
}

function setupDisplaySettings() {
  const list = document.querySelector('#display-list');
  if (!list) return;
  list.addEventListener('change', async (event) => {
    const input = event.target.closest('[data-alias]');
    if (!input) return;
    const display = displays.list.find((item) => item.id === input.closest('.display-item').dataset.id);
    if (!display) return;
    const alias = input.value.trim();
    try {
      const data = await request('/api/displays/alias', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display: displayRefOf(display), alias })
      });
      applyDisplays(data);
      input.blur();
      renderDisplaySettings();
      window.dispatchEvent(new Event('gml-displays'));
      notify(
        alias
          ? 'El monitor ' + display.number + ' ahora se llama «' + alias + '».'
          : 'El monitor ' + display.number + ' vuelve a su nombre de fábrica.',
        { type: 'success' }
      );
    } catch (error) {
      notifyError(error);
    }
  });
  list.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.matches('[data-alias]')) event.target.blur();
  });
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-forget]');
    if (!button) return;
    const display = displays.known[Number(button.closest('.display-item').dataset.known)];
    if (!display) return;
    try {
      const data = await request('/api/displays/forget', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ display })
      });
      applyDisplays(data);
      renderDisplaySettings();
      notify(
        display.games
          ? 'Se olvidó ' +
              display.name +
              ': ' +
              plural(display.games, 'juego vuelve', 'juegos vuelven') +
              ' al monitor principal.'
          : 'Se olvidó ' + display.name + '.',
        { type: 'success' }
      );
    } catch (error) {
      notifyError(error);
    }
  });
  document.querySelector('#display-identify').onclick = async () => {
    try {
      await request('/api/displays/identify', { method: 'POST' });
    } catch (error) {
      notifyError(error);
    }
  };
}

// No se pudo llevar el juego al monitor (evento «display» del servidor).
const failureText = {
  'no-window': 'no apareció su ventana a tiempo',
  'not-moved':
    'el juego no dejó mover su ventana (puede estar en pantalla completa exclusiva o abierto como administrador)',
  'no-folder': 'no se conoce su carpeta de instalación',
  'no-screen': 'Windows no informó esa pantalla',
  error: 'Windows no dejó usar el ayudante que mueve las ventanas'
};
export function describeDisplayFailure(event) {
  return (
    'No se pudo abrir ' +
    event.game +
    ' en ' +
    event.display +
    ': ' +
    (failureText[event.reason] ?? failureText.error) +
    '.'
  );
}
