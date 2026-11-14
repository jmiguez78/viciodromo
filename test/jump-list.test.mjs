import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_USER_MODEL_ID,
  JUMP_LIST_CATEGORY,
  buildJumpList,
  launchArg,
  launchKeyFromArgs,
  recentGames,
  shortcutFix
} from '../src/jump-list.mjs';

const game = (key, name, extra = {}) => ({
  key,
  name,
  platform: 'Steam',
  launch: { type: 'uri', target: 'steam://run/1', available: true },
  lastLaunchedAt: null,
  ...extra
});
const games = [
  game('steam:1', 'Viejo', { lastLaunchedAt: '2026-01-01T00:00:00Z' }),
  game('steam:2', 'Nunca jugado'),
  game('steam:3', 'Según Steam', { steam: { lastPlayedAt: '2026-06-01T00:00:00Z' } }),
  game('steam:4', 'Sin instalar', { installed: false, lastLaunchedAt: '2026-11-01T00:00:00Z' }),
  game('epic games:x', 'Sin lanzamiento', { launch: null, lastLaunchedAt: '2026-11-01T00:00:00Z' }),
  game('gog galaxy:w3', 'The Witcher 3', {
    platform: 'GOG Galaxy',
    launch: { type: 'file', target: 'D:\\GOG\\Witcher 3\\witcher3.exe', available: true },
    lastLaunchedAt: '2026-11-10T00:00:00Z'
  })
];

test('la clave del juego viaja codificada en la línea de comandos', () => {
  assert.equal(launchArg('epic games:x'), '--launch=epic%20games%3Ax');
  assert.equal(launchKeyFromArgs(['C:\\v.exe', '--allow-file-access', launchArg('epic games:x')]), 'epic games:x');
  assert.equal(launchKeyFromArgs(['C:\\v.exe', '--scan']), null);
  assert.equal(launchKeyFromArgs(['C:\\v.exe', '--launch=']), null);
  assert.equal(launchKeyFromArgs(['C:\\v.exe', '--launch=%E0%A4%A']), null);
  assert.equal(launchKeyFromArgs(), null);
});

test('recientes: sólo juegos que se pueden abrir y se jugaron, el último primero', () => {
  assert.deepEqual(
    recentGames(games).map((item) => item.key),
    ['gog galaxy:w3', 'steam:3', 'steam:1']
  );
  assert.deepEqual(
    recentGames(games, 1).map((item) => item.key),
    ['gog galaxy:w3']
  );
});

test('la lista apunta al ejecutable de la aplicación con la clave del juego', () => {
  const [category] = buildJumpList({ games, program: 'C:\\Juegos\\Viciodromo-0.37.0.exe', iconPath: 'C:\\v.exe' });
  assert.equal(category.type, 'custom');
  assert.equal(category.name, JUMP_LIST_CATEGORY);
  assert.deepEqual(category.items[0], {
    type: 'task',
    title: 'The Witcher 3',
    description: 'Jugar The Witcher 3 (GOG Galaxy)',
    program: 'C:\\Juegos\\Viciodromo-0.37.0.exe',
    args: '--launch=gog%20galaxy%3Aw3',
    iconPath: 'D:\\GOG\\Witcher 3\\witcher3.exe', // el ícono del propio juego
    iconIndex: 0
  });
  assert.equal(category.items[1].iconPath, 'C:\\v.exe'); // Steam: sin .exe propio, el ícono de la aplicación
});

test('en desarrollo antepone la carpeta del proyecto, entre comillas si tiene espacios', () => {
  const [category] = buildJumpList({
    games,
    program: 'C:\\electron.exe',
    baseArgs: ['C:\\Users\\Jorge Miguez\\viciodromo'],
    limit: 1
  });
  assert.equal(category.items[0].args, '"C:\\Users\\Jorge Miguez\\viciodromo" --launch=gog%20galaxy%3Aw3');
});

test('lo que se quitó de la lista no se vuelve a agregar, y su lugar lo ocupa el siguiente', () => {
  const [category] = buildJumpList({
    games,
    program: 'C:\\v.exe',
    removed: [{ type: 'task', args: '--launch=gog%20galaxy%3Aw3' }],
    limit: 2
  });
  assert.deepEqual(
    category.items.map((item) => item.title),
    ['Según Steam', 'Viejo']
  );
});

test('sin juegos jugados no hay categoría', () => {
  assert.deepEqual(buildJumpList({ games: [game('steam:2', 'Nunca jugado')], program: 'C:\\v.exe' }), []);
});

test('accesos directos: sólo se corrigen los que apuntan a Viciódromo', () => {
  const exe = 'C:\\Juegos\\Viciodromo-0.37.0.exe';
  // Apunta al .exe en uso y le falta el identificador.
  assert.deepEqual(shortcutFix({ target: 'c:\\juegos\\viciodromo-0.37.0.exe' }, exe), {
    target: 'c:\\juegos\\viciodromo-0.37.0.exe',
    appUserModelId: APP_USER_MODEL_ID
  });
  // Ya está bien.
  assert.equal(shortcutFix({ target: exe, appUserModelId: APP_USER_MODEL_ID }, exe), null);
  // Una versión anterior que se borró: pasa a apuntar a la actual.
  assert.deepEqual(
    shortcutFix({ target: 'C:\\Juegos\\Viciodromo-0.36.2.exe' }, exe, () => false),
    { target: exe, cwd: 'C:\\Juegos', appUserModelId: APP_USER_MODEL_ID }
  );
  // Una versión anterior que sigue ahí (se conservan las dos últimas): no se toca.
  assert.equal(
    shortcutFix({ target: 'C:\\Juegos\\Viciodromo-0.36.2.exe' }, exe, () => true),
    null
  );
  // Otros programas, otra carpeta o un acceso directo sin destino: no se tocan.
  assert.equal(
    shortcutFix({ target: 'C:\\Juegos\\steam.exe' }, exe, () => false),
    null
  );
  assert.equal(
    shortcutFix({ target: 'D:\\Otra\\Viciodromo-0.36.2.exe' }, exe, () => false),
    null
  );
  assert.equal(shortcutFix({}, exe), null);
});
