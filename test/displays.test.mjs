import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HELPER_SCRIPT,
  chooseDisplay,
  cleanDisplayRef,
  cleanDisplayRules,
  createDisplayHelper,
  describeChoice,
  describeDisplays,
  deviceFor,
  findDisplay,
  placeArgs
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

test('cleanDisplayRules descarta reglas incompletas y etiquetas repetidas', () => {
  assert.deepEqual(cleanDisplayRules('nada'), []);
  assert.deepEqual(
    cleanDisplayRules([
      { tag: ' Sim Racing ', display: { id: '2779098405', label: 'LG TV SSCR2' } },
      { tag: 'sim racing', display: { id: '2528732444', label: 'Odyssey G5' } },
      { tag: '', display: { id: '1' } },
      { tag: 'Arcade' }
    ]),
    [{ tag: 'Sim Racing', display: { id: '2779098405', label: 'LG TV SSCR2' } }]
  );
});

test('chooseDisplay: la ficha manda, después la regla por etiqueta y si no, Windows', () => {
  const rules = [{ tag: 'Sim Racing', display: { id: '2779098405', label: 'LG TV SSCR2' } }];
  const racing = { key: 'steam:244210', tags: ['sim racing'] };
  assert.deepEqual(chooseDisplay(racing, rules, displays), { display: lg, source: 'tag', tag: 'Sim Racing' });
  assert.equal(describeChoice(chooseDisplay(racing, rules, displays)), 'LG TV SSCR2 (etiqueta «Sim Racing»)');
  const own = { ...racing, display: { id: '2528732444', label: 'Odyssey G5' } };
  assert.deepEqual(chooseDisplay(own, rules, displays), { display: samsung, source: 'game' });
  // El monitor de la ficha no está conectado: se usa la regla.
  const missing = { ...racing, display: { id: '1', label: 'Proyector' } };
  assert.equal(chooseDisplay(missing, rules, displays).source, 'tag');
  assert.equal(chooseDisplay({ key: 'arcade:sf2', tags: [] }, rules, displays), null);
  assert.equal(chooseDisplay(racing, rules, []), null);
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
  assert.equal(await helper.place(['c:\\juegos\\ac\\'], lg, 'steam:244210'), true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.at(-1)[1], 'powershell.exe');
  assert.ok(calls.at(-1)[2].includes('place'));
  assert.deepEqual(logs.at(-1), ['info', 'monitor', 'steam:244210 → LG TV SSCR2: pantalla-completa']);
  t.after(() => import('node:fs/promises').then((fs) => fs.rm(tempDir, { recursive: true, force: true })));
});
