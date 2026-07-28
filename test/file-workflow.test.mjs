import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanLibrary } from '../src/lib/file-scanner.mjs';
import { applyRenameActions, previewRenameActions } from '../src/lib/rename-service.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-archiver-'));
  const folder = path.join(root, 'download-ad-folder');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, '1pondo010123_001 hexjs.com.mp4'), Buffer.alloc(64));
  await fs.writeFile(path.join(folder, '1pondo010123_001 hexjs.com.zh_CN.srt'), 'subtitle');
  await fs.writeFile(path.join(folder, '最新地址.url'), '[InternetShortcut]');
  return { root, folder };
}

test('scans a folder, pairs subtitles, and reports junk', async (t) => {
  const { root } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await scanLibrary(root, { maxDepth: 2 });
  assert.equal(result.summary.videos, 1);
  assert.equal(result.summary.missingSubtitles, 0);
  assert.equal(result.summary.junk, 1);
  assert.deepEqual(result.items[0].cleanedAds, ['hexjs.com']);
  assert.equal(result.items[0].junk[0].name, '最新地址.url');
  assert.equal(result.items[0].suggestedName, '010123_001.mp4');
  assert.equal(result.items[0].subtitles[0].suggestedName, '010123_001.zh-CN.srt');
});

test('previews actor archive targets from local metadata', async (t) => {
  const { root, folder } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(folder, '.media-archive.json'), JSON.stringify({
    code: '010123_001',
    metadata: { actors: ['Actor A'] },
  }));
  const result = await scanLibrary(root, { maxDepth: 2 });
  assert.equal(result.summary.archiveReady, 1);
  assert.equal(result.items[0].archiveRelativePath, path.join('Actor A', '010123_001'));
});

test('does not assign one subtitle to every video in a multi-video folder', async (t) => {
  const { root, folder } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(folder, 'ABP-124.mkv'), Buffer.alloc(64));
  const result = await scanLibrary(root, { maxDepth: 2 });
  assert.equal(result.summary.videos, 2);
  assert.equal(result.summary.missingSubtitles, 1);
  assert.equal(result.items.find((item) => item.code === 'ABP-124').hasSubtitle, false);
});

test('previews and applies a file rename without overwriting', async (t) => {
  const { root, folder } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(folder, '1pondo010123_001 hexjs.com.mp4');
  const actions = [{ source, targetName: '010123_001.mp4', kind: 'file' }];
  const preview = await previewRenameActions(actions);
  assert.equal(preview.valid, true);
  assert.equal(preview.changes, 1);
  const result = await applyRenameActions(actions);
  assert.equal(result.renamed, 1);
  await assert.doesNotReject(fs.access(path.join(folder, '010123_001.mp4')));
  await assert.rejects(fs.access(source));
});

test('rejects invalid names and existing targets', async (t) => {
  const { root, folder } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(folder, '1pondo010123_001 hexjs.com.mp4');
  await fs.writeFile(path.join(folder, 'existing.mp4'), 'occupied');
  const preview = await previewRenameActions([
    { source, targetName: '..\\escape.mp4', kind: 'file' },
    { source, targetName: 'existing.mp4', kind: 'file' },
  ]);
  assert.equal(preview.valid, false);
  assert.match(preview.actions[0].error, /路径|不允许/);
  assert.equal(preview.actions[1].error, '目标名称已存在');
});

test('skips invalid actions while applying the remaining safe changes', async (t) => {
  const { root, folder } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = path.join(folder, '1pondo010123_001 hexjs.com.mp4');
  const missing = path.join(folder, 'missing.mp4');
  const actions = [
    { source: video, targetName: '010123_001.mp4', kind: 'file' },
    { source: missing, targetName: 'MISSING.mp4', kind: 'file' },
  ];

  await assert.rejects(() => applyRenameActions(actions), /未执行任何更改/);
  const result = await applyRenameActions(actions, { skipErrors: true });
  assert.equal(result.renamed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.skippedActions[0].error, '源文件不存在');
  await assert.doesNotReject(fs.access(path.join(folder, '010123_001.mp4')));
});

test('quarantines advertising files without deleting them permanently', async (t) => {
  const { root, folder } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(folder, '最新地址.url');
  const actions = [{ source, kind: 'quarantine' }];
  const preview = await previewRenameActions(actions, { root });
  assert.equal(preview.valid, true);
  assert.equal(preview.actions[0].target, path.join(root, '.media-archiver-trash', 'download-ad-folder', '最新地址.url'));
  await applyRenameActions(actions, { root });
  await assert.doesNotReject(fs.access(preview.actions[0].target));
  await assert.rejects(fs.access(source));
});

test('renames files before moving a movie folder into an actor directory', async (t) => {
  const { root, folder } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(folder, '1pondo010123_001 hexjs.com.mp4');
  const targetFolder = path.join(root, 'Actor A', '010123_001');
  const actions = [
    { source, targetName: '010123_001.mp4', kind: 'file' },
    { source: folder, targetPath: targetFolder, kind: 'directory-move' },
  ];
  const preview = await previewRenameActions(actions, { root });
  assert.equal(preview.valid, true);
  const result = await applyRenameActions(actions, { root });
  assert.equal(result.renamed, 2);
  await assert.doesNotReject(fs.access(path.join(targetFolder, '010123_001.mp4')));
  await assert.rejects(fs.access(folder));
});
