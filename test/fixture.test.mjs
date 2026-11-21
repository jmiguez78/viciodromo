import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFixture } from './ui/fixture.mjs';
import { CATALOG_SCHEMA } from '../src/indexer.mjs';

test('la fixture mantiene la ruta de MAME dentro de su carpeta de datos', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'viciodromo-fixture-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  writeFixture(dir);
  const settings = JSON.parse(await fs.readFile(path.join(dir, 'arcade.json'), 'utf8'));
  assert.equal(settings.exe, path.join(dir, 'MAME', 'mame.exe'));
  const library = JSON.parse(await fs.readFile(path.join(dir, 'library.json'), 'utf8'));
  assert.equal(library.schema, CATALOG_SCHEMA);
  assert.ok(library.games.length > 40);
});
