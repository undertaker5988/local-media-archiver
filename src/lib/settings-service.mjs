import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const TEMPLATE_TOKENS = ['code', 'part', 'title', 'actor', 'studio', 'year', 'lang', 'ext', 'original'];

export const DEFAULT_SETTINGS = Object.freeze({
  version: 2,
  naming: {
    videoTemplate: '{code}{part}{ext}',
    subtitleTemplate: '{code}{part}{lang}{ext}',
    folderTemplate: '{code}',
    codeCase: 'upper',
  },
  scan: {
    maxDepth: 3,
    recursive: true,
  },
  renaming: {
    renameFolders: false,
  },
  cleanup: {
    adKeywords: ['hexjs', 'hhd800', 'bbs2048', 'thzu', 'sexinsex', 'sis001', 'u9a9', 'fulibus'],
    quarantineJunk: false,
  },
  organization: {
    archiveByActor: false,
    actorFolderTemplate: '{actor}',
  },
  library: {
    sources: [],
    outputDirectory: '',
    fileMode: 'copy',
  },
  corrections: [],
});

function defaults() {
  return structuredClone(DEFAULT_SETTINGS);
}

function validateTemplate(value, field, needsExtension) {
  const template = String(value ?? '').trim();
  if (!template || template.length > 160) throw Object.assign(new Error(`${field}长度应为 1 到 160 个字符`), { statusCode: 400 });
  const unknownTokens = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).filter((token) => !TEMPLATE_TOKENS.includes(token));
  if (unknownTokens.length) throw Object.assign(new Error(`${field}包含未知变量：{${unknownTokens[0]}}`), { statusCode: 400 });
  if (!template.includes('{code}') && !template.includes('{original}')) {
    throw Object.assign(new Error(`${field}至少需要 {code} 或 {original}`), { statusCode: 400 });
  }
  if (needsExtension && !template.includes('{ext}')) throw Object.assign(new Error(`${field}需要保留 {ext}`), { statusCode: 400 });
  return template;
}

function validateActorFolderTemplate(value) {
  const template = String(value ?? '').trim();
  if (!template || template.length > 160) throw Object.assign(new Error('演员目录模板长度应为 1 到 160 个字符'), { statusCode: 400 });
  const unknownTokens = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).filter((token) => !TEMPLATE_TOKENS.includes(token));
  if (unknownTokens.length) throw Object.assign(new Error(`演员目录模板包含未知变量：{${unknownTokens[0]}}`), { statusCode: 400 });
  if (!template.includes('{actor}')) throw Object.assign(new Error('演员目录模板需要包含 {actor}'), { statusCode: 400 });
  return template;
}

function normalizeCorrection(rule, index) {
  const pattern = String(rule?.pattern ?? '').trim();
  const replacement = String(rule?.replacement ?? '').trim();
  if (!pattern || pattern.length > 200) throw Object.assign(new Error(`第 ${index + 1} 条矫正规则的匹配值无效`), { statusCode: 400 });
  if (!replacement || replacement.length > 120) throw Object.assign(new Error(`第 ${index + 1} 条矫正规则的替换值无效`), { statusCode: 400 });
  const isRegex = Boolean(rule?.isRegex);
  if (isRegex) {
    try {
      new RegExp(pattern, 'i');
    } catch {
      throw Object.assign(new Error(`第 ${index + 1} 条矫正规则不是有效正则`), { statusCode: 400 });
    }
  }
  return {
    id: /^[a-z0-9-]{8,80}$/i.test(String(rule?.id ?? '')) ? String(rule.id) : crypto.randomUUID(),
    pattern,
    replacement,
    isRegex,
    enabled: rule?.enabled !== false,
  };
}

function normalizeDirectoryList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? '').trim()).filter(Boolean))].slice(0, 20);
}

export function normalizeSettings(input = {}) {
  const base = defaults();
  const naming = input.naming ?? {};
  const scan = input.scan ?? {};
  const renaming = input.renaming ?? {};
  const cleanup = input.cleanup ?? {};
  const organization = input.organization ?? {};
  const library = input.library ?? {};
  const corrections = Array.isArray(input.corrections) ? input.corrections : [];
  if (corrections.length > 200) throw Object.assign(new Error('矫正规则最多保存 200 条'), { statusCode: 400 });

  return {
    version: 2,
    naming: {
      videoTemplate: validateTemplate(naming.videoTemplate ?? base.naming.videoTemplate, '视频模板', true),
      subtitleTemplate: validateTemplate(naming.subtitleTemplate ?? base.naming.subtitleTemplate, '字幕模板', true),
      folderTemplate: validateTemplate(naming.folderTemplate ?? base.naming.folderTemplate, '文件夹模板', false),
      codeCase: ['upper', 'lower', 'preserve'].includes(naming.codeCase) ? naming.codeCase : base.naming.codeCase,
    },
    scan: {
      maxDepth: Math.min(Math.max(Number(scan.maxDepth) || base.scan.maxDepth, 1), 8),
      recursive: scan.recursive !== false,
    },
    renaming: {
      renameFolders: Boolean(renaming.renameFolders),
    },
    cleanup: {
      adKeywords: Array.isArray(cleanup.adKeywords)
        ? cleanup.adKeywords.map((value) => String(value).trim()).filter(Boolean).slice(0, 100)
        : base.cleanup.adKeywords,
      quarantineJunk: Boolean(cleanup.quarantineJunk),
    },
    organization: {
      archiveByActor: Boolean(organization.archiveByActor),
      actorFolderTemplate: validateActorFolderTemplate(organization.actorFolderTemplate ?? base.organization.actorFolderTemplate),
    },
    library: {
      sources: normalizeDirectoryList(library.sources),
      outputDirectory: String(library.outputDirectory ?? '').trim().slice(0, 1000),
      fileMode: ['copy', 'move', 'hardlink'].includes(library.fileMode) ? library.fileMode : base.library.fileMode,
    },
    corrections: corrections.map(normalizeCorrection),
  };
}

export function settingsFilePath() {
  const dataDirectory = process.env.MEDIA_ARCHIVER_DATA_DIR
    ? path.resolve(process.env.MEDIA_ARCHIVER_DATA_DIR)
    : path.resolve(process.cwd(), '.media-archiver');
  return path.join(dataDirectory, 'settings.json');
}

export async function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(await fs.readFile(settingsFilePath(), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return defaults();
    if (error instanceof SyntaxError) throw Object.assign(new Error('配置文件 JSON 格式无效'), { statusCode: 500 });
    throw error;
  }
}

export async function saveSettings(input) {
  const settings = normalizeSettings(input);
  const filePath = settingsFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { settings, filePath };
}

export function resetSettings() {
  return defaults();
}
