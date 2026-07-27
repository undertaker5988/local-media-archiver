import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanStem, parseMediaName, subtitleLanguageSuffix, suggestedMediaName } from '../src/lib/filename-parser.mjs';

test('removes advertising domains and normalizes a 1Pondo code', () => {
  const filename = '1pondo1111-111 hexjs.com.mp4';
  const parsed = parseMediaName(filename);
  assert.equal(parsed.code, '1PONDO-1111-111');
  assert.equal(parsed.rule, '1pondo');
  assert.equal(suggestedMediaName(filename, parsed), '1PONDO-1111-111.mp4');
  assert.equal(cleanStem('1pondo1111-111 hexjs.com'), '1pondo1111-111');
});

test('recognizes common provider and studio code formats', () => {
  const cases = new Map([
    ['FC2PPV-1234567.mp4', 'FC2-PPV-1234567'],
    ['caribbeancom-010123-001.mkv', 'CARIB-010123-001'],
    ['HEYZO_1234.avi', 'HEYZO-1234'],
    ['[ad] ABP-123 1080p.mkv', 'ABP-123'],
    ['SSIS001.mp4', 'SSIS-001'],
  ]);
  for (const [filename, expected] of cases) assert.equal(parseMediaName(filename).code, expected, filename);
});

test('keeps disc numbers and subtitle languages', () => {
  const parsed = parseMediaName('ABP-123-CD2.mp4');
  assert.equal(parsed.part, 2);
  assert.equal(suggestedMediaName('ABP-123-CD2.mp4', parsed), 'ABP-123-CD2.mp4');
  assert.equal(subtitleLanguageSuffix('ABP-123.zh_CN.srt'), '.zh-CN');
  assert.equal(subtitleLanguageSuffix('ABP-123.CHT.ass'), '.zh-TW');
});

test('leaves unmatched descriptive names for manual review', () => {
  const parsed = parseMediaName('演员名字合集.mp4');
  assert.equal(parsed.code, '');
  assert.equal(parsed.rule, 'unmatched');
  assert.equal(suggestedMediaName('演员名字合集.mp4', parsed), '演员名字合集.mp4');
});
