// Pestaña Guía de la ficha (Fase 1): enlaces armados en visor auxiliar o navegador, marca «Acá estoy» y notas de
// partida por tramo con capturas adjuntas.
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

  // ── 1. Cabecera y «Acá estoy» ──
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
      renderNotes();
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

  // ── 2. Fuentes de guía (enlaces directos) ──
  const linksSection = document.createElement('section');
  linksSection.className = 'guide-card';
  linksSection.innerHTML =
    '<div class="guide-section-head"><h3>Fuentes de guía</h3>' +
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
  renderLinks();

  // ── 3. Notas de partida por tramo ──
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
  renderNotes();
  notesSection.append(noteForm, notesList);

  root.append(progressCard, linksSection, notesSection);
  panel.replaceChildren(root);
}
