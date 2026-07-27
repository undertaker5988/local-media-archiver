import fs from 'node:fs/promises';
import path from 'node:path';
import { findAdvertisingMatches, parseMediaName, suggestedFolderName, suggestedMediaName, suggestedSubtitleName } from './filename-parser.mjs';
import { DEFAULT_SETTINGS } from './settings-service.mjs';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.m4v', '.ts', '.webm', '.rmvb']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub']);
const JUNK_EXTENSIONS = new Set(['.url', '.lnk', '.html', '.htm', '.exe', '.bat']);
const MAX_FILES = 10_000;

function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
}

function isInside(directory, parent) {
  const relative = path.relative(parent, directory);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function collectDirectories(root, recursive, maxDepth, excludePaths = []) {
  const directories = [];
  const queue = [{ directory: root, depth: 0 }];
  let seenFiles = 0;
  const excluded = excludePaths.map((entry) => path.resolve(entry));

  while (queue.length) {
    const current = queue.shift();
    if (excluded.some((entry) => isInside(current.directory, entry))) continue;
    let entries;
    try {
      entries = await fs.readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      if (current.depth === 0) throw error;
      continue;
    }
    directories.push({ path: current.directory, entries });
    seenFiles += entries.length;
    if (seenFiles > MAX_FILES) {
      throw new Error(`扫描已超过 ${MAX_FILES} 个目录项，请缩小目录范围`);
    }

    if (!recursive || current.depth >= maxDepth) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return directories;
}

async function readSidecar(directory) {
  const sidecar = path.join(directory, '.media-archive.json');
  try {
    return JSON.parse(await fs.readFile(sidecar, 'utf8'));
  } catch {
    return null;
  }
}

function pairSubtitles(video, subtitles, parsed, naming, metadata, allowSingleFallback) {
  const videoStem = path.basename(video.name, path.extname(video.name)).toLowerCase();
  let matches = subtitles.filter((subtitle) => {
    const subtitleStem = path.basename(subtitle.name, path.extname(subtitle.name)).toLowerCase();
    return subtitleStem === videoStem || subtitleStem.startsWith(`${videoStem}.`) || subtitleStem.startsWith(`${videoStem}-`);
  });
  if (!matches.length && subtitles.length === 1 && allowSingleFallback) matches = subtitles;

  return matches.map((subtitle) => {
    return {
      ...subtitle,
      suggestedName: suggestedSubtitleName(subtitle.name, parsed, naming, metadata),
    };
  });
}

export async function scanLibrary(rootInput, options = {}, settings = DEFAULT_SETTINGS) {
  if (typeof rootInput !== 'string' || !rootInput.trim()) throw new Error('请选择要扫描的目录');
  const root = path.resolve(rootInput.trim());
  const rootStat = await fs.stat(root);
  if (!rootStat.isDirectory()) throw new Error('扫描路径不是目录');

  const recursive = options.recursive ?? settings.scan?.recursive ?? true;
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || settings.scan?.maxDepth || 3, 0), 8);
  const excludePaths = Array.isArray(options.excludePaths) ? options.excludePaths.filter(Boolean) : [];
  const directories = await collectDirectories(root, recursive, maxDepth, excludePaths);
  const items = [];
  let junkCount = 0;

  for (const directory of directories) {
    const files = directory.entries.filter((entry) => entry.isFile());
    const videos = files
      .filter((entry) => VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .sort((a, b) => naturalCompare(a.name, b.name));
    if (!videos.length) continue;

    const subtitles = files
      .filter((entry) => SUBTITLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
      .map((entry) => ({ name: entry.name, path: path.join(directory.path, entry.name) }));
    const junk = files
      .filter((entry) => {
        const extension = path.extname(entry.name).toLowerCase();
        if (VIDEO_EXTENSIONS.has(extension) || SUBTITLE_EXTENSIONS.has(extension)) return false;
        return JUNK_EXTENSIONS.has(extension)
          || /(?:广告|最新地址)/i.test(entry.name)
          || findAdvertisingMatches(entry.name, settings.cleanup?.adKeywords).length > 0;
      })
      .map((entry) => {
        const filePath = path.join(directory.path, entry.name);
        return {
          name: entry.name,
          path: filePath,
          matches: findAdvertisingMatches(entry.name, settings.cleanup?.adKeywords),
        };
      });
    junkCount += junk.length;
    const sidecar = await readSidecar(directory.path);

    for (const video of videos) {
      const filePath = path.join(directory.path, video.name);
      const stat = await fs.stat(filePath);
      const parsed = parseMediaName(video.name, {
        adKeywords: settings.cleanup?.adKeywords,
        corrections: settings.corrections,
      });
      const metadata = sidecar?.code === parsed.code ? sidecar.metadata : null;
      const matchedSubtitles = pairSubtitles(video, subtitles, parsed, settings.naming, metadata, videos.length === 1);
      const suggestedName = suggestedMediaName(video.name, parsed, settings.naming, metadata);
      const folderSuggestedName = suggestedFolderName(path.basename(directory.path), parsed, settings.naming, metadata);
      const actor = metadata?.actors?.[0] ?? '';
      const actorFolderName = actor
        ? suggestedFolderName(actor, parsed, { ...settings.naming, folderTemplate: settings.organization?.actorFolderTemplate ?? '{actor}' }, metadata)
        : '';
      const archiveRelativePath = actorFolderName ? path.join(actorFolderName, folderSuggestedName) : '';
      const needsRename = suggestedName !== video.name;
      const status = !parsed.code ? 'unmatched' : parsed.confidence < 0.9 ? 'review' : 'ready';

      items.push({
        id: Buffer.from(filePath).toString('base64url'),
        folder: directory.path,
        folderName: path.basename(directory.path),
        name: video.name,
        path: filePath,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        code: parsed.code,
        detectedCode: parsed.detectedCode,
        correctionRuleId: parsed.correctionRuleId,
        confidence: parsed.confidence,
        rule: parsed.rule,
        part: parsed.part,
        cleanedStem: parsed.cleanedStem,
        cleanedAds: findAdvertisingMatches(path.basename(video.name, path.extname(video.name)), settings.cleanup?.adKeywords),
        suggestedName,
        folderSuggestedName,
        actorFolderName,
        archiveRelativePath,
        archiveTargetFolder: archiveRelativePath ? path.join(root, archiveRelativePath) : '',
        needsRename,
        subtitles: matchedSubtitles,
        hasSubtitle: matchedSubtitles.length > 0,
        junk,
        status,
        metadata,
      });
    }
  }

  return {
    root,
    scannedAt: new Date().toISOString(),
    items,
    summary: {
      videos: items.length,
      folders: new Set(items.map((item) => item.folder)).size,
      missingSubtitles: items.filter((item) => !item.hasSubtitle).length,
      needsReview: items.filter((item) => item.status !== 'ready').length,
      renameReady: items.filter((item) => item.code && item.needsRename).length,
      junk: junkCount,
      filenameAds: items.filter((item) => item.cleanedAds.length > 0).length,
      archiveReady: new Set(items.filter((item) => item.archiveTargetFolder).map((item) => item.folder)).size,
    },
  };
}

export const mediaExtensions = {
  video: [...VIDEO_EXTENSIONS],
  subtitle: [...SUBTITLE_EXTENSIONS],
};
