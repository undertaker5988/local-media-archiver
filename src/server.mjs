/**
 * 本地 HTTP 入口，职责接近一个不依赖框架的 Spring Boot Controller。
 * handleApi 只做路由和 DTO 转发，文件扫描、重命名、归集等业务放在 src/lib 的 Service 模块中。
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { scanLibrary } from './lib/file-scanner.mjs';
import { listDirectories } from './lib/directory-browser.mjs';
import { applyRenameActions, previewRenameActions } from './lib/rename-service.mjs';
import { SCRAPER_ADAPTER_OPTIONS, scrapeMetadata } from './lib/scraper-service.mjs';
import { saveMetadata } from './lib/metadata-service.mjs';
import { previewNaming } from './lib/naming-preview.mjs';
import { loadSettings, resetSettings, saveSettings, settingsFilePath } from './lib/settings-service.mjs';
import { applyCollection, getLibraryAsset, indexLibrary, previewCollection } from './lib/library-service.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(here, '../public');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT) || 4318;
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

/** 读取并限制请求体大小，作用类似 Controller 层统一的 JSON 参数解析。 */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_000_000) throw Object.assign(new Error('请求内容过大'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求 JSON 格式无效'), { statusCode: 400 });
  }
}

function openLocalPage() {
  if (process.platform !== 'win32') return;
  execFile('cmd.exe', ['/c', 'start', '', `http://${host}:${port}`], { windowsHide: true }, () => {});
}

/**
 * 前置路由（Front Controller）：根据 method + pathname 分派到对应 Service。
 * Service 抛出的 statusCode 会在最外层统一转换为 HTTP 状态码。
 */
async function handleApi(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/health') {
    return sendJson(response, 200, { ok: true, version: '0.1.0' });
  }
  if (request.method === 'GET' && pathname === '/api/config') {
    const settings = await loadSettings();
    return sendJson(response, 200, {
      defaultRoot: process.cwd(),
      platform: process.platform,
      providers: settings.scraping.providers.filter((source) => source.enabled).map(({ id, name }) => ({ id, name })),
      scraperAdapters: SCRAPER_ADAPTER_OPTIONS,
      settings,
    });
  }
  if (request.method === 'GET' && pathname === '/api/settings') {
    return sendJson(response, 200, { settings: await loadSettings(), defaults: resetSettings(), filePath: settingsFilePath() });
  }
  if (request.method === 'GET' && pathname === '/api/library/asset') {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    const asset = await getLibraryAsset(url.searchParams.get('id'));
    response.writeHead(200, {
      'content-type': asset.contentType,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    });
    response.end(asset.data);
    return;
  }
  const body = await readJson(request);
  if (request.method === 'POST' && pathname === '/api/directories/list') {
    return sendJson(response, 200, await listDirectories(body.path));
  }
  if (request.method === 'POST' && pathname === '/api/scan') {
    return sendJson(response, 200, await scanLibrary(body.root, body.options, await loadSettings()));
  }
  if (request.method === 'POST' && pathname === '/api/library/index') {
    return sendJson(response, 200, await indexLibrary(body, await loadSettings()));
  }
  if (request.method === 'POST' && pathname === '/api/library/collect/preview') {
    return sendJson(response, 200, await previewCollection(body, await loadSettings()));
  }
  if (request.method === 'POST' && pathname === '/api/library/collect/apply') {
    return sendJson(response, 200, await applyCollection(body));
  }
  if (request.method === 'PUT' && pathname === '/api/settings') {
    return sendJson(response, 200, await saveSettings(body.settings ?? body));
  }
  if (request.method === 'POST' && pathname === '/api/settings/correction') {
    const settings = await loadSettings();
    const rule = body.rule ?? {};
    const index = settings.corrections.findIndex((entry) => entry.pattern === rule.pattern && entry.isRegex === Boolean(rule.isRegex));
    if (index >= 0) settings.corrections[index] = { ...settings.corrections[index], ...rule };
    else settings.corrections.push(rule);
    return sendJson(response, 200, await saveSettings(settings));
  }
  if (request.method === 'POST' && pathname === '/api/settings/preview') {
    return sendJson(response, 200, { preview: previewNaming(body.settings, body.samples) });
  }
  if (request.method === 'POST' && pathname === '/api/rename/preview') {
    return sendJson(response, 200, await previewRenameActions(body.actions, { root: body.root }));
  }
  if (request.method === 'POST' && pathname === '/api/rename/apply') {
    return sendJson(response, 200, await applyRenameActions(body.actions, { root: body.root, skipErrors: body.skipErrors === true }));
  }
  if (request.method === 'POST' && pathname === '/api/scrape') {
    const settings = await loadSettings();
    return sendJson(response, 200, await scrapeMetadata(
      String(body.code ?? '').trim(),
      settings.scraping.providers,
      String(body.provider || settings.scraping.defaultProvider || 'auto'),
    ));
  }
  if (request.method === 'POST' && pathname === '/api/metadata/save') {
    return sendJson(response, 200, await saveMetadata(body));
  }
  return sendJson(response, 404, { error: 'API 不存在' });
}

// 静态资源只允许从 publicDirectory 读取，路径越界会在 resolve 后被拒绝。
async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = path.resolve(publicDirectory, requested);
  if (filePath !== publicDirectory && !filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    return sendJson(response, 403, { error: '拒绝访问' });
  }
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    response.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return sendJson(response, 404, { error: '文件不存在' });
    throw error;
  }
}

// 统一异常边界类似 Spring 的 @ControllerAdvice，避免把堆栈和本机路径返回给页面。
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url.pathname);
    else await serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(response, error.statusCode || 500, { error: error.message || '服务器内部错误', details: error.details });
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && process.env.OPEN_BROWSER === '1') {
    console.log(`服务已经在运行，正在打开：http://${host}:${port}`);
    openLocalPage();
    setTimeout(() => process.exit(0), 500);
    return;
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(`片库归档台已启动：http://${host}:${port}`);
  if (process.env.OPEN_BROWSER === '1') openLocalPage();
});
