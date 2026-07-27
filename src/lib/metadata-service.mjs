import fs from 'node:fs/promises';
import path from 'node:path';

function xmlEscape(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function metadataToNfo(metadata) {
  const genres = (metadata.genres ?? []).map((genre) => `  <genre>${xmlEscape(genre)}</genre>`).join('\n');
  const actors = (metadata.actors ?? []).map((actor) => `  <actor><name>${xmlEscape(actor)}</name></actor>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<movie>
  <title>${xmlEscape(metadata.title)}</title>
  <originaltitle>${xmlEscape(metadata.originalTitle || metadata.title)}</originaltitle>
  <id>${xmlEscape(metadata.code)}</id>
  <uniqueid type="num" default="true">${xmlEscape(metadata.code)}</uniqueid>
  <premiered>${xmlEscape(metadata.releaseDate)}</premiered>
  <runtime>${xmlEscape(metadata.runtime ?? '')}</runtime>
  <director>${xmlEscape(metadata.director)}</director>
  <studio>${xmlEscape(metadata.studio)}</studio>
  <set>${xmlEscape(metadata.series)}</set>
${genres}
${actors}
</movie>
`;
}

async function writeChecked(filePath, content, overwrite) {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      error.statusCode = 409;
      error.message = `资料文件已存在：${path.basename(filePath)}`;
    }
    throw error;
  }
}

export async function saveMetadata({ folder, code, metadata, overwrite = false, downloadCover = false }) {
  const resolvedFolder = path.resolve(String(folder ?? ''));
  const stat = await fs.stat(resolvedFolder);
  if (!stat.isDirectory()) throw new Error('元数据目标不是目录');
  if (!/^[a-z0-9-]{3,40}$/i.test(code)) throw new Error('番号格式无效');
  if (!metadata || typeof metadata !== 'object') throw new Error('没有可保存的影片信息');

  const normalized = {
    code,
    title: String(metadata.title ?? ''),
    originalTitle: String(metadata.originalTitle ?? metadata.title ?? ''),
    releaseDate: String(metadata.releaseDate ?? ''),
    runtime: Number(metadata.runtime) || null,
    director: String(metadata.director ?? ''),
    studio: String(metadata.studio ?? ''),
    publisher: String(metadata.publisher ?? ''),
    series: String(metadata.series ?? ''),
    actors: Array.isArray(metadata.actors) ? metadata.actors.map(String).filter(Boolean) : [],
    genres: Array.isArray(metadata.genres) ? metadata.genres.map(String).filter(Boolean) : [],
    coverUrl: String(metadata.coverUrl ?? ''),
    sourceUrl: String(metadata.sourceUrl ?? ''),
    savedAt: new Date().toISOString(),
  };

  const nfoPath = path.join(resolvedFolder, `${code}.nfo`);
  const jsonPath = path.join(resolvedFolder, '.media-archive.json');
  await writeChecked(nfoPath, metadataToNfo(normalized), overwrite);
  try {
    await writeChecked(jsonPath, JSON.stringify({ version: 1, code, metadata: normalized }, null, 2), overwrite);
  } catch (error) {
    if (!overwrite) await fs.rm(nfoPath, { force: true });
    throw error;
  }

  let coverPath = '';
  let coverError = '';
  if (downloadCover && /^https?:\/\//i.test(normalized.coverUrl)) {
    try {
      const response = await fetch(normalized.coverUrl, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      const extension = contentType.includes('png') ? '.png' : '.jpg';
      coverPath = path.join(resolvedFolder, `${code}-poster${extension}`);
      await fs.writeFile(coverPath, Buffer.from(await response.arrayBuffer()), { flag: overwrite ? 'w' : 'wx' });
    } catch (error) {
      coverError = `封面下载失败：${error.message}`;
    }
  }

  return { nfoPath, jsonPath, coverPath, coverError, metadata: normalized };
}
