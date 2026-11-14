// Empaqueta el instalador y el portable de Windows y guarda sólo lo necesario:
// 1. electron-builder compila siempre en dist/ (se sobrescribe en cada build).
// 2. Se copian a releases/ el instalador (Viciodromo-Setup-X.Y.Z.exe), el portable (Viciodromo-X.Y.Z.exe) y lo
//    que usa la actualización automática de la versión instalada: latest.yml y el .blockmap del instalador.
// 3. Se borra dist/ (incluye win-unpacked, la copia intermedia de ~300 MB).
// 4. En releases/ quedan sólo las dos versiones más recientes: la actual y la anterior.
// Cualquier versión vieja se reconstruye desde su etiqueta de Git (por ejemplo, git checkout v0.18.0).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(root, 'dist');
const releasesDir = path.join(root, 'releases');
const KEEP = 2;

// Versión a partir del nombre («Viciodromo-0.36.0.exe», «Viciodromo-Setup-0.38.0.exe» y su .blockmap; antes,
// «Games Meta Launcher 0.18.0.exe»).
export function versionOf(file) {
  const match = /(\d+)\.(\d+)\.(\d+)\.exe(\.blockmap)?$/i.exec(file);
  return match ? match.slice(1, 4).map(Number) : null;
}
export function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}
// Devuelve los archivos que sobran, del más viejo al más nuevo, dejando los de las `keep` versiones más recientes
// (cada versión tiene instalador, portable y .blockmap).
export function releasesToPrune(files, keep = KEEP) {
  const versioned = files
    .filter((file) => versionOf(file))
    .sort((a, b) => compareVersions(versionOf(a), versionOf(b)) || a.localeCompare(b));
  const versions = [...new Set(versioned.map((file) => versionOf(file).join('.')))];
  const kept = new Set(versions.slice(Math.max(0, versions.length - keep)));
  return versioned.filter((file) => !kept.has(versionOf(file).join('.')));
}

async function main() {
  const { version, build } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (build?.directories?.output !== 'dist') throw new Error('build.directories.output debe ser "dist".');
  await fs.rm(distDir, { recursive: true, force: true });
  const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
  // Los destinos (instalador y portable) salen de build.win.target; nunca se publica desde acá.
  const result = spawnSync(process.execPath, [cli, '--win', '--publish', 'never'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const built = (await fs.readdir(distDir)).filter(
    (file) => file === 'latest.yml' || (versionOf(file) && file.includes(version + '.exe'))
  );
  for (const expected of [`Viciodromo-${version}.exe`, `Viciodromo-Setup-${version}.exe`, 'latest.yml'])
    if (!built.includes(expected)) throw new Error('electron-builder no generó ' + expected + '.');
  await fs.mkdir(releasesDir, { recursive: true });
  for (const file of built) await fs.copyFile(path.join(distDir, file), path.join(releasesDir, file));
  await fs.rm(distDir, { recursive: true, force: true });
  for (const old of releasesToPrune(await fs.readdir(releasesDir))) {
    await fs.rm(path.join(releasesDir, old));
    console.log('Se quitó ' + old + ' (se puede reconstruir desde su etiqueta de Git).');
  }
  console.log('Listo, en releases/: ' + built.join(', '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
