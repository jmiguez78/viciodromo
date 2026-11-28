import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guideLinksFor, safeGuideUrl, steamAppIdFor } from '../src/guide-sources/links.mjs';
import { cleanCaptureIds, companionDisplay, createGuides } from '../src/guides.mjs';
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
