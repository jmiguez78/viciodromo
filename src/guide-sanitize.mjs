// Limpieza y conversión de HTML de wikis o archivos locales a Markdown seguro y tramos (sin scripts ni estilos).

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™'
};

const SKIP_HEADINGS = new Set(['contents', 'table of contents', 'navigation', 'external links', 'references']);

export function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, entity) => {
    const lower = entity.toLowerCase();
    if (NAMED_ENTITIES[lower]) return NAMED_ENTITIES[lower];
    const code = lower.startsWith('#x')
      ? Number.parseInt(lower.slice(2), 16)
      : lower.startsWith('#')
        ? Number.parseInt(lower.slice(1), 10)
        : NaN;
    if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) {
      try {
        return String.fromCodePoint(code);
      } catch {
        return full;
      }
    }
    return full;
  });
}

function safeHttps(value, baseUrl = null) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = decodeEntities(value.trim());
  if (/^(javascript|data|vbscript):/i.test(raw)) return null;
  try {
    const parsed = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : null;
  } catch {
    return null;
  }
}

export function stripUnsafe(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|iframe|object|embed|svg|form|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|style|iframe|object|embed|svg)\b[^>]*\/?>/gi, '')
    .replace(/<span\b[^>]*class=["'][^"']*mw-editsection[^"']*["'][^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<div\b[^>]*(?:id=["']toc["']|class=["'][^"']*\btoc\b[^"']*["'])[^>]*>[\s\S]*?<\/div>/gi, '');
}

const stripTags = (html) =>
  decodeEntities(String(html ?? '').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();

const attr = (attrs, name) => {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
};

export function htmlToMarkdown(html, { baseUrl = null } = {}) {
  let text = stripUnsafe(html);
  text = text.replace(/<img\b([^>]*)>/gi, (_all, attrs) => {
    const src = safeHttps(attr(attrs, 'src'), baseUrl);
    if (!src) return '';
    const alt =
      decodeEntities(attr(attrs, 'alt'))
        .replace(/[\[\]\r\n]/g, ' ')
        .trim() || 'Imagen';
    return `\n\n![${alt}](${src})\n\n`;
  });
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_all, attrs, inner) => {
    const label = stripTags(inner).replace(/[\[\]]/g, '');
    const href = safeHttps(attr(attrs, 'href'), baseUrl);
    if (!label) return '';
    return href ? `[${label}](${href})` : label;
  });
  text = text.replace(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level, inner) => {
    const heading = stripTags(inner);
    return heading ? `\n\n${'#'.repeat(Number(level))} ${heading}\n\n` : '\n\n';
  });
  text = text.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_all, inner) => {
    const item = htmlToInlineMarkdown(inner);
    return item ? `\n- ${item}` : '';
  });
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|blockquote|ul|ol|table|tr|dl|dt|dd)>/gi, '\n\n')
    .replace(/<(?:p|div|section|article|blockquote|ul|ol|tr)\b[^>]*>/gi, '\n')
    .replace(/<(?:td|th)\b[^>]*>/gi, ' ')
    .replace(/<\/(?:td|th)>/gi, ' · ');
  text = htmlToInlineMarkdown(text);
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function htmlToInlineMarkdown(fragment) {
  return decodeEntities(
    String(fragment ?? '')
      .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_all, inner) => {
        const clean = stripTags(inner);
        return clean ? `**${clean}**` : '';
      })
      .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_all, inner) => {
        const clean = stripTags(inner);
        return clean ? `*${clean}*` : '';
      })
      .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_all, inner) => {
        const clean = stripTags(inner).replace(/`/g, "'");
        return clean ? `\`${clean}\`` : '';
      })
      .replace(/<[^>]+>/g, '')
  );
}

export function sanitizeSectionTitle(value, fallback = 'Tramo') {
  const clean = stripTags(stripUnsafe(value)).slice(0, 120);
  return clean || fallback;
}

export function splitHtmlIntoSections(html, fallbackTitle = 'Guía completa', { baseUrl = null } = {}) {
  const cleaned = stripUnsafe(html);
  const tag = /<h2\b/i.test(cleaned) ? 'h2' : /<h3\b/i.test(cleaned) ? 'h3' : null;
  if (!tag) {
    const solution = htmlToMarkdown(cleaned, { baseUrl });
    return solution
      ? [{ id: 's01', order: 1, title: sanitizeSectionTitle(fallbackTitle, 'Guía completa'), solution }]
      : [];
  }
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const matches = [...cleaned.matchAll(regex)];
  const sections = [];
  const intro = htmlToMarkdown(cleaned.slice(0, matches[0].index), { baseUrl });
  if (intro && intro.length >= 40) {
    sections.push({ title: 'Introducción', solution: intro });
  }
  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : cleaned.length;
    const title = sanitizeSectionTitle(match[1], `Tramo ${sections.length + 1}`);
    if (SKIP_HEADINGS.has(title.toLowerCase())) return;
    const solution = htmlToMarkdown(cleaned.slice(start, end), { baseUrl });
    if (!solution) return;
    sections.push({ title, solution });
  });
  if (!sections.length) {
    const full = htmlToMarkdown(cleaned, { baseUrl });
    return full
      ? [{ id: 's01', order: 1, title: sanitizeSectionTitle(fallbackTitle, 'Guía completa'), solution: full }]
      : [];
  }
  return sections.map((item, idx) => ({
    id: 's' + String(idx + 1).padStart(2, '0'),
    order: idx + 1,
    title: item.title,
    solution: item.solution
  }));
}
