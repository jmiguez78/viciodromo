// Guías de pistas y soluciones (Fases 1 a 4): enlaces directos en visor auxiliar o navegador, guías sin conexión
// (StrategyWiki e importación .txt/.md/.html), antispoiler por tramo, modo Pistas escalonadas, editor manual,
// IA opcional (pistear, preguntar, traducir), ventana flotante, QR celular, Continuar y modo sala con mando.
import { request } from './api.js';
import { openMediaViewer } from './details.js';
import { notify, notifyError } from './feedback.js';
import { icon } from './icons.js';

const guideUrl = (key) => '/api/guides/game/' + encodeURIComponent(key);
const jsonRequest = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});
const dateText = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' })
    : '';
const thumbUrl = (id) => '/api/screenshots/file/' + encodeURIComponent(id) + '?thumb=1';
const fullUrl = (id) => '/api/screenshots/file/' + encodeURIComponent(id);

let guideSummary = { withGuide: new Set(), available: new Set(), progress: {} };
export const hasGuide = (key) => guideSummary.withGuide.has(key);

function applyGuideSummary(data) {
  if (!data) return;
  guideSummary = {
    withGuide: new Set(data.withGuide ?? []),
    available: new Set(data.available ?? []),
    progress: data.progress && typeof data.progress === 'object' ? data.progress : {}
  };
  paintGuideBadges();
}

export async function loadGuideSummary() {
  try {
    applyGuideSummary(await request('/api/guides'));
  } catch {
    /* sin servidor: las portadas quedan sin insignia de guía */
  }
}

let paintingBadges = 0;
export function paintGuideBadges() {
  cancelAnimationFrame(paintingBadges);
  paintingBadges = requestAnimationFrame(() => {
    document.querySelectorAll('.guide-poster-badge').forEach((badge) => {
      const key = badge.closest('[data-key]')?.dataset.key;
      if (!hasGuide(key)) badge.remove();
    });
    for (const key of guideSummary.withGuide) {
      document.querySelectorAll('.poster[data-key="' + CSS.escape(key) + '"] .poster-art').forEach((art) => {
        if (art.querySelector('.guide-poster-badge')) return;
        const badge = document.createElement('span');
        badge.className = 'guide-poster-badge';
        badge.title = 'Con guía sin conexión';
        badge.setAttribute('aria-label', 'Con guía sin conexión');
        badge.setAttribute('role', 'img');
        badge.innerHTML = icon('book');
        art.append(badge);
      });
    }
    const continueTrack = document.querySelector('#home-shelves .shelf-track[data-shelf="continue"]');
    if (continueTrack) {
      continueTrack.querySelectorAll('.poster[data-key]').forEach((tile) => {
        const key = tile.dataset.key;
        const entry = guideSummary.progress[key];
        const parts = [];
        if (entry?.currentSection) parts.push(entry.currentSection);
        if (entry?.hintsViewed > 0) {
          parts.push(entry.hintsViewed + (entry.hintsViewed === 1 ? ' pista vista' : ' pistas vistas'));
        }
        const text = parts.join(' · ');
        const existing = tile.querySelector('.guide-continue-note');
        if (!text) {
          existing?.remove();
          return;
        }
        const note = existing || document.createElement('p');
        note.className = 'guide-continue-note';
        if (note.textContent !== text) note.textContent = text;
        if (!existing) tile.querySelector('.poster-body')?.append(note);
      });
    }
  });
}

function buildQrSvgElement(qr) {
  const quiet = 4;
  const total = qr.size + quiet * 2;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('class', 'guide-qr-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Código QR para abrir la guía en el celular');
  const bg = document.createElementNS(ns, 'rect');
  bg.setAttribute('width', String(total));
  bg.setAttribute('height', String(total));
  bg.setAttribute('fill', '#ffffff');
  svg.append(bg);
  const group = document.createElementNS(ns, 'g');
  group.setAttribute('fill', '#0b0c12');
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue;
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(c + quiet));
      rect.setAttribute('y', String(r + quiet));
      rect.setAttribute('width', '1');
      rect.setAttribute('height', '1');
      group.append(rect);
    }
  }
  svg.append(group);
  return svg;
}

let couchGuideDialog = null;

async function openCouchGuide(gameKey) {
  if (!gameKey) return;
  const couch = document.querySelector('#couch');
  if (!couch) return;
  if (!couchGuideDialog) {
    couchGuideDialog = document.createElement('dialog');
    couchGuideDialog.id = 'couch-guide-dialog';
    couchGuideDialog.className = 'couch-guide';
    couchGuideDialog.setAttribute('aria-modal', 'true');
    couchGuideDialog.setAttribute('aria-label', 'Guía del juego');
    couchGuideDialog.addEventListener('close', () => {
      document.querySelector('#couch .couch-sheet [data-action="guide"]')?.focus({ preventScroll: true });
    });
    couch.append(couchGuideDialog);
  }

  let data = null;
  let selectedId = null;
  let confirmSol = false;

  const renderDialog = () => {
    couchGuideDialog.replaceChildren();
    const shell = document.createElement('div');
    shell.className = 'couch-guide-shell';
    const head = document.createElement('header');
    head.className = 'couch-guide-head';
    const h2 = document.createElement('h2');
    h2.textContent = (data?.name || 'Juego') + ' · Guía';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'couch-action';
    closeBtn.textContent = 'Volver';
    closeBtn.onclick = () => couchGuideDialog.close();
    head.append(h2, closeBtn);

    const legend = document.createElement('p');
    legend.className = 'couch-guide-legend';
    legend.textContent =
      'LB / RB: cambiar tramo · ↑ / ↓: elegir · A: revelar · X: Pistas / Solución · Y: Acá estoy · B: volver';
    shell.append(head, legend);

    const sections = data?.activeGuide?.sections ?? [];
    if (!sections.length) {
      const card = document.createElement('div');
      card.className = 'couch-guide-card';
      const p = document.createElement('p');
      p.textContent = data?.progress?.currentSection
        ? 'Tramo guardado: ' + data.progress.currentSection + '. No hay guía sin conexión cargada para este juego.'
        : 'Este juego todavía no tiene una guía sin conexión cargada.';
      card.append(p);
      shell.append(card);
      couchGuideDialog.append(shell);
      closeBtn.focus({ preventScroll: true });
      return;
    }

    if (!selectedId || !sections.some((s) => s.id === selectedId)) {
      selectedId = data.progress.currentSectionId || sections[0].id;
    }
    const idx = Math.max(
      0,
      sections.findIndex((s) => s.id === selectedId)
    );
    const sec = sections[idx];
    const mode = data.progress.mode === 'solution' ? 'solution' : 'hints';

    const navBar = document.createElement('div');
    navBar.className = 'guide-overlay-row';
    const prevSec = document.createElement('button');
    prevSec.type = 'button';
    prevSec.className = 'couch-action';
    prevSec.textContent = '◀ Tramo anterior';
    prevSec.disabled = idx <= 0;
    prevSec.onclick = () => {
      selectedId = sections[idx - 1].id;
      renderDialog();
    };
    const nextSec = document.createElement('button');
    nextSec.type = 'button';
    nextSec.className = 'couch-action';
    nextSec.textContent = 'Siguiente tramo ▶';
    nextSec.disabled = idx >= sections.length - 1;
    nextSec.onclick = () => {
      selectedId = sections[idx + 1].id;
      renderDialog();
    };
    const hereBtn = document.createElement('button');
    hereBtn.type = 'button';
    hereBtn.className = 'couch-action';
    hereBtn.textContent = sec.id === data.progress.currentSectionId ? 'Estás acá' : 'Marcar «Acá estoy»';
    hereBtn.onclick = async () => {
      await request(guideUrl(gameKey) + '/progress', jsonRequest('PUT', { currentSectionId: sec.id }));
      data = await request(guideUrl(gameKey));
      renderDialog();
    };
    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.className = 'couch-action';
    modeBtn.textContent = mode === 'hints' ? 'Pasar a Solución' : 'Volver a Pistas';
    modeBtn.onclick = async () => {
      if (mode === 'solution') {
        await request(guideUrl(gameKey) + '/progress', jsonRequest('PUT', { mode: 'hints' }));
        data = await request(guideUrl(gameKey));
        confirmSol = false;
        renderDialog();
      } else if (data.progress.skipSpoilerConfirm || confirmSol) {
        await request(guideUrl(gameKey) + '/progress', jsonRequest('PUT', { mode: 'solution' }));
        data = await request(guideUrl(gameKey));
        confirmSol = false;
        renderDialog();
      } else {
        confirmSol = true;
        renderDialog();
      }
    };
    navBar.append(prevSec, nextSec, hereBtn, modeBtn);
    shell.append(navBar);

    if (confirmSol) {
      const warn = document.createElement('div');
      warn.className = 'couch-guide-card';
      const p = document.createElement('p');
      p.textContent = '¿Confirmás ver la Solución completa de este tramo?';
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'couch-action primary';
      ok.textContent = 'Sí, mostrar solución';
      ok.onclick = modeBtn.onclick;
      warn.append(p, ok);
      shell.append(warn);
    }

    const body = document.createElement('div');
    body.className = 'couch-guide-body';
    const card = document.createElement('section');
    card.className = 'couch-guide-card';
    const secTitle = document.createElement('h3');
    secTitle.textContent = sec.displayTitle + ' (' + (idx + 1) + ' de ' + sections.length + ')';
    card.append(secTitle);

    if (sec.locked) {
      const p = document.createElement('p');
      p.textContent = 'Tramo futuro oculto para evitar spoilers.';
      const unlock = document.createElement('button');
      unlock.type = 'button';
      unlock.className = 'couch-action primary';
      unlock.textContent = 'Mostrar este tramo';
      unlock.onclick = async () => {
        await request(guideUrl(gameKey) + '/progress', jsonRequest('PUT', { revealSectionId: sec.id }));
        data = await request(guideUrl(gameKey));
        renderDialog();
      };
      card.append(p, unlock);
    } else if (mode === 'solution') {
      const md = document.createElement('div');
      renderSafeMarkdown(md, sec.solution || 'Sin texto de solución.');
      card.append(md);
    } else {
      const qs = sec.questions ?? [];
      if (!qs.length) {
        const p = document.createElement('p');
        p.textContent = 'No hay preguntas con pistas en este tramo.';
        card.append(p);
      }
      qs.forEach((q) => {
        const qTitle = document.createElement('h3');
        qTitle.textContent = q.title;
        card.append(qTitle);
        if (q.visibleHints?.length) {
          const ol = document.createElement('ol');
          ol.className = 'couch-guide-hints';
          q.visibleHints.forEach((hint) => {
            const li = document.createElement('li');
            li.textContent = hint;
            ol.append(li);
          });
          card.append(ol);
        }
        if (q.answerRevealed && q.answerQuote) {
          const ans = document.createElement('div');
          ans.className = 'couch-guide-answer';
          ans.textContent = q.answerQuote;
          card.append(ans);
        }
        if (q.revealedCount < q.totalHints) {
          const next = document.createElement('button');
          next.type = 'button';
          next.className = 'couch-action primary';
          next.textContent = q.revealedCount === 0 ? 'Ver pista 1' : 'Otra pista';
          next.onclick = async () => {
            await request(
              guideUrl(gameKey) + '/progress',
              jsonRequest('PUT', {
                setHintCount: { sectionId: sec.id, questionId: q.id, count: q.revealedCount + 1 }
              })
            );
            data = await request(guideUrl(gameKey));
            renderDialog();
          };
          card.append(next);
        } else if (!q.answerRevealed) {
          const ansBtn = document.createElement('button');
          ansBtn.type = 'button';
          ansBtn.className = 'couch-action';
          ansBtn.textContent = 'Ver la respuesta';
          ansBtn.onclick = async () => {
            await request(
              guideUrl(gameKey) + '/progress',
              jsonRequest('PUT', { revealAnswer: { sectionId: sec.id, questionId: q.id } })
            );
            data = await request(guideUrl(gameKey));
            renderDialog();
          };
          card.append(ansBtn);
        }
      });
    }
    body.append(card);
    shell.append(body);
    couchGuideDialog.append(shell);
    (couchGuideDialog.querySelector('.couch-guide-body .couch-action') ?? closeBtn).focus({ preventScroll: true });
  };

  couchGuideDialog.onkeydown = (event) => {
    const sections = data?.activeGuide?.sections ?? [];
    if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'ContextMenu') {
      event.preventDefault();
      event.stopPropagation();
      couchGuideDialog.close();
      return;
    }
    if ((event.key === 'PageDown' || event.key === 'PageUp') && sections.length) {
      event.preventDefault();
      event.stopPropagation();
      const idx = Math.max(
        0,
        sections.findIndex((s) => s.id === selectedId)
      );
      const nextIdx = event.key === 'PageDown' ? Math.min(sections.length - 1, idx + 1) : Math.max(0, idx - 1);
      selectedId = sections[nextIdx].id;
      renderDialog();
      return;
    }
    if (event.key.toLowerCase() === 'f' && sections.length) {
      event.preventDefault();
      event.stopPropagation();
      couchGuideDialog
        .querySelector('.couch-guide-head + .couch-guide-legend + .guide-overlay-row button:last-child')
        ?.click();
      return;
    }
    if (event.key.toLowerCase() === 'y' && sections.length) {
      event.preventDefault();
      event.stopPropagation();
      const idx = Math.max(
        0,
        sections.findIndex((s) => s.id === selectedId)
      );
      request(guideUrl(gameKey) + '/progress', jsonRequest('PUT', { currentSectionId: sections[idx].id }))
        .then(() => request(guideUrl(gameKey)))
        .then((fresh) => {
          data = fresh;
          renderDialog();
        })
        .catch(() => {});
      return;
    }
    if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) {
      const buttons = [...couchGuideDialog.querySelectorAll('button:not(:disabled)')];
      if (!buttons.length) return;
      event.preventDefault();
      event.stopPropagation();
      const current = buttons.indexOf(document.activeElement);
      const step = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
      const target = current < 0 ? 0 : (current + step + buttons.length) % buttons.length;
      buttons[target]?.focus({ preventScroll: true });
    }
  };

  couchGuideDialog.replaceChildren();
  const loading = document.createElement('p');
  loading.textContent = 'Cargando guía…';
  couchGuideDialog.append(loading);
  couchGuideDialog.showModal();
  try {
    data = await request(guideUrl(gameKey));
    renderDialog();
  } catch (error) {
    couchGuideDialog.close();
    notifyError(error);
  }
}

function syncCouchGuideAction() {
  const sheet = document.querySelector('#couch .couch-sheet:not([hidden])');
  if (!sheet) return;
  const actions = sheet.querySelector('.couch-actions');
  if (!actions || actions.querySelector('[data-action="guide"]')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'couch-action';
  btn.dataset.action = 'guide';
  btn.textContent = 'Guía y pistas';
  btn.onclick = () => openCouchGuide(sheet.dataset.key);
  const backBtn = actions.querySelector('[data-action="back"]');
  if (backBtn) actions.insertBefore(btn, backBtn);
  else actions.append(btn);
}

export function setup() {
  loadGuideSummary();
  window.addEventListener('gml-guides', (event) => applyGuideSummary(event.detail));
  const isTile = (node) =>
    node.nodeType === 1 &&
    !node.classList.contains('guide-poster-badge') &&
    !node.classList.contains('guide-continue-note') &&
    !node.closest('.guide-poster-badge, .guide-continue-note');
  new MutationObserver((changes) => {
    if (changes.some((change) => [...change.addedNodes].some(isTile))) paintGuideBadges();
    syncCouchGuideAction();
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
}

export async function openGuideOverlayForGame(game, { inactive = false, toggle = false } = {}) {
  try {
    const result = await request(
      guideUrl(game.key) + '/overlay',
      jsonRequest('POST', {
        ...(inactive ? { inactive: true } : {}),
        ...(toggle ? { toggle: true } : {})
      })
    );
    if (result.opened === 'browser' && result.url && !inactive) {
      window.open(result.url, 'viciodromo-guide-overlay', 'width=440,height=640');
    }
    return result;
  } catch (error) {
    if (!inactive) notifyError(error);
    return null;
  }
}

export async function openGuideForGame(game, { url = null, display = null, inactive = false } = {}) {
  try {
    const result = await request(
      guideUrl(game.key) + '/open',
      jsonRequest('POST', {
        ...(url ? { url } : {}),
        ...(display ? { display } : {}),
        ...(inactive ? { inactive: true } : {})
      })
    );
    if (result.opened === 'external' && result.url && !inactive) {
      window.open(result.url, '_blank', 'noopener,noreferrer');
    }
    return result;
  } catch (error) {
    if (!inactive) notifyError(error);
    return null;
  }
}

function appendHighlightedText(parent, text, query) {
  const clean = String(text ?? '');
  const q = String(query ?? '').trim();
  if (q.length < 2) {
    parent.append(document.createTextNode(clean));
    return;
  }
  const lower = clean.toLowerCase();
  const needle = q.toLowerCase();
  let cursor = 0;
  let idx = lower.indexOf(needle, cursor);
  while (idx >= 0) {
    if (idx > cursor) parent.append(document.createTextNode(clean.slice(cursor, idx)));
    const mark = document.createElement('mark');
    mark.textContent = clean.slice(idx, idx + needle.length);
    parent.append(mark);
    cursor = idx + needle.length;
    idx = lower.indexOf(needle, cursor);
  }
  if (cursor < clean.length) parent.append(document.createTextNode(clean.slice(cursor)));
}

function appendInlineMarkdown(parent, text, query) {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)\s]+\))/g;
  let last = 0;
  for (const match of String(text ?? '').matchAll(pattern)) {
    if (match.index > last) appendHighlightedText(parent, text.slice(last, match.index), query);
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      const strong = document.createElement('strong');
      appendHighlightedText(strong, token.slice(2, -2), query);
      parent.append(strong);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const em = document.createElement('em');
      appendHighlightedText(em, token.slice(1, -1), query);
      parent.append(em);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      const code = document.createElement('code');
      appendHighlightedText(code, token.slice(1, -1), query);
      parent.append(code);
    } else {
      const linkMatch = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(token);
      if (linkMatch) {
        const a = document.createElement('a');
        a.href = linkMatch[2];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        appendHighlightedText(a, linkMatch[1], query);
        parent.append(a);
      } else {
        appendHighlightedText(parent, token, query);
      }
    }
    last = match.index + token.length;
  }
  if (last < String(text ?? '').length) appendHighlightedText(parent, text.slice(last), query);
}

// Render seguro de Markdown en DOM puro (nunca innerHTML con contenido externo).
function renderSafeMarkdown(container, markdown, query = '') {
  container.replaceChildren();
  const lines = String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let list = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInlineMarkdown(p, paragraph.join(' '), query);
    container.append(p);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    container.append(list);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const imgMatch = /^!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)$/.exec(line);
    if (imgMatch) {
      flushParagraph();
      flushList();
      const figure = document.createElement('figure');
      figure.className = 'guide-md-figure';
      const img = document.createElement('img');
      img.src = imgMatch[2];
      img.alt = imgMatch[1] || 'Imagen de la guía';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onerror = () => figure.remove();
      figure.append(img);
      container.append(figure);
      continue;
    }
    const headMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headMatch) {
      flushParagraph();
      flushList();
      const h = document.createElement(headMatch[1].length <= 2 ? 'h4' : 'h5');
      appendInlineMarkdown(h, headMatch[2], query);
      container.append(h);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      if (!list) list = document.createElement('ul');
      const li = document.createElement('li');
      appendInlineMarkdown(li, line.replace(/^[-*]\s+/, ''), query);
      list.append(li);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
}

function countOccurrences(text, query) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (q.length < 2 || !text) return 0;
  const hay = text.toLowerCase();
  let count = 0;
  let pos = hay.indexOf(q, 0);
  while (pos >= 0) {
    count += 1;
    pos = hay.indexOf(q, pos + q.length);
  }
  return count;
}

function originLabel(origin, edited, sourceType) {
  if (origin === 'ai') {
    const base = edited ? 'Pistas armadas con IA (editadas)' : 'Pistas armadas con IA';
    return sourceType === 'strategywiki' ? base + ' · CC BY-SA' : base;
  }
  if (origin === 'source') return 'De la guía';
  return 'Manual';
}

async function fetchGameImages(gameKey) {
  const data = await request('/api/screenshots/game/' + encodeURIComponent(gameKey));
  return (data?.items ?? []).filter((item) => item.kind !== 'video');
}

function renderCaptureThumb(id, gameName, triggerPictures) {
  const wrap = document.createElement('div');
  wrap.className = 'guide-note-capture';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'guide-capture-thumb';
  btn.setAttribute('aria-label', 'Ampliar captura adjunta');
  btn.setAttribute('aria-haspopup', 'dialog');
  const img = document.createElement('img');
  img.src = thumbUrl(id);
  img.alt = 'Captura adjunta de ' + gameName;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.onerror = () => {
    wrap.replaceChildren();
    const missing = document.createElement('span');
    missing.className = 'guide-capture-missing';
    missing.textContent = 'Captura no disponible';
    wrap.append(missing);
  };
  btn.onclick = () => {
    const pictures = triggerPictures();
    const index = Math.max(
      0,
      pictures.findIndex((item) => item.id === id)
    );
    openMediaViewer(pictures, index, gameName + ' · Nota', btn);
  };
  btn.append(img);
  wrap.append(btn);
  return wrap;
}

function buildCaptureSelector({ game, selectedIds, onChange }) {
  const box = document.createElement('div');
  box.className = 'guide-capture-picker';
  box.hidden = true;
  let loaded = false;

  const renderSelectedChips = (holder) => {
    holder.replaceChildren();
    selectedIds.forEach((id) => {
      const chip = document.createElement('span');
      chip.className = 'guide-selected-chip';
      const img = document.createElement('img');
      img.src = thumbUrl(id);
      img.alt = '';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-btn';
      remove.setAttribute('aria-label', 'Quitar captura');
      remove.innerHTML = icon('x');
      remove.onclick = () => {
        const idx = selectedIds.indexOf(id);
        if (idx >= 0) selectedIds.splice(idx, 1);
        renderSelectedChips(holder);
        syncGridButtons();
        onChange?.();
      };
      chip.append(img, remove);
      holder.append(chip);
    });
    holder.hidden = !selectedIds.length;
  };

  const syncGridButtons = () => {
    box.querySelectorAll('[data-capture-pick]').forEach((btn) => {
      const active = selectedIds.includes(btn.dataset.capturePick);
      btn.classList.toggle('selected', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  };

  async function toggle(chipsHost) {
    box.hidden = !box.hidden;
    if (box.hidden || loaded) return;
    loaded = true;
    box.innerHTML = '<p class="helper-text">Cargando capturas…</p>';
    try {
      const items = await fetchGameImages(game.key);
      box.replaceChildren();
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'helper-text';
        empty.textContent = 'Todavía no tenés capturas de este juego en Tus capturas.';
        box.append(empty);
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'guide-picker-grid';
      items.slice(0, 24).forEach((item) => {
        const pick = document.createElement('button');
        pick.type = 'button';
        pick.className = 'guide-picker-item';
        pick.dataset.capturePick = item.id;
        pick.setAttribute('aria-pressed', String(selectedIds.includes(item.id)));
        pick.setAttribute('aria-label', 'Adjuntar captura del ' + dateText(item.takenAt));
        const img = document.createElement('img');
        img.src = thumbUrl(item.id);
        img.alt = '';
        img.loading = 'lazy';
        pick.append(img);
        pick.onclick = () => {
          const idx = selectedIds.indexOf(item.id);
          if (idx >= 0) selectedIds.splice(idx, 1);
          else if (selectedIds.length < 8) selectedIds.push(item.id);
          else notify('Podés adjuntar hasta 8 capturas por nota.', { type: 'info' });
          renderSelectedChips(chipsHost);
          syncGridButtons();
          onChange?.();
        };
        grid.append(pick);
      });
      box.append(grid);
      syncGridButtons();
    } catch (error) {
      loaded = false;
      box.replaceChildren();
      const err = document.createElement('p');
      err.className = 'helper-text';
      err.textContent = error.message || 'No se pudieron cargar las capturas.';
      box.append(err);
    }
  }

  return { box, toggle, renderSelectedChips };
}

function buildQuestionForm({ initial = null, onCancel, onSubmit }) {
  const form = document.createElement('form');
  form.className = 'guide-question-form';
  const titleLabel = document.createElement('label');
  titleLabel.textContent = 'Pregunta (sin spoiler)';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.maxLength = 180;
  titleInput.required = true;
  titleInput.placeholder = 'Ej.: ¿Cómo abro la puerta sellada?';
  titleInput.value = initial?.title ?? '';

  const hintsInputs = [0, 1, 2].map((index) => {
    const label = document.createElement('label');
    label.textContent =
      index === 0 ? 'Pista 1 (vaga)' : index === 1 ? 'Pista 2 (más concreta)' : 'Pista 3 (casi la respuesta)';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 400;
    input.placeholder = index === 0 ? 'Obligatoria' : 'Opcional';
    input.value = initial?.hints?.[index] ?? '';
    return { label, input };
  });

  const answerLabel = document.createElement('label');
  answerLabel.textContent = 'Respuesta o fragmento de la solución';
  const answerInput = document.createElement('textarea');
  answerInput.rows = 3;
  answerInput.maxLength = 1200;
  answerInput.required = true;
  answerInput.placeholder = 'Respuesta completa o cita del tramo.';
  answerInput.value = initial?.answerQuote ?? '';

  const actions = document.createElement('div');
  actions.className = 'guide-note-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'button small';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.onclick = onCancel;
  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'button small primary';
  saveBtn.textContent = initial ? 'Guardar cambios' : 'Guardar pregunta';
  actions.append(cancelBtn, saveBtn);

  form.append(titleLabel, titleInput);
  hintsInputs.forEach(({ label, input }) => form.append(label, input));
  form.append(answerLabel, answerInput, actions);

  form.onsubmit = async (event) => {
    event.preventDefault();
    const hints = hintsInputs.map(({ input }) => input.value.trim()).filter(Boolean);
    if (!titleInput.value.trim() || !hints.length || !answerInput.value.trim()) {
      notify('Completá la pregunta, al menos una pista y la respuesta.', { type: 'info' });
      return;
    }
    saveBtn.disabled = true;
    try {
      await onSubmit({ title: titleInput.value.trim(), hints, answerQuote: answerInput.value.trim() });
    } finally {
      saveBtn.disabled = false;
    }
  };
  return form;
}

export async function loadGuideTab(panel, game) {
  if (!panel || !game) return;
  panel.dataset.guideKey = game.key;
  panel.innerHTML = '<div class="detail-loading"><span class="skeleton"></span></div>';
  let data;
  let companionState = null;
  try {
    [data, companionState] = await Promise.all([
      request(guideUrl(game.key)),
      request('/api/guides/companion').catch(() => null)
    ]);
  } catch (error) {
    if (panel.dataset.guideKey !== game.key || !panel.isConnected) return;
    const msg = document.createElement('p');
    msg.className = 'detail-empty';
    msg.textContent = error.message || 'No se pudo cargar la guía.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'button small';
    retry.textContent = 'Reintentar';
    retry.onclick = () => loadGuideTab(panel, game);
    panel.replaceChildren(msg, retry);
    return;
  }
  if (panel.dataset.guideKey !== game.key || !panel.isConnected) return;

  const uid = 'guide-' + Math.random().toString(36).slice(2, 8);
  const root = document.createElement('div');
  root.className = 'guide-tab';

  let selectedSectionId =
    (data.progress.currentSectionId &&
      data.activeGuide?.sections?.some((s) => s.id === data.progress.currentSectionId) &&
      data.progress.currentSectionId) ||
    data.activeGuide?.sections?.[0]?.id ||
    null;
  let searchQuery = '';
  let wikiSearchState = null;
  let askResult = null;
  const showOriginalSections = new Set();

  const reloadTab = async (keepSectionId = null) => {
    const [fresh, freshCompanion] = await Promise.all([
      request(guideUrl(game.key)),
      request('/api/guides/companion').catch(() => companionState)
    ]);
    if (panel.dataset.guideKey !== game.key || !panel.isConnected) return;
    data = fresh;
    companionState = freshCompanion;
    if (keepSectionId && data.activeGuide?.sections?.some((s) => s.id === keepSectionId)) {
      selectedSectionId = keepSectionId;
    } else if (!data.activeGuide?.sections?.some((s) => s.id === selectedSectionId)) {
      selectedSectionId =
        (data.progress.currentSectionId &&
          data.activeGuide?.sections?.some((s) => s.id === data.progress.currentSectionId) &&
          data.progress.currentSectionId) ||
        data.activeGuide?.sections?.[0]?.id ||
        null;
    }
    sectionInput.value = data.progress.currentSection || '';
    clearSectionBtn.hidden = !data.progress.currentSection;
    updateSubtitle();
    renderOfflineSection();
    renderCompanionSection();
    renderLinks();
    renderNotes();
  };

  // ── 1. Guía sin conexión (StrategyWiki, archivos propios, pistas escalonadas e IA opcional) ──
  const offlineCard = document.createElement('section');
  offlineCard.className = 'guide-card guide-offline-card';

  function renderOfflineSection() {
    offlineCard.replaceChildren();
    const head = document.createElement('div');
    head.className = 'guide-card-head';
    const titleWrap = document.createElement('div');
    const title = document.createElement('h3');
    title.innerHTML = icon('book') + '<span>Guía sin conexión</span>';
    const hint = document.createElement('p');
    hint.className = 'helper-text';
    hint.textContent = data.activeGuide
      ? 'Elegí entre Pistas graduales o Solución completa por tramo, sin spoilers.'
      : 'Descargá una guía libre de StrategyWiki o importá un archivo propio (.txt, .md, .html).';
    titleWrap.append(title, hint);

    const toolbar = document.createElement('div');
    toolbar.className = 'guide-offline-actions';

    if (data.guides?.length > 1) {
      const select = document.createElement('select');
      select.className = 'guide-select';
      select.setAttribute('aria-label', 'Elegir guía descargada o importada');
      data.guides.forEach((item) => {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent =
          item.title +
          ' (' +
          (item.source?.type === 'strategywiki' ? 'StrategyWiki' : item.source?.filename || 'Archivo') +
          ')';
        opt.selected = item.id === data.activeGuide?.id;
        select.append(opt);
      });
      select.onchange = async () => {
        try {
          await request(guideUrl(game.key) + '/progress', jsonRequest('PUT', { activeGuideId: select.value }));
          await reloadTab();
        } catch (error) {
          notifyError(error);
        }
      };
      toolbar.append(select);
    }

    const wikiBtn = document.createElement('button');
    wikiBtn.type = 'button';
    wikiBtn.className = 'button small';
    wikiBtn.textContent = data.availability?.available ? 'Descargar de StrategyWiki' : 'Buscar en StrategyWiki';
    wikiBtn.onclick = async () => {
      wikiBtn.disabled = true;
      try {
        if (data.availability?.available && data.availability?.pageTitle) {
          wikiBtn.textContent = 'Descargando…';
          await request(
            guideUrl(game.key) + '/strategywiki/download',
            jsonRequest('POST', { pageTitle: data.availability.pageTitle })
          );
          wikiSearchState = null;
          await loadGuideSummary();
          await reloadTab();
          notify('Guía descargada de StrategyWiki.', { type: 'success' });
        } else {
          wikiBtn.textContent = 'Buscando…';
          wikiSearchState = await request(guideUrl(game.key) + '/strategywiki/search', { method: 'POST' });
          renderOfflineSection();
        }
      } catch (error) {
        notifyError(error);
        wikiBtn.disabled = false;
        wikiBtn.textContent = data.availability?.available ? 'Descargar de StrategyWiki' : 'Buscar en StrategyWiki';
      }
    };
    toolbar.append(wikiBtn);

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.txt,.md,.html,.htm';
    fileInput.hidden = true;
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      if (!file) return;
      if (file.name.toLowerCase().endsWith('.pdf')) {
        notify('Por ahora se pueden importar guías en .txt, .md o .html (no .pdf).', { type: 'error' });
        return;
      }
      try {
        const content = await file.text();
        await request(guideUrl(game.key) + '/import', jsonRequest('POST', { filename: file.name, content }));
        await loadGuideSummary();
        await reloadTab();
        notify('Guía importada: ' + file.name, { type: 'success' });
      } catch (error) {
        notifyError(error);
      }
    };
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'button small';
    importBtn.innerHTML = icon('upload') + '<span>Importar archivo</span>';
    importBtn.onclick = () => fileInput.click();
    toolbar.append(importBtn, fileInput);

    if (data.activeGuide) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'button small';
      delBtn.textContent = 'Quitar guía';
      delBtn.onclick = async () => {
        delBtn.disabled = true;
        try {
          await request(guideUrl(game.key) + '/items/' + encodeURIComponent(data.activeGuide.id), {
            method: 'DELETE'
          });
          askResult = null;
          await loadGuideSummary();
          await reloadTab();
          notify('Guía quitada (tus notas y tu avance se conservan).', { type: 'info' });
        } catch (error) {
          delBtn.disabled = false;
          notifyError(error);
        }
      };
      toolbar.append(delBtn);
    }

    head.append(titleWrap, toolbar);
    offlineCard.append(head);

    if (wikiSearchState) {
      const box = document.createElement('div');
      box.className = 'guide-wiki-result';
      if (wikiSearchState.found) {
        const p = document.createElement('p');
        p.textContent = 'Encontramos «' + wikiSearchState.pageTitle + '» en StrategyWiki.';
        const dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'button small primary';
        dl.textContent = 'Descargar para leer sin conexión';
        dl.onclick = async () => {
          dl.disabled = true;
          dl.textContent = 'Descargando…';
          try {
            await request(
              guideUrl(game.key) + '/strategywiki/download',
              jsonRequest('POST', { pageTitle: wikiSearchState.pageTitle })
            );
            wikiSearchState = null;
            await loadGuideSummary();
            await reloadTab();
            notify('Guía descargada de StrategyWiki.', { type: 'success' });
          } catch (error) {
            dl.disabled = false;
            dl.textContent = 'Descargar para leer sin conexión';
            notifyError(error);
          }
        };
        box.append(p, dl);
      } else {
        const p = document.createElement('p');
        p.className = 'helper-text';
        p.textContent =
          'No encontramos una guía para este juego en StrategyWiki. Podés importar un archivo propio o usar los enlaces de abajo.';
        box.append(p);
      }
      offlineCard.append(box);
    }

    if (data.activeGuide && data.activeGuide.sections?.length) {
      const sections = data.activeGuide.sections;
      const modeBar = document.createElement('div');
      modeBar.className = 'guide-mode-bar';
      const segmented = document.createElement('div');
      segmented.className = 'segmented guide-mode-switch';
      segmented.setAttribute('role', 'group');
      segmented.setAttribute('aria-label', 'Nivel de ayuda');
      const currentMode = data.progress.mode === 'solution' ? 'solution' : 'hints';

      const hintsTab = document.createElement('button');
      hintsTab.type = 'button';
      hintsTab.dataset.guideMode = 'hints';
      hintsTab.textContent = 'Pistas';
      hintsTab.setAttribute('aria-pressed', String(currentMode === 'hints'));
      hintsTab.classList.toggle('active', currentMode === 'hints');

      const solTab = document.createElement('button');
      solTab.type = 'button';
      solTab.dataset.guideMode = 'solution';
      solTab.textContent = 'Solución';
      solTab.setAttribute('aria-pressed', String(currentMode === 'solution'));
      solTab.classList.toggle('active', currentMode === 'solution');

      const switchConfirmHost = document.createElement('div');
      switchConfirmHost.className = 'guide-confirm-slot';

      const applyMode = async (mode, extra = {}) => {
        await request(guideUrl(game.key) + '/progress', jsonRequest('PUT', { mode, ...extra }));
        await reloadTab(selectedSectionId);
      };

      hintsTab.onclick = async () => {
        if (currentMode === 'hints') return;
        try {
          await applyMode('hints');
        } catch (error) {
          notifyError(error);
        }
      };

      solTab.onclick = async () => {
        if (currentMode === 'solution') return;
        if (data.progress.skipSpoilerConfirm) {
          try {
            await applyMode('solution');
          } catch (error) {
            notifyError(error);
          }
          return;
        }
        switchConfirmHost.replaceChildren();
        const box = document.createElement('div');
        box.className = 'guide-confirm-inline';
        const p = document.createElement('p');
        p.textContent = '¿Pasar a Solución completa? Vas a ver el texto entero de los tramos desbloqueados.';
        const alwaysLabel = document.createElement('label');
        alwaysLabel.className = 'guide-future-toggle';
        const alwaysCb = document.createElement('input');
        alwaysCb.type = 'checkbox';
        const alwaysText = document.createElement('span');
        alwaysText.textContent = 'No volver a preguntar en este juego';
        alwaysLabel.append(alwaysCb, alwaysText);
        const btns = document.createElement('div');
        btns.className = 'guide-note-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'button small';
        cancel.textContent = 'Seguir en Pistas';
        cancel.onclick = () => switchConfirmHost.replaceChildren();
        const confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'button small primary';
        confirm.textContent = 'Ver solución completa';
        confirm.onclick = async () => {
          confirm.disabled = true;
          try {
            await applyMode('solution', alwaysCb.checked ? { skipSpoilerConfirm: true } : {});
          } catch (error) {
            confirm.disabled = false;
            notifyError(error);
          }
        };
        btns.append(cancel, confirm);
        box.append(p, alwaysLabel, btns);
        switchConfirmHost.append(box);
      };

      segmented.append(hintsTab, solTab);
      const searchInput = document.createElement('input');
      searchInput.type = 'search';
      searchInput.value = searchQuery;
      searchInput.placeholder = 'Buscar dentro de esta guía…';
      searchInput.setAttribute('aria-label', 'Buscar dentro de la guía');
      const searchCount = document.createElement('span');
      searchCount.className = 'helper-text';
      const searchRow = document.createElement('div');
      searchRow.className = 'guide-search-row';
      searchRow.append(searchInput, searchCount);
      modeBar.append(segmented, searchRow);
      offlineCard.append(modeBar, switchConfirmHost);

      const reader = document.createElement('div');
      reader.className = 'guide-reader';
      const toc = document.createElement('nav');
      toc.className = 'guide-toc';
      toc.setAttribute('aria-label', 'Índice de tramos');
      const bodyPane = document.createElement('div');
      bodyPane.className = 'guide-solution';
      reader.append(toc, bodyPane);
      offlineCard.append(reader);

      const renderReaderContent = () => {
        toc.replaceChildren();
        bodyPane.replaceChildren();

        const hasFuture = sections.some((s) => s.isFuture);
        if (hasFuture) {
          const toggleLabel = document.createElement('label');
          toggleLabel.className = 'guide-future-toggle';
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = data.progress.showFutureTitles === true;
          cb.onchange = async () => {
            try {
              await request(guideUrl(game.key) + '/progress', jsonRequest('PUT', { showFutureTitles: cb.checked }));
              await reloadTab(selectedSectionId);
            } catch (error) {
              cb.checked = !cb.checked;
              notifyError(error);
            }
          };
          const span = document.createElement('span');
          span.textContent = 'Mostrar títulos futuros';
          toggleLabel.append(cb, span);
          toc.append(toggleLabel);
        }

        const tocList = document.createElement('div');
        tocList.className = 'guide-toc-list';
        let totalMatches = 0;

        sections.forEach((sec) => {
          const matches = !sec.locked ? countOccurrences(sec.solution, searchQuery) : 0;
          totalMatches += matches;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className =
            'guide-toc-item' +
            (sec.id === selectedSectionId ? ' active' : '') +
            (sec.id === data.progress.currentSectionId ? ' current' : '') +
            (sec.locked ? ' locked' : '');
          const labelSpan = document.createElement('span');
          labelSpan.textContent = sec.displayTitle;
          btn.append(labelSpan);
          if (sec.id === data.progress.currentSectionId) {
            const here = document.createElement('small');
            here.className = 'guide-badge';
            here.textContent = 'Acá estoy';
            btn.append(here);
          } else if (matches > 0) {
            const hit = document.createElement('small');
            hit.className = 'guide-badge';
            hit.textContent = String(matches);
            btn.append(hit);
          } else if (sec.locked) {
            const lock = document.createElement('small');
            lock.textContent = 'Oculto';
            btn.append(lock);
          }
          btn.onclick = () => {
            selectedSectionId = sec.id;
            renderReaderContent();
          };
          tocList.append(btn);
        });
        toc.append(tocList);

        searchCount.textContent =
          searchQuery.trim().length >= 2
            ? totalMatches === 1
              ? '1 coincidencia'
              : totalMatches + ' coincidencias'
            : '';

        const currentIndex = Math.max(
          0,
          sections.findIndex((s) => s.id === selectedSectionId)
        );
        const sec = sections[currentIndex];
        if (!sec) return;

        const secHead = document.createElement('div');
        secHead.className = 'guide-solution-head';
        const displaySecTitle =
          currentMode === 'solution' && sec.translation && !showOriginalSections.has(sec.id)
            ? sec.translation.title
            : sec.displayTitle;
        const secTitle = document.createElement('h4');
        secTitle.textContent = displaySecTitle;
        const secActions = document.createElement('div');
        secActions.className = 'guide-solution-actions';

        if (sec.id !== data.progress.currentSectionId && !sec.locked) {
          const markBtn = document.createElement('button');
          markBtn.type = 'button';
          markBtn.className = 'button small';
          markBtn.textContent = 'Marcar «Acá estoy» aquí';
          markBtn.onclick = async () => {
            markBtn.disabled = true;
            try {
              await request(guideUrl(game.key) + '/progress', jsonRequest('PUT', { currentSectionId: sec.id }));
              await reloadTab(sec.id);
              notify('Tramo actual guardado: ' + sec.displayTitle, { type: 'success' });
            } catch (error) {
              markBtn.disabled = false;
              notifyError(error);
            }
          };
          secActions.append(markBtn);
        }

        if (!sec.locked) {
          const renameBtn = document.createElement('button');
          renameBtn.type = 'button';
          renameBtn.className = 'text-button';
          renameBtn.textContent = 'Renombrar';
          renameBtn.onclick = () => {
            const form = document.createElement('form');
            form.className = 'guide-rename-form';
            const input = document.createElement('input');
            input.type = 'text';
            input.maxLength = 120;
            input.value = sec.displayTitle;
            input.setAttribute('aria-label', 'Nuevo título del tramo');
            const save = document.createElement('button');
            save.type = 'submit';
            save.className = 'button small primary';
            save.textContent = 'Guardar';
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'button small';
            cancel.textContent = 'Cancelar';
            cancel.onclick = () => renderReaderContent();
            form.append(input, save, cancel);
            form.onsubmit = async (event) => {
              event.preventDefault();
              try {
                await request(
                  guideUrl(game.key) +
                    '/items/' +
                    encodeURIComponent(data.activeGuide.id) +
                    '/sections/' +
                    encodeURIComponent(sec.id),
                  jsonRequest('PUT', { title: input.value })
                );
                await reloadTab(sec.id);
              } catch (error) {
                notifyError(error);
              }
            };
            secHead.replaceWith(form);
            input.focus();
          };
          secActions.append(renameBtn);

          if (currentIndex > 0 && !sections[currentIndex - 1].locked) {
            const mergeBtn = document.createElement('button');
            mergeBtn.type = 'button';
            mergeBtn.className = 'text-button';
            mergeBtn.textContent = 'Unir con anterior';
            mergeBtn.onclick = async () => {
              mergeBtn.disabled = true;
              try {
                await request(
                  guideUrl(game.key) +
                    '/items/' +
                    encodeURIComponent(data.activeGuide.id) +
                    '/sections/' +
                    encodeURIComponent(sec.id),
                  jsonRequest('PUT', { mergeWithPrevious: true })
                );
                await reloadTab(sections[currentIndex - 1].id);
              } catch (error) {
                mergeBtn.disabled = false;
                notifyError(error);
              }
            };
            secActions.append(mergeBtn);
          }
        }

        secHead.append(secTitle, secActions);
        bodyPane.append(secHead);

        if (sec.locked) {
          const gate = document.createElement('div');
          gate.className = 'guide-spoiler-gate';
          const blur = document.createElement('div');
          blur.className = 'guide-blurred';
          blur.setAttribute('aria-hidden', 'true');
          blur.innerHTML =
            '<p>Contenido posterior protegido para evitar spoilers de tu partida.</p><p>Marcá «Acá estoy» al avanzar o revelá este tramo manualmente.</p>';
          const prompt = document.createElement('div');
          prompt.className = 'guide-spoiler-prompt';
          const msg = document.createElement('p');
          msg.textContent = 'Este tramo viene después de donde estás marcado («Acá estoy»). ¿Querés verlo igual?';
          const revealBtn = document.createElement('button');
          revealBtn.type = 'button';
          revealBtn.className = 'button small primary';
          revealBtn.textContent = 'Ver este tramo';
          revealBtn.onclick = async () => {
            revealBtn.disabled = true;
            try {
              await request(guideUrl(game.key) + '/progress', jsonRequest('PUT', { revealSectionId: sec.id }));
              await reloadTab(sec.id);
            } catch (error) {
              revealBtn.disabled = false;
              notifyError(error);
            }
          };
          const alwaysLabel = document.createElement('label');
          alwaysLabel.className = 'guide-future-toggle';
          const alwaysCb = document.createElement('input');
          alwaysCb.type = 'checkbox';
          alwaysCb.checked = data.progress.skipSpoilerConfirm === true;
          alwaysCb.onchange = async () => {
            try {
              await request(
                guideUrl(game.key) + '/progress',
                jsonRequest('PUT', { skipSpoilerConfirm: alwaysCb.checked })
              );
              await reloadTab(sec.id);
            } catch (error) {
              alwaysCb.checked = !alwaysCb.checked;
              notifyError(error);
            }
          };
          const alwaysText = document.createElement('span');
          alwaysText.textContent = 'No volver a preguntar en este juego';
          alwaysLabel.append(alwaysCb, alwaysText);
          prompt.append(msg, revealBtn, alwaysLabel);
          gate.append(blur, prompt);
          bodyPane.append(gate);
        } else if (currentMode === 'hints') {
          // ── Nivel 1: Modo Pistas escalonadas ──
          const hintsToolbar = document.createElement('div');
          hintsToolbar.className = 'guide-hints-toolbar';
          const addQBtn = document.createElement('button');
          addQBtn.type = 'button';
          addQBtn.className = 'button small';
          addQBtn.textContent = 'Agregar pregunta';
          const formHost = document.createElement('div');
          addQBtn.onclick = () => {
            if (formHost.childElementCount) {
              formHost.replaceChildren();
              return;
            }
            formHost.replaceChildren(
              buildQuestionForm({
                onCancel: () => formHost.replaceChildren(),
                onSubmit: async (payload) => {
                  try {
                    await request(
                      guideUrl(game.key) +
                        '/items/' +
                        encodeURIComponent(data.activeGuide.id) +
                        '/sections/' +
                        encodeURIComponent(sec.id) +
                        '/questions',
                      jsonRequest('POST', payload)
                    );
                    await reloadTab(sec.id);
                    notify('Pregunta guardada.', { type: 'success' });
                  } catch (error) {
                    notifyError(error);
                  }
                }
              })
            );
          };
          hintsToolbar.append(addQBtn);

          if (data.ai?.configured) {
            const aiBtn = document.createElement('button');
            aiBtn.type = 'button';
            aiBtn.className = 'button small';
            aiBtn.textContent = 'Armar pistas con IA';
            aiBtn.onclick = async () => {
              aiBtn.disabled = true;
              aiBtn.textContent = 'Armando pistas…';
              try {
                await request(
                  guideUrl(game.key) +
                    '/items/' +
                    encodeURIComponent(data.activeGuide.id) +
                    '/sections/' +
                    encodeURIComponent(sec.id) +
                    '/hints/generate',
                  { method: 'POST' }
                );
                await reloadTab(sec.id);
                notify('Pistas armadas con IA para este tramo.', { type: 'success' });
              } catch (error) {
                aiBtn.disabled = false;
                aiBtn.textContent = 'Armar pistas con IA';
                notifyError(error);
              }
            };
            hintsToolbar.append(aiBtn);
          }
          bodyPane.append(hintsToolbar, formHost);

          if (data.ai?.configured) {
            const askForm = document.createElement('form');
            askForm.className = 'guide-ask-form';
            const askInput = document.createElement('input');
            askInput.type = 'text';
            askInput.maxLength = 400;
            askInput.placeholder = 'Preguntá sobre esta guía (ej.: ¿qué hago con la palanca roja?)';
            askInput.setAttribute('aria-label', 'Preguntar sobre esta guía');
            const askBtn = document.createElement('button');
            askBtn.type = 'submit';
            askBtn.className = 'button small';
            askBtn.textContent = 'Preguntar';
            askForm.append(askInput, askBtn);
            askForm.onsubmit = async (event) => {
              event.preventDefault();
              if (!askInput.value.trim()) return;
              askBtn.disabled = true;
              askBtn.textContent = 'Buscando…';
              try {
                const res = await request(
                  guideUrl(game.key) + '/items/' + encodeURIComponent(data.activeGuide.id) + '/ask',
                  jsonRequest('POST', { sectionId: sec.id, question: askInput.value.trim(), revealAnswer: false })
                );
                askResult = { ...res, question: askInput.value.trim() };
                renderReaderContent();
              } catch (error) {
                askBtn.disabled = false;
                askBtn.textContent = 'Preguntar';
                notifyError(error);
              }
            };
            bodyPane.append(askForm);

            if (askResult) {
              const box = document.createElement('div');
              box.className = 'guide-ask-result';
              if (!askResult.covered) {
                const p = document.createElement('p');
                p.textContent = 'Esta guía no cubre esa pregunta. Probá con las otras fuentes de abajo.';
                box.append(p);
              } else {
                const badge = document.createElement('span');
                badge.className = 'guide-badge';
                badge.textContent = 'Respuesta sobre la guía · ' + (askResult.sectionTitle || sec.displayTitle);
                const hintP = document.createElement('p');
                hintP.textContent = 'Pista: ' + askResult.hint;
                box.append(badge, hintP);
                if (askResult.answer) {
                  const ansP = document.createElement('p');
                  ansP.textContent = 'Solución: ' + askResult.answer;
                  box.append(ansP);
                } else if (askResult.hasAnswer) {
                  const solBtn = document.createElement('button');
                  solBtn.type = 'button';
                  solBtn.className = 'text-button';
                  solBtn.textContent = 'Ver la solución de esa pregunta';
                  solBtn.onclick = async () => {
                    solBtn.disabled = true;
                    try {
                      const full = await request(
                        guideUrl(game.key) + '/items/' + encodeURIComponent(data.activeGuide.id) + '/ask',
                        jsonRequest('POST', { sectionId: sec.id, question: askResult.question, revealAnswer: true })
                      );
                      askResult = { ...full, question: askResult.question };
                      renderReaderContent();
                    } catch (error) {
                      solBtn.disabled = false;
                      notifyError(error);
                    }
                  };
                  box.append(solBtn);
                }
                if (askResult.quote) {
                  const quoteP = document.createElement('small');
                  quoteP.className = 'helper-text';
                  quoteP.textContent = 'Fragmento de origen: «' + askResult.quote + '»';
                  box.append(quoteP);
                }
              }
              bodyPane.append(box);
            }
          }

          const questions = sec.questions ?? [];
          if (!questions.length) {
            const empty = document.createElement('div');
            empty.className = 'guide-hints-empty';
            const msg = document.createElement('p');
            msg.className = 'detail-empty';
            msg.textContent = data.ai?.configured
              ? 'Este tramo todavía no tiene preguntas con pistas. Podés armarlas con IA, agregar una a mano o pasar a Solución completa.'
              : 'Este tramo todavía no tiene preguntas con pistas. Podés agregar una a mano, cargar tu clave de Anthropic abajo o pasar a Solución completa.';
            empty.append(msg);
            bodyPane.append(empty);
          } else {
            const qList = document.createElement('div');
            qList.className = 'guide-question-list';
            questions.forEach((q) => {
              const card = document.createElement('article');
              card.className = 'guide-question-card';
              card.dataset.questionId = q.id;

              const qHead = document.createElement('div');
              qHead.className = 'guide-question-head';
              const qTitleWrap = document.createElement('div');
              qTitleWrap.className = 'guide-question-title';
              const qTitle = document.createElement('h5');
              qTitle.textContent = q.title;
              const badge = document.createElement('span');
              badge.className = 'guide-badge';
              badge.textContent = originLabel(q.origin, q.edited, data.activeGuide.source?.type);
              qTitleWrap.append(qTitle, badge);

              const qTools = document.createElement('div');
              qTools.className = 'guide-note-controls';
              const editBtn = document.createElement('button');
              editBtn.type = 'button';
              editBtn.className = 'text-button';
              editBtn.textContent = 'Editar';
              editBtn.onclick = async () => {
                try {
                  const full = await request(
                    guideUrl(game.key) +
                      '/items/' +
                      encodeURIComponent(data.activeGuide.id) +
                      '/sections/' +
                      encodeURIComponent(sec.id) +
                      '/questions/' +
                      encodeURIComponent(q.id)
                  );
                  card.replaceChildren(
                    buildQuestionForm({
                      initial: full,
                      onCancel: () => renderReaderContent(),
                      onSubmit: async (payload) => {
                        await request(
                          guideUrl(game.key) +
                            '/items/' +
                            encodeURIComponent(data.activeGuide.id) +
                            '/sections/' +
                            encodeURIComponent(sec.id) +
                            '/questions/' +
                            encodeURIComponent(q.id),
                          jsonRequest('PUT', payload)
                        );
                        await reloadTab(sec.id);
                        notify('Pregunta actualizada.', { type: 'success' });
                      }
                    })
                  );
                } catch (error) {
                  notifyError(error);
                }
              };
              qTools.append(editBtn);

              if (q.revealedCount > 0 || q.answerRevealed) {
                const hideBtn = document.createElement('button');
                hideBtn.type = 'button';
                hideBtn.className = 'text-button';
                hideBtn.textContent = 'Ocultar';
                hideBtn.onclick = async () => {
                  await request(
                    guideUrl(game.key) + '/progress',
                    jsonRequest('PUT', { hideQuestion: { sectionId: sec.id, questionId: q.id } })
                  );
                  await reloadTab(sec.id);
                };
                qTools.append(hideBtn);
              }

              const delQBtn = document.createElement('button');
              delQBtn.type = 'button';
              delQBtn.className = 'text-button';
              delQBtn.textContent = 'Borrar';
              delQBtn.onclick = async () => {
                delQBtn.disabled = true;
                try {
                  await request(
                    guideUrl(game.key) +
                      '/items/' +
                      encodeURIComponent(data.activeGuide.id) +
                      '/sections/' +
                      encodeURIComponent(sec.id) +
                      '/questions/' +
                      encodeURIComponent(q.id),
                    { method: 'DELETE' }
                  );
                  await reloadTab(sec.id);
                } catch (error) {
                  delQBtn.disabled = false;
                  notifyError(error);
                }
              };
              qTools.append(delQBtn);

              qHead.append(qTitleWrap, qTools);
              card.append(qHead);

              if (q.visibleHints?.length) {
                const ol = document.createElement('ol');
                ol.className = 'guide-hint-list';
                q.visibleHints.forEach((hintText) => {
                  const li = document.createElement('li');
                  li.textContent = hintText;
                  ol.append(li);
                });
                card.append(ol);
              }

              const answerSlot = document.createElement('div');
              if (q.answerRevealed) {
                const ansBox = document.createElement('div');
                ansBox.className = 'guide-answer-box';
                const ansLabel = document.createElement('strong');
                ansLabel.textContent = 'Respuesta (de la guía)';
                const ansBody = document.createElement('p');
                ansBody.textContent = q.answerQuote;
                ansBox.append(ansLabel, ansBody);
                card.append(ansBox);
              } else {
                const qBtns = document.createElement('div');
                qBtns.className = 'guide-question-actions';
                if (q.revealedCount < q.totalHints) {
                  const nextHintBtn = document.createElement('button');
                  nextHintBtn.type = 'button';
                  nextHintBtn.className = 'button small primary';
                  nextHintBtn.textContent = q.revealedCount === 0 ? 'Ver pista 1' : 'Otra pista';
                  nextHintBtn.onclick = async () => {
                    nextHintBtn.disabled = true;
                    try {
                      await request(
                        guideUrl(game.key) + '/progress',
                        jsonRequest('PUT', {
                          setHintCount: { sectionId: sec.id, questionId: q.id, count: q.revealedCount + 1 }
                        })
                      );
                      await reloadTab(sec.id);
                    } catch (error) {
                      nextHintBtn.disabled = false;
                      notifyError(error);
                    }
                  };
                  qBtns.append(nextHintBtn);
                }
                const ansBtn = document.createElement('button');
                ansBtn.type = 'button';
                ansBtn.className = 'button small';
                ansBtn.textContent = 'Ver la respuesta';
                ansBtn.onclick = async () => {
                  if (data.progress.skipSpoilerConfirm) {
                    ansBtn.disabled = true;
                    try {
                      await request(
                        guideUrl(game.key) + '/progress',
                        jsonRequest('PUT', { revealAnswer: { sectionId: sec.id, questionId: q.id } })
                      );
                      await reloadTab(sec.id);
                    } catch (error) {
                      ansBtn.disabled = false;
                      notifyError(error);
                    }
                    return;
                  }
                  answerSlot.replaceChildren();
                  const confirmBox = document.createElement('div');
                  confirmBox.className = 'guide-confirm-inline';
                  const p = document.createElement('p');
                  p.textContent = '¿Mostrar la respuesta completa de esta pregunta?';
                  const alwaysLabel = document.createElement('label');
                  alwaysLabel.className = 'guide-future-toggle';
                  const alwaysCb = document.createElement('input');
                  alwaysCb.type = 'checkbox';
                  const alwaysSpan = document.createElement('span');
                  alwaysSpan.textContent = 'No volver a preguntar en este juego';
                  alwaysLabel.append(alwaysCb, alwaysSpan);
                  const row = document.createElement('div');
                  row.className = 'guide-note-actions';
                  const cancel = document.createElement('button');
                  cancel.type = 'button';
                  cancel.className = 'button small';
                  cancel.textContent = 'Cancelar';
                  cancel.onclick = () => answerSlot.replaceChildren();
                  const ok = document.createElement('button');
                  ok.type = 'button';
                  ok.className = 'button small primary';
                  ok.textContent = 'Mostrar respuesta';
                  ok.onclick = async () => {
                    ok.disabled = true;
                    try {
                      await request(
                        guideUrl(game.key) + '/progress',
                        jsonRequest('PUT', {
                          revealAnswer: { sectionId: sec.id, questionId: q.id },
                          ...(alwaysCb.checked ? { skipSpoilerConfirm: true } : {})
                        })
                      );
                      await reloadTab(sec.id);
                    } catch (error) {
                      ok.disabled = false;
                      notifyError(error);
                    }
                  };
                  row.append(cancel, ok);
                  confirmBox.append(p, alwaysLabel, row);
                  answerSlot.append(confirmBox);
                };
                qBtns.append(ansBtn);
                card.append(qBtns, answerSlot);
              }
              qList.append(card);
            });
            bodyPane.append(qList);
          }
        } else {
          // ── Nivel 2: Modo Solución completa ──
          if (data.ai?.configured) {
            const trRow = document.createElement('div');
            trRow.className = 'guide-translate-row';
            const showingTranslated = Boolean(sec.translation) && !showOriginalSections.has(sec.id);
            if (sec.translation) {
              const toggleBtn = document.createElement('button');
              toggleBtn.type = 'button';
              toggleBtn.className = 'text-button';
              toggleBtn.textContent = showingTranslated ? 'Ver original' : 'Ver traducción';
              toggleBtn.onclick = () => {
                if (showOriginalSections.has(sec.id)) showOriginalSections.delete(sec.id);
                else showOriginalSections.add(sec.id);
                renderReaderContent();
              };
              const badge = document.createElement('span');
              badge.className = 'guide-badge';
              badge.textContent = showingTranslated ? 'Traducido con IA' : 'Original';
              trRow.append(badge, toggleBtn);
            } else {
              const trBtn = document.createElement('button');
              trBtn.type = 'button';
              trBtn.className = 'button small';
              trBtn.textContent = 'Traducir tramo';
              trBtn.onclick = async () => {
                trBtn.disabled = true;
                trBtn.textContent = 'Traduciendo…';
                try {
                  await request(
                    guideUrl(game.key) +
                      '/items/' +
                      encodeURIComponent(data.activeGuide.id) +
                      '/sections/' +
                      encodeURIComponent(sec.id) +
                      '/translate',
                    { method: 'POST' }
                  );
                  showOriginalSections.delete(sec.id);
                  await reloadTab(sec.id);
                } catch (error) {
                  trBtn.disabled = false;
                  trBtn.textContent = 'Traducir tramo';
                  notifyError(error);
                }
              };
              trRow.append(trBtn);
            }
            bodyPane.append(trRow);
          }

          const mdBody = document.createElement('div');
          mdBody.className = 'guide-solution-body';
          const contentText =
            sec.translation && !showOriginalSections.has(sec.id) ? sec.translation.solution : sec.solution;
          renderSafeMarkdown(mdBody, contentText, searchQuery);
          bodyPane.append(mdBody);
        }

        const navFooter = document.createElement('div');
        navFooter.className = 'guide-solution-nav';
        const prevBtn = document.createElement('button');
        prevBtn.type = 'button';
        prevBtn.className = 'button small';
        prevBtn.textContent = 'Tramo anterior';
        prevBtn.disabled = currentIndex === 0;
        prevBtn.onclick = () => {
          selectedSectionId = sections[currentIndex - 1].id;
          renderReaderContent();
        };
        const nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'button small';
        nextBtn.textContent = 'Tramo siguiente';
        nextBtn.disabled = currentIndex >= sections.length - 1;
        nextBtn.onclick = () => {
          selectedSectionId = sections[currentIndex + 1].id;
          renderReaderContent();
        };
        navFooter.append(prevBtn, nextBtn);
        bodyPane.append(navFooter);

        const attribution = document.createElement('p');
        attribution.className = 'guide-attribution';
        const src = data.activeGuide.source || {};
        if (src.type === 'strategywiki') {
          const rev = src.revision ? ' · Revisión ' + src.revision : '';
          attribution.append(
            document.createTextNode(
              'Fuente: StrategyWiki (' +
                (src.authors || 'Colaboradores de StrategyWiki') +
                ') · Licencia ' +
                (src.license || 'CC BY-SA 4.0') +
                rev +
                ' · '
            )
          );
          if (src.url) {
            const link = document.createElement('a');
            link.href = src.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Ver original';
            attribution.append(link);
          }
        } else {
          attribution.textContent =
            'Fuente: archivo propio (' + (src.filename || 'local') + ') · Uso personal (se queda en esta PC).';
        }
        bodyPane.append(attribution);
      };

      searchInput.oninput = () => {
        searchQuery = searchInput.value;
        renderReaderContent();
      };

      renderReaderContent();
    }

    // Caja discreta para configurar la clave opcional de Anthropic (compartida con Novedades si ya existe).
    const aiBox = document.createElement('details');
    aiBox.className = 'guide-ai-box';
    const aiSummary = document.createElement('summary');
    aiSummary.textContent = data.ai?.configured
      ? 'IA opcional (lista · ' + (data.ai.source === 'news' ? 'clave de Novedades' : 'clave propia') + ')'
      : 'IA opcional para armar pistas y traducir';
    const aiBody = document.createElement('div');
    aiBody.className = 'guide-ai-body';
    const aiHelp = document.createElement('p');
    aiHelp.className = 'helper-text';
    aiHelp.textContent =
      'Siempre trabaja sobre la guía que tenés cargada (nunca inventa soluciones sin fuente). Modelo: ' +
      (data.ai?.model || 'claude-haiku-5-5') +
      '.';
    aiBody.append(aiHelp);
    if (data.hintsEstimate?.sections) {
      const est = document.createElement('p');
      est.className = 'helper-text';
      est.textContent =
        'Estimación para pistear esta guía completa (' +
        data.hintsEstimate.sections +
        ' tramos): ~US$ ' +
        data.hintsEstimate.estimatedUsd.toFixed(4) +
        ' (por defecto se pistea de a un tramo).';
      aiBody.append(est);
    }
    const aiForm = document.createElement('form');
    aiForm.className = 'news-ai';
    const aiInput = document.createElement('input');
    aiInput.type = 'password';
    aiInput.autocomplete = 'off';
    aiInput.placeholder = 'sk-ant-…';
    aiInput.setAttribute('aria-label', 'Clave de API de Anthropic para Guías');
    const aiSave = document.createElement('button');
    aiSave.type = 'submit';
    aiSave.className = 'button small';
    aiSave.textContent = data.ai?.source === 'guides' ? 'Cambiar clave' : 'Guardar clave';
    aiForm.append(aiInput, aiSave);
    if (data.ai?.source === 'guides') {
      const aiRemove = document.createElement('button');
      aiRemove.type = 'button';
      aiRemove.className = 'button small';
      aiRemove.textContent = 'Quitar';
      aiRemove.onclick = async () => {
        await request('/api/guides/ai', { method: 'DELETE' });
        await reloadTab(selectedSectionId);
        notify('Clave de IA quitada de Guías.', { type: 'info' });
      };
      aiForm.append(aiRemove);
    }
    aiForm.onsubmit = async (event) => {
      event.preventDefault();
      aiSave.disabled = true;
      try {
        await request('/api/guides/ai', jsonRequest('PUT', { key: aiInput.value }));
        await reloadTab(selectedSectionId);
        notify('Clave de Anthropic guardada.', { type: 'success' });
      } catch (error) {
        aiSave.disabled = false;
        notifyError(error);
      }
    };
    aiBody.append(aiForm);
    aiBox.append(aiSummary, aiBody);
    offlineCard.append(aiBox);
  }

  // ── 2. Cabecera y «Acá estoy» manual ──
  const progressCard = document.createElement('section');
  progressCard.className = 'guide-card guide-progress-card';
  const progressHead = document.createElement('div');
  progressHead.className = 'guide-card-head';
  const titleWrap = document.createElement('div');
  const heading = document.createElement('h3');
  heading.innerHTML = icon('book') + '<span>Tu avance en este juego</span>';
  const subtitle = document.createElement('p');
  subtitle.className = 'helper-text';
  const updateSubtitle = () => {
    subtitle.textContent = data.progress.currentSection
      ? 'Tramo guardado: ' + data.progress.currentSection
      : 'Guardá en qué capítulo, zona o jefe estás para retomar sin spoilers.';
  };
  updateSubtitle();
  titleWrap.append(heading, subtitle);
  progressHead.append(titleWrap);

  if (data.viewerSupported) {
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'button small guide-open-viewer';
    openBtn.innerHTML =
      icon('monitor') +
      '<span>' +
      (data.companionDisplay ? 'Abrir en ' + data.companionDisplay.name : 'Abrir ventana de guía') +
      '</span>';
    openBtn.onclick = async () => {
      const res = await openGuideForGame(game);
      if (res?.url) {
        data.progress.lastUrl = res.url;
        renderLinks();
      }
    };
    progressHead.append(openBtn);
  }
  progressCard.append(progressHead);

  const sectionForm = document.createElement('form');
  sectionForm.className = 'guide-section-form';
  const sectionLabel = document.createElement('label');
  sectionLabel.htmlFor = uid + '-section';
  sectionLabel.textContent = 'Acá estoy';
  const sectionInput = document.createElement('input');
  sectionInput.id = uid + '-section';
  sectionInput.type = 'text';
  sectionInput.maxLength = 120;
  sectionInput.placeholder = 'Ej.: Capítulo 4 · El puente';
  sectionInput.value = data.progress.currentSection || '';
  const saveSectionBtn = document.createElement('button');
  saveSectionBtn.type = 'submit';
  saveSectionBtn.className = 'button small primary';
  saveSectionBtn.textContent = 'Guardar';
  const clearSectionBtn = document.createElement('button');
  clearSectionBtn.type = 'button';
  clearSectionBtn.className = 'button small';
  clearSectionBtn.textContent = 'Limpiar';
  clearSectionBtn.hidden = !data.progress.currentSection;

  const saveSectionValue = async (nextSection) => {
    saveSectionBtn.disabled = true;
    clearSectionBtn.disabled = true;
    try {
      const res = await request(guideUrl(game.key) + '/progress', jsonRequest('PUT', { currentSection: nextSection }));
      data.progress = res.progress;
      sectionInput.value = data.progress.currentSection;
      clearSectionBtn.hidden = !data.progress.currentSection;
      updateSubtitle();
      if (!noteSectionInput.value.trim() && data.progress.currentSection) {
        noteSectionInput.value = data.progress.currentSection;
      }
      if (!data.progress.currentSection && data.activeGuide) await reloadTab(selectedSectionId);
      else renderNotes();
      notify(data.progress.currentSection ? 'Tramo guardado.' : 'Marca de tramo quitada.', { type: 'success' });
    } catch (error) {
      notifyError(error);
    } finally {
      saveSectionBtn.disabled = false;
      clearSectionBtn.disabled = false;
    }
  };
  sectionForm.onsubmit = (event) => {
    event.preventDefault();
    saveSectionValue(sectionInput.value);
  };
  clearSectionBtn.onclick = () => saveSectionValue('');
  sectionForm.append(sectionLabel, sectionInput, saveSectionBtn, clearSectionBtn);
  progressCard.append(sectionForm);

  // ── 2b. Jugar con la guía al lado (ventana flotante, QR celular y atajos) ──
  const companionCard = document.createElement('section');
  companionCard.className = 'guide-card guide-companion-card';

  function renderCompanionSection() {
    companionCard.replaceChildren();
    const head = document.createElement('div');
    head.className = 'guide-section-head';
    const h3 = document.createElement('h3');
    h3.textContent = 'Jugar con la guía al lado';
    const help = document.createElement('p');
    help.className = 'helper-text';
    help.textContent =
      'Usá la ventana flotante en 1 pantalla (en ventana sin bordes; en pantalla completa exclusiva Windows la tapa) o abrí la guía en tu celular dentro de la red local.';
    head.append(h3, help);
    companionCard.append(head);

    const actions = document.createElement('div');
    actions.className = 'guide-companion-actions';
    const overlayBtn = document.createElement('button');
    overlayBtn.type = 'button';
    overlayBtn.className = 'button small';
    overlayBtn.innerHTML = icon('layers') + '<span>Ventana flotante</span>';
    overlayBtn.onclick = () => openGuideOverlayForGame(game);

    const lanForThisGame = companionState?.lan?.active && companionState.lan.gameKey === game.key;
    const qrBtn = document.createElement('button');
    qrBtn.type = 'button';
    qrBtn.className = 'button small';
    qrBtn.innerHTML =
      icon('phone') + '<span>' + (lanForThisGame ? 'Apagar guía en el celular' : 'En el celular (QR)') + '</span>';
    qrBtn.onclick = async () => {
      qrBtn.disabled = true;
      try {
        if (lanForThisGame) {
          await request('/api/guides/lan/stop', { method: 'POST' });
          notify('Servidor celular apagado.', { type: 'info' });
        } else {
          await request('/api/guides/lan/start', jsonRequest('POST', { key: game.key }));
          notify('Código QR listo para leer en el celular.', { type: 'success' });
        }
        companionState = await request('/api/guides/companion');
        renderCompanionSection();
      } catch (error) {
        notifyError(error);
      } finally {
        qrBtn.disabled = false;
      }
    };
    actions.append(overlayBtn, qrBtn);
    companionCard.append(actions);

    if (lanForThisGame && companionState.lan) {
      const lan = companionState.lan;
      const qrBox = document.createElement('div');
      qrBox.className = 'guide-qr-box';
      if (!lan.paired && lan.qr) qrBox.append(buildQrSvgElement(lan.qr));
      const info = document.createElement('div');
      info.className = 'guide-qr-info';
      const st = document.createElement('p');
      st.textContent = lan.paired
        ? 'Celular vinculado. El acceso usa una sesión propia y se apaga al cerrar el juego.'
        : 'Escaneá este código con la cámara de tu celular (misma red Wi-Fi). El enlace sirve para una sola vinculación.';
      info.append(st);
      if (lan.url) {
        const urlEl = document.createElement('code');
        urlEl.className = 'guide-qr-url';
        urlEl.textContent = lan.url;
        info.append(urlEl);
      }
      const stopBtn = document.createElement('button');
      stopBtn.type = 'button';
      stopBtn.className = 'button small';
      stopBtn.textContent = 'Detener servidor celular';
      stopBtn.onclick = async () => {
        await request('/api/guides/lan/stop', { method: 'POST' });
        companionState = await request('/api/guides/companion');
        renderCompanionSection();
      };
      info.append(stopBtn);
      qrBox.append(info);
      companionCard.append(qrBox);
    }

    const details = document.createElement('details');
    details.className = 'guide-ai-box';
    const sum = document.createElement('summary');
    sum.textContent = 'Transparencia y atajos globales';
    const form = document.createElement('form');
    form.className = 'guide-companion-form';
    const opacityPct = Math.round((Number(companionState?.opacity) || 0.92) * 100);
    const opWrap = document.createElement('div');
    opWrap.className = 'guide-overlay-opacity';
    const opLbl = document.createElement('label');
    opLbl.htmlFor = uid + '-comp-opacity';
    opLbl.textContent = 'Transparencia: ' + opacityPct + '%';
    const opRange = document.createElement('input');
    opRange.id = uid + '-comp-opacity';
    opRange.type = 'range';
    opRange.min = '35';
    opRange.max = '100';
    opRange.value = String(opacityPct);
    opRange.oninput = () => {
      opLbl.textContent = 'Transparencia: ' + opRange.value + '%';
    };
    opWrap.append(opLbl, opRange);

    const scToggleWrap = document.createElement('label');
    scToggleWrap.className = 'guide-future-toggle';
    const scEnabled = document.createElement('input');
    scEnabled.type = 'checkbox';
    scEnabled.checked = companionState?.shortcutsEnabled !== false;
    const scEnabledTxt = document.createElement('span');
    scEnabledTxt.textContent = 'Activar atajos globales mientras jugás';
    scToggleWrap.append(scEnabled, scEnabledTxt);

    const grid = document.createElement('div');
    grid.className = 'guide-companion-grid';
    const f1 = document.createElement('div');
    f1.className = 'guide-companion-field';
    const l1 = document.createElement('label');
    l1.htmlFor = uid + '-sc-toggle';
    l1.textContent = 'Mostrar / ocultar ventana flotante';
    const i1 = document.createElement('input');
    i1.id = uid + '-sc-toggle';
    i1.type = 'text';
    i1.value = companionState?.toggleShortcut ?? 'CommandOrControl+Alt+G';
    f1.append(l1, i1);

    const f2 = document.createElement('div');
    f2.className = 'guide-companion-field';
    const l2 = document.createElement('label');
    l2.htmlFor = uid + '-sc-hint';
    l2.textContent = 'Pedir «Otra pista» sin salir del juego';
    const i2 = document.createElement('input');
    i2.id = uid + '-sc-hint';
    i2.type = 'text';
    i2.value = companionState?.nextHintShortcut ?? 'CommandOrControl+Alt+H';
    f2.append(l2, i2);
    grid.append(f1, f2);

    const saveRow = document.createElement('div');
    saveRow.className = 'guide-note-actions';
    const saveCompBtn = document.createElement('button');
    saveCompBtn.type = 'submit';
    saveCompBtn.className = 'button small';
    saveCompBtn.textContent = 'Guardar ajustes';
    saveRow.append(saveCompBtn);

    if (companionState?.shortcuts?.supported) {
      const scNote = document.createElement('small');
      scNote.className = 'helper-text';
      const issues = [companionState.shortcuts.toggle, companionState.shortcuts.nextHint]
        .filter((s) => s?.accelerator && !s.registered && s.error)
        .map((s) => s.accelerator + ': ' + s.error);
      scNote.textContent = issues.length ? issues.join(' ') : 'Atajos globales listos.';
      saveRow.append(scNote);
    }

    form.append(opWrap, scToggleWrap, grid, saveRow);
    form.onsubmit = async (event) => {
      event.preventDefault();
      saveCompBtn.disabled = true;
      try {
        companionState = await request(
          '/api/guides/companion/settings',
          jsonRequest('PUT', {
            opacity: Number(opRange.value) / 100,
            shortcutsEnabled: scEnabled.checked,
            toggleShortcut: i1.value,
            nextHintShortcut: i2.value
          })
        );
        renderCompanionSection();
        notify('Ajustes de guía al lado guardados.', { type: 'success' });
      } catch (error) {
        notifyError(error);
      } finally {
        saveCompBtn.disabled = false;
      }
    };
    details.append(sum, form);
    companionCard.append(details);
  }

  // ── 3. Fuentes de guía (enlaces directos) ──
  const linksSection = document.createElement('section');
  linksSection.className = 'guide-card';
  linksSection.innerHTML =
    '<div class="guide-section-head"><h3>Otras fuentes</h3>' +
    '<p class="helper-text">Enlaces directos: Viciódromo no copia guías con derechos reservados.</p></div>' +
    '<ul class="guide-links"></ul>';
  const linksList = linksSection.querySelector('.guide-links');

  const rememberLink = (url) => {
    data.progress.lastUrl = url;
    request(guideUrl(game.key) + '/progress', jsonRequest('PUT', { lastUrl: url })).catch(() => {});
    renderLinks();
  };

  function renderLinks() {
    linksList.replaceChildren();
    data.links.forEach((link) => {
      const item = document.createElement('li');
      item.className = 'guide-link-row';
      const info = document.createElement('div');
      info.className = 'guide-link-info';
      const titleLine = document.createElement('div');
      titleLine.className = 'guide-link-title';
      const strong = document.createElement('strong');
      strong.textContent = link.label;
      titleLine.append(strong);
      if (data.progress.lastUrl === link.url) {
        const badge = document.createElement('span');
        badge.className = 'guide-badge';
        badge.textContent = 'Última abierta';
        titleLine.append(badge);
      }
      const desc = document.createElement('small');
      desc.textContent = link.description;
      info.append(titleLine, desc);

      const actions = document.createElement('div');
      actions.className = 'guide-link-actions';
      if (data.viewerSupported) {
        const viewerBtn = document.createElement('button');
        viewerBtn.type = 'button';
        viewerBtn.className = 'button small';
        viewerBtn.textContent = 'Abrir acá';
        viewerBtn.onclick = async () => {
          const res = await openGuideForGame(game, { url: link.url });
          if (res?.url) {
            data.progress.lastUrl = res.url;
            renderLinks();
          }
        };
        const ext = document.createElement('a');
        ext.className = 'button small';
        ext.href = link.url;
        ext.target = '_blank';
        ext.rel = 'noopener noreferrer';
        ext.innerHTML = icon('external') + '<span>Navegador</span>';
        ext.onclick = () => rememberLink(link.url);
        actions.append(viewerBtn, ext);
      } else {
        const ext = document.createElement('a');
        ext.className = 'button small';
        ext.href = link.url;
        ext.target = '_blank';
        ext.rel = 'noopener noreferrer';
        ext.innerHTML = icon('external') + '<span>Abrir</span>';
        ext.onclick = () => rememberLink(link.url);
        actions.append(ext);
      }
      item.append(info, actions);
      linksList.append(item);
    });
  }

  // ── 4. Notas de partida por tramo ──
  const notesSection = document.createElement('section');
  notesSection.className = 'guide-card';
  notesSection.innerHTML =
    '<div class="guide-section-head"><h3>Notas de partida</h3>' +
    '<p class="helper-text">Anotá pistas propias o trabas por tramo, con capturas de Tus capturas.</p></div>';

  const noteForm = document.createElement('form');
  noteForm.className = 'guide-note-form';
  const noteSectionRow = document.createElement('div');
  noteSectionRow.className = 'guide-note-row';
  const noteSectionLabel = document.createElement('label');
  noteSectionLabel.htmlFor = uid + '-note-section';
  noteSectionLabel.textContent = 'Tramo';
  const noteSectionInput = document.createElement('input');
  noteSectionInput.id = uid + '-note-section';
  noteSectionInput.type = 'text';
  noteSectionInput.maxLength = 120;
  noteSectionInput.placeholder = 'Opcional · ej.: Sala del reloj';
  noteSectionInput.value = data.progress.currentSection || '';
  noteSectionRow.append(noteSectionLabel, noteSectionInput);

  const noteTextLabel = document.createElement('label');
  noteTextLabel.htmlFor = uid + '-note-text';
  noteTextLabel.textContent = 'Nota';
  const noteTextInput = document.createElement('textarea');
  noteTextInput.id = uid + '-note-text';
  noteTextInput.rows = 3;
  noteTextInput.maxLength = 4000;
  noteTextInput.placeholder = 'Ej.: Acá me trabé con la palanca roja; revisar la pared oeste.';

  const draftCaptures = [];
  const selectedChips = document.createElement('div');
  selectedChips.className = 'guide-selected-chips';
  selectedChips.hidden = true;
  const selector = buildCaptureSelector({ game, selectedIds: draftCaptures });

  const formActions = document.createElement('div');
  formActions.className = 'guide-note-actions';
  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'button small';
  attachBtn.innerHTML = icon('camera') + '<span>Adjuntar captura</span>';
  attachBtn.onclick = () => selector.toggle(selectedChips);
  const saveNoteBtn = document.createElement('button');
  saveNoteBtn.type = 'submit';
  saveNoteBtn.className = 'button small primary';
  saveNoteBtn.textContent = 'Guardar nota';
  formActions.append(attachBtn, saveNoteBtn);

  noteForm.append(noteSectionRow, noteTextLabel, noteTextInput, selectedChips, selector.box, formActions);

  noteForm.onsubmit = async (event) => {
    event.preventDefault();
    if (!noteTextInput.value.trim() && !draftCaptures.length) {
      notify('Escribí una nota o adjuntá al menos una captura.', { type: 'info' });
      noteTextInput.focus();
      return;
    }
    saveNoteBtn.disabled = true;
    try {
      const created = await request(
        guideUrl(game.key) + '/notes',
        jsonRequest('POST', {
          section: noteSectionInput.value,
          text: noteTextInput.value,
          captures: [...draftCaptures]
        })
      );
      data.notes.unshift(created);
      noteTextInput.value = '';
      draftCaptures.length = 0;
      selector.renderSelectedChips(selectedChips);
      selector.box.hidden = true;
      renderNotes();
      notify('Nota guardada.', { type: 'success' });
    } catch (error) {
      notifyError(error);
    } finally {
      saveNoteBtn.disabled = false;
    }
  };

  const notesList = document.createElement('div');
  notesList.className = 'guide-notes-list';

  function renderNotes() {
    notesList.replaceChildren();
    if (!data.notes.length) {
      const empty = document.createElement('p');
      empty.className = 'detail-empty';
      empty.textContent = 'Todavía no guardaste notas de partida para este juego.';
      notesList.append(empty);
      return;
    }
    data.notes.forEach((note) => {
      const card = document.createElement('article');
      card.className = 'guide-note-item';
      card.dataset.noteId = note.id;

      const meta = document.createElement('div');
      meta.className = 'guide-note-meta';
      const left = document.createElement('div');
      left.className = 'guide-note-tags';
      if (note.section) {
        const badge = document.createElement('span');
        badge.className = 'guide-badge';
        badge.textContent = note.section;
        left.append(badge);
      }
      const time = document.createElement('time');
      time.textContent = dateText(note.updatedAt);
      left.append(time);

      const controls = document.createElement('div');
      controls.className = 'guide-note-controls';
      if (note.section && note.section !== data.progress.currentSection) {
        const markHere = document.createElement('button');
        markHere.type = 'button';
        markHere.className = 'text-button';
        markHere.textContent = 'Marcar «Acá estoy»';
        markHere.onclick = () => saveSectionValue(note.section);
        controls.append(markHere);
      }
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'text-button';
      editBtn.textContent = 'Editar';
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'text-button';
      delBtn.textContent = 'Borrar';
      delBtn.onclick = async () => {
        delBtn.disabled = true;
        try {
          await request(guideUrl(game.key) + '/notes/' + encodeURIComponent(note.id), { method: 'DELETE' });
          data.notes = data.notes.filter((entry) => entry.id !== note.id);
          renderNotes();
          notify('Nota borrada.', { type: 'info' });
        } catch (error) {
          delBtn.disabled = false;
          notifyError(error);
        }
      };
      controls.append(editBtn, delBtn);
      meta.append(left, controls);
      card.append(meta);

      const viewBody = document.createElement('div');
      viewBody.className = 'guide-note-body';
      if (note.text) {
        const body = document.createElement('p');
        body.className = 'guide-note-text';
        body.textContent = note.text;
        viewBody.append(body);
      }
      if (note.captures?.length) {
        const gallery = document.createElement('div');
        gallery.className = 'guide-note-captures';
        const picturesForNote = () =>
          note.captures.map((id) => ({
            id,
            src: fullUrl(id),
            label: (note.section ? note.section + ' · ' : '') + dateText(note.updatedAt)
          }));
        note.captures.forEach((id) => gallery.append(renderCaptureThumb(id, game.name, picturesForNote)));
        viewBody.append(gallery);
      }
      card.append(viewBody);

      editBtn.onclick = () => {
        const editForm = document.createElement('form');
        editForm.className = 'guide-note-edit';
        const secInput = document.createElement('input');
        secInput.type = 'text';
        secInput.maxLength = 120;
        secInput.placeholder = 'Tramo (opcional)';
        secInput.value = note.section || '';
        secInput.setAttribute('aria-label', 'Tramo de la nota');
        const txtInput = document.createElement('textarea');
        txtInput.rows = 3;
        txtInput.maxLength = 4000;
        txtInput.value = note.text || '';
        txtInput.setAttribute('aria-label', 'Texto de la nota');
        const editCaptures = [...(note.captures ?? [])];
        const editChips = document.createElement('div');
        editChips.className = 'guide-selected-chips';
        const editSelector = buildCaptureSelector({ game, selectedIds: editCaptures });
        editSelector.renderSelectedChips(editChips);
        const editBtns = document.createElement('div');
        editBtns.className = 'guide-note-actions';
        const pickMore = document.createElement('button');
        pickMore.type = 'button';
        pickMore.className = 'button small';
        pickMore.innerHTML = icon('camera') + '<span>Capturas</span>';
        pickMore.onclick = () => editSelector.toggle(editChips);
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'button small';
        cancelBtn.textContent = 'Cancelar';
        cancelBtn.onclick = () => renderNotes();
        const saveBtn = document.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.className = 'button small primary';
        saveBtn.textContent = 'Guardar';
        editBtns.append(pickMore, cancelBtn, saveBtn);
        editForm.append(secInput, txtInput, editChips, editSelector.box, editBtns);
        editForm.onsubmit = async (event) => {
          event.preventDefault();
          if (!txtInput.value.trim() && !editCaptures.length) {
            notify('La nota no puede quedar vacía.', { type: 'info' });
            return;
          }
          saveBtn.disabled = true;
          try {
            const saved = await request(
              guideUrl(game.key) + '/notes/' + encodeURIComponent(note.id),
              jsonRequest('PUT', {
                section: secInput.value,
                text: txtInput.value,
                captures: editCaptures
              })
            );
            Object.assign(note, saved);
            renderNotes();
            notify('Nota actualizada.', { type: 'success' });
          } catch (error) {
            saveBtn.disabled = false;
            notifyError(error);
          }
        };
        viewBody.replaceWith(editForm);
        controls.hidden = true;
        txtInput.focus();
      };

      notesList.append(card);
    });
  }

  renderOfflineSection();
  renderCompanionSection();
  renderLinks();
  renderNotes();
  notesSection.append(noteForm, notesList);

  root.append(offlineCard, progressCard, companionCard, linksSection, notesSection);
  panel.replaceChildren(root);
}
