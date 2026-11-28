import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guideLinksFor, safeGuideUrl, steamAppIdFor } from '../src/guide-sources/links.mjs';
import {
  buildStrategyWikiGuide,
  checkStrategyWikiBatch,
  downloadStrategyWikiGuide,
  extractWalkthroughSubpages,
  licenseForRevision,
  pickSearchMatch
} from '../src/guide-sources/strategywiki.mjs';
import { htmlToMarkdown, splitHtmlIntoSections, stripUnsafe } from '../src/guide-sanitize.mjs';
import { detectMarkdownSections, detectTxtSections, importGuideFile } from '../src/guide-import.mjs';
import {
  applyAntiSpoiler,
  cleanCaptureIds,
  companionDisplay,
  createGuides,
  nightlyGuides,
  normalizeCompanionSettings,
  validateAccelerator
} from '../src/guides.mjs';
import { createGuideLan, detectLanIp, encodeQrMatrix, renderQrSvg } from '../src/guide-lan.mjs';
import { createAiClient } from '../src/ai.mjs';
import {
  askAboutGuide,
  cleanQuestion,
  estimateHintsCost,
  generateSectionHints,
  selectRelevantContext,
  translateSection
} from '../src/guide-hints.mjs';
import { describeDisplays } from '../src/displays.mjs';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gml-guides-test-'));
process.env.GML_DATA_DIR = dataDir;
process.env.GML_STEAM_DIR = path.join(dataDir, 'Steam');
process.env.GML_VIDEOS_DIR = path.join(dataDir, 'Videos');
process.env.GML_CAPTURES_DIR = path.join(dataDir, 'Videos', 'Captures');

const { createServer } = await import('../src/server.mjs');

const rawDisplays = [
  {
    id: 1,
    label: 'Odyssey G5',
    primary: true,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    physical: { x: 0, y: 0, width: 2560, height: 1440 }
  },
  {
    id: 2,
    label: 'LG TV SSCR2',
    primary: false,
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    physical: { x: 2560, y: 0, width: 3840, height: 2160 }
  }
];
const displays = describeDisplays(rawDisplays);

const catalog = {
  schema: 2,
  generatedAt: '2026-11-28T00:00:00.000Z',
  games: [
    {
      key: 'steam:613830',
      id: '613830',
      name: 'Chrono Trigger',
      platform: 'Steam',
      drive: 'C:',
      location: 'C:\\Steam\\ct',
      launch: { type: 'uri', target: 'steam://run/613830', available: true },
      status: 'installed'
    },
    {
      key: 'epic games:hades',
      id: 'hades',
      name: 'Hades',
      platform: 'Epic Games',
      drive: 'D:',
      location: 'D:\\Epic\\Hades',
      launch: { type: 'uri', target: 'com.epicgames.launcher://hades', available: true },
      status: 'installed',
      meta: { websites: [{ label: 'Steam', url: 'https://store.steampowered.com/app/1145360/Hades/' }] }
    },
    {
      key: 'gog galaxy:hollow',
      id: 'hollow',
      name: 'Hollow Knight',
      platform: 'GOG Galaxy',
      drive: 'C:',
      location: 'C:\\GOG\\Hollow',
      launch: { type: 'file', target: 'C:\\GOG\\Hollow\\hollow.exe', available: true },
      status: 'installed'
    }
  ]
};

let server;
let base;
const viewerCalls = [];

before(async () => {
  await fs.writeFile(path.join(dataDir, 'library.json'), JSON.stringify(catalog));
  server = createServer({
    listDisplays: () => rawDisplays,
    openGuideWindow: async (payload) => {
      viewerCalls.push(payload);
      return true;
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('safeGuideUrl solo acepta https sin credenciales y steamAppIdFor extrae appid de Steam o IGDB', () => {
  assert.equal(
    safeGuideUrl('https://strategywiki.org/wiki/Chrono_Trigger'),
    'https://strategywiki.org/wiki/Chrono_Trigger'
  );
  assert.equal(safeGuideUrl('http://example.com/guia'), null);
  assert.equal(safeGuideUrl('javascript:alert(1)'), null);
  assert.equal(safeGuideUrl('https://user:pass@example.com'), null);

  assert.equal(steamAppIdFor({ platform: 'Steam', id: '613830' }), '613830');
  assert.equal(
    steamAppIdFor({
      platform: 'Epic Games',
      id: 'hades',
      meta: { websites: [{ url: 'https://store.steampowered.com/app/1145360/Hades/' }] }
    }),
    '1145360'
  );
  assert.equal(steamAppIdFor({ platform: 'Arcade', id: 'sf2' }), null);
});

test('guideLinksFor arma enlaces directos seguros para Steam, otras tiendas y Arcade', () => {
  const steamLinks = guideLinksFor({ platform: 'Steam', id: '613830', name: 'Chrono Trigger' });
  assert.deepEqual(
    steamLinks.map((item) => item.id),
    ['gamefaqs', 'steam', 'strategywiki', 'youtube', 'ign']
  );
  assert.equal(steamLinks.find((item) => item.id === 'steam').url, 'https://steamcommunity.com/app/613830/guides/');

  const gogLinks = guideLinksFor({ platform: 'GOG Galaxy', id: '1', name: 'Hollow Knight' });
  assert.deepEqual(
    gogLinks.map((item) => item.id),
    ['gamefaqs', 'strategywiki', 'youtube', 'ign']
  );
  assert.ok(gogLinks.every((item) => item.url.startsWith('https://')));
});

test('companionDisplay elige el otro monitor disponible', () => {
  assert.equal(companionDisplay([displays[0]]), null);
  assert.equal(companionDisplay(displays, null)?.id, '2');
  assert.equal(companionDisplay(displays, { id: '2', label: 'LG TV SSCR2' })?.id, '1');
});

test('createGuides guarda progreso y notas por tramo con versionado en guides/progress.json', async () => {
  const unitDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gml-guides-unit-'));
  try {
    const guides = createGuides({ dataDir: unitDir, now: () => Date.parse('2026-11-28T12:00:00.000Z') });
    await assert.rejects(() => guides.addNote('steam:613830', { section: 'Inicio', text: '   ' }), /Escribí una nota/);
    assert.deepEqual(cleanCaptureIds(['abc', '0123456789abcdef0123', '0123456789abcdef0123', 'INVALIDO!']), [
      '0123456789abcdef0123'
    ]);

    const progress = await guides.updateProgress('steam:613830', { currentSection: 'Zeal Palace', mode: 'solution' });
    assert.equal(progress.currentSection, 'Zeal Palace');
    assert.equal(progress.mode, 'solution');

    const note = await guides.addNote('steam:613830', {
      section: 'Zeal Palace',
      text: 'Revisar el colgante en la máquina.',
      captures: ['0123456789abcdef0123']
    });
    assert.match(note.id, /^n-/);
    assert.deepEqual(note.captures, ['0123456789abcdef0123']);

    const saved = JSON.parse(await fs.readFile(path.join(unitDir, 'guides', 'progress.json'), 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.games['steam:613830'].currentSection, 'Zeal Palace');
    assert.equal(saved.games['steam:613830'].notes.length, 1);
  } finally {
    await fs.rm(unitDir, { recursive: true, force: true });
  }
});

test('API de guías: consultar, guardar Acá estoy, CRUD de notas y abrir en visor auxiliar', async () => {
  const initial = await (await fetch(`${base}/api/guides/game/${encodeURIComponent('steam:613830')}`)).json();
  assert.equal(initial.viewerSupported, true);
  assert.equal(initial.companionDisplay?.name, 'LG TV SSCR2');
  assert.equal(initial.progress.mode, 'hints');
  assert.equal(
    initial.links.some((link) => link.id === 'steam'),
    true
  );

  const progRes = await fetch(`${base}/api/guides/game/${encodeURIComponent('steam:613830')}/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentSection: 'Capítulo 4 · El puente' })
  });
  assert.equal(progRes.status, 200);
  const progData = await progRes.json();
  assert.equal(progData.progress.currentSection, 'Capítulo 4 · El puente');

  const createRes = await fetch(`${base}/api/guides/game/${encodeURIComponent('steam:613830')}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      section: 'Capítulo 4 · El puente',
      text: 'Usar la llave oxidada.',
      captures: ['0123456789abcdef0123']
    })
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();

  const editRes = await fetch(
    `${base}/api/guides/game/${encodeURIComponent('steam:613830')}/notes/${encodeURIComponent(created.id)}`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Usar la llave oxidada en la torre norte.' })
    }
  );
  assert.equal(editRes.status, 200);
  const edited = await editRes.json();
  assert.equal(edited.text, 'Usar la llave oxidada en la torre norte.');

  const openRes = await fetch(`${base}/api/guides/game/${encodeURIComponent('steam:613830')}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://strategywiki.org/wiki/Chrono_Trigger/Walkthrough', inactive: true })
  });
  assert.equal(openRes.status, 200);
  const opened = await openRes.json();
  assert.equal(opened.opened, 'viewer');
  assert.equal(opened.display?.name, 'LG TV SSCR2');
  assert.equal(viewerCalls.at(-1)?.inactive, true);
  assert.equal(viewerCalls.at(-1)?.display?.id, '2');

  const afterOpen = await (await fetch(`${base}/api/guides/game/${encodeURIComponent('steam:613830')}`)).json();
  assert.equal(afterOpen.progress.lastUrl, 'https://strategywiki.org/wiki/Chrono_Trigger/Walkthrough');

  const delRes = await fetch(
    `${base}/api/guides/game/${encodeURIComponent('steam:613830')}/notes/${encodeURIComponent(created.id)}`,
    { method: 'DELETE' }
  );
  assert.equal(delRes.status, 204);

  const badUrl = await fetch(`${base}/api/guides/game/${encodeURIComponent('steam:613830')}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://inseguro.example.com' })
  });
  assert.equal(badUrl.status, 400);

  const missingGame = await fetch(`${base}/api/guides/game/${encodeURIComponent('steam:999999')}`);
  assert.equal(missingGame.status, 404);
});

test('sin visor Electron, POST /api/guides/game/:key/open devuelve opened=external', async () => {
  const webServer = createServer();
  await new Promise((resolve) => webServer.listen(0, '127.0.0.1', resolve));
  try {
    const webBase = `http://127.0.0.1:${webServer.address().port}`;
    const res = await fetch(`${webBase}/api/guides/game/${encodeURIComponent('gog galaxy:hollow')}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.opened, 'external');
    assert.ok(body.url.startsWith('https://gamefaqs.gamespot.com/search?game=Hollow%20Knight'));
  } finally {
    webServer.close();
  }
});

test('guide-sanitize limpia scripts, enlaces inseguros y corta HTML de wiki en tramos', () => {
  const dirty =
    '<div id="toc">Tabla</div>' +
    '<h2>Capítulo 1<span class="mw-editsection">[edit]</span></h2>' +
    '<p>Entrá por la <a href="/wiki/Puerta">puerta norte</a> y <a href="javascript:alert(1)">no toques</a> esto.</p>' +
    '<script>evil()</script><iframe src="https://evil.example"></iframe>' +
    '<h2>Capítulo 2</h2><p>Vencé al <strong>guardián</strong> del puente.</p>';
  assert.equal(stripUnsafe(dirty).includes('evil()'), false);
  const md = htmlToMarkdown('<p>Hola <strong>mundo</strong> <img src="/images/a.png" alt="Mapa"></p>', {
    baseUrl: 'https://strategywiki.org'
  });
  assert.match(md, /\*\*mundo\*\*/);
  assert.match(md, /!\[Mapa\]\(https:\/\/strategywiki\.org\/images\/a\.png\)/);

  const sections = splitHtmlIntoSections(dirty, 'Prueba', { baseUrl: 'https://strategywiki.org' });
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, 'Capítulo 1');
  assert.match(sections[0].solution, /\[puerta norte\]\(https:\/\/strategywiki\.org\/wiki\/Puerta\)/);
  assert.equal(sections[0].solution.includes('javascript:'), false);
  assert.equal(sections[1].title, 'Capítulo 2');
});

test('strategywiki: coincidencia, subpáginas, licencia por fecha, descarga offline y consulta en lote', async () => {
  assert.equal(licenseForRevision('2023-05-01T00:00:00Z'), 'CC BY-SA 3.0');
  assert.equal(licenseForRevision('2025-01-15T00:00:00Z'), 'CC BY-SA 4.0');

  const match = pickSearchMatch(
    [{ title: 'Talk:Chrono Trigger' }, { title: 'Chrono Trigger' }, { title: 'Chrono Trigger/Walkthrough' }],
    ['Chrono Trigger']
  );
  assert.equal(match?.pageTitle, 'Chrono Trigger/Walkthrough');

  const tocHtml =
    '<a href="/wiki/Chrono_Trigger/Table_of_Contents">TOC</a>' +
    '<a href="/wiki/Chrono_Trigger/Millennial_Fair">Feria</a>' +
    '<a href="/wiki/Chrono_Trigger/Zeal_Palace">Zeal</a>';
  assert.deepEqual(extractWalkthroughSubpages(tocHtml, 'Chrono Trigger'), [
    'Chrono Trigger/Millennial Fair',
    'Chrono Trigger/Zeal Palace'
  ]);

  const fakeFetch = async (url) => {
    const parsed = new URL(url);
    const action = parsed.searchParams.get('action');
    if (action === 'query' && parsed.searchParams.get('list') === 'search') {
      return new Response(JSON.stringify({ query: { search: [{ title: 'Chrono Trigger/Walkthrough' }] } }));
    }
    if (action === 'query' && parsed.searchParams.get('prop') === 'revisions') {
      return new Response(
        JSON.stringify({ query: { pages: [{ revisions: [{ timestamp: '2025-02-01T10:00:00Z' }] }] } })
      );
    }
    if (action === 'query' && parsed.searchParams.get('titles')) {
      return new Response(
        JSON.stringify({
          query: {
            normalized: [{ from: 'Chrono_Trigger/Walkthrough', to: 'Chrono Trigger/Walkthrough' }],
            pages: [{ title: 'Chrono Trigger/Walkthrough' }]
          }
        })
      );
    }
    if (action === 'parse') {
      const page = parsed.searchParams.get('page');
      if (page === 'Chrono Trigger/Walkthrough') {
        return new Response(
          JSON.stringify({
            parse: {
              title: 'Chrono Trigger/Walkthrough',
              revid: 9876,
              text: tocHtml
            }
          })
        );
      }
      return new Response(
        JSON.stringify({
          parse: { title: page, revid: 9877, text: `<p>Recorrido de ${page}.</p>` }
        })
      );
    }
    throw new Error('URL no esperada: ' + url);
  };

  const guide = await downloadStrategyWikiGuide(
    { key: 'steam:613830', name: 'Chrono Trigger' },
    { fetchImpl: fakeFetch, pauseMs: 0 }
  );
  assert.equal(guide.source.license, 'CC BY-SA 4.0');
  assert.equal(guide.source.revision, 9876);
  assert.equal(guide.sections.length, 2);
  assert.equal(guide.sections[0].title, 'Millennial Fair');

  const batch = await checkStrategyWikiBatch([{ key: 'steam:613830', name: 'Chrono Trigger' }], {
    fetchImpl: fakeFetch
  });
  assert.equal(batch.get('steam:613830')?.available, true);

  const built = buildStrategyWikiGuide({
    gameKey: 'steam:613830',
    title: 'Chrono Trigger',
    pageTitle: 'Chrono Trigger',
    revision: 1,
    timestamp: '2020-01-01T00:00:00Z',
    sections: [{ title: 'Inicio', solution: 'Texto' }]
  });
  assert.equal(built.source.license, 'CC BY-SA 3.0');
});

test('guide-import detecta tramos en 3 FAQs reales simuladas, Markdown y rechaza PDF', () => {
  // 1. FAQ con subrayados =====
  const faq1 = [
    'GUIA DE AVENTURA',
    '',
    'Capítulo 1: El pueblo',
    '=====================',
    'Hablá con el herrero para recibir la brújula.',
    '',
    'Capítulo 2: El templo',
    '=====================',
    'Usá la brújula frente a la estatua.'
  ].join('\n');
  const s1 = detectTxtSections(faq1);
  assert.equal(s1.length, 2);
  assert.equal(s1[0].title, 'Capítulo 1: El pueblo');
  assert.equal(s1[1].title, 'Capítulo 2: El templo');

  // 2. FAQ con índice consecutivo seguido de secciones numeradas reales
  const faq2 = [
    'INDICE',
    '1. Introduccion',
    '2. Ruinas',
    '',
    '1. Introduccion',
    'Recogé la antorcha en la entrada norte antes de bajar.',
    '',
    '2. Ruinas',
    'Encendé los cuatro braseros en sentido horario.'
  ].join('\n');
  const s2 = detectTxtSections(faq2);
  assert.equal(s2.length, 2);
  assert.equal(s2[0].title, '1. Introduccion');
  assert.equal(s2[1].title, '2. Ruinas');

  // 3. Texto plano sin encabezados claros -> un único tramo con búsqueda
  const faq3 = 'Caminá hacia el sur hasta encontrar la cabaña.\nEl código de la puerta es 4815.';
  const s3 = detectTxtSections(faq3, 'Notas sueltas');
  assert.equal(s3.length, 1);
  assert.equal(s3[0].title, 'Notas sueltas');

  // Markdown ignorando # dentro de bloque de código
  const md = '# Parte 1\nTexto uno\n```\n# Comentario codigo\n```\n# Parte 2\nTexto dos';
  assert.equal(detectMarkdownSections(md).length, 2);

  assert.throws(
    () => importGuideFile({ filename: 'manual.pdf', content: '%PDF-1.4', gameKey: 'steam:613830' }),
    /\.txt, \.md o \.html/
  );
  const imported = importGuideFile({ filename: 'walk.txt', content: faq1, gameKey: 'steam:613830' });
  assert.equal(imported.source.type, 'file');
  assert.equal(imported.sections.length, 2);
});

test('applyAntiSpoiler oculta tramos futuros y la API de Fase 2 importa, edita, borra sin perder notas y corre nightlyGuides', async () => {
  const sections = [
    { id: 's01', order: 1, title: 'Bosque', solution: 'Paso 1' },
    { id: 's02', order: 2, title: 'Torre secreta', solution: 'Paso 2' },
    { id: 's03', order: 3, title: 'Jefe final', solution: 'Paso 3' }
  ];
  const hidden = applyAntiSpoiler(sections, { currentSectionId: 's01', showFutureTitles: false });
  assert.equal(hidden[0].locked, false);
  assert.equal(hidden[1].locked, true);
  assert.equal(hidden[1].displayTitle, 'Tramo 2');
  assert.equal(hidden[1].solution, '');

  const revealed = applyAntiSpoiler(sections, {
    currentSectionId: 's01',
    revealedSections: ['s02'],
    showFutureTitles: false
  });
  assert.equal(revealed[1].locked, false);
  assert.equal(revealed[1].displayTitle, 'Torre secreta');
  assert.equal(revealed[2].locked, true);

  // Importar vía HTTP, conservar notas al borrar la guía y editar tramo
  await fetch(`${base}/api/guides/game/${encodeURIComponent('gog galaxy:hollow')}/notes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ section: 'Bosque', text: 'Nota que sobrevive.' })
  });
  const impRes = await fetch(`${base}/api/guides/game/${encodeURIComponent('gog galaxy:hollow')}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: 'hollow.txt',
      content: 'Bosque\n======\nSaltar por la izquierda.\n\nCiudad\n======\nHablar con Cornifer.'
    })
  });
  assert.equal(impRes.status, 201);
  const impData = await impRes.json();
  const guideId = impData.activeGuide.id;

  const summary = await (await fetch(`${base}/api/guides`)).json();
  assert.ok(summary.withGuide.includes('gog galaxy:hollow'));

  const renameRes = await fetch(
    `${base}/api/guides/game/${encodeURIComponent('gog galaxy:hollow')}/items/${guideId}/sections/s02`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Ciudad de Lágrimas' })
    }
  );
  assert.equal(renameRes.status, 200);
  const renamed = await renameRes.json();
  assert.equal(renamed.sections[1].title, 'Ciudad de Lágrimas');

  const delRes = await fetch(`${base}/api/guides/game/${encodeURIComponent('gog galaxy:hollow')}/items/${guideId}`, {
    method: 'DELETE'
  });
  assert.equal(delRes.status, 204);
  const afterDel = await (await fetch(`${base}/api/guides/game/${encodeURIComponent('gog galaxy:hollow')}`)).json();
  assert.equal(afterDel.activeGuide, null);
  assert.equal(afterDel.notes.length, 1);

  // nightlyGuides consulta en lote sin descargar contenido
  const nightDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gml-nightly-guides-'));
  try {
    await fs.writeFile(
      path.join(nightDir, 'library.json'),
      JSON.stringify({ schema: 2, games: [{ key: 'steam:613830', name: 'Chrono Trigger', platform: 'Steam' }] })
    );
    const night = await nightlyGuides(nightDir, () => {}, {
      offline: false,
      fetchImpl: async () =>
        new Response(JSON.stringify({ query: { pages: [{ title: 'Chrono Trigger/Walkthrough' }] } }))
    });
    assert.equal(night.checked, 1);
    assert.equal(night.found, 1);
  } finally {
    await fs.rm(nightDir, { recursive: true, force: true });
  }
});

test('ai.mjs valida clave, lee fallback de news.json y llama a Anthropic estructurado', async () => {
  const aiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gml-ai-test-'));
  try {
    await fs.writeFile(
      path.join(aiDir, 'news.json'),
      JSON.stringify({ schemaVersion: 1, settings: { aiKey: 'cifrado-news' } })
    );
    const ai = createAiClient({
      dataDir: aiDir,
      protect: async (raw) => 'enc:' + raw,
      unprotect: async (blob) => blob.replace(/^enc:/, ''),
      fetchImpl: async () =>
        new Response(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true,"valor":42}' }] }))
    });
    assert.deepEqual(await ai.status(), { configured: true, source: 'news', model: 'claude-haiku-5-5' });
    await assert.rejects(() => ai.setKey('invalida'), /sk-ant-/);
    const saved = await ai.setKey('sk-ant-api03-12345678901234567890');
    assert.equal(saved.source, 'guides');
    const jsonOut = await ai.askJson({ prompt: 'Hola' });
    assert.equal(jsonOut.valor, 42);
    await ai.setKey(null);
    assert.equal((await ai.status()).source, 'news');
  } finally {
    await fs.rm(aiDir, { recursive: true, force: true });
  }
});

test('guide-hints: estimación, selección sin tramos bloqueados, pistear, preguntar y traducir', async () => {
  const q = cleanQuestion({
    title: '¿Puerta?',
    hints: ['Mirá atrás', 'Llave roja'],
    answerQuote: 'Usá la llave roja.'
  });
  assert.equal(q.origin, 'manual');
  const est = estimateHintsCost([{ solution: 'a'.repeat(400) }, { solution: '' }]);
  assert.equal(est.sections, 1);
  assert.ok(est.estimatedUsd > 0);

  const ctx = selectRelevantContext(
    [
      { id: 's01', title: 'Inicio', solution: 'La palanca está en el sótano.', locked: false },
      { id: 's02', title: 'Final secreto', solution: 'Palanca dorada del jefe.', locked: true }
    ],
    { sectionId: 's01', question: 'palanca' }
  );
  assert.equal(ctx.length, 1);
  assert.equal(ctx[0].id, 's01');

  const fakeAi = {
    askJson: async ({ prompt }) => {
      if (prompt.includes('Universal Hint System')) {
        return {
          questions: [
            {
              title: '¿Cómo abro la compuerta?',
              hints: ['Mirá al costado', 'Hay una palanca', 'Tirala hacia abajo'],
              answerQuote: 'Tirá la palanca del sótano.'
            }
          ]
        };
      }
      if (prompt.includes('Pregunta del jugador:')) {
        return {
          covered: true,
          hint: 'Revisá el sótano.',
          answer: 'Tirá la palanca del sótano.',
          quote: 'La palanca está en el sótano.',
          sectionId: 's01'
        };
      }
      return { title: 'El sótano', solution: 'La palanca está acá.' };
    }
  };

  const generated = await generateSectionHints({
    ai: fakeAi,
    gameName: 'Ámbar',
    section: { id: 's01', title: 'Basement', solution: 'The lever is in the basement.' }
  });
  assert.equal(generated.length, 1);
  assert.equal(generated[0].origin, 'ai');
  assert.equal(generated[0].hints.length, 3);

  const askHintOnly = await askAboutGuide({
    ai: fakeAi,
    gameName: 'Ámbar',
    sections: [{ id: 's01', title: 'Sótano', solution: 'La palanca está en el sótano.', locked: false }],
    sectionId: 's01',
    question: '¿Qué hago con la palanca?',
    revealAnswer: false
  });
  assert.equal(askHintOnly.covered, true);
  assert.equal(askHintOnly.answer, null);
  assert.equal(askHintOnly.hasAnswer, true);

  const translated = await translateSection({
    ai: fakeAi,
    gameName: 'Ámbar',
    section: { id: 's01', title: 'Basement', solution: 'The lever is here.' }
  });
  assert.equal(translated.title, 'El sótano');
});

test('API Fase 3: editor manual de preguntas, revelado progresivo, IA simulada y rechazo sin clave', async () => {
  const aiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gml-guides-p3-'));
  const aiClient = createAiClient({
    dataDir: aiDir,
    protect: async (raw) => 'enc:' + raw,
    unprotect: async (blob) => blob.replace(/^enc:/, ''),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const prompt = body.messages[0].content;
      if (prompt.includes('Universal Hint System')) {
        return new Response(
          JSON.stringify({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  questions: [
                    {
                      title: '¿Cómo cruzo?',
                      hints: ['Mirá el puente', 'Cortá la soga'],
                      answerQuote: 'Cortá la soga derecha.'
                    }
                  ]
                })
              }
            ]
          })
        );
      }
      if (prompt.includes('Traducí')) {
        return new Response(
          JSON.stringify({
            content: [{ type: 'text', text: JSON.stringify({ title: 'Puente', solution: 'Cortá la soga derecha.' }) }]
          })
        );
      }
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({ covered: false }) }]
        })
      );
    }
  });
  const guidesSvc = createGuides({ dataDir: aiDir, ai: aiClient });
  const game = { key: 'steam:613830', id: '613830', name: 'Chrono Trigger', platform: 'Steam' };
  try {
    const imported = await guidesSvc.importFile(game, {
      filename: 'ct.txt',
      content: 'Bridge\n======\nCut the right rope to cross.'
    });
    const gid = imported.activeGuide.id;

    // Sin clave, generar pistas falla con 409
    await assert.rejects(() => guidesSvc.generateHints(game, gid, 's01'), /Cargá tu clave/);

    // Agregar pregunta manual y revelar pistas paso a paso
    const manualQ = await guidesSvc.addQuestion(game.key, gid, 's01', {
      title: '¿Qué soga corto?',
      hints: ['No es la izquierda', 'Probá la derecha'],
      answerQuote: 'Cut the right rope.'
    });
    await guidesSvc.updateProgress(game.key, { setHintCount: { sectionId: 's01', questionId: manualQ.id, count: 1 } });
    const view1 = await guidesSvc.forGame(game);
    assert.equal(view1.activeGuide.sections[0].questions[0].visibleHints.length, 1);
    assert.equal(view1.activeGuide.sections[0].questions[0].answerQuote, '');

    await guidesSvc.updateProgress(game.key, { revealAnswer: { sectionId: 's01', questionId: manualQ.id } });
    const view2 = await guidesSvc.forGame(game);
    assert.equal(view2.activeGuide.sections[0].questions[0].answerQuote, 'Cut the right rope.');

    // Cargar clave, pistear con IA (conserva la manual) y traducir con caché
    await aiClient.setKey('sk-ant-api03-12345678901234567890');
    await guidesSvc.generateHints(game, gid, 's01');
    const view3 = await guidesSvc.forGame(game);
    assert.equal(view3.activeGuide.sections[0].questions.length, 2);
    assert.equal(view3.activeGuide.sections[0].questions[1].origin, 'ai');

    const tr = await guidesSvc.translateGuideSection(game, gid, 's01');
    assert.equal(tr.title, 'Puente');
    const askMiss = await guidesSvc.askGuide(game, gid, { sectionId: 's01', question: '¿Jefe final?' });
    assert.equal(askMiss.covered, false);
  } finally {
    await fs.rm(aiDir, { recursive: true, force: true });
  }
});

test('Fase 4: atajos globales, revealNextHint, summary.progress y guide-lan QR', async () => {
  const game = catalog.games[0];
  assert.equal(validateAccelerator('ctrl+alt+g'), 'Control+Alt+G');
  assert.equal(validateAccelerator('CommandOrControl+Shift+F5'), 'CommandOrControl+Shift+F5');
  assert.equal(validateAccelerator(''), '');
  assert.throws(() => validateAccelerator('G'), /modificador/);
  assert.throws(() => validateAccelerator('Ctrl+Ctrl+G'), /repitas/);
  assert.throws(
    () =>
      normalizeCompanionSettings({
        toggleShortcut: 'Alt+G',
        nextHintShortcut: 'Alt+G'
      }),
    /iguales/
  );

  // QR SVG puro sin dependencias e IP LAN
  const qr = encodeQrMatrix('http://192.168.1.25:47322/pair?t=abc123');
  assert.ok(qr.size >= 29 && qr.modules.length === qr.size);
  const svg = renderQrSvg(qr);
  assert.match(svg, /^<svg /);
  assert.match(svg, /<rect /);
  assert.equal(
    detectLanIp({
      Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      APIPA: [{ family: 'IPv4', internal: false, address: '169.254.10.1' }],
      WiFi: [{ family: 'IPv4', internal: false, address: '192.168.0.44' }]
    }),
    '192.168.0.44'
  );

  const f4Dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gml-guides-f4-'));
  try {
    const f4Guides = createGuides({ dataDir: f4Dir, offline: true });
    await f4Guides.updateCompanionSettings({ opacity: 0.75, toggleShortcut: 'Ctrl+Alt+O' });
    const loadedComp = await f4Guides.getCompanionSettings();
    assert.equal(loadedComp.opacity, 0.75);
    assert.equal(loadedComp.toggleShortcut, 'Control+Alt+O');

    const imported = await f4Guides.importFile(game, {
      filename: 'ruta.txt',
      content: 'Zona Uno\n========\nUsá el gancho para cruzar el puente.\n\nZona Dos\n========\nSubí la escalera.'
    });
    const gid = imported.activeGuide.id;
    const secId = imported.activeGuide.sections[0].id;
    await f4Guides.addQuestion(game.key, gid, secId, {
      title: '¿Cómo cruzo?',
      hints: ['Mirá arriba de la puerta', 'Necesitás el gancho'],
      answerQuote: 'Usá el gancho para cruzar el puente.'
    });
    await f4Guides.updateProgress(game.key, { currentSectionId: secId });

    // Avance de pistas por atajo sin revelar la respuesta automáticamente
    const h1 = await f4Guides.revealNextHint(game.key);
    assert.equal(h1.ok, true);
    assert.equal(h1.hintIndex, 1);
    assert.equal(h1.hint, 'Mirá arriba de la puerta');

    const h2 = await f4Guides.revealNextHint(game.key);
    assert.equal(h2.ok, true);
    assert.equal(h2.hintIndex, 2);
    assert.equal(h2.exhausted, true);

    const h3 = await f4Guides.revealNextHint(game.key);
    assert.equal(h3.ok, false);
    assert.equal(h3.reason, 'exhausted');
    const afterCheck = await f4Guides.forGame(game);
    assert.equal(afterCheck.activeGuide.sections[0].questions[0].answerRevealed, false);

    // summary() incluye progress para la fila Continuar
    const sum = await f4Guides.summary();
    assert.deepEqual(sum.progress[game.key], { currentSection: 'Zona Uno', hintsViewed: 2 });

    // Servidor LAN efímero en loopback
    const lan = createGuideLan({
      guides: f4Guides,
      findGame: async (k) => (k === game.key ? game : null),
      host: '127.0.0.1',
      lanIp: '127.0.0.1'
    });
    const started = await lan.start(game.key);
    assert.equal(started.active, true);
    assert.ok(started.url);

    // Sin cookie -> 403
    const base = `http://127.0.0.1:${started.port}`;
    const unauth = await fetch(`${base}/api/guide`);
    assert.equal(unauth.status, 403);

    // Canje del token de un solo uso -> cookie HttpOnly y redirect
    const pairRes = await fetch(started.url, { redirect: 'manual' });
    assert.equal(pairRes.status, 302);
    const cookie = pairRes.headers.get('set-cookie')?.split(';')[0];
    assert.match(cookie, /^vicio_guide_sid=/);

    // Segundo intento con el mismo token -> 403
    const reuseRes = await fetch(started.url, { redirect: 'manual' });
    assert.equal(reuseRes.status, 403);

    // Con cookie: /api/guide y /api/progress funcionan
    const apiGuide = await fetch(`${base}/api/guide`, { headers: { cookie } });
    assert.equal(apiGuide.status, 200);
    const mobileView = await apiGuide.json();
    assert.equal(mobileView.key, game.key);

    const mobileProg = await fetch(`${base}/api/progress`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'solution' })
    });
    assert.equal(mobileProg.status, 200);
    assert.equal((await mobileProg.json()).progress.mode, 'solution');

    // Al cerrar el juego se apaga automáticamente
    await lan.stopForGame(game.key);
    assert.equal(lan.status().active, false);
  } finally {
    await fs.rm(f4Dir, { recursive: true, force: true });
  }
});

test('API Fase 4: endpoints HTTP de acompañante, overlay y servidor LAN', async () => {
  const game = catalog.games[0];
  let overlayCalls = [];
  const f4Server = createServer({
    openGuideOverlay: async (opts) => {
      overlayCalls.push(opts);
      return { open: true };
    }
  });
  await new Promise((resolve) => f4Server.listen(0, '127.0.0.1', resolve));
  const f4Base = `http://127.0.0.1:${f4Server.address().port}`;
  try {
    const comp0 = await fetch(`${f4Base}/api/guides/companion`).then((r) => r.json());
    assert.equal(comp0.overlaySupported, true);
    assert.equal(comp0.lan.active, false);

    const upd = await fetch(`${f4Base}/api/guides/companion/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ opacity: 0.65 })
    }).then((r) => r.json());
    assert.equal(upd.opacity, 0.65);

    const ov = await fetch(`${f4Base}/api/guides/game/${encodeURIComponent(game.key)}/overlay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inactive: true })
    }).then((r) => r.json());
    assert.equal(ov.opened, 'overlay');
    assert.equal(overlayCalls.length, 1);
    assert.equal(overlayCalls[0].opacity, 0.65);

    const lanStart = await fetch(`${f4Base}/api/guides/lan/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: game.key })
    });
    assert.equal(lanStart.status, 201);
    const lanBody = await lanStart.json();
    assert.equal(lanBody.active, true);
    assert.ok(lanBody.qr?.size >= 21);

    const lanStop = await fetch(`${f4Base}/api/guides/lan/stop`, { method: 'POST' }).then((r) => r.json());
    assert.equal(lanStop.active, false);
  } finally {
    f4Server.closeAllConnections?.();
    await new Promise((resolve) => f4Server.close(resolve));
  }
});
