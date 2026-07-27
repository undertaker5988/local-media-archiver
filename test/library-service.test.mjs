import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyCollection, getLibraryAsset, indexLibrary, previewCollection } from '../src/lib/library-service.mjs';
import { DEFAULT_SETTINGS } from '../src/lib/settings-service.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-library-'));
  const sourceA = path.join(root, 'source-a');
  const sourceB = path.join(root, 'source-b');
  await fs.mkdir(path.join(sourceA, 'ABP-123'), { recursive: true });
  await fs.mkdir(path.join(sourceB, 'downloads'), { recursive: true });
  const content = Buffer.from('same-video-content');
  await fs.writeFile(path.join(sourceA, 'ABP-123', 'ABP-123.mp4'), content);
  await fs.writeFile(path.join(sourceB, 'downloads', 'ABP-123-FHP.mp4'), content);
  await fs.writeFile(path.join(sourceB, 'downloads', 'ABP-123-alt.mp4'), Buffer.from('diff-video-content'));
  await fs.writeFile(path.join(sourceA, 'ABP-123', 'ABP-123.zh-CN.srt'), 'subtitle');
  await fs.writeFile(path.join(sourceA, 'ABP-123', 'ABP-123-poster.jpg'), 'fake-jpeg-poster');
  await fs.writeFile(path.join(sourceA, 'ABP-123', '.media-archive.json'), JSON.stringify({
    code: 'ABP-123',
    metadata: { title: '测试影片', actors: ['演员甲'], studio: '测试片商' },
  }));
  return { root, sourceA, sourceB, output: path.join(root, 'output') };
}

test('indexes multiple sources and groups exact duplicates by code and SHA-256', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const result = await indexLibrary({ sourceDirectories: [data.sourceA, data.sourceB], outputDirectory: data.output }, DEFAULT_SETTINGS);
  assert.equal(result.summary.movies, 1);
  assert.equal(result.summary.files, 3);
  assert.equal(result.summary.duplicateGroups, 1);
  assert.equal(result.summary.duplicateFiles, 1);
  assert.equal(result.movies[0].variants, 2);
  assert.deepEqual(result.movies[0].actors, ['演员甲']);
  assert.equal(result.movies[0].files.find((file) => file.name === 'ABP-123-alt.mp4').duplicateOf, '');
  const assetId = new URL(result.movies[0].posterUrl, 'http://localhost').searchParams.get('id');
  const asset = await getLibraryAsset(assetId);
  assert.equal(asset.contentType, 'image/jpeg');
  assert.equal(asset.data.toString(), 'fake-jpeg-poster');
});

test('defaults output under the first source and excludes it from future indexes', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const first = await indexLibrary({ sourceDirectories: [data.sourceA] }, DEFAULT_SETTINGS);
  assert.equal(first.outputDirectory, path.join(data.sourceA, '整理完成'));
  await fs.mkdir(path.join(first.outputDirectory, '演员甲', 'ABP-123'), { recursive: true });
  await fs.writeFile(path.join(first.outputDirectory, '演员甲', 'ABP-123', 'ABP-123.mp4'), 'output-copy');
  const second = await indexLibrary({ sourceDirectories: [data.sourceA] }, DEFAULT_SETTINGS);
  assert.equal(second.summary.files, 1);
});

test('previews duplicate skips and applies only ready copy actions', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const preview = await previewCollection({
    sourceDirectories: [data.sourceA, data.sourceB],
    outputDirectory: data.output,
    fileMode: 'copy',
  }, DEFAULT_SETTINGS);
  assert.equal(preview.summary.duplicates, 1);
  assert.equal(path.basename(preview.actions.find((action) => action.status === 'duplicate').source), 'ABP-123-FHP.mp4');
  assert.ok(preview.summary.ready >= 3);
  const result = await applyCollection(preview);
  assert.equal(result.failed, 0);
  assert.equal(result.completed, preview.summary.ready);
  await assert.doesNotReject(fs.access(path.join(data.output, '演员甲', 'ABP-123', 'ABP-123.mp4')));
  await assert.doesNotReject(fs.access(path.join(data.output, '演员甲', 'ABP-123', 'ABP-123-V2.mp4')));
  await assert.doesNotReject(fs.access(path.join(data.sourceA, 'ABP-123', 'ABP-123.mp4')));
});

test('rejects a hard-link preview across Windows volumes', async (t) => {
  if (process.platform !== 'win32') return;
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const otherRoot = path.parse(data.root).root.toUpperCase() === 'C:\\' ? 'D:\\archive-output' : 'C:\\archive-output';
  const preview = await previewCollection({
    sourceDirectories: [data.sourceA],
    outputDirectory: otherRoot,
    fileMode: 'hardlink',
  }, DEFAULT_SETTINGS);
  assert.ok(preview.actions.some((action) => action.status === 'error' && /同一个磁盘卷/.test(action.reason)));
});

test('creates hard links on the same volume while retaining source files', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const preview = await previewCollection({
    sourceDirectories: [data.sourceA],
    outputDirectory: data.output,
    fileMode: 'hardlink',
  }, DEFAULT_SETTINGS);
  const result = await applyCollection(preview);
  assert.equal(result.failed, 0);
  const source = path.join(data.sourceA, 'ABP-123', 'ABP-123.mp4');
  const target = path.join(data.output, '演员甲', 'ABP-123', 'ABP-123.mp4');
  const [sourceStat, targetStat] = await Promise.all([fs.stat(source), fs.stat(target)]);
  assert.equal(sourceStat.ino, targetStat.ino);
  assert.ok(sourceStat.nlink >= 2);
});

test('moves ready files but leaves duplicate sources untouched', async (t) => {
  const data = await fixture();
  t.after(() => fs.rm(data.root, { recursive: true, force: true }));
  const cleanSource = path.join(data.sourceA, 'ABP-123', 'ABP-123.mp4');
  const duplicateSource = path.join(data.sourceB, 'downloads', 'ABP-123-FHP.mp4');
  const preview = await previewCollection({
    sourceDirectories: [data.sourceA, data.sourceB],
    outputDirectory: data.output,
    fileMode: 'move',
  }, DEFAULT_SETTINGS);
  const result = await applyCollection(preview);
  assert.equal(result.failed, 0);
  await assert.rejects(fs.access(cleanSource));
  await assert.doesNotReject(fs.access(duplicateSource));
  await assert.doesNotReject(fs.access(path.join(data.output, '演员甲', 'ABP-123', 'ABP-123.mp4')));
});
