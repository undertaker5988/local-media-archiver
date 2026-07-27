import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJavBusHtml, scrapeJavBus } from '../src/lib/scrapers/javbus.mjs';

test('extracts catalog fields from a JavBus-style page', () => {
  const html = `
    <html><head>
      <meta property="og:title" content="ABP-123 Sample title - JavBus">
      <meta property="og:image" content="//images.example/cover.jpg">
    </head><body>
      <p><span>發行日期:</span> 2025-06-01</p>
      <p><span>長度:</span> 121分鐘</p>
      <p><span>導演:</span> <a>Director A</a></p>
      <p><span>製作商:</span> <a>Studio B</a></p>
      <p><span>系列:</span> <a>Series C</a></p>
      <p><span>類別:</span> <a>Drama</a><a>Featured</a></p>
      <p><span>演員:</span> <a>Actor One</a><a>Actor Two</a></p>
    </body></html>`;
  const metadata = parseJavBusHtml(html, 'ABP-123', 'https://www.javbus.com/ABP-123');
  assert.equal(metadata.title, 'Sample title');
  assert.equal(metadata.releaseDate, '2025-06-01');
  assert.equal(metadata.runtime, 121);
  assert.equal(metadata.director, 'Director A');
  assert.equal(metadata.studio, 'Studio B');
  assert.deepEqual(metadata.actors, ['Actor One', 'Actor Two']);
  assert.deepEqual(metadata.genres, ['Drama', 'Featured']);
  assert.equal(metadata.coverUrl, 'https://images.example/cover.jpg');
});

test('reports scraper connection failures in actionable Chinese', async () => {
  await assert.rejects(
    () => scrapeJavBus('ABP-123', { baseUrl: 'http://127.0.0.1:1' }),
    /无法连接刮削源/,
  );
});
