const BASE_URL = 'https://www.javbus.com';

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
  return decodeEntities(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function first(html, pattern) {
  return stripTags(html.match(pattern)?.[1] ?? '');
}

function meta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forward = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i');
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i');
  return decodeEntities(html.match(forward)?.[1] ?? html.match(reverse)?.[1] ?? '');
}

function field(html, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`<p[^>]*>\\s*<span[^>]*>\\s*${escaped}\\s*:?\\s*<\\/span>([\\s\\S]*?)<\\/p>`, 'i');
    const value = first(html, pattern);
    if (value) return value;
  }
  return '';
}

function linksFollowingLabel(html, labels) {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = html.match(new RegExp(`<p[^>]*>[\\s\\S]*?<span[^>]*>\\s*${escaped}\\s*:?\\s*<\\/span>([\\s\\S]*?)<\\/p>`, 'i'))?.[1];
    if (!block) continue;
    return [...block.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((match) => stripTags(match[1])).filter(Boolean);
  }
  return [];
}

export function parseJavBusHtml(html, code, sourceUrl) {
  const rawTitle = meta(html, 'og:title') || first(html, /<h3[^>]*>([\s\S]*?)<\/h3>/i) || first(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = rawTitle.replace(new RegExp(`^\\s*${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i'), '').replace(/\s*[-|]\s*JavBus.*$/i, '').trim();
  const dateText = field(html, ['發行日期', '发行日期', 'Release Date']);
  const runtimeText = field(html, ['長度', '长度', 'Length']);
  const coverRaw = meta(html, 'og:image') || html.match(/<a[^>]+class=["'][^"']*bigImage[^"']*["'][^>]+href=["']([^"']+)/i)?.[1] || '';
  const coverUrl = coverRaw.startsWith('//') ? `https:${coverRaw}` : new URL(coverRaw || '/', sourceUrl).href;

  return {
    code,
    title,
    originalTitle: title,
    releaseDate: dateText.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? dateText,
    runtime: Number(runtimeText.match(/\d+/)?.[0] ?? 0) || null,
    director: linksFollowingLabel(html, ['導演', '导演', 'Director'])[0] ?? '',
    studio: linksFollowingLabel(html, ['製作商', '制作商', 'Studio'])[0] ?? '',
    publisher: linksFollowingLabel(html, ['發行商', '发行商', 'Label'])[0] ?? '',
    series: linksFollowingLabel(html, ['系列', 'Series'])[0] ?? '',
    genres: linksFollowingLabel(html, ['類別', '类别', 'Genre']),
    actors: linksFollowingLabel(html, ['演員', '演员', 'Star']),
    coverUrl,
    sourceUrl,
    scrapedAt: new Date().toISOString(),
  };
}

export async function scrapeJavBus(code, options = {}) {
  if (!/^[a-z0-9-]{3,40}$/i.test(code)) throw new Error('番号格式不适合查询');
  const baseUrl = options.baseUrl ?? BASE_URL;
  const sourceUrl = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(code)}`;
  let response;
  try {
    response = await fetch(sourceUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        cookie: 'existmag=all',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const timeout = error.name === 'TimeoutError' || error.cause?.code === 'ETIMEDOUT';
    throw new Error(timeout ? '连接刮削源超时（15 秒）' : '无法连接刮削源，请检查网络或站点可用性');
  }
  if (!response.ok) throw new Error(`刮削源返回 HTTP ${response.status}`);
  const html = await response.text();
  const metadata = parseJavBusHtml(html, code, sourceUrl);
  if (!metadata.title) throw new Error('页面中没有识别到影片信息，站点结构可能已变化');
  return metadata;
}

export const javBusProvider = {
  id: 'javbus',
  name: 'JavBus',
  scrape: scrapeJavBus,
};
