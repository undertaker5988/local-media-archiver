import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/;

function normalizeForComparison(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function validateTargetName(targetName) {
  if (typeof targetName !== 'string' || !targetName.trim()) return '新名称不能为空';
  if (targetName !== path.basename(targetName) || targetName === '.' || targetName === '..') return '新名称不能包含路径';
  if (INVALID_NAME.test(targetName) || /[. ]$/.test(targetName)) return '新名称包含系统不允许的字符';
  return '';
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function previewRenameActions(inputActions, options = {}) {
  if (!Array.isArray(inputActions) || !inputActions.length) throw new Error('没有可预览的重命名项');
  if (inputActions.length > 2000) throw new Error('单次最多处理 2000 个项目');

  const root = options.root ? path.resolve(String(options.root)) : '';
  const targetKeys = new Map();
  const actions = [];
  for (const raw of inputActions) {
    const source = path.resolve(String(raw.source ?? ''));
    const kind = ['directory', 'directory-move', 'quarantine'].includes(raw.kind) ? raw.kind : 'file';
    let targetName = String(raw.targetName ?? '');
    let target = path.join(path.dirname(source), targetName);
    let error = String(raw.error ?? '');

    if (kind === 'directory-move') {
      target = path.resolve(String(raw.targetPath ?? ''));
      targetName = path.basename(target);
      error ||= validateTargetName(targetName);
      if (!root) error ||= '演员归档缺少扫描根目录';
      else if (!isWithin(root, source) || !isWithin(root, target)) error ||= '演员归档目标必须位于扫描目录内';
      if (!error && normalizeForComparison(source) !== normalizeForComparison(target) && isWithin(source, target)) {
        error = '不能把文件夹移动到自身内部';
      }
    } else if (kind === 'quarantine') {
      if (!root) {
        error ||= '广告隔离缺少扫描根目录';
      } else if (!isWithin(root, source)) {
        error ||= '广告文件不在扫描目录内';
      } else {
        const relative = path.relative(root, source);
        target = path.join(root, '.media-archiver-trash', relative);
        targetName = path.basename(target);
      }
    } else {
      error ||= validateTargetName(targetName);
    }
    let sourceStat = null;
    try {
      sourceStat = await fs.stat(source);
    } catch {
      error ||= '源文件不存在';
    }

    if (!error && (kind === 'directory' || kind === 'directory-move') && !sourceStat.isDirectory()) error = '源项目不是目录';
    if (!error && kind !== 'directory' && kind !== 'directory-move' && !sourceStat.isFile()) error = '源项目不是文件';
    const noop = normalizeForComparison(source) === normalizeForComparison(target) && source === target;

    if (!error && !noop && normalizeForComparison(source) !== normalizeForComparison(target)) {
      try {
        await fs.access(target);
        error = '目标名称已存在';
      } catch {
        // The target does not exist, so the rename is safe to preview.
      }
    }

    const targetKey = normalizeForComparison(target);
    if (targetKeys.has(targetKey) && normalizeForComparison(source) !== targetKey) {
      error = '多个项目会生成同一个目标名称';
      const previous = actions[targetKeys.get(targetKey)];
      previous.error ||= '多个项目会生成同一个目标名称';
    } else {
      targetKeys.set(targetKey, actions.length);
    }

    actions.push({
      source,
      target,
      targetName,
      kind,
      error,
      noop,
    });
  }

  return {
    actions,
    valid: actions.every((action) => !action.error),
    changes: actions.filter((action) => !action.noop && !action.error).length,
  };
}

export async function applyRenameActions(inputActions, options = {}) {
  const preview = await previewRenameActions(inputActions, options);
  if (!preview.valid && !options.skipErrors) {
    const error = new Error('预览中存在冲突，未执行任何更改');
    error.statusCode = 409;
    error.details = preview;
    throw error;
  }

  const skipped = preview.actions.filter((action) => action.error);
  const priority = { file: 0, quarantine: 1, directory: 2, 'directory-move': 2 };
  const ordered = preview.actions
    .filter((action) => !action.noop && !action.error)
    .sort((a, b) => (priority[a.kind] === priority[b.kind] ? b.source.length - a.source.length : priority[a.kind] - priority[b.kind]));
  const completed = [];

  try {
    for (const action of ordered) {
      if (action.kind === 'quarantine' || action.kind === 'directory-move') {
        await fs.mkdir(path.dirname(action.target), { recursive: true });
      }
      if (normalizeForComparison(action.source) === normalizeForComparison(action.target)) {
        const temporary = path.join(path.dirname(action.source), `.__archive-${crypto.randomUUID()}${path.extname(action.source)}`);
        await fs.rename(action.source, temporary);
        await fs.rename(temporary, action.target);
      } else {
        await fs.rename(action.source, action.target);
      }
      completed.push(action);
    }
  } catch (cause) {
    for (const action of completed.reverse()) {
      try {
        await fs.rename(action.target, action.source);
      } catch {
        // Best-effort rollback; the original error remains the useful failure.
      }
    }
    const error = new Error(`重命名失败，已回滚可恢复项目：${cause.message}`);
    error.cause = cause;
    throw error;
  }

  return { renamed: completed.length, skipped: skipped.length, skippedActions: skipped, actions: completed };
}
