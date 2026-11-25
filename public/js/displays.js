// Monitor de cada juego: los monitores conectados, las reglas por etiqueta (Configuración) y el selector de la
// ficha. Sólo en la aplicación de escritorio de Windows con más de un monitor (ver src/displays.mjs).
import { escapeHtml, request, tagsOf } from './api.js';
import { notify, notifyError } from './feedback.js';
import { hydrateIcons } from './icons.js';
import { state } from './state.js';

export const displays = { supported: false, list: [], rules: [] };

export async function loadDisplays() {
  try {
    const data = await request('/api/displays');
    displays.supported = data.supported === true;
    displays.list = Array.isArray(data.displays) ? data.displays : [];
  } catch {
    displays.supported = false;
    displays.list = [];
  }
  renderDisplayRules();
  return displays;
}

export function setDisplayRules(rules) {
  displays.rules = Array.isArray(rules) ? rules : [];
  renderDisplayRules();
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

export function displayLabel(display) {
  return (
    display.name +
    (display.primary ? ' · principal' : '') +
    (display.width && display.height ? ' · ' + display.width + '×' + display.height : '')
  );
}

// Opciones de un <select>: los monitores conectados y, si el guardado no está conectado, ese con su nombre
// (valor «saved»), así guardar la ficha no lo borra.
export function displayOptions(selected, { automatic } = {}) {
  const current = findDisplay(selected);
  const options = automatic ? ['<option value="">' + escapeHtml(automatic) + '</option>'] : [];
  for (const display of displays.list)
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

// El valor de un <select> de monitores, como se guarda; `saved` es lo que había.
export function displayFromValue(value, saved = null) {
  if (value === 'saved') return saved;
  const display = displays.list.find((item) => item.id === value);
  return display ? displayRefOf(display) : null;
}

// La primera regla por etiqueta que le corresponde al juego.
export function ruleFor(game, rules = displays.rules) {
  const tags = new Set(tagsOf(game).map((tag) => tag.toLowerCase()));
  return rules.find((rule) => tags.has(String(rule.tag).toLowerCase())) || null;
}

// Qué hace «Automático» con este juego, para la ayuda de la ficha.
export function automaticHint(game) {
  const rule = ruleFor(game);
  if (!rule) return 'Automático: se abre en el monitor principal, como siempre.';
  const target = findDisplay(rule.display);
  return (
    'Automático: por la etiqueta «' +
    rule.tag +
    '» va a ' +
    (target
      ? target.name
      : (rule.display.label || 'otro monitor') + ', que no está conectado (se abre en el principal)') +
    '.'
  );
}

function knownTags() {
  const tags = new Map();
  for (const game of state.games)
    for (const tag of tagsOf(game)) if (!tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
  return [...tags.values()].sort((a, b) => a.localeCompare(b, 'es'));
}

export function renderDisplayRules() {
  const row = document.querySelector('#displays-row');
  if (!row) return;
  row.hidden = !displays.supported && !displays.rules.length;
  const list = document.querySelector('#display-rules');
  document.querySelector('#display-rules-empty').hidden = displays.rules.length > 0;
  list.innerHTML = displays.rules
    .map(
      (rule, index) =>
        '<li class="display-rule" data-index="' +
        index +
        '"><input type="text" list="display-tag-options" maxlength="60" data-rule-tag value="' +
        escapeHtml(rule.tag) +
        '" aria-label="Etiqueta de la regla ' +
        (index + 1) +
        '" /><span class="display-rule-arrow" aria-hidden="true">→</span><select data-rule-display aria-label="Monitor de la regla ' +
        (index + 1) +
        '">' +
        displayOptions(rule.display) +
        '</select><button type="button" class="icon-btn" data-rule-remove aria-label="Quitar la regla «' +
        escapeHtml(rule.tag) +
        '»"><span data-icon="x"></span></button></li>'
    )
    .join('');
  hydrateIcons(list);
  const select = document.querySelector('#display-rule-display');
  const chosen = select.value;
  select.innerHTML = displayOptions(null);
  // Por defecto, el primer monitor que no es el principal (el caso típico: la tele).
  const fallback = displays.list.find((item) => !item.primary) ?? displays.list[0];
  select.value = displays.list.some((item) => item.id === chosen) ? chosen : (fallback?.id ?? '');
  document.querySelector('#display-rule-form button[type="submit"]').disabled = !displays.list.length;
}

async function saveRules(rules, message) {
  try {
    const settings = await request('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayRules: rules })
    });
    setDisplayRules(settings.displayRules);
    notify(message, { type: 'success' });
    return true;
  } catch (error) {
    renderDisplayRules();
    notifyError(error);
    return false;
  }
}

const sameTag = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Enlaces de eventos; se llama una vez desde main.js.
export function setup() {
  const row = document.querySelector('#displays-row');
  if (!row) return;
  // Las etiquetas sugeridas salen de la biblioteca, que puede cargarse después que Configuración.
  row.addEventListener('focusin', () => {
    document.querySelector('#display-tag-options').innerHTML = knownTags()
      .map((tag) => '<option value="' + escapeHtml(tag) + '"></option>')
      .join('');
  });
  const list = document.querySelector('#display-rules');
  list.addEventListener('change', (event) => {
    const item = event.target.closest('.display-rule');
    if (!item) return;
    const index = Number(item.dataset.index);
    const rules = displays.rules.map((rule) => ({ ...rule }));
    const rule = rules[index];
    if (!rule) return;
    if (event.target.matches('[data-rule-tag]')) {
      const tag = event.target.value.trim();
      if (!tag || rules.some((other, position) => position !== index && sameTag(other.tag, tag))) {
        notify(tag ? 'Ya hay una regla para «' + tag + '».' : 'La regla necesita una etiqueta.', { type: 'error' });
        renderDisplayRules();
        return;
      }
      rule.tag = tag;
    } else if (event.target.matches('[data-rule-display]')) {
      rule.display = displayFromValue(event.target.value, rule.display) ?? rule.display;
    } else return;
    saveRules(rules, 'Regla de «' + rule.tag + '» actualizada.');
  });
  list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-rule-remove]');
    if (!button) return;
    const index = Number(button.closest('.display-rule').dataset.index);
    const removed = displays.rules[index];
    if (!removed) return;
    saveRules(
      displays.rules.filter((_, position) => position !== index),
      'Se quitó la regla de «' + removed.tag + '».'
    );
  });
  document.querySelector('#display-rule-form').onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = document.querySelector('#display-rule-tag');
    const error = form.querySelector('.form-error');
    const tag = input.value.trim();
    const display = displayFromValue(document.querySelector('#display-rule-display').value);
    error.textContent = '';
    if (!tag) error.textContent = 'Escribí la etiqueta, por ejemplo Sim Racing.';
    else if (displays.rules.some((rule) => sameTag(rule.tag, tag)))
      error.textContent = 'Ya hay una regla para «' + tag + '». Cambiale el monitor en la lista.';
    else if (!display) error.textContent = 'Elegí un monitor.';
    if (error.textContent) {
      input.focus();
      return;
    }
    const saved = await saveRules(
      [...displays.rules, { tag, display }],
      'Los juegos con la etiqueta «' + tag + '» se van a abrir en ' + findDisplay(display).name + '.'
    );
    if (saved) input.value = '';
  };
}
