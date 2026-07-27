/**
 * 片库应用服务（可类比 Java 的 @Service）。它分成三个阶段：indexLibrary 建索引，
 * previewCollection 生成不可直接执行的计划，applyCollection 再校验并执行计划。
 * 这种两阶段设计保证 UI 一定能先展示复制/移动/硬链接的完整影响范围。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { scanLibrary } from './file-scanner.mjs';
import { subtitleLanguageSuffix } from './filename-parser.mjs';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const assetRegistry = new Map();

function apiError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function isInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function safeSegment(value, fallback) {
  const result = String(value ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return result || fallback;
}

function normalizeMode(value) {
  return ['copy', 'move', 'hardlink'].includes(value) ? value : 'copy';
}

// API 边界先把用户路径规范化为绝对路径，后续所有安全判断都基于同一表示形式。
async function normalizeLocations(sourceInput, outputInput) {
  const rawSources = Array.isArray(sourceInput) ? sourceInput : [];
  const sources = [...new Set(rawSources.map((entry) => path.resolve(String(entry ?? '').trim())).filter(Boolean))];
  if (!sources.length) throw apiError('请至少选择一个片库来源目录');
  if (sources.length > 20) throw apiError('来源目录最多选择 20 个');
  for (const source of sources) {
    let stat;
    try {
      stat = await fs.stat(source);
    } catch (error) {
      if (error.code === 'ENOENT') throw apiError(`来源目录不存在：${source}`);
      throw error;
    }
    if (!stat.isDirectory()) throw apiError(`来源路径不是目录：${source}`);
  }
  const outputDirectory = outputInput
    ? path.resolve(String(outputInput).trim())
    : path.join(sources[0], '整理完成');
  if (sources.some((source) => path.resolve(source) === outputDirectory)) {
    throw apiError('输出目录不能与来源目录完全相同，请选择其下的子目录或其他目录');
  }
  return { sources, outputDirectory };
}

// 流式计算 SHA-256，固定使用 1 MiB 缓冲区，避免大视频一次性读入内存。
async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function registerAsset(filePath) {
  if (!filePath) return '';
  const id = crypto.createHash('sha256').update(filePath).digest('base64url').slice(0, 32);
  assetRegistry.set(id, filePath);
  return `/api/library/asset?id=${encodeURIComponent(id)}`;
}

async function discoverFolderFiles(folder, code) {
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return { posterPath: '', companionFiles: [] };
  }
  const files = entries.filter((entry) => entry.isFile()).map((entry) => ({
    name: entry.name,
    path: path.join(folder, entry.name),
    extension: path.extname(entry.name).toLowerCase(),
  }));
  const images = files.filter((entry) => IMAGE_EXTENSIONS.has(entry.extension));
  const normalizedCode = code.toLowerCase();
  images.sort((left, right) => {
    const score = (entry) => {
      const name = entry.name.toLowerCase();
      if (name.startsWith(`${normalizedCode}-poster`)) return 0;
      if (/^(poster|cover|folder)\./i.test(name)) return 1;
      if (name.includes('poster') || name.includes('cover')) return 2;
      return 3;
    };
    return score(left) - score(right) || left.name.localeCompare(right.name, 'zh-CN', { numeric: true });
  });
  const jsonSidecar = files.find((entry) => entry.name === '.media-archive.json');
  const nfoSidecar = files.find((entry) => entry.name.toLowerCase() === `${normalizedCode}.nfo`)
    ?? files.find((entry) => entry.extension === '.nfo');
  const sidecars = [jsonSidecar, nfoSidecar].filter(Boolean);
  const posterPath = images[0]?.path ?? '';
  return {
    posterPath,
    companionFiles: [...sidecars, ...(posterPath ? [images[0]] : [])].map(({ name, path: filePath, extension }) => ({ name, path: filePath, extension })),
  };
}

function groupBy(values, key) {
  const result = new Map();
  for (const value of values) {
    const groupKey = key(value);
    if (!result.has(groupKey)) result.set(groupKey, []);
    result.get(groupKey).push(value);
  }
  return result;
}

/**
 * 聚合多个来源目录。先按番号分组，再只对“同番号且同大小”的候选计算 SHA-256，
 * 以减少扫描大型片库时不必要的磁盘读取。
 */
export async function indexLibrary(input = {}, settings = {}) {
  const requestedSources = input.sourceDirectories ?? settings.library?.sources;
  const requestedOutput = input.outputDirectory ?? settings.library?.outputDirectory;
  const { sources, outputDirectory } = await normalizeLocations(requestedSources, requestedOutput);
  const logs = [];
  const allItems = [];
  const seenPaths = new Set();
  let unmatchedFiles = 0;
  assetRegistry.clear();

  for (const source of sources) {
    logs.push(`扫描来源：${source}`);
    const result = await scanLibrary(source, {
      recursive: true,
      maxDepth: input.maxDepth ?? settings.scan?.maxDepth ?? 3,
      excludePaths: [outputDirectory],
    }, settings);
    for (const item of result.items.filter((entry) => entry.code)) {
      const key = item.path.toLowerCase();
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      allItems.push(item);
    }
    unmatchedFiles += result.items.filter((item) => !item.code).length;
    logs.push(`发现 ${result.summary.videos} 个视频，已识别 ${result.items.filter((item) => item.code).length} 个`);
  }

  const movies = [];
  const codeGroups = groupBy(allItems, (item) => item.code.toUpperCase());
  for (const [code, group] of codeGroups) {
    const candidateScore = (item) => {
      const extension = path.extname(item.name);
      const stem = path.basename(item.name, extension).toUpperCase();
      const expected = `${code}${item.part ? `-CD${item.part}` : ''}`;
      if (stem === expected) return 0;
      if (stem.startsWith(`${expected}-`) || stem.startsWith(`${expected}_`)) return 1;
      return 2;
    };
    group.sort((left, right) => candidateScore(left) - candidateScore(right)
      || left.name.length - right.name.length
      || left.path.localeCompare(right.path, 'zh-CN', { numeric: true }));
    // 大小不同必然不是同一内容；大小相同才进入成本更高的哈希阶段。
    const sizeGroups = groupBy(group, (item) => item.size);
    for (const sameSize of sizeGroups.values()) {
      if (sameSize.length < 2) continue;
      logs.push(`校验 ${code} 的 ${sameSize.length} 个同大小候选`);
      for (const item of sameSize) item.contentHash = await hashFile(item.path);
    }

    // 每个哈希保留首个文件为主版本，其余只标记 duplicateOf，不在索引阶段删除。
    const firstByHash = new Map();
    for (const item of group) {
      item.duplicateOf = '';
      if (!item.contentHash) continue;
      if (firstByHash.has(item.contentHash)) item.duplicateOf = firstByHash.get(item.contentHash);
      else firstByHash.set(item.contentHash, item.id);
    }

    const metadataItem = group.find((item) => item.metadata) ?? group[0];
    const folderDetails = await discoverFolderFiles(metadataItem.folder, code);
    const duplicateBuckets = groupBy(group.filter((item) => item.contentHash), (item) => item.contentHash);
    const duplicateGroups = [...duplicateBuckets.values()].filter((items) => items.length > 1);
    const metadata = metadataItem.metadata ?? null;
    const movie = {
      id: Buffer.from(code).toString('base64url'),
      code,
      title: metadata?.title || code,
      actors: metadata?.actors ?? [],
      studio: metadata?.studio ?? '',
      releaseDate: metadata?.releaseDate ?? '',
      metadata,
      posterUrl: folderDetails.posterPath ? registerAsset(folderDetails.posterPath) : (metadata?.coverUrl ?? ''),
      posterPath: folderDetails.posterPath,
      companionFiles: folderDetails.companionFiles,
      files: group.map((item) => ({
        id: item.id,
        name: item.name,
        path: item.path,
        folder: item.folder,
        size: item.size,
        part: item.part,
        contentHash: item.contentHash ?? '',
        duplicateOf: item.duplicateOf,
        subtitles: item.subtitles,
      })),
      variants: group.filter((item) => !item.duplicateOf).length,
      duplicateFiles: duplicateGroups.reduce((total, items) => total + items.length - 1, 0),
      hasMetadata: Boolean(metadata),
    };
    movies.push(movie);
  }
  movies.sort((left, right) => left.code.localeCompare(right.code, 'zh-CN', { numeric: true }));

  const summary = {
    movies: movies.length,
    files: allItems.length,
    duplicateGroups: movies.filter((movie) => movie.duplicateFiles > 0).length,
    duplicateFiles: movies.reduce((total, movie) => total + movie.duplicateFiles, 0),
    missingMetadata: movies.filter((movie) => !movie.hasMetadata).length,
    missingActors: movies.filter((movie) => !movie.actors.length).length,
    unmatchedFiles,
  };
  logs.push(`索引完成：${summary.movies} 部影片，${summary.duplicateFiles} 个完全重复文件`);
  return { sources, outputDirectory, movies, summary, logs };
}

function modeLabel(mode) {
  return { copy: '复制', move: '移动', hardlink: '硬链接' }[mode];
}

function sameVolume(left, right) {
  if (process.platform !== 'win32') return true;
  return path.parse(left).root.toLowerCase() === path.parse(right).root.toLowerCase();
}

async function pathExists(filePath) {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function identicalFiles(left, right, knownHash = '') {
  const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)]);
  if (leftStat.size !== rightStat.size) return false;
  const leftHash = knownHash || await hashFile(left);
  return leftHash === await hashFile(right);
}

function withVariant(stem, variant) {
  return variant > 1 ? `${stem}-V${variant}` : stem;
}

async function chooseVideoTarget(directory, stem, extension, source, knownHash, reservations, startVariant = 1) {
  let variant = startVariant;
  while (variant < 1000) {
    const target = path.join(directory, `${withVariant(stem, variant)}${extension}`);
    const key = target.toLowerCase();
    if (reservations.has(key)) {
      variant += 1;
      continue;
    }
    const existing = await pathExists(target);
    if (!existing) {
      reservations.add(key);
      return { target, variant, duplicateExisting: false };
    }
    if (existing.isFile() && await identicalFiles(source, target, knownHash)) {
      return { target, variant, duplicateExisting: true };
    }
    variant += 1;
  }
  throw apiError(`无法为 ${path.basename(source)} 分配可用目标名称`);
}

/**
 * 生成归集计划，不改动文件。每个 action 都带 ready/duplicate/error 状态，
 * 因而调用方可以跳过错误和重复项，只执行明确安全的 ready 项。
 */
export async function previewCollection(input = {}, settings = {}) {
  const mode = normalizeMode(input.fileMode ?? settings.library?.fileMode);
  const indexed = await indexLibrary(input, settings);
  const selected = new Set(Array.isArray(input.movieIds) ? input.movieIds : []);
  const movies = selected.size ? indexed.movies.filter((movie) => selected.has(movie.id)) : indexed.movies;
  if (!movies.length) throw apiError('没有选择可归集的影片');
  const actions = [];
  const reservations = new Set();

  for (const movie of movies) {
    const actor = safeSegment(movie.actors[0], '待补演员');
    const code = safeSegment(movie.code, '待识别');
    const targetDirectory = path.join(indexed.outputDirectory, actor, code);
    const nextVariantByPart = new Map();
    const keptVideoTargets = new Map();

    for (const file of movie.files) {
      if (file.duplicateOf) {
        actions.push({
          movieId: movie.id, code, kind: 'video', operation: mode, source: file.path, target: '',
          status: 'duplicate', reason: '与同番号文件内容完全一致，保留源文件但不重复归集', size: file.size,
        });
        continue;
      }
      const partStem = file.part ? `${code}-CD${file.part}` : code;
      const nextVariant = nextVariantByPart.get(partStem) ?? 1;
      const extension = path.extname(file.name).toLowerCase();
      const targetResult = await chooseVideoTarget(targetDirectory, partStem, extension, file.path, file.contentHash, reservations, nextVariant);
      nextVariantByPart.set(partStem, targetResult.variant + 1);
      const hardlinkError = mode === 'hardlink' && !sameVolume(file.path, targetResult.target)
        ? '硬链接只能在同一个磁盘卷内创建'
        : '';
      const action = {
        movieId: movie.id, code, kind: 'video', operation: mode, source: file.path, target: targetResult.target,
        status: hardlinkError ? 'error' : (targetResult.duplicateExisting ? 'duplicate' : 'ready'),
        reason: hardlinkError || (targetResult.duplicateExisting ? '输出目录已有内容相同的文件' : ''), size: file.size,
      };
      actions.push(action);
      if (action.status === 'ready') keptVideoTargets.set(file.id, path.basename(targetResult.target, extension));

      if (action.status !== 'ready') continue;
      for (const subtitle of file.subtitles ?? []) {
        const subtitleExtension = path.extname(subtitle.name).toLowerCase();
        const language = subtitleLanguageSuffix(subtitle.name);
        const subtitleTarget = path.join(targetDirectory, `${keptVideoTargets.get(file.id)}${language}${subtitleExtension}`);
        const exists = await pathExists(subtitleTarget);
        const subtitleHardlinkError = mode === 'hardlink' && !sameVolume(subtitle.path, subtitleTarget)
          ? '硬链接只能在同一个磁盘卷内创建'
          : '';
        actions.push({
          movieId: movie.id, code, kind: 'subtitle', operation: mode, source: subtitle.path, target: subtitleTarget,
          status: subtitleHardlinkError ? 'error' : (exists ? 'error' : 'ready'),
          reason: subtitleHardlinkError || (exists ? '目标字幕已存在' : ''), size: 0,
        });
        reservations.add(subtitleTarget.toLowerCase());
      }
    }

    for (const companion of movie.companionFiles) {
      const extension = companion.extension;
      const targetName = companion.name === '.media-archive.json'
        ? companion.name
        : extension === '.nfo'
          ? `${code}.nfo`
          : `${code}-poster${extension}`;
      const target = path.join(targetDirectory, targetName);
      const exists = await pathExists(target);
      const hardlinkError = mode === 'hardlink' && !sameVolume(companion.path, target)
        ? '硬链接只能在同一个磁盘卷内创建'
        : '';
      actions.push({
        movieId: movie.id, code, kind: 'companion', operation: mode, source: companion.path, target,
        status: hardlinkError ? 'error' : (exists ? 'error' : 'ready'),
        reason: hardlinkError || (exists ? '目标资料文件已存在' : ''), size: 0,
      });
      reservations.add(target.toLowerCase());
    }
  }

  const summary = {
    movies: movies.length,
    ready: actions.filter((action) => action.status === 'ready').length,
    duplicates: actions.filter((action) => action.status === 'duplicate').length,
    errors: actions.filter((action) => action.status === 'error').length,
  };
  return {
    sourceDirectories: indexed.sources,
    outputDirectory: indexed.outputDirectory,
    fileMode: mode,
    fileModeLabel: modeLabel(mode),
    actions,
    summary,
    logs: [...indexed.logs, `归集预览：${summary.ready} 项可${modeLabel(mode)}，${summary.duplicates} 项重复跳过，${summary.errors} 项错误`],
  };
}

/**
 * 执行预览计划。即使 action 来自本应用，也按不可信 DTO 重新验证源/目标边界，
 * 防止调用者篡改路径后越过来源目录或输出目录。
 */
export async function applyCollection(input = {}) {
  const mode = normalizeMode(input.fileMode);
  const { sources, outputDirectory } = await normalizeLocations(input.sourceDirectories, input.outputDirectory);
  const requested = Array.isArray(input.actions) ? input.actions.filter((action) => action.status === 'ready') : [];
  if (!requested.length) throw apiError('没有可执行的归集项目');
  const results = [];

  for (const action of requested) {
    const source = path.resolve(String(action.source ?? ''));
    const target = path.resolve(String(action.target ?? ''));
    let error = '';
    if (!sources.some((root) => isInside(source, root)) || isInside(source, outputDirectory)) error = '源文件不在允许的来源目录内';
    if (!isInside(target, outputDirectory) || target === outputDirectory) error = '目标文件不在输出目录内';
    if (mode === 'hardlink' && !sameVolume(source, target)) error = '硬链接只能在同一个磁盘卷内创建';
    try {
      if (error) throw new Error(error);
      const sourceStat = await fs.stat(source);
      if (!sourceStat.isFile()) throw new Error('源路径不是文件');
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (await pathExists(target)) throw new Error('目标文件已存在');
      if (mode === 'copy') await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
      else if (mode === 'hardlink') await fs.link(source, target);
      else {
        try {
          await fs.rename(source, target);
        } catch (moveError) {
          if (moveError.code !== 'EXDEV') throw moveError;
          // Java NIO 的跨 FileStore move 也可能失败；跨卷时先独占复制，成功后再删源。
          await fs.copyFile(source, target, fsConstants.COPYFILE_EXCL);
          await fs.unlink(source);
        }
      }
      results.push({ ...action, source, target, status: 'done', message: `${modeLabel(mode)}完成` });
    } catch (actionError) {
      results.push({ ...action, source, target, status: 'error', message: actionError.message });
    }
  }

  const completed = results.filter((result) => result.status === 'done').length;
  return {
    completed,
    failed: results.length - completed,
    results,
    outputDirectory,
    fileMode: mode,
  };
}

export async function getLibraryAsset(id) {
  const filePath = assetRegistry.get(String(id ?? ''));
  if (!filePath) throw apiError('海报资源不存在或索引已刷新', 404);
  const extension = path.extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw apiError('不支持的海报格式', 415);
  const data = await fs.readFile(filePath);
  const contentType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
  return { data, contentType };
}
