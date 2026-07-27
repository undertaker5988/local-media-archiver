import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listDirectories } from '../src/lib/directory-browser.mjs';

test('directory browser lists only child directories and returns parent', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-directory-browser-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'folder-10'));
  await fs.mkdir(path.join(root, 'folder-2'));
  await fs.writeFile(path.join(root, 'video.mp4'), 'placeholder');

  const result = await listDirectories(root, { platform: 'linux' });
  assert.equal(result.current, path.resolve(root));
  assert.equal(result.parent, path.dirname(path.resolve(root)));
  assert.deepEqual(result.directories.map((entry) => entry.name), ['folder-2', 'folder-10']);
  assert.deepEqual(result.roots, ['/']);
});

test('directory browser rejects missing paths and regular files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-directory-browser-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'not-a-directory.txt');
  await fs.writeFile(filePath, 'placeholder');

  await assert.rejects(listDirectories(path.join(root, 'missing')), /目录不存在/);
  await assert.rejects(listDirectories(filePath), /不是目录/);
});
