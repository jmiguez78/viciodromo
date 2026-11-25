import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HELPER_SCRIPT,
  chooseDisplay,
  cleanDisplayAliases,
  cleanDisplayRef,
  createDisplayHelper,
  describeChoice,
  describeDisplays,
  deviceFor,
  displayRef,
  findDisplay,
  placeArgs,
  sameDisplayRef
} from '../src/displays.mjs';

const raw = [
  {
    id: 2779098405,
    label: 'LG TV SSCR2',
    primary: false,
    bounds: { x: 1707, y: 0, width: 2560, height: 1440 },
    physical: { x: 2560, y: 0, width: 3840, height: 2160 }
  },
  {
    id: 2528732444,
    label: 'Odyssey G5',
    primary: true,
    bounds: { x: 0, y: 0, width: 1707, height: 960 },
    physical: { x: 0, y: 0, width: 2560, height: 1440 }
  }
];
const displays = describeDisplays(raw);
const [samsung, lg] = displays;

test('describeDisplays ordena de izquierda a derecha y usa el nombre del monitor', () => {
  assert.deepEqual(
    displays.map((item) => [item.id, item.name, item.primary]),
    [
      ['2528732444', 'Odyssey G5', true],
      ['2779098405', 'LG TV SSCR2', false]
    ]
  );
  assert.equal(lg.physical.width, 3840);
});

test('describeDisplays numera los monitores sin nombre o con nombres repetidos', () => {
  const list = describeDisplays([
    { id: 1, label: '', bounds: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 2, label: 'Dell', bounds: { x: 10, y: 0, width: 10, height: 10 } },
    { id: 3, label: 'Dell', bounds: { x: 20, y: 0, width: 10, height: 10 } },
    { id: 4, label: 'Roto' }
  ]);
  assert.deepEqual(
    list.map((item) => item.name),
    ['Monitor 1', 'Dell (1)', 'Dell (2)']
  );
});

test('cleanDisplayRef y findDisplay reconocen el monitor por identificador o por nombre', () => {
  assert.equal(cleanDisplayRef(null), null);
  assert.equal(cleanDisplayRef({ id: '', label: ' ' }), null);
  assert.deepEqual(cleanDisplayRef({ id: 7, label: 'LG TV SSCR2' }), { id: '', label: 'LG TV SSCR2' });
  assert.equal(findDisplay(displays, { id: '2779098405', label: 'otro' }), lg);
  // Windows cambió el identificador (otro puerto, otro cable): se lo reconoce por el nombre.
  assert.equal(findDisplay(displays, { id: '999', label: 'LG TV SSCR2' }), lg);
  assert.equal(findDisplay(displays, { id: '999', label: 'Desconectado' }), null);
});

test('describeDisplays usa el alias como nombre y conserva el de fábrica', () => {
  const named = describeDisplays(raw, [
    { ...displayRef(lg), alias: ' Tele del living ' },
    { id: '1', label: 'Proyector', alias: 'Proyector' }
  ]);
  assert.deepEqual(
    named.map((item) => [item.number, item.name, item.detected, item.alias]),
    [
      [1, 'Odyssey G5', 'Odyssey G5', ''],
      [2, 'Tele del living', 'LG TV SSCR2', 'Tele del living']
    ]
  );
  assert.deepEqual(displayRef(lg), {
    id: '2779098405',
    label: 'LG TV SSCR2',
    x: 2560,
    y: 0,
    width: 3840,
    height: 2160
  });
  assert.deepEqual(cleanDisplayAliases([{ id: '1', label: 'X', alias: '' }, 'roto']), []);
});

test('findDisplay distingue dos monitores iguales por resolución y posición', () => {
  const twins = describeDisplays([
    {
      id: 'a',
      label: 'DELL U2720Q',
      bounds: { x: 0, y: 0, width: 2560, height: 1440 },
      physical: { x: 0, y: 0, width: 3840, height: 2160 }
    },
    {
      id: 'b',
      label: 'DELL U2720Q',
      bounds: { x: 2560, y: 0, width: 1920, height: 1080 },
      physical: { x: 3840, y: 0, width: 1920, height: 1080 }
    },
    {
      id: 'c',
      label: 'DELL U2720Q',
      bounds: { x: 4480, y: 0, width: 1920, height: 1080 },
      physical: { x: 5760, y: 0, width: 1920, height: 1080 }
    }
  ]);
  assert.deepEqual(
    twins.map((item) => item.detected),
    ['DELL U2720Q (1)', 'DELL U2720Q (2)', 'DELL U2720Q (3)']
  );
  // Windows cambió los identificadores: se reconoce cada uno por resolución y posición.
  const right = { ...displayRef(twins[2]), id: 'nuevo' };
  assert.equal(findDisplay(twins, right), twins[2]);
  assert.equal(
    findDisplay(twins, { ...displayRef(twins[0]), id: 'nuevo', x: 99 }),
    twins[0],
    'única con esa resolución'
  );
  assert.equal(findDisplay(twins, { id: 'nuevo', label: 'DELL U2720Q' }), twins[0]);
  assert.equal(sameDisplayRef(displayRef(twins[1]), { ...displayRef(twins[1]), id: 'otro' }), true);
  assert.equal(sameDisplayRef(displayRef(twins[1]), { ...displayRef(twins[2]), id: 'otro' }), false);
  assert.equal(sameDisplayRef({ id: '', label: 'DELL U2720Q' }, displayRef(twins[2])), true);
  assert.equal(sameDisplayRef(null, displayRef(twins[2])), false);
});

test('chooseDisplay: el elegido para esta vez, después el predeterminado del juego y si no, Windows', () => {
  const racing = { key: 'steam:244210', display: { id: '2779098405', label: 'LG TV SSCR2' } };
  assert.deepEqual(chooseDisplay(racing, displays), { display: lg, source: 'game' });
  assert.equal(describeChoice(chooseDisplay(racing, displays)), 'LG TV SSCR2');
  const once = chooseDisplay(racing, displays, { id: '2528732444', label: 'Odyssey G5' });
  assert.deepEqual(once, { display: samsung, source: 'once' });
  assert.equal(describeChoice(once), 'Odyssey G5 (sólo esta vez)');
  // El elegido no está conectado: se usa el predeterminado; el predeterminado tampoco: Windows decide.
  assert.equal(chooseDisplay(racing, displays, { id: '1', label: 'Proyector' }).source, 'game');
  assert.equal(chooseDisplay({ key: 'x', display: { id: '1', label: 'Proyector' } }, displays), null);
  assert.equal(chooseDisplay({ key: 'arcade:sf2' }, displays), null);
  assert.equal(chooseDisplay(racing, []), null);
  assert.equal(describeChoice(null), 'monitor principal');
});

test('deviceFor encuentra el dispositivo de Windows por el centro del monitor', () => {
  const monitors = [
    { device: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 2560, height: 1440 },
    { device: '\\\\.\\DISPLAY2', x: 2560, y: 0, width: 3840, height: 2160 }
  ];
  assert.equal(deviceFor(monitors, lg), '\\\\.\\DISPLAY2');
  assert.equal(deviceFor(monitors, samsung), '\\\\.\\DISPLAY1');
  assert.equal(deviceFor([{ device: 'raro', x: 0, y: 0, width: 9999, height: 9999 }], lg), null);
  assert.equal(deviceFor(null, lg), null);
});

test('placeArgs pasa las carpetas y el rectángulo físico del monitor', () => {
  const args = placeArgs('C:\\tmp\\ayudante.ps1', ['c:\\juegos\\ac\\', 'd:\\otro\\'], lg);
  assert.deepEqual(args.slice(args.indexOf('-Mode')), [
    '-Mode',
    'place',
    '-Roots',
    'c:\\juegos\\ac\\|d:\\otro\\',
    '-Target',
    '2560,0,3840,2160',
    '-Wait',
    '240',
    '-Settle',
    '30'
  ]);
  assert.match(HELPER_SCRIPT, /SetProcessDpiAwarenessContext/);
  assert.doesNotMatch(HELPER_SCRIPT, /`/);
});

test('createDisplayHelper no hace nada fuera de Windows', async () => {
  const helper = createDisplayHelper({ platform: 'linux' });
  assert.equal(helper.supported, false);
  assert.deepEqual(await helper.monitors(), []);
  assert.deepEqual(await helper.mameArgs(lg), []);
  assert.equal(await helper.place(['c:\\juegos\\ac\\'], lg), false);
});

test('createDisplayHelper en Windows: monitores para MAME y ayudante para mover la ventana', async (t) => {
  const calls = [];
  const tempDir = await (
    await import('node:fs/promises')
  ).mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(), 'gml-monitores-'));
  const execFileImpl = (command, args, options, done) => {
    calls.push(['exec', command, args]);
    done(null, JSON.stringify({ device: '\\\\.\\DISPLAY2', x: 2560, y: 0, width: 3840, height: 2160 }));
  };
  const { EventEmitter } = await import('node:events');
  const spawnImpl = (command, args) => {
    calls.push(['spawn', command, args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit('data', 'pantalla-completa\r\n');
      child.emit('exit', 0);
    });
    return child;
  };
  const logs = [];
  const helper = createDisplayHelper({
    platform: 'win32',
    execFileImpl,
    spawnImpl,
    tempDir,
    log: (...line) => logs.push(line)
  });
  assert.deepEqual(await helper.mameArgs(lg), ['-screen', '\\\\.\\DISPLAY2']);
  await helper.mameArgs(lg);
  assert.equal(calls.filter(([kind]) => kind === 'exec').length, 1, 'la lista de monitores se recuerda');
  const results = [];
  assert.equal(await helper.place(['c:\\juegos\\ac\\'], lg, 'steam:244210', (result) => results.push(result)), true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1)[1], 'powershell.exe');
  assert.ok(calls.at(-1)[2].includes('place'));
  assert.deepEqual(logs.at(-1), ['info', 'monitor', 'steam:244210 → LG TV SSCR2: pantalla-completa']);
  assert.deepEqual(results, [{ ok: true }]);
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(tempDir, { recursive: true, force: true })));
});
