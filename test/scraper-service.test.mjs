import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScraperUrl,
  parseJavDbHtml,
  parseJavLibraryHtml,
  scrapeMetadata,
} from '../src/lib/scraper-service.mjs';

test('builds a scraper URL from a validated code placeholder', () => {
  assert.equal(
    buildScraperUrl('https://example.test/search?q={code}', '010123_001'),
    'https://example.test/search?q=010123_001',
  );
  assert.throws(() => buildScraperUrl('https://example.test/search', 'ABP-123'), /缺少 \{code\}/);
});

test('extracts metadata from JavDB and JavLibrary detail pages', () => {
  const javdb = parseJavDbHtml(`
    <meta property="og:title" content="ABP-123 JavDB title - JavDB">
    <meta property="og:image" content="/covers/abp.jpg">
    <div><strong>日期:</strong><span>2025-07-01</span></div>
    <div id="actors"><a>Actor A</a><a>Actor B</a></div>
  `, 'ABP-123', 'https://javdb.example/v/abc');
  assert.equal(javdb.title, 'JavDB title');
  assert.deepEqual(javdb.actors, ['Actor A', 'Actor B']);
  assert.equal(javdb.coverUrl, 'https://javdb.example/covers/abp.jpg');

  const javlibrary = parseJavLibraryHtml(`
    <div id="video_title"><h3>ABP-123 Library title</h3></div>
    <div id="video_date">2025-07-02</div>
    <div id="video_length">120 分钟</div>
    <div id="video_maker"><a>Studio C</a></div>
    <div id="video_cast"><a>Actor C</a></div>
    <div id="video_jacket_img"><img src="//img.example/cover.jpg"></div>
  `, 'ABP-123', 'https://javlibrary.example/?v=abc');
  assert.equal(javlibrary.title, 'Library title');
  assert.equal(javlibrary.releaseDate, '2025-07-02');
  assert.equal(javlibrary.runtime, 120);
  assert.equal(javlibrary.studio, 'Studio C');
  assert.deepEqual(javlibrary.actors, ['Actor C']);
});

test('auto provider falls back in order and reports the successful source', async () => {
  const sources = [
    { id: 'down', name: 'Unavailable', adapter: 'generic', urlTemplate: 'https://down.example/{code}', enabled: true },
    { id: 'working', name: 'Working source', adapter: 'generic', urlTemplate: 'https://working.example/{code}', enabled: true },
  ];
  const fetchImpl = async (url) => {
    if (url.includes('down.example')) return { ok: false, status: 503, url, text: async () => '' };
    return {
      ok: true,
      status: 200,
      url,
      text: async () => '<meta property="og:title" content="ABP-123 Fallback title"><meta property="og:image" content="/cover.jpg">',
    };
  };
  const result = await scrapeMetadata('ABP-123', sources, 'auto', { fetchImpl });
  assert.equal(result.metadata.title, 'Fallback title');
  assert.equal(result.provider.id, 'working');
  assert.deepEqual(result.attempts, [{ id: 'down', name: 'Unavailable', error: '返回 HTTP 503' }]);
});

test('a manually selected provider does not silently switch sources', async () => {
  const sources = [
    { id: 'down', name: 'Unavailable', adapter: 'generic', urlTemplate: 'https://down.example/{code}', enabled: true },
    { id: 'working', name: 'Working source', adapter: 'generic', urlTemplate: 'https://working.example/{code}', enabled: true },
  ];
  let calls = 0;
  await assert.rejects(
    () => scrapeMetadata('ABP-123', sources, 'down', {
      fetchImpl: async (url) => {
        calls += 1;
        return { ok: false, status: 503, url, text: async () => '' };
      },
    }),
    /Unavailable：返回 HTTP 503/,
  );
  assert.equal(calls, 1);
});
