import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanStem, parseMediaName, subtitleLanguageSuffix, suggestedMediaName } from '../src/lib/filename-parser.mjs';

test('normalizes real 1Pondo date IDs and removes advertising domains', () => {
  const cases = new Map([
    ['1pondo010123_001 hexjs.com.mp4', '010123_001.mp4'],
    ['1PONDO-010123-001.mkv', '010123_001.mkv'],
    ['010123_001-1PON.avi', '010123_001.avi'],
  ]);
  for (const [filename, expected] of cases) {
    const parsed = parseMediaName(filename);
    assert.equal(parsed.rule, '1pondo', filename);
    assert.equal(suggestedMediaName(filename, parsed), expected, filename);
  }
  assert.equal(cleanStem('1pondo010123_001 hexjs.com'), '1pondo010123 001');
});

test('leaves guessed short 1Pondo IDs for manual review', () => {
  const filename = '1pondo111-11 hexjs.com.mp4';
  const parsed = parseMediaName(filename);
  assert.equal(parsed.code, '');
  assert.equal(parsed.rule, 'unmatched');
  assert.equal(suggestedMediaName(filename, parsed), filename);
});

test('recognizes common provider and studio code formats', () => {
  const cases = new Map([
    ['FC2PPV-1234567.mp4', 'FC2-PPV-1234567'],
    ['caribbeancom-010123_001.mkv', '010123-001'],
    ['010123-001-CARIB.mp4', '010123-001'],
    ['10musume-010123-01.mp4', '010123_01'],
    ['010123_01-10MU.mp4', '010123_01'],
    ['pacopacomama-010123-001.mp4', '010123_001'],
    ['010123_001.mp4', '010123_001'],
    ['HEYZO_1234.avi', 'HEYZO-1234'],
    ['Tokyo Hot n1234.mp4', 'N1234'],
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
