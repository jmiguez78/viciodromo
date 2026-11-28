// Micro-servidor efímero en red local y generador de código QR sin dependencias para leer la guía en el celular
// durante una partida (Fase 4). Apagado por defecto, con token de un solo uso canjeable por cookie de sesión.
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { badRequest, notFound } from './http.mjs';

const DEFAULT_IDLE_MS = 4 * 60 * 60 * 1000;
const SESSION_COOKIE = 'vicio_guide_sid';
const ALLOWED_PROGRESS_FIELDS = [
  'currentSectionId',
  'currentSection',
  'mode',
  'showFutureTitles',
  'skipSpoilerConfirm',
  'revealSectionId',
  'setHintCount',
  'revealAnswer',
  'hideQuestion'
];

// ── Código QR ISO/IEC 18004 (modo Byte, corrección L, versiones 1–6) ─────────────────────────────
const QR_VERSIONS = [
  { version: 1, size: 21, total: 26, data: 19, ecPerBlock: 7, blocks: 1, align: [] },
  { version: 2, size: 25, total: 44, data: 34, ecPerBlock: 10, blocks: 1, align: [6, 18] },
  { version: 3, size: 29, total: 70, data: 55, ecPerBlock: 15, blocks: 1, align: [6, 22] },
  { version: 4, size: 33, total: 100, data: 80, ecPerBlock: 20, blocks: 1, align: [6, 26] },
  { version: 5, size: 37, total: 134, data: 108, ecPerBlock: 26, blocks: 1, align: [6, 30] },
  { version: 6, size: 41, total: 172, data: 136, ecPerBlock: 18, blocks: 2, align: [6, 34] }
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const msg = [...data, ...new Array(ecCount).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      msg[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return msg.slice(data.length);
}

function formatBits(maskId) {
  const data = (0b01 << 3) | (maskId & 7);
  let rem = data << 10;
  const gen = 0x537;
  for (let i = 4; i >= 0; i--) {
    if (rem & (1 << (i + 10))) rem ^= gen << i;
  }
  return ((data << 10) | rem) ^ 0x5412;
}

const MASK_FN = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function applyFunctionPatterns(size, align) {
  const grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = top + r;
        const cc = left + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inBorder = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[rr][cc] = inBorder || inCore ? 1 : 0;
        reserved[rr][cc] = 1;
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (const r of align) {
    for (const c of align) {
      if (reserved[r][c]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) === 2 || (dr === 0 && dc === 0);
          grid[r + dr][c + dc] = dark ? 1 : 0;
          reserved[r + dr][c + dc] = 1;
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (!reserved[6][i]) {
      grid[6][i] = bit;
      reserved[6][i] = 1;
    }
    if (!reserved[i][6]) {
      grid[i][6] = bit;
      reserved[i][6] = 1;
    }
  }

  grid[size - 8][8] = 1;
  reserved[size - 8][8] = 1;

  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = 1;
      reserved[i][8] = 1;
    }
  }
  for (let i = size - 8; i < size; i++) reserved[8][i] = 1;
  for (let i = size - 7; i < size; i++) reserved[i][8] = 1;

  return { grid, reserved };
}

function writeFormatInfo(grid, size, maskId) {
  const fmt = formatBits(maskId);
  const bit = (idx) => (fmt >> idx) & 1;
  // Copia 1 (alrededor del buscador superior izquierdo)
  const topLeftCols = [0, 1, 2, 3, 4, 5, 7, 8];
  topLeftCols.forEach((c, idx) => {
    grid[8][c] = bit(14 - idx);
  });
  const topLeftRows = [7, 5, 4, 3, 2, 1, 0];
  topLeftRows.forEach((r, idx) => {
    grid[r][8] = bit(6 - idx);
  });
  // Copia 2 (abajo izquierda + arriba derecha)
  for (let idx = 0; idx < 7; idx++) grid[size - 1 - idx][8] = bit(14 - idx);
  for (let idx = 0; idx < 8; idx++) grid[8][size - 8 + idx] = bit(7 - idx);
}

function penaltyScore(grid, size) {
  let score = 0;
  // Regla 1: 5 o más módulos iguales seguidos
  for (let r = 0; r < size; r++) {
    let runRow = 1;
    let runCol = 1;
    for (let i = 1; i < size; i++) {
      if (grid[r][i] === grid[r][i - 1]) runRow += 1;
      else {
        if (runRow >= 5) score += runRow - 2;
        runRow = 1;
      }
      if (grid[i][r] === grid[i - 1][r]) runCol += 1;
      else {
        if (runCol >= 5) score += runCol - 2;
        runCol = 1;
      }
    }
    if (runRow >= 5) score += runRow - 2;
    if (runCol >= 5) score += runCol - 2;
  }
  // Regla 2: bloques 2x2
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (grid[r][c + 1] === v && grid[r + 1][c] === v && grid[r + 1][c + 1] === v) score += 3;
    }
  }
  // Regla 3: patrón tipo buscador (1011101 con 4 blancos a un lado)
  const isFinderLike = (slice, idx) =>
    idx + 6 < slice.length &&
    slice[idx] === 1 &&
    slice[idx + 1] === 0 &&
    slice[idx + 2] === 1 &&
    slice[idx + 3] === 1 &&
    slice[idx + 4] === 1 &&
    slice[idx + 5] === 0 &&
    slice[idx + 6] === 1;
  for (let i = 0; i < size; i++) {
    const row = grid[i];
    const col = grid.map((r) => r[i]);
    for (const line of [row, col]) {
      for (let j = 0; j <= size - 11; j++) {
        if (
          (j + 10 < size &&
            isFinderLike(line, j) &&
            line[j + 7] === 0 &&
            line[j + 8] === 0 &&
            line[j + 9] === 0 &&
            line[j + 10] === 0) ||
          (j + 10 < size &&
            line[j] === 0 &&
            line[j + 1] === 0 &&
            line[j + 2] === 0 &&
            line[j + 3] === 0 &&
            isFinderLike(line, j + 4))
        ) {
          score += 40;
        }
      }
    }
  }
  // Regla 4: proporción de oscuros
  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) if (grid[r][c] === 1) dark += 1;
  }
  const percent = (dark * 100) / (size * size);
  const diff = Math.min(Math.abs(Math.floor(percent / 5) * 5 - 50), Math.abs(Math.ceil(percent / 5) * 5 - 50));
  score += Math.floor(diff / 5) * 10;
  return score;
}

export function encodeQrMatrix(text) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  const spec = QR_VERSIONS.find((v) => Math.floor((v.data * 8 - 12) / 8) >= bytes.length);
  if (!spec) throw badRequest('El enlace del código QR es demasiado largo.');

  // Empaquetado de bits: modo Byte (0100), largo (8 bits), datos, terminador y relleno.
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  const maxDataBits = spec.data * 8;
  pushBits(0, Math.min(4, maxDataBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const dataWords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
    dataWords.push(w);
  }
  const pad = [0xec, 0x11];
  for (let i = 0; dataWords.length < spec.data; i++) dataWords.push(pad[i % 2]);

  // Bloques Reed-Solomon e intercalado.
  const blockSize = Math.floor(spec.data / spec.blocks);
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < spec.blocks; b++) {
    const slice = dataWords.slice(b * blockSize, (b + 1) * blockSize);
    dataBlocks.push(slice);
    ecBlocks.push(rsRemainder(slice, spec.ecPerBlock));
  }
  const stream = [];
  for (let i = 0; i < blockSize; i++) {
    for (let b = 0; b < spec.blocks; b++) stream.push(dataBlocks[b][i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < spec.blocks; b++) stream.push(ecBlocks[b][i]);
  }

  const streamBits = [];
  for (const w of stream) {
    for (let b = 7; b >= 0; b--) streamBits.push((w >> b) & 1);
  }

  const { grid: baseGrid, reserved } = applyFunctionPatterns(spec.size, spec.align);
  let bitIdx = 0;
  let dir = -1;
  for (let col = spec.size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let step = 0; step < spec.size; step++) {
      const row = dir === -1 ? spec.size - 1 - step : step;
      for (const c of [col, col - 1]) {
        if (reserved[row][c]) continue;
        baseGrid[row][c] = bitIdx < streamBits.length ? streamBits[bitIdx++] : 0;
      }
    }
    dir *= -1;
  }

  let bestGrid = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = baseGrid.map((row) => Int8Array.from(row));
    const fn = MASK_FN[mask];
    for (let r = 0; r < spec.size; r++) {
      for (let c = 0; c < spec.size; c++) {
        if (!reserved[r][c] && fn(r, c)) candidate[r][c] ^= 1;
      }
    }
    writeFormatInfo(candidate, spec.size, mask);
    const score = penaltyScore(candidate, spec.size);
    if (score < bestScore) {
      bestScore = score;
      bestGrid = candidate;
    }
  }

  return {
    size: spec.size,
    modules: bestGrid.map((row) => Array.from(row))
  };
}

export function renderQrSvg(matrix) {
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  const rects = [];
  for (let r = 0; r < matrix.size; r++) {
    for (let c = 0; c < matrix.size; c++) {
      if (matrix.modules[r][c]) rects.push(`<rect x="${c + quiet}" y="${r + quiet}" width="1" height="1"/>`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" role="img" aria-label="Código QR de acceso en el celular">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<g fill="#0b0c12">${rects.join('')}</g></svg>`
  );
}

// ── Detección de IP LAN ───────────────────────────────────────────────────────────────────────────
export function detectLanIp(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const entries of Object.values(interfaces ?? {})) {
    for (const info of entries ?? []) {
      if (!info || info.internal || (info.family !== 'IPv4' && info.family !== 4)) continue;
      if (info.address.startsWith('169.254.')) continue;
      const isPrivate =
        info.address.startsWith('192.168.') ||
        info.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(info.address);
      candidates.push({ address: info.address, priority: isPrivate ? 0 : 1 });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.address ?? '127.0.0.1';
}

// ── HTML y Script para la vista móvil en la LAN ───────────────────────────────────────────────────
const MOBILE_HTML = `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Guía · Viciódromo</title>
    <style>
      :root { color-scheme: dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 16px;
        background: #0d0e14;
        color: #f4f3f8;
        font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { max-width: 680px; margin: 0 auto; display: grid; gap: 14px; }
      header, section {
        background: #171923;
        border: 1px solid #2b2e40;
        border-radius: 14px;
        padding: 14px;
        display: grid;
        gap: 10px;
      }
      h1 { margin: 0; font-size: 20px; line-height: 1.2; }
      h2, h3, p { margin: 0; }
      small, .muted { color: #b2b6c8; font-size: 13px; }
      .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      select, button {
        min-height: 44px;
        padding: 8px 14px;
        border-radius: 10px;
        border: 1px solid #3a3f57;
        background: #232636;
        color: #f4f3f8;
        font: inherit;
        font-weight: 600;
      }
      select { flex: 1; min-width: 180px; }
      button.primary, button[aria-pressed="true"] {
        background: #6d5dfc;
        border-color: #8b7cf6;
        color: #ffffff;
      }
      .card {
        background: #11131c;
        border: 1px solid #292d3e;
        border-radius: 10px;
        padding: 12px;
        display: grid;
        gap: 8px;
      }
      .answer { border-left: 3px solid #8b7cf6; padding-left: 10px; }
      .md p, .md ul { margin: 0 0 8px; }
      .md img { max-width: 100%; border-radius: 8px; }
      a { color: #a89bff; }
    </style>
    <script src="/mobile.js" defer></script>
  </head>
  <body>
    <main id="app" aria-live="polite">Cargando guía…</main>
  </body>
</html>`;

const MOBILE_JS = `'use strict';
const app = document.getElementById('app');
let state = null;
let selectedId = null;
let confirmSolution = false;

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || 'Error ' + res.status);
  return data;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function renderInline(parent, text) {
  const pattern = /(\\*\\*[^*]+\\*\\*|\\*[^*]+\\*|\`[^\`]+\`|\\[[^\\]]+\\]\\(https:\\/\\/[^)\\s]+\\))/g;
  let last = 0;
  for (const m of String(text || '').matchAll(pattern)) {
    if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    if (tok.startsWith('**') && tok.endsWith('**')) parent.append(el('strong', '', tok.slice(2, -2)));
    else if (tok.startsWith('*') && tok.endsWith('*')) parent.append(el('em', '', tok.slice(1, -1)));
    else if (tok.startsWith('\`') && tok.endsWith('\`')) parent.append(el('code', '', tok.slice(1, -1)));
    else {
      const lm = /^\\[([^\\]]+)\\]\\((https:\\/\\/[^)\\s]+)\\)$/.exec(tok);
      if (lm) {
        const a = el('a', '', lm[1]);
        a.href = lm[2];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        parent.append(a);
      } else parent.append(document.createTextNode(tok));
    }
    last = m.index + tok.length;
  }
  if (last < String(text || '').length) parent.append(document.createTextNode(text.slice(last)));
}

function renderMd(host, md) {
  host.replaceChildren();
  let list = null;
  let para = [];
  const flushP = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    renderInline(p, para.join(' '));
    host.append(p);
    para = [];
  };
  const flushL = () => {
    if (list) host.append(list);
    list = null;
  };
  for (const raw of String(md || '').replace(/\\r\\n?/g, '\\n').split('\\n')) {
    const line = raw.trim();
    if (!line) { flushP(); flushL(); continue; }
    const hm = /^(#{1,4})\\s+(.+)$/.exec(line);
    if (hm) { flushP(); flushL(); const h = document.createElement('h3'); renderInline(h, hm[2]); host.append(h); continue; }
    if (/^[-*]\\s+/.test(line)) {
      flushP();
      if (!list) list = document.createElement('ul');
      const li = document.createElement('li');
      renderInline(li, line.replace(/^[-*]\\s+/, ''));
      list.append(li);
      continue;
    }
    flushL();
    para.push(line);
  }
  flushP();
  flushL();
}

async function saveProgress(patch) {
  await api('/api/progress', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch)
  });
  await refresh();
}

function render() {
  app.replaceChildren();
  if (!state) return;
  const header = el('header');
  header.append(el('h1', '', state.name));
  const sub = state.progress.currentSection ? 'Acá estoy: ' + state.progress.currentSection : 'Guía vinculada en red local';
  header.append(el('small', '', sub));

  const sections = state.activeGuide?.sections || [];
  if (!selectedId || !sections.some((s) => s.id === selectedId)) {
    selectedId = state.progress.currentSectionId || sections[0]?.id || null;
  }

  if (sections.length) {
    const modeRow = el('div', 'row');
    const mode = state.progress.mode === 'solution' ? 'solution' : 'hints';
    const bHints = el('button', '', 'Pistas');
    bHints.setAttribute('aria-pressed', String(mode === 'hints'));
    bHints.onclick = () => { confirmSolution = false; if (mode !== 'hints') saveProgress({ mode: 'hints' }); else render(); };
    const bSol = el('button', '', 'Solución');
    bSol.setAttribute('aria-pressed', String(mode === 'solution'));
    bSol.onclick = () => {
      if (mode === 'solution') return;
      if (state.progress.skipSpoilerConfirm) return saveProgress({ mode: 'solution' });
      confirmSolution = !confirmSolution;
      render();
    };
    modeRow.append(bHints, bSol);
    header.append(modeRow);

    if (confirmSolution) {
      const box = el('div', 'card');
      box.append(el('p', '', '¿Pasar a Solución completa?'));
      const yes = el('button', 'primary', 'Mostrar solución');
      yes.onclick = () => { confirmSolution = false; saveProgress({ mode: 'solution' }); };
      box.append(yes);
      header.append(box);
    }

    const navRow = el('div', 'row');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Tramo');
    sections.forEach((s) => {
      const opt = el('option', '', s.displayTitle + (s.id === state.progress.currentSectionId ? ' · Acá estoy' : ''));
      opt.value = s.id;
      if (s.id === selectedId) opt.selected = true;
      sel.append(opt);
    });
    sel.onchange = () => { selectedId = sel.value; render(); };
    const hereBtn = el('button', '', 'Acá estoy');
    hereBtn.onclick = () => saveProgress({ currentSectionId: selectedId });
    navRow.append(sel, hereBtn);
    header.append(navRow);
  }
  app.append(header);

  const currentSec = sections.find((s) => s.id === selectedId);
  if (currentSec) {
    const content = el('section');
    content.append(el('h2', '', currentSec.displayTitle));
    if (currentSec.locked) {
      content.append(el('p', 'muted', 'Este tramo está después de «Acá estoy» y sigue oculto.'));
      const unlock = el('button', 'primary', 'Mostrar este tramo');
      unlock.onclick = () => saveProgress({ revealSectionId: currentSec.id });
      content.append(unlock);
    } else if (state.progress.mode === 'solution') {
      const mdBox = el('div', 'md');
      renderMd(mdBox, currentSec.solution || 'Sin texto de solución.');
      content.append(mdBox);
    } else {
      const qs = currentSec.questions || [];
      if (!qs.length) content.append(el('p', 'muted', 'Todavía no hay pistas escalonadas en este tramo.'));
      qs.forEach((q) => {
        const card = el('article', 'card');
        card.append(el('h3', '', q.title));
        const ol = document.createElement('ol');
        (q.visibleHints || []).forEach((h) => ol.append(el('li', '', h)));
        if (q.visibleHints?.length) card.append(ol);
        if (q.answerRevealed && q.answerQuote) {
          const ans = el('div', 'answer');
          ans.append(el('p', '', q.answerQuote));
          card.append(ans);
        }
        const actions = el('div', 'row');
        if (q.revealedCount < q.totalHints) {
          const next = el('button', 'primary', q.revealedCount === 0 ? 'Ver pista 1' : 'Otra pista');
          next.onclick = () => saveProgress({ setHintCount: { sectionId: currentSec.id, questionId: q.id, count: q.revealedCount + 1 } });
          actions.append(next);
        } else if (!q.answerRevealed) {
          const ansBtn = el('button', '', 'Ver la respuesta');
          ansBtn.onclick = () => saveProgress({ revealAnswer: { sectionId: currentSec.id, questionId: q.id } });
          actions.append(ansBtn);
        }
        if (actions.children.length) card.append(actions);
        content.append(card);
      });
    }
    app.append(content);
  }

  if (state.notes?.length) {
    const notesSec = el('section');
    notesSec.append(el('h2', '', 'Tus notas'));
    state.notes.forEach((n) => {
      const card = el('div', 'card');
      if (n.section) card.append(el('small', '', n.section));
      if (n.text) card.append(el('p', '', n.text));
      notesSec.append(card);
    });
    app.append(notesSec);
  }
}

async function refresh() {
  state = await api('/api/guide');
  render();
}
refresh().catch((err) => { app.textContent = err.message; });
`;

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function tokensEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  return bufA.length > 0 && bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function readJsonBody(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(badRequest('Pedido demasiado grande.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(badRequest('El cuerpo debe ser JSON válido.'));
      }
    });
    req.on('error', reject);
  });
}

function sendSecurityHeaders(res, contentType) {
  res.setHeader('content-type', contentType);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cache-control', 'no-store');
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; img-src https:; frame-ancestors 'none'"
  );
}

export function createGuideLan({
  guides,
  findGame,
  log = () => {},
  host = '0.0.0.0',
  lanIp = null,
  idleMs = DEFAULT_IDLE_MS
}) {
  let state = null;

  function status() {
    if (!state) return { active: false };
    return {
      active: true,
      gameKey: state.gameKey,
      gameName: state.gameName,
      port: state.port,
      ip: state.ip,
      url: state.pairTokenUsed ? null : state.url,
      paired: Boolean(state.sessionId),
      startedAt: state.startedAt,
      qr: state.pairTokenUsed ? null : state.qr
    };
  }

  async function stop() {
    if (!state) return { active: false };
    const active = state;
    state = null;
    clearTimeout(active.timer);
    active.server.closeAllConnections?.();
    await new Promise((resolve) => active.server.close(() => resolve()));
    log('info', 'guias', `Servidor celular apagado (${active.gameKey})`);
    return { active: false };
  }

  async function stopForGame(gameKey) {
    if (state && state.gameKey === gameKey) return stop();
    return status();
  }

  function isAuthorized(req) {
    if (!state?.sessionId) return false;
    const cookies = parseCookies(req.headers.cookie);
    return tokensEqual(cookies[SESSION_COOKIE], state.sessionId);
  }

  async function handleRequest(req, res) {
    if (!state) {
      res.writeHead(404);
      return res.end();
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    if (url.pathname === '/pair' && req.method === 'GET') {
      const token = url.searchParams.get('t') || '';
      if (state.pairTokenUsed || !tokensEqual(token, state.pairToken)) {
        sendSecurityHeaders(res, 'text/html; charset=utf-8');
        res.writeHead(403);
        return res.end(
          '<!doctype html><html lang="es"><meta charset="utf-8"><body style="font-family:sans-serif;background:#0d0e14;color:#f4f3f8;padding:24px"><h1>Código ya utilizado o vencido</h1><p>Generá un nuevo QR desde Viciódromo en tu PC.</p></body></html>'
        );
      }
      state.pairTokenUsed = true;
      state.sessionId = crypto.randomBytes(24).toString('base64url');
      sendSecurityHeaders(res, 'text/html; charset=utf-8');
      res.setHeader('set-cookie', `${SESSION_COOKIE}=${state.sessionId}; HttpOnly; SameSite=Lax; Path=/`);
      res.writeHead(302, { location: '/' });
      return res.end();
    }

    if (!isAuthorized(req)) {
      // El QR abre Chrome desde otra app (la cámara): por eso la cookie es Lax y no Strict, que no se
      // mandaría en la redirección de /pair a /. Sin sesión, una página se explica en vez de mostrar JSON.
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        sendSecurityHeaders(res, 'text/html; charset=utf-8');
        res.writeHead(403);
        return res.end(
          '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="font-family:sans-serif;background:#0d0e14;color:#f4f3f8;padding:24px"><h1>Este celular no está vinculado</h1><p>En Viciódromo, abrí la pestaña Guía del juego, tocá «En el celular (QR)» y escaneá el código nuevo.</p></body></html>'
        );
      }
      sendSecurityHeaders(res, 'application/json; charset=utf-8');
      res.writeHead(403);
      return res.end(JSON.stringify({ error: 'Sesión no vinculada. Escaneá el código QR desde Viciódromo.' }));
    }

    if (url.pathname === '/' && req.method === 'GET') {
      sendSecurityHeaders(res, 'text/html; charset=utf-8');
      res.writeHead(200);
      return res.end(MOBILE_HTML);
    }

    if (url.pathname === '/mobile.js' && req.method === 'GET') {
      sendSecurityHeaders(res, 'application/javascript; charset=utf-8');
      res.writeHead(200);
      return res.end(MOBILE_JS);
    }

    if (url.pathname === '/api/guide' && req.method === 'GET') {
      const game = await findGame(state.gameKey);
      if (!game) {
        sendSecurityHeaders(res, 'application/json; charset=utf-8');
        res.writeHead(404);
        return res.end(JSON.stringify({ error: 'Juego no encontrado.' }));
      }
      const view = await guides.forGame(game);
      sendSecurityHeaders(res, 'application/json; charset=utf-8');
      res.writeHead(200);
      return res.end(
        JSON.stringify({
          key: view.key,
          name: view.name,
          progress: view.progress,
          activeGuide: view.activeGuide,
          links: view.links,
          notes: view.notes
        })
      );
    }

    if (url.pathname === '/api/progress' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const patch = {};
        for (const field of ALLOWED_PROGRESS_FIELDS) {
          if (field in body) patch[field] = body[field];
        }
        if (!Object.keys(patch).length) throw badRequest('Sin cambios válidos.');
        const progress = await guides.updateProgress(state.gameKey, patch);
        sendSecurityHeaders(res, 'application/json; charset=utf-8');
        res.writeHead(200);
        return res.end(JSON.stringify({ progress }));
      } catch (error) {
        sendSecurityHeaders(res, 'application/json; charset=utf-8');
        res.writeHead(error.status || 400);
        return res.end(JSON.stringify({ error: error.message }));
      }
    }

    sendSecurityHeaders(res, 'application/json; charset=utf-8');
    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Ruta no disponible en el lector móvil.' }));
  }

  async function start(gameKey) {
    const game = await findGame(gameKey);
    if (!game) throw notFound('Juego no encontrado.');
    if (state) await stop();

    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(error.message);
        }
      });
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolve);
    });

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const ip = lanIp || detectLanIp();
    const pairToken = crypto.randomBytes(16).toString('base64url');
    const url = `http://${ip}:${port}/pair?t=${pairToken}`;
    const qr = encodeQrMatrix(url);

    const timer = setTimeout(() => {
      stop().catch(() => {});
    }, idleMs);
    timer.unref?.();

    state = {
      server,
      port,
      ip,
      gameKey: game.key,
      gameName: game.name,
      pairToken,
      pairTokenUsed: false,
      sessionId: null,
      startedAt: new Date().toISOString(),
      url,
      qr,
      timer
    };
    log('info', 'guias', `Servidor celular activo en ${ip}:${port} para ${game.key}`);
    return status();
  }

  return { start, stop, stopForGame, status };
}
