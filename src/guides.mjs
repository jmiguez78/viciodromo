// Guías de pistas y soluciones (Fases 1 a 3): almacenamiento separado de progreso («Acá estoy», nivel,
// último enlace abierto, pistas reveladas, tramos revelados y notas con capturas), índice/ítems de guías
// sin conexión (StrategyWiki y archivos propios), disponibilidad nocturna y pistas escalonadas / IA opcional.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findDisplay } from './displays.mjs';
import { createVersionedFile, readJsonCached } from './json-file.mjs';
import { badRequest, conflict, notFound } from './http.mjs';
import { guideLinksFor, safeGuideUrl } from './guide-sources/links.mjs';
import {
  checkStrategyWikiBatch,
  downloadStrategyWikiGuide,
  searchStrategyWiki
} from './guide-sources/strategywiki.mjs';
import { importGuideFile } from './guide-import.mjs';
import {
  askAboutGuide,
  cleanQuestion,
  estimateHintsCost,
  generateSectionHints,
  translateSection
} from './guide-hints.mjs';

export const GUIDE_MODES = ['hints', 'solution'];
export const DEFAULT_COMPANION = {
  opacity: 0.92,
  shortcutsEnabled: true,
  toggleShortcut: 'CommandOrControl+Alt+G',
  nextHintShortcut: 'CommandOrControl+Alt+H'
};
const MAX_SECTION_LENGTH = 120;
const MAX_NOTE_LENGTH = 4000;
const MAX_CAPTURES_PER_NOTE = 8;
const MAX_NOTES_PER_GAME = 200;
const MAX_REVEALED_SECTIONS = 500;
const CAPTURE_ID = /^[a-f0-9]{16,40}$/;
const GUIDE_ID = /^[a-z0-9][a-z0-9_-]{1,80}$/i;
const AVAILABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ARCADE_AVAILABILITY_LIMIT = 300;

const ACCEL_MODIFIERS = {
  cmdorctrl: 'CommandOrControl',
  commandorcontrol: 'CommandOrControl',
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  super: 'Super',
  meta: 'Super',
  cmd: 'Super',
  command: 'Super'
};

const ACCEL_SPECIAL_KEYS = {
  space: 'Space',
  tab: 'Tab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  plus: 'Plus',
  minus: 'Minus',
  insert: 'Insert',
  delete: 'Delete'
};

export function validateAccelerator(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') throw badRequest('El atajo debe ser texto.');
  const trimmed = value.trim();
  if (!trimmed) return '';
  const parts = trimmed
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    throw badRequest('El atajo debe incluir al menos un modificador (Ctrl, Alt o Shift) y una tecla.');
  }
  const keyRaw = parts[parts.length - 1];
  const modRaw = parts.slice(0, -1);
  const mods = [];
  const seen = new Set();
  for (const mod of modRaw) {
    const canonical = ACCEL_MODIFIERS[mod.toLowerCase()];
    if (!canonical) throw badRequest(`Modificador no reconocido en atajo: ${mod}.`);
    const group = canonical === 'Control' || canonical === 'CommandOrControl' ? 'Ctrl' : canonical;
    if (seen.has(group)) throw badRequest('No repitas modificadores en el mismo atajo.');
    seen.add(group);
    mods.push(canonical);
  }
  let canonicalKey = null;
  if (/^[a-z0-9]$/i.test(keyRaw)) {
    canonicalKey = keyRaw.toUpperCase();
  } else if (/^f([1-9]|1[0-2])$/i.test(keyRaw)) {
    canonicalKey = keyRaw.toUpperCase();
  } else if (ACCEL_SPECIAL_KEYS[keyRaw.toLowerCase()]) {
    canonicalKey = ACCEL_SPECIAL_KEYS[keyRaw.toLowerCase()];
  }
  if (!canonicalKey) throw badRequest(`Tecla no válida para atajo global: ${keyRaw}.`);
  return [...mods, canonicalKey].join('+');
}

export function normalizeCompanionSettings(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const rawOpacity = Number(src.opacity);
  const opacity = Number.isFinite(rawOpacity)
    ? Math.round(Math.max(0.35, Math.min(1, rawOpacity)) * 100) / 100
    : DEFAULT_COMPANION.opacity;
  const shortcutsEnabled =
    typeof src.shortcutsEnabled === 'boolean' ? src.shortcutsEnabled : DEFAULT_COMPANION.shortcutsEnabled;
  const toggleShortcut =
    'toggleShortcut' in src ? validateAccelerator(src.toggleShortcut) : DEFAULT_COMPANION.toggleShortcut;
  const nextHintShortcut =
    'nextHintShortcut' in src ? validateAccelerator(src.nextHintShortcut) : DEFAULT_COMPANION.nextHintShortcut;
  if (toggleShortcut && nextHintShortcut && toggleShortcut === nextHintShortcut) {
    throw badRequest('Los atajos para mostrar la ventana y pedir pista no pueden ser iguales.');
  }
  return { opacity, shortcutsEnabled, toggleShortcut, nextHintShortcut };
}

const emptyProgressStore = () => ({ games: {}, companion: { ...DEFAULT_COMPANION } });
const emptyIndexStore = () => ({ guides: {}, availability: {} });

const cleanSection = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_SECTION_LENGTH) : '');
const cleanNoteText = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_NOTE_LENGTH) : '');
const hintKey = (sectionId, questionId) => `${sectionId}/${questionId}`;

export function cleanCaptureIds(value) {
  if (!Array.isArray(value)) return [];
  const unique = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (CAPTURE_ID.test(id) && !unique.includes(id)) unique.push(id);
    if (unique.length >= MAX_CAPTURES_PER_NOTE) break;
  }
  return unique;
}

// Monitor acompañante donde abrir la guía al jugar: con menos de dos monitores devuelve null.
export function companionDisplay(displays, gameDisplay = null) {
  if (!Array.isArray(displays) || displays.length < 2) return null;
  const gameTarget =
    (gameDisplay && findDisplay(displays, gameDisplay)) ?? displays.find((item) => item.primary) ?? displays[0];
  return displays.find((item) => item.id !== gameTarget?.id) ?? null;
}

function projectQuestions(questions = [], sectionId, progress = {}) {
  const revealedHints = progress.revealedHints ?? {};
  const revealedAnswers = new Set(Array.isArray(progress.revealedAnswers) ? progress.revealedAnswers : []);
  return (Array.isArray(questions) ? questions : []).map((q) => {
    const qKey = hintKey(sectionId, q.id);
    const allHints = Array.isArray(q.hints) ? q.hints : [];
    const count = Math.min(allHints.length, Math.max(0, Number(revealedHints[qKey]) || 0));
    const answerRevealed = revealedAnswers.has(qKey);
    return {
      id: q.id,
      title: q.title,
      origin: q.origin || 'manual',
      edited: q.edited === true,
      totalHints: allHints.length,
      revealedCount: count,
      visibleHints: allHints.slice(0, count),
      answerRevealed,
      answerQuote: answerRevealed ? (q.answerQuote ?? '') : ''
    };
  });
}

// Antispoiler por tramo: lo que viene después del tramo actual («Acá estoy») queda oculto salvo que se revele.
export function applyAntiSpoiler(sections = [], progress = {}) {
  const currentIndex = progress.currentSectionId
    ? sections.findIndex((item) => item.id === progress.currentSectionId)
    : -1;
  const revealed = new Set(Array.isArray(progress.revealedSections) ? progress.revealedSections : []);
  return sections.map((section, index) => {
    const isFuture = currentIndex >= 0 && index > currentIndex;
    const unlocked = !isFuture || Boolean(progress.skipSpoilerConfirm) || revealed.has(section.id);
    const showTitle = !isFuture || Boolean(progress.showFutureTitles) || unlocked;
    const order = section.order ?? index + 1;
    return {
      id: section.id,
      order,
      title: showTitle ? section.title : `Tramo ${order}`,
      displayTitle: showTitle ? section.title : `Tramo ${order}`,
      realTitle: showTitle ? section.title : null,
      solution: unlocked ? section.solution : '',
      translation: unlocked && section.translation ? section.translation : null,
      questions: unlocked ? projectQuestions(section.questions, section.id, progress) : [],
      isFuture,
      locked: !unlocked
    };
  });
}

function normalizeEntry(entry) {
  const mode = GUIDE_MODES.includes(entry?.mode) ? entry.mode : 'hints';
  const currentSection = cleanSection(entry?.currentSection);
  const currentSectionId =
    typeof entry?.currentSectionId === 'string' && entry.currentSectionId.trim()
      ? entry.currentSectionId.trim().slice(0, 40)
      : null;
  const activeGuideId =
    typeof entry?.activeGuideId === 'string' && GUIDE_ID.test(entry.activeGuideId.trim())
      ? entry.activeGuideId.trim()
      : null;
  const lastUrl = safeGuideUrl(entry?.lastUrl);
  const revealedSections = Array.isArray(entry?.revealedSections)
    ? [...new Set(entry.revealedSections.filter((id) => typeof id === 'string' && id.trim()))].slice(
        -MAX_REVEALED_SECTIONS
      )
    : [];
  const revealedHints = {};
  if (entry?.revealedHints && typeof entry.revealedHints === 'object' && !Array.isArray(entry.revealedHints)) {
    for (const [k, v] of Object.entries(entry.revealedHints)) {
      if (typeof k === 'string' && Number.isInteger(v) && v > 0 && v <= 10) revealedHints[k] = v;
    }
  }
  const revealedAnswers = Array.isArray(entry?.revealedAnswers)
    ? [...new Set(entry.revealedAnswers.filter((id) => typeof id === 'string' && id.trim()))].slice(-1000)
    : [];
  const notes = Array.isArray(entry?.notes)
    ? entry.notes
        .filter((note) => note && typeof note === 'object' && typeof note.id === 'string')
        .map((note) => ({
          id: note.id,
          section: cleanSection(note.section),
          text: cleanNoteText(note.text),
          captures: cleanCaptureIds(note.captures),
          updatedAt: typeof note.updatedAt === 'string' ? note.updatedAt : null
        }))
        .slice(0, MAX_NOTES_PER_GAME)
    : [];
  return {
    currentSection,
    currentSectionId,
    activeGuideId,
    mode,
    lastUrl,
    showFutureTitles: entry?.showFutureTitles === true,
    skipSpoilerConfirm: entry?.skipSpoilerConfirm === true,
    revealedSections,
    revealedHints,
    revealedAnswers,
    updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
    notes
  };
}

export function createGuides({
  dataDir,
  offline = false,
  fetchImpl = globalThis.fetch,
  ai = null,
  log = () => {},
  now = () => Date.now(),
  onChange = () => {}
}) {
  const guidesDir = path.join(dataDir, 'guides');
  const itemsDir = path.join(guidesDir, 'items');
  const filePath = path.join(guidesDir, 'progress.json');
  const indexPath = path.join(guidesDir, 'index.json');

  const progressFile = createVersionedFile(filePath, {
    version: 1,
    fallback: emptyProgressStore,
    migrations: {
      1: (saved) => ({
        games: saved?.games && typeof saved.games === 'object' ? saved.games : {},
        companion: normalizeCompanionSettings(saved?.companion)
      })
    }
  });
  const indexFile = createVersionedFile(indexPath, {
    version: 1,
    fallback: emptyIndexStore,
    migrations: {
      1: (saved) => ({
        guides: saved?.guides && typeof saved.guides === 'object' ? saved.guides : {},
        availability: saved?.availability && typeof saved.availability === 'object' ? saved.availability : {}
      })
    }
  });

  const readProgress = async () => {
    const data = await progressFile.read();
    return data?.games && typeof data.games === 'object'
      ? { games: data.games, companion: data.companion }
      : emptyProgressStore();
  };
  const updateProgressStore = (change) =>
    progressFile.update((store) => {
      const next =
        store?.games && typeof store.games === 'object'
          ? { ...store, games: store.games, companion: store.companion }
          : emptyProgressStore();
      return change(next) ?? next;
    });

  const readIndex = async () => {
    const data = await indexFile.read();
    return {
      guides: data?.guides && typeof data.guides === 'object' ? data.guides : {},
      availability: data?.availability && typeof data.availability === 'object' ? data.availability : {}
    };
  };
  const updateIndex = (change) =>
    indexFile.update((store) => {
      const next = {
        guides: store?.guides && typeof store.guides === 'object' ? store.guides : {},
        availability: store?.availability && typeof store.availability === 'object' ? store.availability : {}
      };
      return change(next) ?? next;
    });

  const iso = () => new Date(now()).toISOString();

  function itemPath(id) {
    if (!GUIDE_ID.test(String(id ?? ''))) throw badRequest('Identificador de guía no válido.');
    return path.join(itemsDir, `${id}.json`);
  }

  async function readItem(id) {
    return readJsonCached(itemPath(id), null);
  }

  async function writeItem(guide) {
    const target = itemPath(guide.id);
    await fs.mkdir(itemsDir, { recursive: true });
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify({ schemaVersion: 1, ...guide }, null, 2));
    await fs.rename(temp, target);
  }

  async function summary() {
    const [idx, prog] = await Promise.all([readIndex(), readProgress()]);
    const withGuide = [
      ...new Set(
        Object.values(idx.guides)
          .map((item) => item.gameKey)
          .filter(Boolean)
      )
    ];
    const available = Object.entries(idx.availability)
      .filter(([, entry]) => entry?.strategywiki?.available === true)
      .map(([key]) => key);
    const progress = {};
    for (const [gameKey, raw] of Object.entries(prog.games ?? {})) {
      const entry = normalizeEntry(raw);
      const hintsViewed = Object.values(entry.revealedHints).reduce((sum, n) => sum + (Number(n) || 0), 0);
      if (entry.currentSection || hintsViewed > 0) {
        progress[gameKey] = {
          currentSection: entry.currentSection,
          hintsViewed
        };
      }
    }
    return { withGuide, available, progress };
  }

  async function saveGuideItem(guide) {
    await writeItem(guide);
    const meta = {
      id: guide.id,
      gameKey: guide.gameKey,
      title: guide.title,
      lang: guide.lang,
      source: guide.source,
      sectionCount: guide.sections.length,
      updatedAt: iso()
    };
    await updateIndex((idx) => {
      idx.guides[guide.id] = meta;
      if (guide.source?.type === 'strategywiki') {
        idx.availability[guide.gameKey] = {
          ...(idx.availability[guide.gameKey] ?? {}),
          strategywiki: {
            available: true,
            pageTitle: guide.source.pageTitle ?? null,
            url: guide.source.url ?? null,
            checkedAt: iso()
          }
        };
      }
      return idx;
    });
    await updateProgressStore((store) => {
      const current = normalizeEntry(store.games[guide.gameKey]);
      current.activeGuideId = guide.id;
      current.updatedAt = iso();
      store.games[guide.gameKey] = current;
      return store;
    });
    onChange(await summary());
    return meta;
  }

  function publicProgress(entry) {
    return {
      currentSection: entry.currentSection,
      currentSectionId: entry.currentSectionId,
      activeGuideId: entry.activeGuideId,
      mode: entry.mode,
      lastUrl: entry.lastUrl,
      showFutureTitles: entry.showFutureTitles,
      skipSpoilerConfirm: entry.skipSpoilerConfirm,
      revealedSections: entry.revealedSections,
      revealedHints: entry.revealedHints,
      revealedAnswers: entry.revealedAnswers,
      updatedAt: entry.updatedAt
    };
  }

  async function forGame(game, { viewerSupported = false, companion = null } = {}) {
    const [progStore, idx, aiStatus] = await Promise.all([
      readProgress(),
      readIndex(),
      ai
        ? ai.status().catch(() => ({ configured: false, source: null }))
        : Promise.resolve({ configured: false, source: null })
    ]);
    const entry = normalizeEntry(progStore.games[game.key]);
    const guides = Object.values(idx.guides)
      .filter((item) => item.gameKey === game.key)
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    const activeId =
      (entry.activeGuideId && guides.some((g) => g.id === entry.activeGuideId) ? entry.activeGuideId : guides[0]?.id) ??
      null;
    let activeGuide = null;
    let hintsEstimate = null;
    if (activeId) {
      const item = await readItem(activeId).catch(() => null);
      if (item && Array.isArray(item.sections)) {
        hintsEstimate = estimateHintsCost(item.sections);
        activeGuide = {
          id: item.id,
          gameKey: item.gameKey,
          title: item.title,
          lang: item.lang,
          source: item.source,
          sections: applyAntiSpoiler(item.sections, entry)
        };
      }
    }
    return {
      key: game.key,
      name: game.name,
      links: guideLinksFor(game),
      progress: publicProgress({ ...entry, activeGuideId: activeId }),
      notes: entry.notes,
      guides,
      activeGuide,
      hintsEstimate,
      ai: aiStatus,
      availability: idx.availability[game.key]?.strategywiki ?? null,
      viewerSupported: Boolean(viewerSupported),
      companionDisplay: companion
        ? { id: companion.id, name: companion.name, number: companion.number, primary: Boolean(companion.primary) }
        : null
    };
  }

  async function updateProgress(key, patch = {}) {
    let savedProgress = null;
    const idx = await readIndex();
    await updateProgressStore(async (store) => {
      const current = normalizeEntry(store.games[key]);
      if ('activeGuideId' in patch) {
        if (patch.activeGuideId === null || patch.activeGuideId === '') {
          current.activeGuideId = null;
        } else {
          const meta = idx.guides[patch.activeGuideId];
          if (!meta || meta.gameKey !== key) throw notFound('No se encontró esa guía para este juego.');
          current.activeGuideId = meta.id;
        }
      }
      if ('currentSectionId' in patch) {
        if (patch.currentSectionId === null || patch.currentSectionId === '') {
          current.currentSectionId = null;
        } else if (typeof patch.currentSectionId === 'string') {
          current.currentSectionId = patch.currentSectionId.trim().slice(0, 40);
          const targetGuideId =
            current.activeGuideId ?? Object.values(idx.guides).find((item) => item.gameKey === key)?.id;
          if (targetGuideId && !('currentSection' in patch)) {
            const item = await readItem(targetGuideId).catch(() => null);
            const found = item?.sections?.find((s) => s.id === current.currentSectionId);
            if (found) current.currentSection = cleanSection(found.title);
          }
        } else {
          throw badRequest('Identificador de tramo no válido.');
        }
      }
      if ('currentSection' in patch) {
        if (typeof patch.currentSection !== 'string') throw badRequest('El tramo debe ser texto.');
        current.currentSection = cleanSection(patch.currentSection);
        if (!current.currentSection && !('currentSectionId' in patch)) current.currentSectionId = null;
      }
      if ('mode' in patch) {
        if (!GUIDE_MODES.includes(patch.mode)) throw badRequest('Elegí Pistas o Solución.');
        current.mode = patch.mode;
      }
      if ('lastUrl' in patch) {
        if (patch.lastUrl === null || patch.lastUrl === '') current.lastUrl = null;
        else {
          const url = safeGuideUrl(patch.lastUrl);
          if (!url) throw badRequest('El enlace de la guía debe empezar con https://.');
          current.lastUrl = url;
        }
      }
      if ('showFutureTitles' in patch) {
        if (typeof patch.showFutureTitles !== 'boolean') throw badRequest('Indicá si se muestran los títulos futuros.');
        current.showFutureTitles = patch.showFutureTitles;
      }
      if ('skipSpoilerConfirm' in patch) {
        if (typeof patch.skipSpoilerConfirm !== 'boolean') throw badRequest('Valor no válido.');
        current.skipSpoilerConfirm = patch.skipSpoilerConfirm;
      }
      if ('revealSectionId' in patch && typeof patch.revealSectionId === 'string' && patch.revealSectionId.trim()) {
        const sid = patch.revealSectionId.trim().slice(0, 40);
        current.revealedSections = [...new Set([...current.revealedSections, sid])].slice(-MAX_REVEALED_SECTIONS);
      }
      if (patch.resetRevealed === true) {
        current.revealedSections = [];
      }
      if (patch.setHintCount && typeof patch.setHintCount === 'object') {
        const { sectionId, questionId, count } = patch.setHintCount;
        if (
          typeof sectionId !== 'string' ||
          typeof questionId !== 'string' ||
          !Number.isInteger(count) ||
          count < 0 ||
          count > 10
        ) {
          throw badRequest('Datos de pista no válidos.');
        }
        const k = hintKey(sectionId.trim(), questionId.trim());
        if (count === 0) delete current.revealedHints[k];
        else current.revealedHints[k] = count;
      }
      if (patch.revealAnswer && typeof patch.revealAnswer === 'object') {
        const { sectionId, questionId } = patch.revealAnswer;
        if (typeof sectionId !== 'string' || typeof questionId !== 'string') {
          throw badRequest('Datos de respuesta no válidos.');
        }
        const k = hintKey(sectionId.trim(), questionId.trim());
        current.revealedAnswers = [...new Set([...current.revealedAnswers, k])].slice(-1000);
      }
      if (patch.hideQuestion && typeof patch.hideQuestion === 'object') {
        const { sectionId, questionId } = patch.hideQuestion;
        if (typeof sectionId === 'string' && typeof questionId === 'string') {
          const k = hintKey(sectionId.trim(), questionId.trim());
          delete current.revealedHints[k];
          current.revealedAnswers = current.revealedAnswers.filter((item) => item !== k);
        }
      }
      current.updatedAt = iso();
      store.games[key] = current;
      savedProgress = publicProgress(current);
      return store;
    });
    if (
      'currentSection' in patch ||
      'currentSectionId' in patch ||
      'setHintCount' in patch ||
      'revealAnswer' in patch ||
      'hideQuestion' in patch ||
      patch.resetRevealed === true
    ) {
      onChange(await summary());
    }
    return savedProgress;
  }

  async function addNote(key, { section = '', text = '', captures = [] } = {}) {
    const cleanText = cleanNoteText(text);
    const cleanCaps = cleanCaptureIds(captures);
    if (!cleanText && !cleanCaps.length) throw badRequest('Escribí una nota o adjuntá al menos una captura.');
    const note = {
      id: 'n-' + crypto.randomUUID().slice(0, 12),
      section: cleanSection(section),
      text: cleanText,
      captures: cleanCaps,
      updatedAt: iso()
    };
    await updateProgressStore((store) => {
      const current = normalizeEntry(store.games[key]);
      current.notes = [note, ...current.notes].slice(0, MAX_NOTES_PER_GAME);
      store.games[key] = current;
      return store;
    });
    log('info', 'guias', `Nota guardada en ${key}${note.section ? ` (${note.section})` : ''}`);
    return note;
  }

  async function updateNote(key, id, patch = {}) {
    let updated = null;
    await updateProgressStore((store) => {
      const current = normalizeEntry(store.games[key]);
      const index = current.notes.findIndex((item) => item.id === id);
      if (index < 0) throw notFound('No se encontró esa nota.');
      const existing = current.notes[index];
      const next = {
        ...existing,
        section: 'section' in patch ? cleanSection(patch.section) : existing.section,
        text: 'text' in patch ? cleanNoteText(patch.text) : existing.text,
        captures: 'captures' in patch ? cleanCaptureIds(patch.captures) : existing.captures,
        updatedAt: iso()
      };
      if (!next.text && !next.captures.length) throw badRequest('La nota no puede quedar vacía sin texto ni capturas.');
      current.notes[index] = next;
      store.games[key] = current;
      updated = next;
      return store;
    });
    return updated;
  }

  async function deleteNote(key, id) {
    await updateProgressStore((store) => {
      const current = normalizeEntry(store.games[key]);
      const before = current.notes.length;
      current.notes = current.notes.filter((item) => item.id !== id);
      if (current.notes.length === before) throw notFound('No se encontró esa nota.');
      store.games[key] = current;
      return store;
    });
  }

  async function rememberOpened(key, url) {
    const safe = safeGuideUrl(url);
    if (!safe) return null;
    return updateProgress(key, { lastUrl: safe });
  }

  async function searchStrategyWikiForGame(game) {
    const result = await searchStrategyWiki(game, { fetchImpl, offline });
    await updateIndex((idx) => {
      idx.availability[game.key] = {
        ...(idx.availability[game.key] ?? {}),
        strategywiki: {
          available: Boolean(result.found),
          pageTitle: result.pageTitle ?? null,
          url: result.url ?? null,
          checkedAt: iso()
        }
      };
      return idx;
    });
    return result;
  }

  async function downloadStrategyWiki(game, { pageTitle = null } = {}) {
    const guide = await downloadStrategyWikiGuide(game, { pageTitle, fetchImpl, offline, now });
    const meta = await saveGuideItem(guide);
    log('info', 'guias', `Guía descargada de StrategyWiki para ${game.key}: ${guide.sections.length} tramos`);
    return { meta, ...(await forGame(game)) };
  }

  async function importFile(game, { filename, content, title = '' }) {
    let guide;
    try {
      guide = importGuideFile({ filename, content, title, gameKey: game.key, now });
    } catch (error) {
      throw badRequest(error.message);
    }
    const meta = await saveGuideItem(guide);
    log('info', 'guias', `Guía importada (${guide.source.filename}) para ${game.key}: ${guide.sections.length} tramos`);
    return { meta, ...(await forGame(game)) };
  }

  async function deleteGuide(gameKey, guideId) {
    const targetPath = itemPath(guideId);
    const idx = await readIndex();
    const meta = idx.guides[guideId];
    if (!meta || meta.gameKey !== gameKey) throw notFound('No se encontró esa guía.');
    await fs.rm(targetPath, { force: true });
    let nextActive = null;
    await updateIndex((store) => {
      delete store.guides[guideId];
      nextActive = Object.values(store.guides).find((item) => item.gameKey === gameKey)?.id ?? null;
      return store;
    });
    await updateProgressStore((store) => {
      const current = normalizeEntry(store.games[gameKey]);
      if (current.activeGuideId === guideId) {
        current.activeGuideId = nextActive;
        current.currentSectionId = null;
        current.revealedSections = [];
        store.games[gameKey] = current;
      }
      return store;
    });
    onChange(await summary());
  }

  async function loadSectionContext(gameKey, guideId, sectionId) {
    const item = await readItem(guideId).catch(() => null);
    if (!item || item.gameKey !== gameKey) throw notFound('No se encontró esa guía.');
    const sections = Array.isArray(item.sections) ? [...item.sections] : [];
    const index = sections.findIndex((s) => s.id === sectionId);
    if (index < 0) throw notFound('No se encontró ese tramo.');
    return { item, sections, index, section: sections[index] };
  }

  async function editSection(gameKey, guideId, sectionId, { title, mergeWithPrevious = false } = {}) {
    const { item, sections, index } = await loadSectionContext(gameKey, guideId, sectionId);
    if (mergeWithPrevious) {
      if (index === 0) throw badRequest('El primer tramo no tiene uno anterior para unir.');
      const prev = sections[index - 1];
      const cur = sections[index];
      sections[index - 1] = {
        ...prev,
        solution: [prev.solution, `### ${cur.title}\n\n${cur.solution}`].filter(Boolean).join('\n\n'),
        questions: [...(prev.questions ?? []), ...(cur.questions ?? [])]
      };
      sections.splice(index, 1);
    } else if (typeof title === 'string') {
      const clean = cleanSection(title);
      if (!clean) throw badRequest('Escribí un nombre para el tramo.');
      sections[index] = { ...sections[index], title: clean };
    } else {
      throw badRequest('Indicá un título nuevo o si querés unir el tramo con el anterior.');
    }
    const reordered = sections.map((s, idx) => ({ ...s, order: idx + 1 }));
    await writeItem({ ...item, sections: reordered });
    await updateIndex((idx) => {
      if (idx.guides[guideId]) idx.guides[guideId].sectionCount = reordered.length;
      return idx;
    });
    if (!mergeWithPrevious && typeof title === 'string') {
      await updateProgressStore((store) => {
        const current = normalizeEntry(store.games[gameKey]);
        if (current.currentSectionId === sectionId) {
          current.currentSection = cleanSection(title);
          store.games[gameKey] = current;
        }
        return store;
      });
    }
    return reordered;
  }

  // ── Fase 3: Preguntas y pistas escalonadas (editor manual + IA opcional) ──
  async function getQuestion(gameKey, guideId, sectionId, questionId) {
    const { section } = await loadSectionContext(gameKey, guideId, sectionId);
    const found = (section.questions ?? []).find((q) => q.id === questionId);
    if (!found) throw notFound('No se encontró esa pregunta.');
    return found;
  }

  async function addQuestion(gameKey, guideId, sectionId, payload) {
    const { item, sections, index, section } = await loadSectionContext(gameKey, guideId, sectionId);
    const question = cleanQuestion(payload, { origin: 'manual' });
    sections[index] = { ...section, questions: [...(section.questions ?? []), question] };
    await writeItem({ ...item, sections });
    return question;
  }

  async function updateQuestion(gameKey, guideId, sectionId, questionId, payload) {
    const { item, sections, index, section } = await loadSectionContext(gameKey, guideId, sectionId);
    const list = [...(section.questions ?? [])];
    const qIndex = list.findIndex((q) => q.id === questionId);
    if (qIndex < 0) throw notFound('No se encontró esa pregunta.');
    const existing = list[qIndex];
    const next = cleanQuestion(
      {
        ...existing,
        ...payload,
        id: existing.id,
        edited: existing.origin === 'ai' ? true : existing.edited === true
      },
      { origin: existing.origin || 'manual' }
    );
    list[qIndex] = next;
    sections[index] = { ...section, questions: list };
    await writeItem({ ...item, sections });
    return next;
  }

  async function deleteQuestion(gameKey, guideId, sectionId, questionId) {
    const { item, sections, index, section } = await loadSectionContext(gameKey, guideId, sectionId);
    const list = section.questions ?? [];
    const filtered = list.filter((q) => q.id !== questionId);
    if (filtered.length === list.length) throw notFound('No se encontró esa pregunta.');
    sections[index] = { ...section, questions: filtered };
    await writeItem({ ...item, sections });
    await updateProgressStore((store) => {
      const current = normalizeEntry(store.games[gameKey]);
      const k = hintKey(sectionId, questionId);
      delete current.revealedHints[k];
      current.revealedAnswers = current.revealedAnswers.filter((entry) => entry !== k);
      store.games[gameKey] = current;
      return store;
    });
  }

  async function generateHints(game, guideId, sectionId) {
    if (!ai) throw conflict('La IA no está disponible.');
    const { item, sections, index, section } = await loadSectionContext(game.key, guideId, sectionId);
    const generated = await generateSectionHints({ ai, gameName: game.name, section });
    const keptManual = (section.questions ?? []).filter((q) => q.origin !== 'ai');
    sections[index] = { ...section, questions: [...keptManual, ...generated] };
    await writeItem({ ...item, sections });
    log('info', 'guias', `Pistas armadas con IA para ${game.key} · ${section.title} (${generated.length})`);
    return generated;
  }

  async function askGuide(game, guideId, { sectionId = null, question = '', revealAnswer = false }) {
    if (!ai) throw conflict('La IA no está disponible.');
    const item = await readItem(guideId).catch(() => null);
    if (!item || item.gameKey !== game.key) throw notFound('No se encontró esa guía.');
    const entry = normalizeEntry((await readProgress()).games[game.key]);
    const visibleSections = applyAntiSpoiler(item.sections ?? [], entry);
    return askAboutGuide({ ai, gameName: game.name, sections: visibleSections, sectionId, question, revealAnswer });
  }

  async function translateGuideSection(game, guideId, sectionId) {
    if (!ai) throw conflict('La IA no está disponible.');
    const { item, sections, index, section } = await loadSectionContext(game.key, guideId, sectionId);
    if (section.translation) return section.translation;
    const translation = await translateSection({ ai, gameName: game.name, section });
    sections[index] = { ...section, translation };
    await writeItem({ ...item, sections });
    return translation;
  }

  async function checkAvailability(
    games = [],
    { max = 100, ttlMs = AVAILABILITY_TTL_MS, arcadeLimit = ARCADE_AVAILABILITY_LIMIT, prefsGames = {} } = {}
  ) {
    if (offline) return { checked: 0, found: 0 };
    const idx = await readIndex();
    const arcadeCount = games.filter((g) => g.platform === 'Arcade').length;
    const candidates = games
      .filter((game) => game.installed !== false)
      .filter((game) => {
        if (game.platform !== 'Arcade' || arcadeCount <= arcadeLimit) return true;
        return Boolean(prefsGames[game.key]?.favorite || prefsGames[game.key]?.lastLaunchedAt);
      })
      .filter((game) => {
        const prev = idx.availability[game.key]?.strategywiki;
        return !prev?.checkedAt || now() - Date.parse(prev.checkedAt) > ttlMs;
      })
      .slice(0, max);
    if (!candidates.length) return { checked: 0, found: 0 };
    const results = await checkStrategyWikiBatch(candidates, { fetchImpl, offline });
    const at = iso();
    let found = 0;
    await updateIndex((store) => {
      for (const [key, res] of results.entries()) {
        if (res.available) found += 1;
        store.availability[key] = {
          ...(store.availability[key] ?? {}),
          strategywiki: { ...res, checkedAt: at }
        };
      }
      return store;
    });
    if (found) onChange(await summary());
    return { checked: results.size, found };
  }

  async function getCompanionSettings() {
    const prog = await readProgress();
    return normalizeCompanionSettings(prog.companion);
  }

  async function updateCompanionSettings(patch = {}) {
    let saved = null;
    await updateProgressStore((store) => {
      const current = normalizeCompanionSettings(store.companion);
      const next = normalizeCompanionSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
      store.companion = next;
      saved = next;
      return store;
    });
    return saved;
  }

  async function revealNextHint(gameKey, { sectionId = null, questionId = null } = {}) {
    const [progStore, idx] = await Promise.all([readProgress(), readIndex()]);
    const entry = normalizeEntry(progStore.games[gameKey]);
    const guides = Object.values(idx.guides)
      .filter((item) => item.gameKey === gameKey)
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    const activeId =
      (entry.activeGuideId && guides.some((g) => g.id === entry.activeGuideId) ? entry.activeGuideId : guides[0]?.id) ??
      null;
    if (!activeId) return { ok: false, reason: 'no-guide', gameKey };
    const item = await readItem(activeId).catch(() => null);
    if (!item || !Array.isArray(item.sections)) return { ok: false, reason: 'no-guide', gameKey };
    const projected = applyAntiSpoiler(item.sections, entry);
    const unlockedSections = projected.filter((s) => !s.locked);
    const targetSec =
      (sectionId && unlockedSections.find((s) => s.id === sectionId)) ||
      (entry.currentSectionId && unlockedSections.find((s) => s.id === entry.currentSectionId)) ||
      unlockedSections[0] ||
      null;
    if (!targetSec || !targetSec.questions?.length) {
      return { ok: false, reason: 'no-questions', gameKey, sectionId: targetSec?.id ?? null };
    }
    const rawSec = item.sections.find((s) => s.id === targetSec.id);
    const qProjected =
      (questionId && targetSec.questions.find((q) => q.id === questionId)) ||
      targetSec.questions.find((q) => q.revealedCount < q.totalHints) ||
      targetSec.questions[0];
    const qRaw = (rawSec?.questions ?? []).find((q) => q.id === qProjected.id);
    const hints = Array.isArray(qRaw?.hints) ? qRaw.hints : [];
    const currentCount = qProjected.revealedCount;
    if (currentCount >= hints.length) {
      return {
        ok: false,
        reason: 'exhausted',
        gameKey,
        sectionId: targetSec.id,
        questionId: qProjected.id,
        questionTitle: qProjected.title,
        answerAvailable: Boolean(qRaw?.answerQuote)
      };
    }
    const nextCount = currentCount + 1;
    await updateProgress(gameKey, {
      setHintCount: { sectionId: targetSec.id, questionId: qProjected.id, count: nextCount }
    });
    return {
      ok: true,
      gameKey,
      sectionId: targetSec.id,
      sectionTitle: targetSec.displayTitle,
      questionId: qProjected.id,
      questionTitle: qProjected.title,
      hintIndex: nextCount,
      totalHints: hints.length,
      hint: hints[nextCount - 1],
      exhausted: nextCount >= hints.length
    };
  }

  return {
    filePath,
    indexPath,
    summary,
    forGame,
    updateProgress,
    getCompanionSettings,
    updateCompanionSettings,
    revealNextHint,
    addNote,
    updateNote,
    deleteNote,
    rememberOpened,
    searchStrategyWikiForGame,
    downloadStrategyWiki,
    importFile,
    deleteGuide,
    editSection,
    getQuestion,
    addQuestion,
    updateQuestion,
    deleteQuestion,
    generateHints,
    askGuide,
    translateGuideSection,
    checkAvailability
  };
}

// Búsqueda nocturna (electron-main --scan): consulta en lotes qué juegos instalados tienen guía en StrategyWiki
// sin descargar contenido ni modificar notas/progreso.
export async function nightlyGuides(dataDir, log = () => {}, options = {}) {
  const offline = options.offline ?? process.env.GML_OFFLINE === '1';
  if (offline) return { checked: 0, found: 0 };
  const readJson = async (name, fallback) => {
    try {
      return JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8'));
    } catch {
      return fallback;
    }
  };
  const [catalog, prefs] = await Promise.all([readJson('library.json', {}), readJson('preferences.json', {})]);
  const guides = createGuides({ ...options, dataDir, offline, log });
  const result = await guides.checkAvailability(catalog.games ?? [], { prefsGames: prefs.games ?? {} });
  if (result.checked) {
    log('info', 'tarea', `Guías en StrategyWiki: ${result.checked} consultados, ${result.found} disponibles`);
  }
  return result;
}
