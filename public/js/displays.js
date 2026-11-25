// Monitor de cada juego: los monitores conectados, el botón Jugar ▾ de la página del juego (jugar en otro monitor
// sólo esta vez) y el selector de Editar (monitor predeterminado). Sólo en la aplicación de escritorio de Windows con
// más de un monitor (ver src/displays.mjs).
import { escapeHtml, request } from './api.js';
import { icon } from './icons.js';
import { playGame } from './launch.js';
import { state } from './state.js';

export const displays = { supported: false, list: [] };

// Avisa con «gml-displays» para que la página del juego muestre (o saque) el menú de monitores.
export async function loadDisplays() {
  const before = JSON.stringify(displays);
  try {
    const data = await request('/api/displays');
    displays.supported = data.supported === true;
    displays.list = Array.isArray(data.displays) ? data.displays : [];
  } catch {
    displays.supported = false;
    displays.list = [];
  }
  if (JSON.stringify(displays) !== before) window.dispatchEvent(new Event('gml-displays'));
  return displays;
}

export const displayRefOf = (display) => ({ id: display.id, label: display.label || display.name });

// Por identificador o, si Windows lo cambió, por nombre.
export function findDisplay(ref) {
  if (!ref) return null;
  return (
    displays.list.find((item) => ref.id && item.id === ref.id) ||
    displays.list.find((item) => ref.label && (item.label === ref.label || item.name === ref.label)) ||
    null
  );
}

const primaryDisplay = () => displays.list.find((item) => item.primary) ?? null;

// El monitor donde abre Jugar: el predeterminado del juego si está conectado; si no, el principal.
export function defaultDisplay(game) {
  return findDisplay(game.display) ?? primaryDisplay();
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
// Con más de un monitor, el botón Jugar de la página del juego suma una flecha con los monitores.
export function playSplitHtml(game, playHtml) {
  if (!displays.supported || game.installed === false || !game.launch?.available) return playHtml;
  return (
    '<div class="play-split">' +
    playHtml +
    '<button type="button" class="button play play-more" data-play-menu aria-haspopup="menu" aria-expanded="false"' +
    ' aria-label="Jugar en otro monitor" title="Jugar en otro monitor">' +
    icon('chevronDown') +
    '</button><div class="play-menu" role="menu" aria-label="Jugar en" hidden></div></div>'
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
  menu.innerHTML = displays.list
    .map(
      (display) =>
        '<button type="button" role="menuitemradio" class="play-menu-item" data-display="' +
        escapeHtml(display.id) +
        '" aria-checked="' +
        String(display === current) +
        '" tabindex="-1"><span>' +
        escapeHtml(display.name) +
        '</span><small>' +
        escapeHtml(
          [display.primary ? 'principal' : '', display === current ? 'predeterminado' : ''].filter(Boolean).join(' · ')
        ) +
        '</small>' +
        icon('check') +
        '</button>'
    )
    .join('');
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
  (menu.querySelector('[aria-checked=true]') ?? menu.querySelector('[role=menuitemradio]'))?.focus();
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
      const items = [...openMenu.menu.querySelectorAll('[role=menuitemradio]')];
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
  // Al volver a la ventana, un monitor pudo conectarse o desconectarse.
  window.addEventListener('focus', () => {
    if (state.page === 'game') loadDisplays();
  });
}
