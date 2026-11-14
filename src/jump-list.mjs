// Jump List de Windows: el menú del clic derecho sobre el ícono de la barra de tareas (o del menú Inicio) muestra
// los últimos juegos jugados y los abre sin pasar por la biblioteca, como hace Steam.
// Cada entrada vuelve a ejecutar la aplicación con «--launch=<clave>»: si ya está abierta, el pedido llega a la
// ventana existente (second-instance); si no, la aplicación se abre minimizada e inicia el juego.
// Windows asocia la lista al ícono por el identificador de la aplicación (AppUserModelID): el acceso directo que
// se ancla tiene que llevar el mismo. Acá sólo hay funciones puras; Electron se usa en electron-main.mjs.
import path from 'node:path';

export const APP_USER_MODEL_ID = 'com.jorgemiguez.viciodromo';
export const JUMP_LIST_LIMIT = 8;
export const JUMP_LIST_CATEGORY = 'Jugados recientemente';
const LAUNCH_FLAG = '--launch=';
const PORTABLE_EXE = /^Viciodromo-\d[\w.-]*\.exe$/i;

// La clave va codificada: tiene espacios y dos puntos («epic games:x») y viaja en una línea de comandos.
export const launchArg = (key) => LAUNCH_FLAG + encodeURIComponent(key);

export function launchKeyFromArgs(argv = []) {
  const arg = argv.find((item) => typeof item === 'string' && item.startsWith(LAUNCH_FLAG));
  if (!arg) return null;
  try {
    return decodeURIComponent(arg.slice(LAUNCH_FLAG.length)) || null;
  } catch {
    return null;
  }
}

const time = (value) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
};
// El mismo criterio que la fila «Seguí jugando» de Inicio (public/shelves.js): instalados, que se pueden abrir
// y jugados alguna vez, desde la aplicación o según Steam; los más recientes primero.
const lastPlayed = (game) => Math.max(time(game.lastLaunchedAt), time(game.steam?.lastPlayedAt));
export function recentGames(games = [], limit = JUMP_LIST_LIMIT) {
  return games
    .filter((game) => game.installed !== false && game.launch?.available && lastPlayed(game) > 0)
    .sort((a, b) => lastPlayed(b) - lastPlayed(a) || a.name.localeCompare(b.name, 'es'))
    .slice(0, limit);
}

const quote = (arg) => (/[\s"]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg);
// Windows corta los textos largos de la lista.
const clip = (text, max) => (text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text);

// Categorías para app.setJumpList. program + baseArgs: cómo se ejecuta la aplicación (el .exe portable; en
// desarrollo, electron.exe y la carpeta del proyecto). iconPath: el ícono para los juegos sin .exe propio.
// removed: las entradas que la persona quitó de la lista (getJumpListSettings): si se vuelven a agregar en la
// misma llamada, Windows descarta la categoría entera.
export function buildJumpList({ games = [], program, baseArgs = [], iconPath, removed = [], limit = JUMP_LIST_LIMIT }) {
  const prefix = baseArgs.map(quote);
  const removedArgs = new Set(removed.map((item) => item?.args).filter(Boolean));
  const items = recentGames(games, limit + removedArgs.size)
    .map((game) => {
      const ownExe = game.launch.type === 'file' && /\.exe$/i.test(game.launch.target ?? '');
      return {
        type: 'task',
        title: clip(game.name, 100),
        description: clip(`Jugar ${game.name}${game.platform ? ` (${game.platform})` : ''}`, 250),
        program,
        args: [...prefix, launchArg(game.key)].join(' '),
        iconPath: ownExe ? game.launch.target : iconPath,
        iconIndex: 0
      };
    })
    .filter((item) => !removedArgs.has(item.args))
    .slice(0, limit);
  return items.length ? [{ type: 'custom', name: JUMP_LIST_CATEGORY, items }] : [];
}

const same = (a, b) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
// Qué hay que corregir en un acceso directo (.lnk) para que Windows lo asocie a esta aplicación. Sólo se tocan
// los que ya apuntan a Viciódromo: al .exe en uso, o a una versión anterior del portable en la misma carpeta que
// ya no existe (cada versión cambia el nombre del archivo y el acceso directo quedaba roto).
// details: lo que devuelve shell.readShortcutLink. Devuelve null si no hay nada que cambiar.
export function shortcutFix(details, exe, exists = () => true) {
  const target = details?.target;
  if (!target || !exe) return null;
  let retarget = false;
  if (!same(target, exe)) {
    retarget =
      same(path.win32.dirname(target), path.win32.dirname(exe)) &&
      PORTABLE_EXE.test(path.win32.basename(target)) &&
      !exists(target);
    if (!retarget) return null;
  }
  if (!retarget && details.appUserModelId === APP_USER_MODEL_ID) return null;
  // «target» va siempre: writeShortcutLink lo exige también al actualizar.
  return {
    target: retarget ? exe : target,
    ...(retarget ? { cwd: path.win32.dirname(exe) } : {}),
    appUserModelId: APP_USER_MODEL_ID
  };
}
