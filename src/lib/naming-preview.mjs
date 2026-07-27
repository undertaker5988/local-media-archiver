import path from 'node:path';
import { parseMediaName, suggestedFolderName, suggestedMediaName, suggestedSubtitleName } from './filename-parser.mjs';
import { normalizeSettings } from './settings-service.mjs';

const DEFAULT_SAMPLES = [
  { kind: 'video', name: '1pondo1111-111 hexjs.com.mp4', metadata: { title: 'Sample title', actors: ['Actor A'], studio: 'Studio A', releaseDate: '2025-06-01' } },
  { kind: 'video', name: 'ABP-123-CD2.mkv', metadata: { title: 'Sample title', actors: ['Actor A'], studio: 'Studio A', releaseDate: '2025-06-01' } },
  { kind: 'subtitle', name: 'ABP-123.zh_CN.srt' },
  { kind: 'folder', name: 'ABP-123 download folder', code: 'ABP-123' },
  { kind: 'archive', name: 'ABP-123 download folder', code: 'ABP-123', metadata: { actors: ['Actor A'] } },
];

function applyPreviewCorrection(code, corrections) {
  for (const rule of corrections) {
    if (!rule.enabled) continue;
    if (rule.isRegex) {
      const expression = new RegExp(rule.pattern, 'i');
      if (expression.test(code)) return code.replace(expression, rule.replacement).trim();
    } else if (code.localeCompare(rule.pattern, undefined, { sensitivity: 'accent' }) === 0) {
      return rule.replacement;
    }
  }
  return code;
}

export function previewNaming(inputSettings, inputSamples = []) {
  const settings = normalizeSettings(inputSettings);
  const samples = Array.isArray(inputSamples) && inputSamples.length ? inputSamples.slice(0, 40) : DEFAULT_SAMPLES;
  return samples.map((sample) => {
    const name = String(sample.name ?? '');
    const parsed = sample.code
      ? {
          code: applyPreviewCorrection(String(sample.code), settings.corrections),
          detectedCode: String(sample.detectedCode ?? sample.code),
          part: Number(sample.part) || null,
          extension: path.extname(name).toLowerCase(),
          cleanedStem: path.basename(name, path.extname(name)),
        }
      : parseMediaName(name, { adKeywords: settings.cleanup.adKeywords, corrections: settings.corrections });
    let target;
    if (sample.kind === 'subtitle') target = suggestedSubtitleName(name, parsed, settings.naming, sample.metadata);
    else if (sample.kind === 'folder') target = suggestedFolderName(name, parsed, settings.naming, sample.metadata);
    else if (sample.kind === 'archive') {
      const actor = sample.metadata?.actors?.[0];
      target = actor
        ? path.join(
            suggestedFolderName(actor, parsed, { ...settings.naming, folderTemplate: settings.organization.actorFolderTemplate }, sample.metadata),
            suggestedFolderName(name, parsed, settings.naming, sample.metadata),
          )
        : '等待演员资料';
    }
    else target = suggestedMediaName(name, parsed, settings.naming, sample.metadata);
    return { kind: sample.kind || 'video', source: name, target, code: parsed.code };
  });
}
