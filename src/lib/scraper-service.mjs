/**
 * 多刮削源应用服务。
 * Java 类比：source 是配置 DTO，ADAPTERS 是 Strategy 注册表，scrapeMetadata 负责故障转移编排。
 */
import { parseJavBusHtml } from './scrapers/javbus.mjs';

const CODE_PATTERN = /^[a-z0-9_-]{3,40}$/i;

function decodeEntities(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(value = '') {
  return decodeEntities(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function meta(html, property) {
  const escaped = escapeRegExp(property);
  const forward = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i');
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i');
  return decodeEntities(html.match(forward)?.[1] ?? html.match(reverse)?.[1] ?? '');
}

function first(html, pattern) {
  return stripTags(html.match(pattern)?.[1] ?? '');
}

function blockById(html, id) {
  const escaped = escapeRegExp(id);
  return html.match(new RegExp(`<([a-z0-9]+)[^>]*id=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i'))?.[2] ?? '';
}

function links(block = '') {
  return [...block.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => stripTags(match[1]))
    .filter(Boolean);
}

function valueAfterLabel(html, labels) {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const pattern = new RegExp(`${escaped}\\s*:?\\s*<\\/[^>]+>([\\s\\S]{0,500}?)(?:<\\/(?:p|div|td|tr)>|<br\\s*\\/?>)`, 'i');
    const value = first(html, pattern);
    if (value) return value;
  }
  return '';
}

function linksAfterLabel(html, labels) {
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const block = html.match(new RegExp(`${escaped}\\s*:?\\s*<\\/[^>]+>([\\s\\S]{0,900}?)(?:<\\/(?:p|div|td|tr)>)`, 'i'))?.[1] ?? '';
    const values = links(block);
    if (values.length) return values;
  }
  return [];
}

function absoluteUrl(value, sourceUrl) {
  if (!value) return '';
  try {
    return new URL(value.startsWith('//') ? `https:${value}` : value, sourceUrl).href;
  } catch {
    return '';
  }
}

function cleanTitle(rawTitle, code, siteNames = []) {
  let title = String(rawTitle ?? '').trim();
  title = title.replace(new RegExp(`^\\s*${escapeRegExp(code)}\\s*[-_:|]?\\s*`, 'i'), '');
  for (const siteName of siteNames) title = title.replace(new RegExp(`\\s*[-|]\\s*${escapeRegExp(siteName)}.*$`, 'i'), '');
  return title.trim();
}

function metadataResult(code, sourceUrl, values = {}) {
  return {
    code,
    title: values.title ?? '',
    originalTitle: values.originalTitle ?? values.title ?? '',
    releaseDate: values.releaseDate ?? '',
    runtime: Number(values.runtime) || null,
    director: values.director ?? '',
    studio: values.studio ?? '',
    publisher: values.publisher ?? '',
    series: values.series ?? '',
    genres: values.genres ?? [],
    actors: values.actors ?? [],
    coverUrl: values.coverUrl ?? '',
    sourceUrl,
    scrapedAt: new Date().toISOString(),
  };
}

export function parseGenericHtml(html, code, sourceUrl) {
  const rawTitle = meta(html, 'og:title')
    || first(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)
    || first(html, /<h2[^>]*>([\s\S]*?)<\/h2>/i)
    || first(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const releaseDate = valueAfterLabel(html, ['發行日期', '发行日期', '日期', 'Release Date', 'Date']);
  const runtimeText = valueAfterLabel(html, ['長度', '长度', '時長', '时长', 'Length', 'Runtime']);
  return metadataResult(code, sourceUrl, {
    title: cleanTitle(rawTitle, code),
    releaseDate: releaseDate.match(/\d{4}[-/.]\d{2}[-/.]\d{2}/)?.[0]?.replace(/[/.]/g, '-') ?? releaseDate,
    runtime: runtimeText.match(/\d+/)?.[0],
    director: linksAfterLabel(html, ['導演', '导演', 'Director'])[0] ?? '',
    studio: linksAfterLabel(html, ['製作商', '制作商', '片商', 'Studio', 'Maker'])[0] ?? '',
    publisher: linksAfterLabel(html, ['發行商', '发行商', 'Label'])[0] ?? '',
    series: linksAfterLabel(html, ['系列', 'Series'])[0] ?? '',
    genres: linksAfterLabel(html, ['類別', '类别', '標籤', '标签', 'Genre', 'Tags']),
    actors: linksAfterLabel(html, ['演員', '演员', 'Actor', 'Actors', 'Star']),
    coverUrl: absoluteUrl(meta(html, 'og:image'), sourceUrl),
  });
}

export function parseJavDbHtml(html, code, sourceUrl) {
  const generic = parseGenericHtml(html, code, sourceUrl);
  const actorBlock = blockById(html, 'actors') || blockById(html, 'movie-actors');
  return metadataResult(code, sourceUrl, {
    ...generic,
    title: cleanTitle(meta(html, 'og:title') || generic.title, code, ['JavDB']),
    actors: links(actorBlock).length ? links(actorBlock) : generic.actors,
  });
}

export function parseJavLibraryHtml(html, code, sourceUrl) {
  const titleBlock = blockById(html, 'video_title');
  const dateText = stripTags(blockById(html, 'video_date'));
  const runtimeText = stripTags(blockById(html, 'video_length'));
  const coverBlock = blockById(html, 'video_jacket_img');
  const coverRaw = coverBlock.match(/(?:src|href)=["']([^"']+)/i)?.[1] ?? meta(html, 'og:image');
  return metadataResult(code, sourceUrl, {
    title: cleanTitle(first(titleBlock, /<h3[^>]*>([\s\S]*?)<\/h3>/i) || stripTags(titleBlock), code, ['JavLibrary']),
    releaseDate: dateText.match(/\d{4}[-/.]\d{2}[-/.]\d{2}/)?.[0]?.replace(/[/.]/g, '-') ?? dateText,
    runtime: runtimeText.match(/\d+/)?.[0],
    director: links(blockById(html, 'video_director'))[0] ?? '',
    studio: links(blockById(html, 'video_maker'))[0] ?? '',
    publisher: links(blockById(html, 'video_label'))[0] ?? '',
    genres: links(blockById(html, 'video_genres')),
    actors: links(blockById(html, 'video_cast')),
    coverUrl: absoluteUrl(coverRaw, sourceUrl),
  });
}

const ADAPTERS = {
  javbus: parseJavBusHtml,
  javdb: parseJavDbHtml,
  javlibrary: parseJavLibraryHtml,
  generic: parseGenericHtml,
};

function detailUrlFromSearch(html, adapter, code, sourceUrl) {
  const linkPattern = adapter === 'javdb'
    ? /<a\b[^>]+href=["']([^"']*\/v\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    : /<a\b[^>]+href=["']([^"']*(?:\?v=|\/\?v=)[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(linkPattern)) {
    if (!stripTags(match[2]).toUpperCase().includes(code.toUpperCase())) continue;
    return absoluteUrl(decodeEntities(match[1]), sourceUrl);
  }
  return '';
}

async function fetchPage(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        accept: 'text/html,application/xhtml+xml',
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    const timeout = error.name === 'TimeoutError' || error.cause?.code === 'ETIMEDOUT';
    throw new Error(timeout ? '连接超时' : '无法连接，请检查网络或站点可用性');
  }
  if (!response.ok) throw new Error(`返回 HTTP ${response.status}`);
  return { html: await response.text(), url: response.url || url };
}

export function buildScraperUrl(template, code) {
  if (!CODE_PATTERN.test(code)) throw Object.assign(new Error('番号格式不适合查询'), { statusCode: 400 });
  if (!String(template).includes('{code}')) throw Object.assign(new Error('刮削源 URL 模板缺少 {code}'), { statusCode: 400 });
  return String(template).replaceAll('{code}', encodeURIComponent(code));
}

export async function scrapeWithSource(code, source, options = {}) {
  const adapter = ADAPTERS[source.adapter];
  if (!adapter) throw Object.assign(new Error(`不支持解析器 ${source.adapter}`), { statusCode: 400 });
  const queryUrl = buildScraperUrl(source.urlTemplate, code);
  const requestOptions = { ...options, cookie: source.adapter === 'javbus' ? 'existmag=all' : '' };
  let page = await fetchPage(queryUrl, requestOptions);
  if (source.adapter === 'javdb' || source.adapter === 'javlibrary') {
    const detailUrl = detailUrlFromSearch(page.html, source.adapter, code, page.url);
    if (detailUrl && detailUrl !== page.url) page = await fetchPage(detailUrl, requestOptions);
  }
  const metadata = adapter(page.html, code, page.url);
  if (!metadata.title) throw new Error('页面中没有识别到影片信息，站点结构可能已变化');
  metadata.sourceProvider = { id: source.id, name: source.name };
  return metadata;
}

/** 按配置顺序执行。指定 providerId 时只查询一个；auto 才会在失败后继续。 */
export async function scrapeMetadata(code, sources, providerId = 'auto', options = {}) {
  const normalizedCode = String(code ?? '').trim();
  if (!CODE_PATTERN.test(normalizedCode)) throw Object.assign(new Error('番号格式不适合查询'), { statusCode: 400 });
  const enabled = (Array.isArray(sources) ? sources : []).filter((source) => source.enabled !== false);
  const candidates = providerId === 'auto'
    ? enabled
    : enabled.filter((source) => source.id === providerId);
  if (!candidates.length) throw Object.assign(new Error(providerId === 'auto' ? '没有启用的刮削源' : '未知或未启用的刮削源'), { statusCode: 400 });

  const attempts = [];
  for (const source of candidates) {
    try {
      const metadata = await scrapeWithSource(normalizedCode, source, options);
      return { metadata, provider: { id: source.id, name: source.name }, attempts };
    } catch (error) {
      attempts.push({ id: source.id, name: source.name, error: error.message });
      if (providerId !== 'auto') {
        throw Object.assign(new Error(`${source.name}：${error.message}`), { statusCode: error.statusCode || 502, details: attempts });
      }
    }
  }
  const summary = attempts.map((attempt) => `${attempt.name}：${attempt.error}`).join('；');
  throw Object.assign(new Error(`所有刮削源均失败：${summary}`), { statusCode: 502, details: attempts });
}

export const SCRAPER_ADAPTER_OPTIONS = Object.freeze([
  { id: 'javbus', name: 'JavBus' },
  { id: 'javdb', name: 'JavDB' },
  { id: 'javlibrary', name: 'JavLibrary' },
  { id: 'generic', name: '通用页面' },
]);
