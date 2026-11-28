// Guías de pistas y soluciones (Fases 1 y 2): almacenamiento separado de progreso («Acá estoy», nivel, último
// enlace abierto, tramos revelados y notas con capturas) e índice/ítems de guías sin conexión (StrategyWiki y
// archivos propios), más disponibilidad en búsqueda nocturna y selección de monitor acompañante.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findDisplay } from './displays.mjs';
import { createVersionedFile, readJsonCached } from './json-file.mjs';
import { badRequest, notFound } from './http.mjs';
import { guideLinksFor, safeGuideUrl } from './guide-sources/links.mjs';
import {
  checkStrategyWikiBatch,
  downloadStrategyWikiGuide,
  searchStrategyWiki
} from './guide-sources/strategywiki.mjs';
import { importGuideFile } from './guide-import.mjs';

export const GUIDE_MODES = ['hints', 'solution'];
const MAX_SECTION_LENGTH = 120;
const MAX_NOTE_LENGTH = 4000;
const MAX_CAPTURES_PER_NOTE = 8;
const MAX_NOTES_PER_GAME = 200;
const MAX_REVEALED_SECTIONS = 500;
const CAPTURE_ID = /^[a-f0-9]{16,40}$/;
const GUIDE_ID = /^[a-z0-9][a-z0-9_-]{1,80}$/i;
const AVAILABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ARCADE_AVAILABILITY_LIMIT = 300;

const emptyProgressStore = () => ({ games: {} });
const emptyIndexStore = () => ({ guides: {}, availability: {} });

const cleanSection = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_SECTION_LENGTH) : '');
const cleanNoteText = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_NOTE_LENGTH) : '');

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
    updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
    notes
  };
}

export function createGuides({
  dataDir,
  offline = false,
  fetchImpl = globalThis.fetch,
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
        games: saved?.games && typeof saved.games === 'object' ? saved.games : {}
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
    return data?.games && typeof data.games === 'object' ? data : emptyProgressStore();
  };
  const updateProgressStore = (change) =>
    progressFile.update((store) => {
      const next = store?.games && typeof store.games === 'object' ? store : emptyProgressStore();
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
    const idx = await readIndex();
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
    return { withGuide, available };
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
      updatedAt: entry.updatedAt
    };
  }

  async function forGame(game, { viewerSupported = false, companion = null } = {}) {
    const [progStore, idx] = await Promise.all([readProgress(), readIndex()]);
    const entry = normalizeEntry(progStore.games[game.key]);
    const guides = Object.values(idx.guides)
      .filter((item) => item.gameKey === game.key)
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    const activeId =
      (entry.activeGuideId && guides.some((g) => g.id === entry.activeGuideId) ? entry.activeGuideId : guides[0]?.id) ??
      null;
    let activeGuide = null;
    if (activeId) {
      const item = await readItem(activeId).catch(() => null);
      if (item && Array.isArray(item.sections)) {
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
      current.updatedAt = iso();
      store.games[key] = current;
      savedProgress = publicProgress(current);
      return store;
    });
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

  async function editSection(gameKey, guideId, sectionId, { title, mergeWithPrevious = false } = {}) {
    const item = await readItem(guideId).catch(() => null);
    if (!item || item.gameKey !== gameKey) throw notFound('No se encontró esa guía.');
    const sections = Array.isArray(item.sections) ? [...item.sections] : [];
    const index = sections.findIndex((s) => s.id === sectionId);
    if (index < 0) throw notFound('No se encontró ese tramo.');
    if (mergeWithPrevious) {
      if (index === 0) throw badRequest('El primer tramo no tiene uno anterior para unir.');
      const prev = sections[index - 1];
      const cur = sections[index];
      sections[index - 1] = {
        ...prev,
        solution: [prev.solution, `### ${cur.title}\n\n${cur.solution}`].filter(Boolean).join('\n\n')
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

  return {
    filePath,
    indexPath,
    summary,
    forGame,
    updateProgress,
    addNote,
    updateNote,
    deleteNote,
    rememberOpened,
    searchStrategyWikiForGame,
    downloadStrategyWiki,
    importFile,
    deleteGuide,
    editSection,
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
