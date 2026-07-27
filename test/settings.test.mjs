import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMediaName, suggestedMediaName } from '../src/lib/filename-parser.mjs';
import { previewNaming } from '../src/lib/naming-preview.mjs';
import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings } from '../src/lib/settings-service.mjs';

test('renders configured metadata variables into a video name', () => {
  const settings = normalizeSettings({
    naming: {
      videoTemplate: '{actor} - {code}{part}{ext}',
      subtitleTemplate: '{code}{part}{lang}{ext}',
      folderTemplate: '{code}',
      codeCase: 'upper',
    },
  });
  const parsed = parseMediaName('ABP-123-CD2.mkv');
  const target = suggestedMediaName('ABP-123-CD2.mkv', parsed, settings.naming, { actors: ['Actor A'] });
  assert.equal(target, 'Actor A - ABP-123-CD2.mkv');
});

test('previews the actor and movie folder hierarchy', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.organization.actorFolderTemplate = '演员 - {actor}';
  const preview = previewNaming(settings, [{
    kind: 'archive',
    name: 'ABP-123 download folder',
    code: 'ABP-123',
    metadata: { actors: ['Actor A'] },
  }]);
  assert.equal(preview[0].target, path.join('演员 - Actor A', 'ABP-123'));
});

test('applies exact and regular-expression correction rules', () => {
  const exact = parseMediaName('ABP-123.mp4', {
    corrections: [{ id: 'rule-exact', pattern: 'ABP-123', replacement: 'ABP-0123', isRegex: false, enabled: true }],
  });
  assert.equal(exact.detectedCode, 'ABP-123');
  assert.equal(exact.code, 'ABP-0123');
  assert.equal(exact.correctionRuleId, 'rule-exact');

  const regex = parseMediaName('ABP-123.mp4', {
    corrections: [{ id: 'rule-regex', pattern: '^ABP-(\\d+)$', replacement: 'ABP-0$1', isRegex: true, enabled: true }],
  });
  assert.equal(regex.code, 'ABP-0123');
});

test('uses draft correction rules in current-batch naming preview', () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.corrections = [{ id: 'rule-preview', pattern: 'ABP-123', replacement: 'ABP-0123', isRegex: false, enabled: true }];
  const [entry] = previewNaming(settings, [{ kind: 'video', name: 'ABP-123 hhd800.com.mp4', code: 'ABP-123' }]);
  assert.equal(entry.code, 'ABP-0123');
  assert.equal(entry.target, 'ABP-0123.mp4');
});

test('rejects unsafe templates before saving', () => {
  assert.throws(
    () => normalizeSettings({ naming: { videoTemplate: '{code}', subtitleTemplate: '{code}{ext}', folderTemplate: '{code}' } }),
    /需要保留 \{ext\}/,
  );
  assert.throws(
    () => normalizeSettings({ naming: { videoTemplate: '{code}{unknown}{ext}', subtitleTemplate: '{code}{ext}', folderTemplate: '{code}' } }),
    /未知变量/,
  );
  assert.throws(
    () => normalizeSettings({ organization: { actorFolderTemplate: '{code}' } }),
    /\{actor\}/,
  );
});

test('persists normalized settings in the configured data directory', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-settings-'));
  const previous = process.env.MEDIA_ARCHIVER_DATA_DIR;
  process.env.MEDIA_ARCHIVER_DATA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.MEDIA_ARCHIVER_DATA_DIR;
    else process.env.MEDIA_ARCHIVER_DATA_DIR = previous;
    await fs.rm(directory, { recursive: true, force: true });
  });

  const input = structuredClone(DEFAULT_SETTINGS);
  input.naming.videoTemplate = '{studio} - {code}{ext}';
  input.library.sources = ['D:\\Downloads\\A', 'D:\\Downloads\\B'];
  input.library.outputDirectory = 'D:\\Media\\整理完成';
  input.library.fileMode = 'hardlink';
  await saveSettings(input);
  const loaded = await loadSettings();
  assert.equal(loaded.naming.videoTemplate, '{studio} - {code}{ext}');
  assert.deepEqual(loaded.library.sources, input.library.sources);
  assert.equal(loaded.library.outputDirectory, input.library.outputDirectory);
  assert.equal(loaded.library.fileMode, 'hardlink');
});
