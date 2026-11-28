// Guías de pistas y soluciones (Fase 1): almacenamiento separado de progreso («Acá estoy», nivel, último enlace
// abierto) y notas de partida por tramo (con capturas asociadas por identificador), más selección de monitor
// acompañante.
import crypto from 'node:crypto';
import path from 'node:path';
import { findDisplay } from './displays.mjs';
import { createVersionedFile } from './json-file.mjs';
import { badRequest, notFound } from './http.mjs';
import { guideLinksFor, safeGuideUrl } from './guide-sources/links.mjs';

export const GUIDE_MODES = ['hints', 'solution'];
const MAX_SECTION_LENGTH = 120;
const MAX_NOTE_LENGTH = 4000;
const MAX_CAPTURES_PER_NOTE = 8;
const MAX_NOTES_PER_GAME = 200;
const CAPTURE_ID = /^[a-f0-9]{16,40}$/;

const emptyStore = () => ({ games: {} });

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
// Si el juego va en un monitor elegido (o en el principal), elige el primer otro monitor conectado.
export function companionDisplay(displays, gameDisplay = null) {
  if (!Array.isArray(displays) || displays.length < 2) return null;
  const gameTarget =
    (gameDisplay && findDisplay(displays, gameDisplay)) ?? displays.find((item) => item.primary) ?? displays[0];
  return displays.find((item) => item.id !== gameTarget?.id) ?? null;
}

function normalizeEntry(entry) {
  const mode = GUIDE_MODES.includes(entry?.mode) ? entry.mode : 'hints';
  const currentSection = cleanSection(entry?.currentSection);
  const lastUrl = safeGuideUrl(entry?.lastUrl);
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
    mode,
    lastUrl,
    updatedAt: typeof entry?.updatedAt === 'string' ? entry.updatedAt : null,
    notes
  };
}

export function createGuides({ dataDir, log = () => {}, now = () => Date.now() }) {
  const filePath = path.join(dataDir, 'guides', 'progress.json');
  const file = createVersionedFile(filePath, {
    version: 1,
    fallback: emptyStore,
    migrations: {
      1: (saved) => ({
        games: saved?.games && typeof saved.games === 'object' ? saved.games : {}
      })
    }
  });
  const read = async () => {
    const data = await file.read();
    return data?.games && typeof data.games === 'object' ? data : emptyStore();
  };
  const update = (change) =>
    file.update((store) => {
      const next = store?.games && typeof store.games === 'object' ? store : emptyStore();
      return change(next) ?? next;
    });
  const iso = () => new Date(now()).toISOString();

  async function forGame(game, { viewerSupported = false, companion = null } = {}) {
    const store = await read();
    const entry = normalizeEntry(store.games[game.key]);
    return {
      key: game.key,
      name: game.name,
      links: guideLinksFor(game),
      progress: {
        currentSection: entry.currentSection,
        mode: entry.mode,
        lastUrl: entry.lastUrl,
        updatedAt: entry.updatedAt
      },
      notes: entry.notes,
      viewerSupported: Boolean(viewerSupported),
      companionDisplay: companion
        ? { id: companion.id, name: companion.name, number: companion.number, primary: Boolean(companion.primary) }
        : null
    };
  }

  async function updateProgress(key, patch = {}) {
    let savedProgress = null;
    await update((store) => {
      const current = normalizeEntry(store.games[key]);
      if ('currentSection' in patch) {
        if (typeof patch.currentSection !== 'string') throw badRequest('El tramo debe ser texto.');
        current.currentSection = cleanSection(patch.currentSection);
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
      current.updatedAt = iso();
      store.games[key] = current;
      savedProgress = {
        currentSection: current.currentSection,
        mode: current.mode,
        lastUrl: current.lastUrl,
        updatedAt: current.updatedAt
      };
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
    await update((store) => {
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
    await update((store) => {
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
    await update((store) => {
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

  return {
    filePath,
    forGame,
    updateProgress,
    addNote,
    updateNote,
    deleteNote,
    rememberOpened
  };
}
