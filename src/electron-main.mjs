import { app, BrowserWindow, dialog, nativeTheme, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_APP_FOLDERS, chooseDataDir, migrateLegacyData } from './portable.mjs';
import { APP_USER_MODEL_ID, buildJumpList, launchKeyFromArgs, shortcutFix } from './jump-list.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Puerto fijo para que la interfaz conserve lo que recuerda (vista, colección, la última biblioteca) entre
// aperturas: el almacenamiento del navegador depende del origen. Si estuviera ocupado, se usa uno libre.
const PREFERRED_PORT = 47321;

let server;
let window;
const scanMode = process.argv.includes('--scan');
// Abierta desde la Jump List («--launch=<clave>»): el juego se inicia apenas la aplicación está lista.
let pendingLaunch = launchKeyFromArgs(process.argv);
const isWindows = process.platform === 'win32';
// El identificador con el que Windows agrupa la ventana, el ícono anclado y la Jump List.
if (isWindows) app.setAppUserModelId(APP_USER_MODEL_ID);

// Portable (B8): los datos pueden vivir junto al .exe (ver portable.mjs). Se decide antes de que Electron use la
// carpeta; las cachés de Chromium se quedan en AppData de cada PC.
// Sin await: tiene que pasar antes del evento «ready».
{
  const defaultDir = app.getPath('userData');
  // Antes de la 0.36.0 la aplicación se llamaba Games Meta Launcher: sus datos se copian a la carpeta nueva.
  const appData = app.getPath('appData');
  migrateLegacyData({ defaultDir, legacyDirs: LEGACY_APP_FOLDERS.map((name) => path.join(appData, name)) });
  const chosen = chooseDataDir({ exeDir: process.env.PORTABLE_EXECUTABLE_DIR, defaultDir });
  if (chosen.portable) {
    app.setPath('sessionData', defaultDir);
    app.setPath('userData', chosen.dir);
  }
}

async function runScan() {
  process.env.GML_DATA_DIR = app.getPath('userData');
  const { log } = await import('./log.mjs');
  log('info', 'tarea', 'Indexación programada: inicio');
  const { scanLibrary } = await import('./indexer.mjs');
  try {
    const scanned = await scanLibrary();
    log('info', 'tarea', `Indexación programada: ${scanned.games.length} juegos`);
  } catch (error) {
    log('error', 'tarea', `Indexación programada: ${error.message}`, error.stack);
  }
  const { createSteam } = await import('./steam.mjs');
  const steam = createSteam(app.getPath('userData'));
  try {
    if ((await steam.settings()).configured) await steam.sync();
  } catch (error) {
    log('warn', 'tarea', `Steam: ${error.message}`);
  }
  steam.close();
  try {
    const { createArcade } = await import('./mame.mjs');
    for (const slot of ['main', 'legacy']) {
      const arcade = createArcade(app.getPath('userData'), { slot });
      if ((await arcade.settings()).exe) await arcade.refresh();
    }
  } catch (error) {
    log('warn', 'tarea', `Arcade: ${error.message}`);
  }
  const { flushLog } = await import('./log.mjs');
  await flushLog();
  app.quit();
}

function listen(start, port) {
  return new Promise((resolve, reject) => {
    const instance = start(port, { ...callbacks });
    instance.once('listening', () => resolve(instance));
    instance.once('error', (error) => {
      if (port !== 0 && error.code === 'EADDRINUSE') resolve(listen(start, 0));
      else reject(error);
    });
  });
}
// Al iniciar un juego, la ventana se minimiza para que el juego quede adelante (se puede desactivar).
// Al cerrar un juego que el launcher abrió (Arcade), la ventana vuelve al frente.
function bringBack() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
// Jump List (ver jump-list.mjs). El ejecutable a repetir es el portable, no su copia temporal; en desarrollo,
// electron.exe con la carpeta del proyecto.
const appExe = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
async function refreshJumpList() {
  if (!isWindows || !server?.games) return;
  const { log } = await import('./log.mjs');
  try {
    const categories = buildJumpList({
      games: await server.games.list(),
      program: appExe(),
      baseArgs: app.isPackaged ? [] : [app.getAppPath()],
      iconPath: appExe(),
      removed: app.getJumpListSettings().removedItems
    });
    const result = app.setJumpList(categories);
    if (result !== 'ok') log('warn', 'app', `Jump List: ${result}`);
  } catch (error) {
    log('warn', 'app', `Jump List: ${error.message}`);
  }
}
// Varios avisos seguidos (una sincronización, una sesión que termina) actualizan la lista una sola vez.
let jumpListTimer = null;
function refreshJumpListSoon() {
  clearTimeout(jumpListTimer);
  jumpListTimer = setTimeout(refreshJumpList, 1500);
}
// Los accesos directos del Escritorio y del menú Inicio que apuntan a Viciódromo reciben el identificador de la
// aplicación: sin él, Windows no asocia la Jump List al ícono que se ancla desde ese acceso directo.
async function adoptShortcuts() {
  if (!isWindows || !app.isPackaged) return;
  const { log } = await import('./log.mjs');
  const folders = [
    app.getPath('desktop'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ];
  for (const folder of folders) {
    let names = [];
    try {
      names = fs.readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.lnk'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(folder, name);
      try {
        const fix = shortcutFix(shell.readShortcutLink(file), appExe(), fs.existsSync);
        if (fix && shell.writeShortcutLink(file, 'update', fix))
          log('info', 'app', `Acceso directo actualizado: ${name}`);
      } catch {
        /* un acceso directo que no se puede leer no es nuestro */
      }
    }
  }
}
// Inicia un juego pedido desde la Jump List. Si falla, la ventana pasa al frente y lo explica.
async function playFromJumpList(key) {
  const { log } = await import('./log.mjs');
  try {
    await server.games.play(key);
  } catch (error) {
    log('warn', 'app', `Jump List: no se pudo iniciar ${key}: ${error.message}`);
    bringBack();
    if (window && !window.isDestroyed())
      dialog.showMessageBox(window, {
        type: 'warning',
        title: 'Viciódromo',
        message: 'No se pudo iniciar el juego.',
        detail: error.message
      });
  }
}
const callbacks = {
  onLaunch: () => window?.minimize(),
  onLibraryChange: refreshJumpListSoon,
  // Después de copiar los datos junto al .exe: se vuelve a abrir el portable (no la copia temporal).
  onRestart: () => {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE;
    app.relaunch(exe ? { execPath: exe, args: [] } : undefined);
    app.exit(0);
  },
  onGameExit: () => {
    bringBack();
    window?.webContents.executeJavaScript("window.dispatchEvent(new Event('gml-game-exit'))").catch(() => {});
  }
};

async function openWindow() {
  process.env.GML_DATA_DIR = app.getPath('userData');
  const { startServer, appSettings } = await import('./server.mjs');
  const { log } = await import('./log.mjs');
  // El tema elegido también gobierna la barra de título y prefers-color-scheme de la ventana.
  const applyTheme = ({ theme }) => {
    nativeTheme.themeSource = theme;
  };
  callbacks.onSettingsChange = applyTheme;
  applyTheme(await appSettings());
  server = await listen(startServer, PREFERRED_PORT);
  const origin = `http://127.0.0.1:${server.address().port}`;
  log('info', 'app', `Inicio de la versión ${app.getVersion()} en ${origin}`);

  // Permisos: sólo pantalla completa (modo sala). Cámara, micrófono, ubicación o notificaciones, nunca.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, done) =>
    done(permission === 'fullscreen')
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');

  window = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 920,
    minHeight: 650,
    title: 'Viciódromo',
    icon: path.join(root, 'public', 'brand', 'icon-256.png'),
    // La ventana se muestra recién cuando la interfaz pintó su primer cuadro, con el fondo del tema:
    // así no hay un destello blanco al abrir.
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#07080c' : '#f4f5f8',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      spellcheck: false
    }
  });
  // Abierta desde la Jump List para jugar: la ventana queda minimizada, detrás del juego.
  const startMinimized = Boolean(pendingLaunch);
  window.once('ready-to-show', () => (startMinimized ? window.minimize() : window.show()));
  // La ventana nunca sale de la interfaz: los enlaces https se abren en el navegador y el resto se bloquea.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin + '/')) return;
    event.preventDefault();
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('render-process-gone', (_event, details) =>
    log('error', 'app', `La interfaz se cerró inesperadamente: ${details.reason}`)
  );
  await window.loadURL(origin);
  adoptShortcuts();
  refreshJumpList();
  if (pendingLaunch) {
    const key = pendingLaunch;
    pendingLaunch = null;
    playFromJumpList(key);
  }
}

if (scanMode) {
  app.whenReady().then(runScan);
} else if (!app.requestSingleInstanceLock()) {
  // Ya hay una ventana abierta: esa pasa al frente (second-instance) y esta termina.
  app.quit();
} else {
  // Abrir el .exe otra vez trae la ventana al frente; con un juego de la Jump List, lo inicia.
  app.on('second-instance', (_event, argv) => {
    const key = launchKeyFromArgs(argv);
    if (!key) bringBack();
    else if (server?.games) playFromJumpList(key);
    else pendingLaunch = key; // todavía está arrancando
  });
  app.whenReady().then(openWindow);
  app.on('window-all-closed', () => {
    server?.close();
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
}
process.on('uncaughtException', async (error) => {
  try {
    const { log } = await import('./log.mjs');
    log('error', 'app', `Error no controlado: ${error.message}`, error.stack);
  } catch {}
});
process.on('unhandledRejection', async (reason) => {
  try {
    const { log } = await import('./log.mjs');
    log('error', 'app', `Promesa rechazada sin manejar: ${reason?.message ?? reason}`, reason?.stack);
  } catch {}
});
