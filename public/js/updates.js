// Versión nueva: unos segundos después de abrir se consulta (el servidor lo hace como mucho una vez por día) y, si
// hay una versión publicada más nueva, se avisa una sola vez por versión. La versión instalada además la descarga
// y la instala desde Configuración (info.install); el portable sólo lleva a las novedades.
import { request } from './api.js';
import { notify } from './feedback.js';

const SEEN_KEY = 'gml-update-seen';
const remembered = () => {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
};
const remember = (version) => {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    /* sin almacenamiento: se vuelve a avisar en la próxima apertura */
  }
};
const openRelease = (url) => url && window.open(url, '_blank', 'noopener');

export function describeUpdates(info) {
  if (!info?.enabled) return 'Versión ' + (info?.current ?? '') + '.';
  const install = info.install ?? {};
  if (install.phase === 'downloading')
    return 'Versión ' + info.current + '. Descargando la versión nueva… ' + (install.percent ?? 0) + ' %.';
  if (install.phase === 'ready')
    return (
      'Versión ' + info.current + '. La versión ' + (install.version ?? info.latest) + ' está lista para instalar.'
    );
  if (info.newer && install.phase === 'error')
    return 'Versión ' + info.current + '. No se pudo descargar la versión ' + info.latest + '.';
  if (info.newer) return 'Versión ' + info.current + '. Hay una versión nueva: ' + info.latest + '.';
  if (info.available) return 'Versión ' + info.current + '. Estás al día.';
  if (info.error) return 'Versión ' + info.current + '. No se pudo consultar si hay una versión nueva.';
  return 'Versión ' + info.current + '. ' + (info.reason ?? '');
}

// Qué ofrece el botón según el estado: buscar, ver las novedades (portable) o actualizar (versión instalada).
export function updateAction(info) {
  const install = info.install ?? {};
  if (install.phase === 'ready') return { label: 'Reiniciar y actualizar', run: 'install' };
  if (install.phase === 'downloading') return { label: 'Descargando…', run: null };
  if (!info.newer) return { label: 'Buscar actualizaciones', run: 'check' };
  if (!install.supported) return { label: 'Ver novedades', run: 'release' };
  return { label: install.phase === 'error' ? 'Reintentar' : 'Actualizar', run: 'download' };
}

let watching = null;
// Mientras se descarga, el avance se consulta una vez por segundo.
function watchDownload() {
  clearTimeout(watching);
  watching = setTimeout(() => loadUpdates(), 1000);
}

async function act(run, info) {
  try {
    if (run === 'release') return openRelease(info.url);
    if (run === 'check') return loadUpdates({ force: true });
    if (run === 'download') await request('/api/updates/download', { method: 'POST' });
    if (run === 'install') {
      await request('/api/updates/install', { method: 'POST' });
      notify('Viciódromo se cierra para instalar la versión nueva y vuelve a abrirse.');
      return null;
    }
    return loadUpdates();
  } catch (error) {
    notify(error.message || 'No se pudo actualizar.', { type: 'error' });
    return null;
  }
}

export async function loadUpdates({ force = false } = {}) {
  const status = document.querySelector('#update-status');
  const button = document.querySelector('#check-updates');
  try {
    const info = await request('/api/updates' + (force ? '?refresh=1' : ''));
    if (status) status.textContent = describeUpdates(info);
    if (button) {
      const action = updateAction(info);
      button.hidden = !info.enabled;
      button.textContent = action.label;
      button.disabled = !action.run;
      button.onclick = action.run ? () => act(action.run, info) : null;
    }
    if (info.install?.phase === 'downloading') watchDownload();
    return info;
  } catch {
    if (status) status.textContent = 'No se pudo consultar la versión.';
    return null;
  }
}

export function setup() {
  setTimeout(async () => {
    const info = await loadUpdates();
    if (!info?.newer || remembered() === info.latest) return;
    remember(info.latest);
    const canInstall = Boolean(info.install?.supported);
    notify(
      'Hay una versión nueva de Viciódromo: ' +
        info.latest +
        '.' +
        (canInstall ? ' Se instala desde Configuración.' : ''),
      { action: info.url ? { label: 'Ver novedades', run: () => openRelease(info.url) } : undefined }
    );
  }, 8000);
}
