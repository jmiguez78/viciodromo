import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAutoUpdate, noAutoUpdate } from '../src/auto-update.mjs';

// Un autoUpdater de mentira: la descarga termina cuando la prueba llama a finish().
function fakeUpdater({ available = true, failure = null } = {}) {
  const updater = new EventEmitter();
  updater.calls = [];
  updater.checkForUpdates = async () => {
    updater.calls.push('check');
    if (failure) throw new Error(failure);
    return { isUpdateAvailable: available, updateInfo: { version: '9.9.9' } };
  };
  updater.downloadUpdate = () => {
    updater.calls.push('download');
    return new Promise((resolve) => {
      updater.finish = () => {
        updater.emit('update-downloaded', { version: '9.9.9' });
        resolve();
      };
    });
  };
  updater.quitAndInstall = (...args) => updater.calls.push(['install', ...args]);
  return updater;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('nada se descarga hasta que se pide; después avanza, queda lista y se instala al reiniciar', async () => {
  const updater = fakeUpdater();
  const update = createAutoUpdate({ updater });
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.deepEqual(update.state(), { supported: true, phase: 'idle', percent: 0, version: null, error: null });
  assert.deepEqual(updater.calls, []);
  assert.throws(() => update.install(), /todavía no terminó/);

  assert.equal(update.download().phase, 'downloading');
  await tick();
  update.download(); // pedirla dos veces no la empieza de nuevo
  assert.deepEqual(updater.calls, ['check', 'download']);
  updater.emit('download-progress', { percent: 41.7 });
  assert.deepEqual(
    { phase: update.state().phase, percent: update.state().percent, version: update.state().version },
    { phase: 'downloading', percent: 42, version: '9.9.9' }
  );

  updater.finish();
  await tick();
  assert.equal(update.state().phase, 'ready');
  assert.equal(update.state().percent, 100);
  assert.deepEqual(update.install(), { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(updater.calls.at(-1), ['install', true, true]);
});

test('si falla la descarga queda el error y se puede reintentar; sin versión nueva vuelve al reposo', async () => {
  const broken = fakeUpdater({ failure: 'sin conexión' });
  const update = createAutoUpdate({ updater: broken });
  update.download();
  await tick();
  assert.equal(update.state().phase, 'error');
  assert.equal(update.state().error, 'sin conexión');
  update.download();
  await tick();
  assert.deepEqual(broken.calls, ['check', 'check']);

  const current = createAutoUpdate({ updater: fakeUpdater({ available: false }) });
  current.download();
  await tick();
  assert.equal(current.state().phase, 'idle');
});

test('el portable y el desarrollo no se actualizan solos', () => {
  assert.deepEqual(noAutoUpdate.state(), { supported: false });
  assert.throws(() => noAutoUpdate.download(), /no se actualiza sola/);
  assert.throws(() => noAutoUpdate.install(), /no se actualiza sola/);
});
