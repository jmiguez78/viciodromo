// Actualización automática de la versión instalada (el instalador de Windows). El portable no se actualiza solo:
// sigue avisando la versión nueva (updates.mjs) y se descarga a mano.
// Acá no se usa Electron: `updater` es el autoUpdater de electron-updater (o uno de mentira, en las pruebas).
// Nada se descarga hasta que la persona lo pide; una vez descargada, la versión nueva se instala al reiniciar
// desde Configuración o, si no, al cerrar la aplicación.
import { conflict } from './http.mjs';

export const noAutoUpdate = {
  state: () => ({ supported: false }),
  download() {
    throw conflict('Esta copia de Viciódromo no se actualiza sola: descargá la versión nueva desde GitHub.');
  },
  install() {
    throw conflict('Esta copia de Viciódromo no se actualiza sola: descargá la versión nueva desde GitHub.');
  }
};

export function createAutoUpdate({ updater, log = () => {} }) {
  // phase: idle (nada pedido), downloading, ready (descargada, falta reiniciar) o error.
  let state = { supported: true, phase: 'idle', percent: 0, version: null, error: null };
  const set = (change) => {
    state = { ...state, ...change };
  };
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.on('download-progress', (progress) => {
    if (state.phase === 'downloading') set({ percent: Math.max(0, Math.min(100, Math.round(progress?.percent ?? 0))) });
  });
  updater.on('update-downloaded', (info) => {
    set({ phase: 'ready', percent: 100, version: info?.version ?? state.version });
    log('info', 'versión', `Versión ${state.version ?? 'nueva'} descargada: se instala al reiniciar`);
  });

  async function run() {
    try {
      const found = await updater.checkForUpdates();
      if (!found?.isUpdateAvailable) {
        set({ phase: 'idle', percent: 0 });
        return;
      }
      set({ version: found.updateInfo?.version ?? null });
      await updater.downloadUpdate();
    } catch (error) {
      set({ phase: 'error', error: error?.message ?? String(error) });
      log('warn', 'versión', `No se pudo descargar la versión nueva: ${state.error}`);
    }
  }

  return {
    state: () => ({ ...state }),
    // Empieza la descarga y responde enseguida: el avance se consulta con state().
    download() {
      if (state.phase !== 'downloading' && state.phase !== 'ready') {
        set({ phase: 'downloading', percent: 0, error: null });
        run();
      }
      return { ...state };
    },
    // Cierra la aplicación, instala sin preguntar y la vuelve a abrir.
    install() {
      if (state.phase !== 'ready') throw conflict('La versión nueva todavía no terminó de descargarse.');
      setTimeout(() => updater.quitAndInstall(true, true), 300);
      return { ok: true };
    }
  };
}
