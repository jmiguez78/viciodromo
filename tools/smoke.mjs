// Prueba de humo de un ejecutable: lo abre con --smoke=<carpeta temporal> (ver runSmoke en electron-main.mjs) y
// lee el resultado. No usa los datos de la PC ni toca la tarea nocturna.
//   node tools/smoke.mjs                    el portable de la versión actual en releases/
//   node tools/smoke.mjs <ruta al .exe>     cualquier otro (por ejemplo, el instalado)
//   node tools/smoke.mjs --dev              el código del proyecto con el Electron de node_modules
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const arg = process.argv[2];
const dev = arg === '--dev';
const exe = dev
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.resolve(arg ?? path.join(root, 'releases', `Viciodromo-${version}.exe`));
if (!fs.existsSync(exe)) {
  console.error('No existe ' + exe + (dev ? ' (ejecutá npx electron --version para descargarlo).' : '.'));
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viciodromo-humo-'));
const run = spawnSync(exe, [...(dev ? [root] : []), '--smoke=' + dir], { stdio: 'ignore', timeout: 180000 });
let result = null;
try {
  result = JSON.parse(fs.readFileSync(path.join(dir, 'smoke.json'), 'utf8'));
} catch {
  /* sin resultado: el ejecutable no llegó a abrir la interfaz */
}
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
if (!result) {
  console.error(`${path.basename(exe)} no dejó resultado (${run.error?.message ?? 'código ' + run.status}).`);
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));
if (!result.ok || (!dev && result.version !== version)) {
  console.error(result.ok ? `Se esperaba la versión ${version}.` : 'La prueba de humo falló.');
  process.exit(1);
}
console.log(`${path.basename(exe)} abre bien (versión ${result.version}, Electron ${result.electron}).`);
