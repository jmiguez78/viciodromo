// Cliente compartido de Anthropic (DPAPI en Windows): guarda su propia clave cifrada en ai.json y, si está vacía,
// reutiliza en modo sólo lectura la que ya hayas cargado en Novedades (news.json).
import fs from 'node:fs/promises';
import path from 'node:path';
import { createVersionedFile } from './json-file.mjs';
import { badGateway, badRequest, conflict } from './http.mjs';
import { protect as defaultProtect, unprotect as defaultUnprotect } from './secrets.mjs';

export const AI_MODEL = 'claude-haiku-5-5';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const emptyAi = () => ({ apiKey: null });

export function createAiClient({
  dataDir,
  offline = false,
  fetchImpl = globalThis.fetch,
  protect = defaultProtect,
  unprotect = defaultUnprotect
}) {
  const filePath = path.join(dataDir, 'ai.json');
  const file = createVersionedFile(filePath, {
    version: 1,
    fallback: emptyAi,
    migrations: {
      1: (saved) => ({ apiKey: typeof saved?.apiKey === 'string' ? saved.apiKey : null })
    }
  });

  async function readOwnKey() {
    const data = await file.read();
    return typeof data?.apiKey === 'string' && data.apiKey ? data.apiKey : null;
  }

  async function readNewsKey() {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dataDir, 'news.json'), 'utf8'));
      return typeof raw?.settings?.aiKey === 'string' && raw.settings.aiKey ? raw.settings.aiKey : null;
    } catch {
      return null;
    }
  }

  async function resolveEncryptedKey() {
    const own = await readOwnKey();
    if (own) return { blob: own, source: 'guides' };
    const fromNews = await readNewsKey();
    if (fromNews) return { blob: fromNews, source: 'news' };
    return { blob: null, source: null };
  }

  async function status() {
    const { blob, source } = await resolveEncryptedKey();
    return { configured: Boolean(blob), source, model: AI_MODEL };
  }

  async function setKey(value) {
    if (value === null || value === '') {
      await file.update(() => ({ apiKey: null }));
      return status();
    }
    const key = typeof value === 'string' ? value.trim() : '';
    if (!/^sk-ant-[\w-]{20,}$/.test(key)) {
      throw badRequest('Esa no parece una clave de API de Anthropic (empieza con sk-ant-).');
    }
    const saved = await protect(key);
    await file.update(() => ({ apiKey: saved }));
    return status();
  }

  async function askJson({ prompt, system = '', maxTokens = 2400, timeoutMs = 45000 }) {
    const { blob } = await resolveEncryptedKey();
    if (!blob) {
      throw conflict('Cargá tu clave de Anthropic en la sección Guía (o en Configuración → Novedades).');
    }
    if (offline) throw conflict('Sin conexión (modo de prueba).');
    let apiKey;
    try {
      apiKey = await unprotect(blob);
    } catch {
      throw conflict('La clave guardada no se puede leer en esta PC: cargala de nuevo.');
    }
    const response = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok) {
      throw badGateway(
        response.status === 401
          ? 'La clave de Anthropic no es válida.'
          : `El servicio de IA respondió ${response.status}.`
      );
    }
    const data = JSON.parse(await response.text());
    const text = (data?.content ?? []).find((part) => part?.type === 'text')?.text ?? '';
    try {
      const match = /\{[\s\S]*\}/.exec(text);
      if (!match) throw new Error('sin json');
      return JSON.parse(match[0]);
    } catch {
      throw badGateway('La IA no devolvió una respuesta estructurada legible.');
    }
  }

  return {
    filePath,
    status,
    setKey,
    askJson
  };
}
