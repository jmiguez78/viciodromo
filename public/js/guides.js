// Guías de pistas y soluciones (Fases 1 y 2): enlaces directos en visor auxiliar o navegador, guías sin conexión
// (StrategyWiki e importación .txt/.md/.html), antispoiler por tramo, marca «Acá estoy» y notas con capturas.
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

let guideSummary = { withGuide: new Set(), available: new Set() };
export const hasGuide = (key) => guideSummary.withGuide.has(key);

function applyGuideSummary(data) {
  if (!data) return;
  guideSummary = {
    withGuide: new Set(data.withGuide ?? []),
    available: new Set(data.available ?? [])
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
  });
}

export function setup() {
  loadGuideSummary();
  window.addEventListener('gml-guides', (event) => applyGuideSummary(event.detail));
  const isTile = (node) =>
    node.nodeType === 1 && !node.classList.contains('guide-poster-badge') && !node.closest('.guide-poster-badge');
  new MutationObserver((changes) => {
    if (!guideSummary.withGuide.size) return;
    if (changes.some((change) => [...change.addedNodes].some(isTile))) paintGuideBadges();
  }).observe(document.querySelector('main') ?? document.body, { childList: true, subtree: true });
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

export async function loadGuideTab(panel, game) {
  if (!panel || !game) return;
  panel.dataset.guideKey = game.key;
  panel.innerHTML = '<div class="detail-loading"><span class="skeleton"></span></div>';
  let data;
  try {
    data = await request(guideUrl(game.key));
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

  const reloadTab = async (keepSectionId = null) => {
    const fresh = await request(guideUrl(game.key));
    if (panel.dataset.guideKey !== game.key || !panel.isConnected) return;
    data = fresh;
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
    renderLinks();
    renderNotes();
  };

  // ── 1. Guía sin conexión (StrategyWiki, archivos propios y lector con antispoiler) ──
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
      ? 'Leé por tramos sin internet y ocultá lo que viene después de «Acá estoy».'
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

    if (!data.activeGuide || !data.activeGuide.sections?.length) return;

    const sections = data.activeGuide.sections;
    const searchRow = document.createElement('div');
    searchRow.className = 'guide-search-row';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.value = searchQuery;
    searchInput.placeholder = 'Buscar dentro de esta guía…';
    searchInput.setAttribute('aria-label', 'Buscar dentro de la guía');
    const searchCount = document.createElement('span');
    searchCount.className = 'helper-text';
    searchRow.append(searchInput, searchCount);
    offlineCard.append(searchRow);

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
        searchQuery.trim().length >= 2 ? (totalMatches === 1 ? '1 coincidencia' : totalMatches + ' coincidencias') : '';

      const currentIndex = Math.max(
        0,
        sections.findIndex((s) => s.id === selectedSectionId)
      );
      const sec = sections[currentIndex];
      if (!sec) return;

      const secHead = document.createElement('div');
      secHead.className = 'guide-solution-head';
      const secTitle = document.createElement('h4');
      secTitle.textContent = sec.displayTitle;
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
      } else {
        const mdBody = document.createElement('div');
        mdBody.className = 'guide-solution-body';
        renderSafeMarkdown(mdBody, sec.solution, searchQuery);
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
  renderLinks();
  renderNotes();
  notesSection.append(noteForm, notesList);

  root.append(offlineCard, progressCard, linksSection, notesSection);
  panel.replaceChildren(root);
}
