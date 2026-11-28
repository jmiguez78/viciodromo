// Pistas escalonadas y asistencia opcional con IA: siempre parten de un tramo o guía ya cargada; nunca inventan
// soluciones de memoria ni exponen tramos futuros bloqueados por antispoiler.
import crypto from 'node:crypto';
import { badGateway, badRequest, conflict } from './http.mjs';

export const HINT_ORIGINS = ['manual', 'source', 'ai'];
const MAX_TITLE = 180;
const MAX_HINT = 400;
const MAX_HINTS_PER_QUESTION = 4;
const MAX_ANSWER = 1200;
const MAX_QUESTIONS_PER_AI_PASS = 8;

const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export function cleanQuestion(input, { origin = 'manual' } = {}) {
  if (!input || typeof input !== 'object') throw badRequest('Pregunta no válida.');
  const title = cleanText(input.title, MAX_TITLE);
  if (!title) throw badRequest('Escribí el título de la pregunta (sin spoiler).');
  const rawHints = Array.isArray(input.hints) ? input.hints : [];
  const hints = rawHints
    .map((item) => cleanText(item, MAX_HINT))
    .filter(Boolean)
    .slice(0, MAX_HINTS_PER_QUESTION);
  if (!hints.length) throw badRequest('Agregá al menos una pista.');
  const answerQuote = cleanText(input.answerQuote ?? input.answer ?? '', MAX_ANSWER);
  if (!answerQuote) throw badRequest('Escribí la respuesta o cita de la solución.');
  const id =
    typeof input.id === 'string' && /^[\w-]{1,40}$/.test(input.id.trim())
      ? input.id.trim()
      : 'q-' + crypto.randomUUID().slice(0, 8);
  return {
    id,
    title,
    hints,
    answerQuote,
    origin: HINT_ORIGINS.includes(origin) ? origin : 'manual',
    ...(input.edited === true ? { edited: true } : {})
  };
}

export function estimateHintsCost(sections = []) {
  const nonEmpty = (Array.isArray(sections) ? sections : []).filter((s) => String(s?.solution ?? '').trim().length > 0);
  const chars = nonEmpty.reduce((sum, s) => sum + String(s.solution).length, 0);
  const inputTokens = Math.ceil(chars / 4) + nonEmpty.length * 180;
  const outputTokens = nonEmpty.length * 450;
  const estimatedUsd = Number(((inputTokens * 0.8 + outputTokens * 4.0) / 1_000_000).toFixed(4));
  return {
    sections: nonEmpty.length,
    inputTokens,
    outputTokens,
    estimatedUsd
  };
}

export function selectRelevantContext(sections = [], { sectionId = null, question = '', maxChars = 12000 } = {}) {
  const unlocked = (Array.isArray(sections) ? sections : []).filter(
    (s) => !s?.locked && String(s?.solution ?? '').trim().length > 0
  );
  if (!unlocked.length) return [];
  const words = String(question ?? '')
    .toLowerCase()
    .split(/[^a-záéíóúñ0-9]+/i)
    .filter((w) => w.length >= 3);
  const scoreOf = (sec) => {
    if (sec.id === sectionId) return 1_000_000;
    const hay = `${sec.title ?? ''} ${sec.solution ?? ''}`.toLowerCase();
    return words.reduce((sum, w) => sum + (hay.includes(w) ? 1 : 0), 0);
  };
  const ranked = [...unlocked].sort((a, b) => scoreOf(b) - scoreOf(a));
  const picked = [];
  let used = 0;
  for (const sec of ranked) {
    const chunk = String(sec.solution).slice(0, maxChars - used);
    if (!chunk) break;
    picked.push({ id: sec.id, title: sec.displayTitle || sec.title, solution: chunk });
    used += chunk.length;
    if (used >= maxChars) break;
  }
  return picked;
}

export function parseGeneratedQuestions(parsed) {
  const raw = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const out = [];
  for (const item of raw) {
    try {
      out.push(cleanQuestion(item, { origin: 'ai' }));
    } catch {
      /* descarta una pregunta mal formada si el resto sirve */
    }
    if (out.length >= MAX_QUESTIONS_PER_AI_PASS) break;
  }
  if (!out.length) throw badGateway('La IA no pudo armar pistas válidas para este tramo.');
  return out;
}

export async function generateSectionHints({ ai, gameName, section }) {
  const sourceText = String(section?.solution ?? '').trim();
  if (!sourceText) {
    throw conflict('Necesitás una guía con texto cargado en este tramo para armar pistas.');
  }
  const clipped = sourceText.slice(0, 14000);
  const prompt =
    `Juego: ${gameName}\nTramo: ${section.title}\n\n` +
    'Convertí ÚNICAMENTE el texto de este tramo en preguntas de ayuda estilo Universal Hint System.\n' +
    'Reglas obligatorias:\n' +
    '1. Usá español neutro.\n' +
    '2. Títulos de pregunta sin spoilers (ej.: "¿Cómo abro la puerta sellada?", no "¿Dónde está la llave de María?").\n' +
    '3. Cada pregunta debe tener 3 o 4 pistas progresivas: de la más vaga ("mirá bien la sala") a la más concreta (casi la solución).\n' +
    '4. El campo "answerQuote" debe ser un fragmento literal o cita fiel del texto de abajo. No inventes datos ni pasos que no estén en el texto.\n' +
    '5. Respondé SÓLO con JSON válido: {"questions":[{"title":"...","hints":["pista 1","pista 2","pista 3"],"answerQuote":"..."}]}\n\n' +
    'Texto del tramo:\n' +
    clipped;
  const parsed = await ai.askJson({ prompt, maxTokens: 2800 });
  return parseGeneratedQuestions(parsed);
}

export async function askAboutGuide({ ai, gameName, sections, sectionId = null, question, revealAnswer = false }) {
  const cleanQ = cleanText(question, 400);
  if (!cleanQ) throw badRequest('Escribí tu pregunta sobre la guía.');
  const context = selectRelevantContext(sections, { sectionId, question: cleanQ });
  if (!context.length) {
    throw conflict('No hay tramos desbloqueados con texto para consultar. Cargá una guía primero.');
  }
  const prompt =
    `Juego: ${gameName}\nPregunta del jugador: ${cleanQ}\n\n` +
    'Respondé usando EXCLUSIVAMENTE los fragmentos de guía de abajo. Nunca inventes información de memoria.\n' +
    'Si la pregunta NO está cubierta por estos fragmentos, respondé {"covered":false,"hint":"","answer":"","quote":"","sectionId":""}.\n' +
    'Si SÍ está cubierta: da en "hint" una primera pista útil sin arruinar toda la solución, en "answer" la solución completa sacada del texto, en "quote" la cita textual exacta de donde sale, y en "sectionId" el id del tramo.\n' +
    'Respondé SÓLO con JSON válido.\n\n' +
    context.map((s) => `[${s.id} · ${s.title}]\n${s.solution}`).join('\n\n---\n\n');
  const parsed = await ai.askJson({ prompt, maxTokens: 1200 });
  const covered = parsed?.covered === true;
  if (!covered) {
    return { covered: false, hint: '', answer: null, quote: '', sectionId: null, sectionTitle: null, origin: 'ai' };
  }
  const ref = context.find((s) => s.id === parsed.sectionId) ?? context[0];
  return {
    covered: true,
    hint: cleanText(parsed.hint, 600),
    answer: revealAnswer ? cleanText(parsed.answer, MAX_ANSWER) : null,
    hasAnswer: Boolean(cleanText(parsed.answer, MAX_ANSWER)),
    quote: cleanText(parsed.quote, MAX_ANSWER),
    sectionId: ref?.id ?? null,
    sectionTitle: ref?.title ?? null,
    origin: 'ai'
  };
}

export async function translateSection({ ai, gameName, section }) {
  const sourceText = String(section?.solution ?? '').trim();
  if (!sourceText) {
    throw conflict('Este tramo no tiene texto para traducir.');
  }
  const prompt =
    `Juego: ${gameName}\n\n` +
    'Traducí al español neutro el título y el contenido de este tramo de una guía de videojuego. Conservá la estructura Markdown (encabezados, listas, negritas y enlaces). No agregues información nueva.\n' +
    'Respondé SÓLO con JSON válido: {"title":"...","solution":"..."}\n\n' +
    `Título: ${section.title}\nContenido:\n${sourceText.slice(0, 14000)}`;
  const parsed = await ai.askJson({ prompt, maxTokens: 3200 });
  const title = cleanText(parsed?.title, 120) || section.title;
  const solution = cleanText(parsed?.solution, 30000);
  if (!solution) throw badGateway('La IA no devolvió una traducción legible.');
  return {
    title,
    solution,
    translatedAt: new Date().toISOString()
  };
}
