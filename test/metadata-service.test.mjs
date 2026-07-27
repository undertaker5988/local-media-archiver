import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { metadataToNfo, saveMetadata } from '../src/lib/metadata-service.mjs';

const metadata = {
  code: 'ABP-123',
  title: 'Title & detail',
  releaseDate: '2025-01-01',
  studio: 'Studio',
  actors: ['Actor A'],
  genres: ['Genre A'],
};

test('generates escaped Kodi-compatible NFO XML', () => {
  const nfo = metadataToNfo(metadata);
  assert.match(nfo, /<title>Title &amp; detail<\/title>/);
  assert.match(nfo, /<actor><name>Actor A<\/name><\/actor>/);
  assert.match(nfo, /<uniqueid type="num" default="true">ABP-123<\/uniqueid>/);
});

test('writes NFO and local JSON sidecar without overwriting by default', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-metadata-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await saveMetadata({ folder: root, code: 'ABP-123', metadata });
  assert.equal(JSON.parse(await fs.readFile(result.jsonPath, 'utf8')).code, 'ABP-123');
  await assert.rejects(
    saveMetadata({ folder: root, code: 'ABP-123', metadata }),
    (error) => error.statusCode === 409,
  );
});
