// Ventana flotante siempre visible (Fase 4): muestra pistas escalonadas, solución por tramo y «Acá estoy»
// de un juego desde una ventana compacta independiente, con control de transparencia y aviso de pantalla completa.
import { request } from './api.js';
import { icon } from './icons.js';

const app = document.querySelector('#guide-overlay-app');
const params = new URLSearchParams(location.search);
let currentKey = params.get('key') || '';

const guideUrl = (key) => '/api/guides/game/' + encodeURIComponent(key);
const jsonReq = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
});

let guideData = null;
let companion = { opacity: 0.92 };
let selectedSectionId = null;
let confirmSolution = false;
let confirmAnswerId = null;
let fullscreenNoticeHidden = false;
let showTranslated = false;

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function appendInlineMarkdown(parent, text) {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^)\s]+\))/g;
  let last = 0;
  const raw = String(text ?? '');
  for (const match of raw.matchAll(pattern)) {
    if (match.index > last) parent.append(document.createTextNode(raw.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      const el = document.createElement('strong');
      el.textContent = token.slice(2, -2);
      parent.append(el);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const el = document.createElement('em');
      el.textContent = token.slice(1, -1);
      parent.append(el);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      const el = document.createElement('code');
      el.textContent = token.slice(1, -1);
      parent.append(el);
    } else {
      const lm = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(token);
      if (lm) {
        const a = document.createElement('a');
        a.href = lm[2];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = lm[1];
        parent.append(a);
      } else {
        parent.append(document.createTextNode(token));
      }
    }
    last = match.index + token.length;
  }
  if (last < raw.length) parent.append(document.createTextNode(raw.slice(last)));
}

function renderSafeMarkdown(container, markdown) {
  container.replaceChildren();
  const lines = String(markdown ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  let list = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    appendInlineMarkdown(p, paragraph.join(' '));
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
    const headMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headMatch) {
      flushParagraph();
      flushList();
      const h = document.createElement(headMatch[1].length <= 2 ? 'h3' : 'h4');
      appendInlineMarkdown(h, headMatch[2]);
      container.append(h);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      if (!list) list = document.createElement('ul');
      const li = document.createElement('li');
      appendInlineMarkdown(li, line.replace(/^[-*]\s+/, ''));
      list.append(li);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
}

async function saveProgress(patch) {
  await request(guideUrl(currentKey) + '/progress', jsonReq('PUT', patch));
  await loadData();
}

async function loadData() {
  if (!currentKey) {
    render();
    return;
  }
  const [data, comp] = await Promise.all([
    request(guideUrl(currentKey)),
    request('/api/guides/companion').catch(() => null)
  ]);
  guideData = data;
  if (comp) companion = comp;
  document.documentElement.style.setProperty('--guide-overlay-alpha', String(companion.opacity ?? 0.92));
  const sections = guideData.activeGuide?.sections ?? [];
  if (!selectedSectionId || !sections.some((s) => s.id === selectedSectionId)) {
    selectedSectionId = guideData.progress.currentSectionId || sections[0]?.id || null;
  }
  document.title = guideData.name + ' · Guía flotante';
  render();
}

function render() {
  app.replaceChildren();
  if (!currentKey) {
    const h1 = document.createElement('h1');
    h1.textContent = 'Guía flotante';
    const p = document.createElement('p');
    p.className = 'helper-text';
    p.textContent = 'Elegí un juego desde Viciódromo para abrir su guía flotante.';
    app.append(h1, p);
    return;
  }
  if (!guideData) {
    const p = document.createElement('p');
    p.className = 'helper-text';
    p.textContent = 'Cargando guía…';
    app.append(p);
    return;
  }

  const head = document.createElement('header');
  head.className = 'guide-overlay-head';
  const titleWrap = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = guideData.name;
  const sub = document.createElement('p');
  sub.className = 'helper-text';
  sub.textContent = guideData.progress.currentSection
    ? 'Acá estoy: ' + guideData.progress.currentSection
    : 'Guía flotante siempre visible';
  titleWrap.append(h1, sub);
  head.append(titleWrap);

  const controlsBar = document.createElement('div');
  controlsBar.className = 'guide-overlay-opacity';
  const opLabel = document.createElement('label');
  opLabel.htmlFor = 'overlay-opacity';
  const opPct = Math.round((Number(companion.opacity) || 0.92) * 100);
  opLabel.textContent = 'Opacidad ' + opPct + '%';
  const opInput = document.createElement('input');
  opInput.id = 'overlay-opacity';
  opInput.type = 'range';
  opInput.min = '35';
  opInput.max = '100';
  opInput.value = String(opPct);
  opInput.oninput = () => {
    const pct = Number(opInput.value);
    opLabel.textContent = 'Opacidad ' + pct + '%';
    document.documentElement.style.setProperty('--guide-overlay-alpha', String(pct / 100));
  };
  opInput.onchange = async () => {
    const nextOpacity = Number(opInput.value) / 100;
    companion = await request('/api/guides/companion/settings', jsonReq('PUT', { opacity: nextOpacity })).catch(
      () => companion
    );
  };
  controlsBar.append(opLabel, opInput);
  head.append(controlsBar);
  app.append(head);

  if (!fullscreenNoticeHidden) {
    const notice = document.createElement('aside');
    notice.className = 'guide-overlay-notice';
    notice.innerHTML =
      icon('info') +
      '<p>Funciona sobre juegos en <strong>ventana sin bordes</strong>. En pantalla completa exclusiva Windows la oculta; usá ventana sin bordes, otro monitor o el celular.</p>';
    const closeNotice = document.createElement('button');
    closeNotice.type = 'button';
    closeNotice.className = 'button small';
    closeNotice.textContent = 'Entendido';
    closeNotice.onclick = () => {
      fullscreenNoticeHidden = true;
      render();
    };
    notice.append(closeNotice);
    app.append(notice);
  }

  const sections = guideData.activeGuide?.sections ?? [];
  if (sections.length) {
    const mode = guideData.progress.mode === 'solution' ? 'solution' : 'hints';
    const navCard = document.createElement('section');
    navCard.className = 'guide-overlay-card';

    const modeRow = document.createElement('div');
    modeRow.className = 'guide-overlay-row';
    const modeGroup = document.createElement('div');
    modeGroup.className = 'segmented guide-mode-switch';
    modeGroup.setAttribute('role', 'group');
    modeGroup.setAttribute('aria-label', 'Nivel de ayuda');

    const bHints = document.createElement('button');
    bHints.type = 'button';
    bHints.dataset.guideMode = 'hints';
    bHints.textContent = 'Pistas';
    bHints.setAttribute('aria-pressed', String(mode === 'hints'));
    bHints.classList.toggle('active', mode === 'hints');
    bHints.onclick = () => {
      confirmSolution = false;
      if (mode !== 'hints') saveProgress({ mode: 'hints' });
      else render();
    };

    const bSol = document.createElement('button');
    bSol.type = 'button';
    bSol.dataset.guideMode = 'solution';
    bSol.textContent = 'Solución';
    bSol.setAttribute('aria-pressed', String(mode === 'solution'));
    bSol.classList.toggle('active', mode === 'solution');
    bSol.onclick = () => {
      if (mode === 'solution') return;
      if (guideData.progress.skipSpoilerConfirm) return saveProgress({ mode: 'solution' });
      confirmSolution = !confirmSolution;
      render();
    };
    modeGroup.append(bHints, bSol);

    const hereBtn = document.createElement('button');
    hereBtn.type = 'button';
    hereBtn.className = 'button small';
    hereBtn.textContent = selectedSectionId === guideData.progress.currentSectionId ? 'Estás acá' : 'Acá estoy';
    hereBtn.onclick = () => saveProgress({ currentSectionId: selectedSectionId });
    modeRow.append(modeGroup, hereBtn);
    navCard.append(modeRow);

    if (confirmSolution) {
      const cBox = document.createElement('div');
      cBox.className = 'guide-confirm-inline';
      const p = document.createElement('p');
      p.textContent = '¿Pasar a Solución completa? Vas a ver el texto entero de este tramo.';
      const actions = document.createElement('div');
      actions.className = 'guide-overlay-row';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'button small';
      cancel.textContent = 'Seguir en Pistas';
      cancel.onclick = () => {
        confirmSolution = false;
        render();
      };
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'button small primary';
      ok.textContent = 'Ver solución completa';
      ok.onclick = () => {
        confirmSolution = false;
        saveProgress({ mode: 'solution' });
      };
      actions.append(cancel, ok);
      cBox.append(p, actions);
      navCard.append(cBox);
    }

    const secRow = document.createElement('div');
    secRow.className = 'guide-overlay-row';
    const idx = Math.max(
      0,
      sections.findIndex((s) => s.id === selectedSectionId)
    );
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'button small';
    prevBtn.setAttribute('aria-label', 'Tramo anterior');
    prevBtn.innerHTML = icon('chevronLeft');
    prevBtn.disabled = idx <= 0;
    prevBtn.onclick = () => {
      selectedSectionId = sections[idx - 1].id;
      showTranslated = false;
      render();
    };

    const secSelect = document.createElement('select');
    secSelect.className = 'guide-overlay-select';
    secSelect.setAttribute('aria-label', 'Elegir tramo');
    sections.forEach((sec) => {
      const opt = document.createElement('option');
      opt.value = sec.id;
      opt.textContent = sec.displayTitle + (sec.id === guideData.progress.currentSectionId ? ' · Acá estoy' : '');
      opt.selected = sec.id === selectedSectionId;
      secSelect.append(opt);
    });
    secSelect.onchange = () => {
      selectedSectionId = secSelect.value;
      showTranslated = false;
      render();
    };

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'button small';
    nextBtn.setAttribute('aria-label', 'Tramo siguiente');
    nextBtn.innerHTML = icon('chevronRight');
    nextBtn.disabled = idx >= sections.length - 1;
    nextBtn.onclick = () => {
      selectedSectionId = sections[idx + 1].id;
      showTranslated = false;
      render();
    };
    secRow.append(prevBtn, secSelect, nextBtn);
    navCard.append(secRow);
    app.append(navCard);

    const activeSec = sections[idx];
    const contentCard = document.createElement('section');
    contentCard.className = 'guide-overlay-card';
    const secHeading = document.createElement('h2');
    secHeading.textContent = activeSec.displayTitle;
    contentCard.append(secHeading);

    if (activeSec.locked) {
      const p = document.createElement('p');
      p.className = 'helper-text';
      p.textContent = 'Este tramo está después de «Acá estoy» y permanece oculto para evitar spoilers.';
      const unlock = document.createElement('button');
      unlock.type = 'button';
      unlock.className = 'button small primary';
      unlock.textContent = 'Mostrar este tramo';
      unlock.onclick = () => saveProgress({ revealSectionId: activeSec.id });
      contentCard.append(p, unlock);
    } else if (mode === 'solution') {
      if (activeSec.translation) {
        const transBtn = document.createElement('button');
        transBtn.type = 'button';
        transBtn.className = 'button small';
        transBtn.textContent = showTranslated ? 'Ver original' : 'Ver traducción al español';
        transBtn.onclick = () => {
          showTranslated = !showTranslated;
          render();
        };
        contentCard.append(transBtn);
      }
      const md = document.createElement('div');
      md.className = 'guide-markdown';
      const bodyText = showTranslated && activeSec.translation ? activeSec.translation.solution : activeSec.solution;
      renderSafeMarkdown(md, bodyText || 'Sin texto en este tramo.');
      contentCard.append(md);
    } else {
      const qs = activeSec.questions ?? [];
      if (!qs.length) {
        const p = document.createElement('p');
        p.className = 'helper-text';
        p.textContent = 'Este tramo no tiene preguntas con pistas todavía.';
        contentCard.append(p);
      }
      qs.forEach((q) => {
        const card = document.createElement('article');
        card.className = 'guide-question-card';
        const h3 = document.createElement('h3');
        h3.textContent = q.title;
        card.append(h3);
        if (q.visibleHints?.length) {
          const ol = document.createElement('ol');
          ol.className = 'guide-hint-list';
          q.visibleHints.forEach((hint) => {
            const li = document.createElement('li');
            li.textContent = hint;
            ol.append(li);
          });
          card.append(ol);
        }
        if (q.answerRevealed && q.answerQuote) {
          const ans = document.createElement('div');
          ans.className = 'guide-answer-box';
          const lbl = document.createElement('small');
          lbl.className = 'helper-text';
          lbl.textContent = 'Respuesta citada de la guía';
          const p = document.createElement('p');
          p.textContent = q.answerQuote;
          ans.append(lbl, p);
          card.append(ans);
        }
        const row = document.createElement('div');
        row.className = 'guide-question-actions';
        if (q.revealedCount < q.totalHints) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'button small primary';
          btn.textContent = q.revealedCount === 0 ? 'Ver pista 1' : 'Otra pista';
          btn.onclick = () =>
            saveProgress({
              setHintCount: { sectionId: activeSec.id, questionId: q.id, count: q.revealedCount + 1 }
            });
          row.append(btn);
        } else if (!q.answerRevealed) {
          if (confirmAnswerId === q.id && !guideData.progress.skipSpoilerConfirm) {
            const c = document.createElement('button');
            c.type = 'button';
            c.className = 'button small primary';
            c.textContent = 'Mostrar respuesta';
            c.onclick = () => {
              confirmAnswerId = null;
              saveProgress({ revealAnswer: { sectionId: activeSec.id, questionId: q.id } });
            };
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'button small';
            cancel.textContent = 'Cancelar';
            cancel.onclick = () => {
              confirmAnswerId = null;
              render();
            };
            row.append(c, cancel);
          } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'button small';
            btn.textContent = 'Ver la respuesta';
            btn.onclick = () => {
              if (guideData.progress.skipSpoilerConfirm) {
                saveProgress({ revealAnswer: { sectionId: activeSec.id, questionId: q.id } });
              } else {
                confirmAnswerId = q.id;
                render();
              }
            };
            row.append(btn);
          }
        }
        if (row.children.length) card.append(row);
        contentCard.append(card);
      });
    }
    app.append(contentCard);
  } else {
    const manualCard = document.createElement('section');
    manualCard.className = 'guide-overlay-card';
    const h2 = document.createElement('h2');
    h2.textContent = 'Sin guía sin conexión cargada';
    const p = document.createElement('p');
    p.className = 'helper-text';
    p.textContent = 'Podés guardar tu tramo en la ficha del juego o abrir una fuente externa.';
    manualCard.append(h2, p);
    const linksUl = document.createElement('ul');
    linksUl.className = 'guide-overlay-links';
    (guideData.links ?? []).forEach((link) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = link.label;
      li.append(a);
      linksUl.append(li);
    });
    manualCard.append(linksUl);
    app.append(manualCard);
  }

  if (guideData.notes?.length) {
    const notesDetails = document.createElement('details');
    notesDetails.className = 'guide-overlay-card';
    const sum = document.createElement('summary');
    sum.textContent = 'Notas de partida (' + guideData.notes.length + ')';
    notesDetails.append(sum);
    guideData.notes.forEach((n) => {
      const p = document.createElement('p');
      p.className = 'helper-text';
      p.textContent = (n.section ? n.section + ': ' : '') + n.text;
      notesDetails.append(p);
    });
    app.append(notesDetails);
  }
}

async function init() {
  try {
    const settings = await request('/api/settings').catch(() => null);
    applyTheme(settings?.theme);
    await loadData();
  } catch (error) {
    app.replaceChildren();
    const p = document.createElement('p');
    p.className = 'helper-text';
    p.textContent = error.message;
    app.append(p);
  }

  if (typeof EventSource === 'function') {
    const es = new EventSource('/api/events');
    es.addEventListener('guide-overlay', (event) => {
      const payload = JSON.parse(event.data || '{}');
      if (payload.gameKey && payload.gameKey !== currentKey) return;
      loadData().catch(() => {});
    });
    es.addEventListener('guides', () => {
      loadData().catch(() => {});
    });
  }
}

init();
