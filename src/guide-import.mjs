// Importador nativo de guías propias (.txt, .md y .html): divide en tramos por encabezados, subrayados o
// numeración típica de FAQs en texto plano; si no detecta estructura clara, conserva un solo tramo con búsqueda.
import crypto from 'node:crypto';
import path from 'node:path';
import { sanitizeSectionTitle, splitHtmlIntoSections } from './guide-sanitize.mjs';

export const ALLOWED_GUIDE_EXTENSIONS = ['.txt', '.md', '.html', '.htm'];
export const MAX_IMPORT_BYTES = 4_000_000;

const UNDERLINE = /^[=\-*~_]{4,}\s*$/;
const DECORATED_HEADING = /^(?:[=\-*~]{2,}\s+(.+?)\s+[=\-*~]{2,}|\[([0-9]+(?:\.[0-9]+)*|[A-Z0-9-]{1,12})\]\s+(.+))$/;
const NUMBERED_HEADING =
  /^(?:(?:chapter|cap[ií]tulo|part|parte|section|secci[oó]n|stage|escenario|act|acto|level|nivel|episode|episodio)\s+[0-9ivxlcdm]+\b.*|(?:[0-9]{1,2}|[ivxlcdm]{1,5})[.)]\s+[A-ZÁÉÍÓÚÑ0-9].{2,80})$/i;

function packSections(items, fallbackTitle) {
  const valid = items
    .map((item) => ({
      title: sanitizeSectionTitle(item.title, fallbackTitle),
      solution: String(item.solution ?? '').trim()
    }))
    .filter((item) => item.solution.length > 0);
  if (valid.length < 2) {
    const joined = valid
      .map((item) => item.solution)
      .join('\n\n')
      .trim();
    return joined
      ? [{ id: 's01', order: 1, title: sanitizeSectionTitle(fallbackTitle, 'Guía completa'), solution: joined }]
      : [];
  }
  return valid.map((item, index) => ({
    id: 's' + String(index + 1).padStart(2, '0'),
    order: index + 1,
    title: item.title,
    solution: item.solution
  }));
}

export function detectTxtSections(text, fallbackTitle = 'Guía completa') {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const markers = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.length > 90) continue;
    const prevBlank = i === 0 || !lines[i - 1].trim();
    const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (next && UNDERLINE.test(next) && !UNDERLINE.test(line)) {
      markers.push({ line: i, bodyStart: i + 2, title: line });
      i += 1;
      continue;
    }
    const decorated = DECORATED_HEADING.exec(line);
    if (decorated) {
      const title = (decorated[1] ?? decorated[3] ?? '').trim();
      if (title.length >= 2) {
        markers.push({ line: i, bodyStart: i + 1, title });
        continue;
      }
    }
    if (prevBlank && NUMBERED_HEADING.test(line)) {
      const nextBody = lines[i + 1]?.trim() || lines[i + 2]?.trim() || '';
      // Evita tomar líneas consecutivas de una tabla de contenidos como tramos separados.
      if (nextBody && !NUMBERED_HEADING.test(nextBody) && !UNDERLINE.test(nextBody)) {
        markers.push({ line: i, bodyStart: i + 1, title: line });
      }
    }
  }
  if (markers.length < 2) {
    const full = lines.join('\n').trim();
    return full
      ? [{ id: 's01', order: 1, title: sanitizeSectionTitle(fallbackTitle, 'Guía completa'), solution: full }]
      : [];
  }
  const sections = [];
  const intro = lines.slice(0, markers[0].line).join('\n').trim();
  if (intro.length >= 60) sections.push({ title: 'Introducción', solution: intro });
  markers.forEach((marker, idx) => {
    const end = idx + 1 < markers.length ? markers[idx + 1].line : lines.length;
    const body = lines.slice(marker.bodyStart, end).join('\n').trim();
    if (body) sections.push({ title: marker.title, solution: body });
  });
  return packSections(sections, fallbackTitle);
}

export function detectMarkdownSections(text, fallbackTitle = 'Guía completa') {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const markers = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^#{1,3}\s+(.+)$/.exec(trimmed);
    if (match) markers.push({ line: i, title: match[1].replace(/\s+#*$/, '').trim() });
  }
  if (!markers.length) {
    const full = lines.join('\n').trim();
    return full
      ? [{ id: 's01', order: 1, title: sanitizeSectionTitle(fallbackTitle, 'Guía completa'), solution: full }]
      : [];
  }
  const sections = [];
  const intro = lines.slice(0, markers[0].line).join('\n').trim();
  if (intro.length >= 40) sections.push({ title: 'Introducción', solution: intro });
  markers.forEach((marker, idx) => {
    const end = idx + 1 < markers.length ? markers[idx + 1].line : lines.length;
    const body = lines
      .slice(marker.line + 1, end)
      .join('\n')
      .trim();
    if (body) sections.push({ title: marker.title, solution: body });
  });
  return packSections(sections, fallbackTitle);
}

export function importGuideFile({ filename, content, title = '', gameKey, now = Date.now }) {
  const baseName = path.basename(String(filename ?? '').trim());
  const ext = path.extname(baseName).toLowerCase();
  if (ext === '.pdf') {
    throw new Error('Por ahora se pueden importar guías en .txt, .md o .html (no .pdf).');
  }
  if (!ALLOWED_GUIDE_EXTENSIONS.includes(ext)) {
    throw new Error('Formato no compatible. Elegí un archivo .txt, .md o .html.');
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('El archivo está vacío.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_IMPORT_BYTES) {
    throw new Error('El archivo supera el límite de 4 MB.');
  }
  if (content.includes('\0')) {
    throw new Error('El archivo no contiene texto legible.');
  }
  const displayTitle = sanitizeSectionTitle(title || path.basename(baseName, ext), 'Guía importada');
  const sections =
    ext === '.html' || ext === '.htm'
      ? splitHtmlIntoSections(content, displayTitle)
      : ext === '.md'
        ? detectMarkdownSections(content, displayTitle)
        : detectTxtSections(content, displayTitle);
  if (!sections.length) throw new Error('No se encontró contenido legible en el archivo.');
  const digest = crypto.createHash('sha1').update(`${gameKey}:${baseName}:${content}`).digest('hex').slice(0, 12);
  return {
    id: 'file-' + digest,
    gameKey,
    title: displayTitle,
    lang: 'personal',
    source: {
      type: 'file',
      filename: baseName,
      authors: 'Archivo propio',
      license: 'Uso personal',
      retrievedAt: new Date(now()).toISOString().slice(0, 10)
    },
    sections
  };
}
