import fs from 'node:fs/promises';
import path from 'node:path';

function directoryError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

async function availableRoots(platform) {
  if (platform !== 'win32') return ['/'];

  const candidates = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  const checks = await Promise.all(candidates.map(async (candidate) => {
    try {
      return (await fs.stat(candidate)).isDirectory() ? candidate : null;
    } catch {
      return null;
    }
  }));
  return checks.filter(Boolean);
}

export async function listDirectories(input, options = {}) {
  if (typeof input !== 'string' || !input.trim()) {
    throw directoryError('请输入要浏览的目录路径', 400);
  }

  const current = path.resolve(input.trim());
  let stat;
  try {
    stat = await fs.stat(current);
  } catch (error) {
    if (error.code === 'ENOENT') throw directoryError('目录不存在', 404);
    if (error.code === 'EACCES' || error.code === 'EPERM') throw directoryError('无权访问该目录', 403);
    throw error;
  }
  if (!stat.isDirectory()) throw directoryError('所选路径不是目录', 400);

  let entries;
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') throw directoryError('无权读取该目录', 403);
    throw error;
  }

  const parentPath = path.dirname(current);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));

  return {
    current,
    parent: parentPath === current ? null : parentPath,
    roots: await availableRoots(options.platform ?? process.platform),
    directories,
  };
}
