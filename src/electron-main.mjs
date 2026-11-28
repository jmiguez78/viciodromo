import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  nativeTheme,
  Notification,
  screen,
  session,
  shell
} from 'electron';
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
let serverOrigin = '';
let window;
let guideWindow = null;
let guideOverlayWindow = null;
let guideOverlayKey = null;
let guideSessionHardened = false;
const scanMode = process.argv.includes('--scan');
// Prueba de humo («--smoke=<carpeta>», ver tools/smoke.mjs): abre la interfaz con los datos en esa carpeta, sin
// tocar los de la PC, anota el resultado en smoke.json y termina.
const smokeDir = process.argv.find((arg) => arg.startsWith('--smoke='))?.slice('--smoke='.length) || null;
// Abierta desde la Jump List («--launch=<clave>»): el juego se inicia apenas la aplicación está lista.
let pendingLaunch = launchKeyFromArgs(process.argv);
const isWindows = process.platform === 'win32';
// El identificador con el que Windows agrupa la ventana, el ícono anclado y la Jump List.
if (isWindows) app.setAppUserModelId(APP_USER_MODEL_ID);

// Portable (B8): los datos pueden vivir junto al .exe (ver portable.mjs). Se decide antes de que Electron use la
// carpeta; las cachés de Chromium se quedan en AppData de cada PC.
// Sin await: tiene que pasar antes del evento «ready».
if (smokeDir) {
  app.setPath('userData', path.resolve(smokeDir));
} else {
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
  // Novedades de los juegos que seguís (ver news.mjs), con el inventario recién buscado.
  try {
    const { nightlyNews } = await import('./news.mjs');
    const { createArcade } = await import('./mame.mjs');
    const arcade = createArcade(app.getPath('userData'), { slot: 'main' });
    await nightlyNews(app.getPath('userData'), log, { mameVersion: async () => (await arcade.info()).version });
  } catch (error) {
    log('warn', 'tarea', `Novedades: ${error.message}`);
  }
  // Disponibilidad de guías libres en StrategyWiki (ver guides.mjs), sólo consulta si existen.
  try {
    const { nightlyGuides } = await import('./guides.mjs');
    await nightlyGuides(app.getPath('userData'), log);
  } catch (error) {
    log('warn', 'tarea', `Guías: ${error.message}`);
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
// Monitores conectados para elegir el de cada juego (ver displays.mjs). En Windows se suma el rectángulo en píxeles
// físicos, el que usan las ventanas de los juegos y MAME (con escalas distintas por monitor no coincide con bounds).
function listDisplays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((display) => ({
    id: display.id,
    label: display.label,
    primary: display.id === primary,
    bounds: display.bounds,
    physical: isWindows ? screen.dipToScreenRect(null, display.bounds) : null
  }));
}
// «Identificar» (Configuración → Monitores): un número grande unos segundos en el centro de cada pantalla, como en
// Configuración de pantalla de Windows. Ventanas sin marco, sin foco y que no reciben clics.
const escapeText = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
function identifyDisplays(items) {
  const all = screen.getAllDisplays();
  for (const item of items) {
    const display = all.find((entry) => String(entry.id) === item.id);
    if (!display) continue;
    const width = 440;
    const height = 300;
    const area = display.workArea;
    const note = item.name !== item.detected ? `<small>${escapeText(item.detected)}</small>` : '';
    const html =
      '<!DOCTYPE html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}' +
      'main{box-sizing:border-box;height:100%;display:grid;place-content:center;gap:6px;text-align:center;' +
      'border-radius:28px;background:rgba(18,16,26,.92);color:#fff;font-family:"Segoe UI",sans-serif;border:3px solid #8b7cf6}' +
      'b{font-size:150px;line-height:1;font-weight:800}span{font-size:26px;font-weight:600}small{font-size:16px;opacity:.7}</style>' +
      `<main><b>${item.number}</b><span>${escapeText(item.name)}</span>${note}</main>`;
    const overlay = new BrowserWindow({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2),
      width,
      height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, javascript: false }
    });
    overlay.setIgnoreMouseEvents(true);
    overlay.once('ready-to-show', () => overlay.showInactive());
    overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).catch(() => {});
    setTimeout(() => overlay.isDestroyed() || overlay.destroy(), 3000);
  }
}
const GUIDE_URL = /^https:\/\//i;
// Visor auxiliar aislado para guías externas (GameFAQs, Steam, YouTube, IGN): sin acceso a 127.0.0.1 ni a Node.
function openGuideWindow({ url, title, display, inactive = false } = {}) {
  if (!GUIDE_URL.test(String(url ?? ''))) return false;
  const all = screen.getAllDisplays();
  const targetDisplay = (display?.id && all.find((item) => String(item.id) === String(display.id))) || null;
  const area = (targetDisplay ?? screen.getPrimaryDisplay()).workArea;
  const width = targetDisplay
    ? Math.min(1280, Math.max(760, Math.round(area.width * 0.92)))
    : Math.min(1040, area.width);
  const height = targetDisplay
    ? Math.min(960, Math.max(600, Math.round(area.height * 0.92)))
    : Math.min(780, area.height);
  const bounds = {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height
  };
  const guideSession = session.fromPartition('persist:guides');
  if (!guideSessionHardened) {
    guideSessionHardened = true;
    guideSession.setPermissionRequestHandler((_contents, permission, done) => done(permission === 'fullscreen'));
    guideSession.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');
  }
  const windowTitle = title ? `${title} — Guía · Viciódromo` : 'Guía · Viciódromo';
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.setTitle(windowTitle);
    if (targetDisplay) guideWindow.setBounds(bounds);
    if (guideWindow.webContents.getURL() !== url) guideWindow.loadURL(url).catch(() => {});
    if (inactive) guideWindow.showInactive();
    else {
      if (guideWindow.isMinimized()) guideWindow.restore();
      guideWindow.show();
      guideWindow.focus();
    }
    return true;
  }
  guideWindow = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 480,
    title: windowTitle,
    icon: path.join(root, 'public', 'brand', 'icon-256.png'),
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#07080c' : '#f4f5f8',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:guides',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      navigateOnDragDrop: false,
      spellcheck: false
    }
  });
  guideWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  guideWindow.webContents.on('will-navigate', (event, nextUrl) => {
    if (!GUIDE_URL.test(nextUrl)) event.preventDefault();
  });
  guideWindow.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (GUIDE_URL.test(popupUrl)) shell.openExternal(popupUrl);
    return { action: 'deny' };
  });
  guideWindow.once('ready-to-show', () => {
    if (!guideWindow || guideWindow.isDestroyed()) return;
    if (inactive) guideWindow.showInactive();
    else guideWindow.show();
  });
  guideWindow.on('closed', () => {
    guideWindow = null;
  });
  guideWindow.loadURL(url).catch(() => {});
  return true;
}

const clampOverlayOpacity = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0.35, Math.min(1, num)) : 0.92;
};

// Ventana flotante siempre visible sobre juegos en ventana sin bordes (Fase 4).
function openGuideOverlay({ gameKey, title, opacity = 0.92, inactive = false, toggle = false } = {}) {
  if (!serverOrigin || !gameKey) return { open: false };
  const url = `${serverOrigin}/guide-overlay.html?key=${encodeURIComponent(gameKey)}`;
  const alpha = clampOverlayOpacity(opacity);

  if (toggle && guideOverlayWindow && !guideOverlayWindow.isDestroyed()) {
    if (guideOverlayWindow.isVisible()) {
      guideOverlayWindow.hide();
      server?.guides?.setOverlayOpen(false);
      return { open: false };
    }
    guideOverlayWindow.setOpacity(alpha);
    guideOverlayWindow.showInactive();
    server?.guides?.setOverlayOpen(true);
    return { open: true };
  }

  const windowTitle = title ? `${title} · Guía flotante` : 'Guía flotante · Viciódromo';
  if (guideOverlayWindow && !guideOverlayWindow.isDestroyed()) {
    guideOverlayWindow.setTitle(windowTitle);
    guideOverlayWindow.setOpacity(alpha);
    if (guideOverlayKey !== gameKey) {
      guideOverlayKey = gameKey;
      guideOverlayWindow.loadURL(url).catch(() => {});
    }
    if (inactive) guideOverlayWindow.showInactive();
    else guideOverlayWindow.show();
    server?.guides?.setOverlayOpen(true);
    return { open: true };
  }

  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(440, Math.max(340, Math.round(area.width * 0.28)));
  const height = Math.min(640, Math.max(420, Math.round(area.height * 0.65)));
  const x = Math.round(area.x + area.width - width - 20);
  const y = Math.round(area.y + 20);

  guideOverlayKey = gameKey;
  guideOverlayWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 320,
    minHeight: 380,
    title: windowTitle,
    icon: path.join(root, 'public', 'brand', 'icon-256.png'),
    show: false,
    alwaysOnTop: true,
    opacity: alpha,
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
  guideOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
  guideOverlayWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  guideOverlayWindow.webContents.on('will-navigate', (event, nextUrl) => {
    if (!nextUrl.startsWith(`${serverOrigin}/guide-overlay.html`)) event.preventDefault();
  });
  guideOverlayWindow.webContents.setWindowOpenHandler(({ url: popupUrl }) => {
    if (GUIDE_URL.test(popupUrl)) shell.openExternal(popupUrl);
    return { action: 'deny' };
  });
  guideOverlayWindow.once('ready-to-show', () => {
    if (!guideOverlayWindow || guideOverlayWindow.isDestroyed()) return;
    if (inactive) guideOverlayWindow.showInactive();
    else guideOverlayWindow.show();
  });
  guideOverlayWindow.on('closed', () => {
    guideOverlayWindow = null;
    guideOverlayKey = null;
    server?.guides?.setOverlayOpen(false);
  });
  guideOverlayWindow.loadURL(url).catch(() => {});
  server?.guides?.setOverlayOpen(true);
  return { open: true };
}

function closeGuideOverlay() {
  if (guideOverlayWindow && !guideOverlayWindow.isDestroyed()) {
    guideOverlayWindow.close();
  }
  server?.guides?.setOverlayOpen(false);
}

function setGuideOverlayOpacity(opacity) {
  if (guideOverlayWindow && !guideOverlayWindow.isDestroyed()) {
    guideOverlayWindow.setOpacity(clampOverlayOpacity(opacity));
  }
}

function applyGuideShortcuts(settings = {}) {
  globalShortcut.unregisterAll();
  const status = {
    supported: true,
    enabled: Boolean(settings.shortcutsEnabled),
    toggle: { accelerator: settings.toggleShortcut || '', registered: false, error: null },
    nextHint: { accelerator: settings.nextHintShortcut || '', registered: false, error: null }
  };
  if (!settings.shortcutsEnabled) return status;

  const tryRegister = (target, handler) => {
    if (!target.accelerator) return;
    try {
      target.registered = globalShortcut.register(target.accelerator, handler);
      if (!target.registered) target.error = 'El atajo está ocupado por Windows u otra aplicación.';
    } catch (error) {
      target.registered = false;
      target.error = error.message;
    }
  };

  tryRegister(status.toggle, () => {
    if (guideOverlayWindow && !guideOverlayWindow.isDestroyed()) {
      openGuideOverlay({ gameKey: guideOverlayKey, opacity: settings.opacity, toggle: true });
      return;
    }
    const key = server?.guides?.activeGameKey?.();
    if (key) openGuideOverlay({ gameKey: key, opacity: settings.opacity, inactive: true });
  });

  tryRegister(status.nextHint, () => {
    server?.guides?.triggerNextHint?.().catch(() => {});
  });

  return status;
}

const callbacks = {
  onLaunch: () => window?.minimize(),
  listDisplays,
  identifyDisplays,
  openGuideWindow,
  openGuideOverlay,
  closeGuideOverlay,
  setGuideOverlayOpacity,
  applyGuideShortcuts,
  onLibraryChange: refreshJumpListSoon,
  // Después de copiar los datos junto al .exe: se vuelve a abrir el portable (no la copia temporal).
  onRestart: () => {
    const exe = process.env.PORTABLE_EXECUTABLE_FILE;
    app.relaunch(exe ? { execPath: exe, args: [] } : undefined);
    app.exit(0);
  },
  // Novedades nuevas (ver news.mjs): con «Avisos de Windows» activado y la ventana sin foco, un aviso; al tocarlo se
  // abre la sección Novedades.
  onNews: async (result) => {
    if (!result.notify || !Notification.isSupported() || window?.isFocused()) return;
    const { notificationText } = await import('./news.mjs');
    const body = notificationText(result.fresh);
    if (!body) return;
    const notice = new Notification({
      title: 'Novedades en Viciódromo',
      body,
      icon: path.join(root, 'public', 'brand', 'icon-256.png')
    });
    notice.on('click', () => {
      bringBack();
      window?.webContents.executeJavaScript("window.GML?.showPage?.('news')").catch(() => {});
    });
    notice.show();
  },
  onGameExit: () => {
    bringBack();
    window?.webContents.executeJavaScript("window.dispatchEvent(new Event('gml-game-exit'))").catch(() => {});
  }
};

const windowOptions = () => ({
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

// Prueba de humo: el servidor (sin tarea nocturna ni consultas a internet) y la misma ventana, sin mostrarla.
// Pasa si la interfaz arranca, recibe la biblioteca y no deja errores en la consola.
async function runSmoke() {
  const dir = app.getPath('userData');
  process.env.GML_DATA_DIR = dir;
  process.env.GML_OFFLINE = '1';
  const result = {
    ok: false,
    version: app.getVersion(),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    errors: []
  };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    result.ok = result.errors.length === 0;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'smoke.json'), JSON.stringify(result, null, 2));
    app.exit(result.ok ? 0 : 1);
  };
  const fail = (message) => {
    result.errors.push(message);
    finish();
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  setTimeout(() => fail('La interfaz no arrancó en 60 segundos.'), 60000);
  try {
    const { createServer } = await import('./server.mjs');
    const instance = createServer({});
    await new Promise((resolve, reject) => {
      instance.once('error', reject);
      instance.listen(0, '127.0.0.1', resolve);
    });
    const smokeWindow = new BrowserWindow(windowOptions());
    smokeWindow.webContents.on('console-message', (event) => {
      if (event.level === 'error') result.errors.push('Consola: ' + event.message);
    });
    smokeWindow.webContents.on('render-process-gone', (_event, details) =>
      fail('La interfaz se cerró: ' + details.reason)
    );
    await smokeWindow.loadURL(`http://127.0.0.1:${instance.address().port}`);
    const started = Date.now();
    while (Date.now() - started < 30000) {
      result.page = await smokeWindow.webContents.executeJavaScript(
        `fetch('/api/library').then(async (response) => ({
          title: document.title,
          started: Boolean(window.GML),
          text: document.body.innerText.trim().length,
          library: response.status,
          games: response.ok ? (await response.json()).games.length : null
        }))`
      );
      if (result.page.started && result.page.text > 100 && result.page.library === 200) break;
      await wait(500);
    }
    if (!result.page?.started) result.errors.push('La interfaz no terminó de iniciarse.');
    if (result.page?.library !== 200) result.errors.push('La biblioteca respondió ' + result.page?.library + '.');
    if (!(result.page?.text > 100)) result.errors.push('La ventana quedó vacía.');
    // En el ejecutable, además: que el módulo de actualización automática cargue (lo usa la versión instalada).
    if (app.isPackaged) {
      try {
        const { default: updaterPackage } = await import('electron-updater');
        result.updater = updaterPackage.autoUpdater.isUpdaterActive();
      } catch (error) {
        result.errors.push('electron-updater: ' + error.message);
      }
    }
    // Un momento más, por si algún error aparece después del primer cuadro.
    await wait(2000);
    instance.close();
    finish();
  } catch (error) {
    fail(error.stack ?? String(error));
  }
}

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
  // La versión instalada se actualiza sola; el portable y el desarrollo sólo avisan (ver auto-update.mjs).
  if (isWindows && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE) {
    try {
      const [{ default: updaterPackage }, { createAutoUpdate }] = await Promise.all([
        import('electron-updater'),
        import('./auto-update.mjs')
      ]);
      callbacks.autoUpdate = createAutoUpdate({ updater: updaterPackage.autoUpdater, log });
    } catch (error) {
      log('warn', 'versión', `Actualización automática no disponible: ${error.message}`);
    }
  }
  server = await listen(startServer, PREFERRED_PORT);
  const origin = `http://127.0.0.1:${server.address().port}`;
  serverOrigin = origin;
  log('info', 'app', `Inicio de la versión ${app.getVersion()} en ${origin}`);
  server.guides
    ?.getCompanionSettings()
    .then((companion) => server.guides.setShortcutStatus(applyGuideShortcuts(companion)))
    .catch(() => {});

  // Permisos: sólo pantalla completa (modo sala). Cámara, micrófono, ubicación o notificaciones, nunca.
  session.defaultSession.setPermissionRequestHandler((_contents, permission, done) =>
    done(permission === 'fullscreen')
  );
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => permission === 'fullscreen');

  window = new BrowserWindow(windowOptions());
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
  window.on('closed', () => {
    if (guideWindow && !guideWindow.isDestroyed()) guideWindow.close();
    if (guideOverlayWindow && !guideOverlayWindow.isDestroyed()) guideOverlayWindow.close();
    globalShortcut.unregisterAll();
  });
  await window.loadURL(origin);
  adoptShortcuts();
  refreshJumpList();
  if (pendingLaunch) {
    const key = pendingLaunch;
    pendingLaunch = null;
    playFromJumpList(key);
  }
}

if (smokeDir) {
  app.whenReady().then(runSmoke);
} else if (scanMode) {
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
    globalShortcut.unregisterAll();
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
