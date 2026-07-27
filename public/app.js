const state = {
  config: null,
  root: '',
  items: [],
  summary: null,
  selected: new Set(),
  activeId: '',
  filter: 'all',
  query: '',
  previewActions: [],
  previewResult: null,
  settings: null,
  savedSettings: null,
  defaultSettings: null,
  settingsFilePath: '',
  activeView: 'workspace',
  correctionItemId: '',
  focusedTemplateInput: null,
  settingsPreviewTimer: null,
  settingsPreviewRequest: 0,
  directoryBrowser: null,
  directoryPickerTarget: 'workspace',
  librarySources: [],
  libraryOutput: '',
  libraryEffectiveOutput: '',
  libraryMode: 'copy',
  libraryMovies: [],
  librarySummary: null,
  librarySelected: new Set(),
  libraryQuery: '',
  libraryPreview: null,
};

const $ = (selector) => document.querySelector(selector);
const rowsElement = $('#media-rows');
const emptyState = $('#empty-state');

function api(path, options = {}) {
  return fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `请求失败（${response.status}）`);
      error.details = data.details;
      throw error;
    }
    return data;
  });
}

function toast(message, type = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.textContent = message;
  $('#toast-region').append(element);
  setTimeout(() => element.remove(), 3600);
}

function appendTaskLog(message, type = '') {
  const entry = create('div', `task-log-entry ${type}`.trim());
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.append(time, create('span', '', message));
  const log = $('#task-log');
  log.append(entry);
  log.scrollTop = log.scrollHeight;
}

function updateTaskProgress(completed, total, status) {
  const safeTotal = Math.max(Number(total) || 0, 0);
  const safeCompleted = Math.min(Math.max(Number(completed) || 0, 0), safeTotal);
  const progress = $('#task-progress');
  progress.max = Math.max(safeTotal, 1);
  progress.value = safeTotal ? safeCompleted : 0;
  progress.dataset.total = String(safeTotal);
  $('#task-count').textContent = `${safeCompleted} / ${safeTotal}`;
  if (status) $('#task-status').textContent = status;
}

function startTask(title, total, status = '准备中') {
  $('#task-panel').hidden = false;
  $('#task-title').textContent = title;
  $('#task-log').replaceChildren();
  updateTaskProgress(0, total, status);
  appendTaskLog(status, 'muted');
}

function finishTask(message, type = 'success') {
  const total = Number($('#task-progress').dataset.total) || 0;
  updateTaskProgress(total, total, message);
  appendTaskLog(message, type);
}

function describeTaskAction(action) {
  const labels = { file: '重命名', quarantine: '隔离广告', directory: '重命名文件夹', 'directory-move': '演员归档' };
  return `${labels[action.kind] || '整理'}：${basename(action.source)}${action.noop ? '（名称不变）' : ` → ${basename(action.target)}`}`;
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle('busy', busy);
}

function renderDirectoryBrowser(result) {
  state.directoryBrowser = result;
  $('#directory-path').value = result.current;
  $('#directory-up').disabled = !result.parent;

  const roots = $('#directory-roots');
  roots.replaceChildren();
  for (const root of result.roots) {
    const button = create('button', 'directory-root', root);
    button.type = 'button';
    button.title = `浏览 ${root}`;
    button.addEventListener('click', () => loadDirectory(root));
    roots.append(button);
  }

  const list = $('#directory-list');
  list.replaceChildren();
  for (const directory of result.directories) {
    const button = create('button', 'directory-entry');
    button.type = 'button';
    button.title = `打开 ${directory.name}`;
    button.append(create('span', 'directory-entry-icon', '▸'), create('span', 'directory-entry-name', directory.name));
    button.addEventListener('click', () => loadDirectory(directory.path));
    list.append(button);
  }
  $('#directory-empty').hidden = result.directories.length > 0;
}

async function loadDirectory(directoryPath) {
  const goButton = $('#directory-go');
  setBusy(goButton, true);
  try {
    const result = await api('/api/directories/list', { method: 'POST', body: { path: directoryPath } });
    renderDirectoryBrowser(result);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(goButton, false);
  }
}

async function openDirectoryBrowser(target = 'workspace') {
  state.directoryPickerTarget = target;
  const labels = {
    workspace: ['选择扫描目录', '选择此目录'],
    'library-source': ['添加片库来源', '添加此目录'],
    'library-output': ['选择输出目录', '设为输出目录'],
  };
  const [title, action] = labels[target] || labels.workspace;
  $('#directory-dialog-title').textContent = title;
  $('#select-directory').textContent = action;
  const dialog = $('#directory-dialog');
  if (!dialog.open) dialog.showModal();
  const initialPath = target === 'workspace'
    ? $('#root-path').value.trim()
    : target === 'library-output'
      ? (state.libraryOutput || state.librarySources[0])
      : state.librarySources.at(-1);
  await loadDirectory(initialPath || state.config?.defaultRoot || '.');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index > 2 ? 2 : 1)} ${units[index]}`;
}

function basename(filePath) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function localSeparator() {
  return state.config?.platform === 'win32' ? '\\' : '/';
}

function joinLocalPath(...parts) {
  const separator = localSeparator();
  return parts
    .filter(Boolean)
    .map((part, index) => String(part).replace(index === 0 ? /[\\/]+$/g : /^[\\/]+|[\\/]+$/g, ''))
    .join(separator);
}

function extension(filename) {
  const index = filename.lastIndexOf('.');
  return index >= 0 ? filename.slice(index).toLowerCase() : '';
}

function stem(filename) {
  const suffix = extension(filename);
  return suffix ? filename.slice(0, -suffix.length) : filename;
}

function create(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function formatConfiguredCode(code) {
  const mode = state.savedSettings?.naming?.codeCase || 'upper';
  if (mode === 'lower') return code.toLowerCase();
  if (mode === 'preserve') return code;
  return code.toUpperCase();
}

function safeNameValue(value) {
  return String(value ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim();
}

function subtitleLanguage(filename) {
  const match = stem(filename).match(/(?:^|[._-])(zh[-_]?cn|zh[-_]?tw|chs|cht|eng?|ja|jp)(?:$|[._-])/i);
  if (!match) return '';
  const normalized = match[1].toLowerCase().replace('_', '-');
  const aliases = { chs: 'zh-CN', cht: 'zh-TW', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', en: 'en', eng: 'en', ja: 'ja', jp: 'ja' };
  return `.${aliases[normalized] || normalized}`;
}

function renderConfiguredName(template, item, filename, lang = '', isFolder = false) {
  const metadata = item.metadata || {};
  const values = {
    code: formatConfiguredCode(safeNameValue(item.code)),
    part: item.part ? `-CD${item.part}` : '',
    title: safeNameValue(metadata.title),
    actor: safeNameValue(metadata.actors?.[0]),
    studio: safeNameValue(metadata.studio),
    year: safeNameValue(String(metadata.releaseDate || '').match(/^\d{4}/)?.[0]),
    lang: safeNameValue(lang),
    ext: safeNameValue(extension(filename)),
    original: safeNameValue(isFolder ? filename : stem(filename)),
  };
  return String(template)
    .replace(/\{([a-z]+)\}/g, (_, token) => values[token] ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
}

function updateArchiveSuggestion(item) {
  const actor = item.metadata?.actors?.[0] || '';
  const actorTemplate = state.savedSettings?.organization?.actorFolderTemplate || '{actor}';
  item.actorFolderName = actor ? renderConfiguredName(actorTemplate, item, actor, '', true) : '';
  item.archiveRelativePath = item.actorFolderName && item.folderSuggestedName
    ? joinLocalPath(item.actorFolderName, item.folderSuggestedName)
    : '';
  item.archiveTargetFolder = item.archiveRelativePath ? joinLocalPath(state.root, item.archiveRelativePath) : '';
}

function filteredItems() {
  const query = state.query.toLowerCase();
  return state.items.filter((item) => {
    if (state.filter === 'ready' && (!item.code || !item.needsRename)) return false;
    if (state.filter === 'missing' && item.hasSubtitle) return false;
    if (state.filter === 'review' && item.status === 'ready') return false;
    return !query || item.name.toLowerCase().includes(query) || item.code.toLowerCase().includes(query) || item.folderName.toLowerCase().includes(query);
  });
}

function statusPill(item, type) {
  if (type === 'subtitle') return create('span', `status-pill ${item.hasSubtitle ? 'ok' : 'warn'}`, item.hasSubtitle ? `${item.subtitles.length} 个` : '缺字幕');
  if (!item.code) return create('span', 'status-pill danger', '未识别');
  if (item.confidence < 0.9) return create('span', 'status-pill warn', '需确认');
  return create('span', 'status-pill ok', item.metadata ? '已入库' : '待刮削');
}

function updateSuggestedNames(item, code) {
  item.code = code.trim();
  const naming = state.savedSettings?.naming || { videoTemplate: '{code}{part}{ext}', subtitleTemplate: '{code}{part}{lang}{ext}', folderTemplate: '{code}' };
  item.suggestedName = item.code ? renderConfiguredName(naming.videoTemplate, item, item.name) : item.name;
  item.folderSuggestedName = item.code ? renderConfiguredName(naming.folderTemplate, item, item.folderName, '', true) : item.folderName;
  item.subtitles = item.subtitles.map((subtitle) => {
    return {
      ...subtitle,
      suggestedName: item.code ? renderConfiguredName(naming.subtitleTemplate, item, subtitle.name, subtitleLanguage(subtitle.name)) : subtitle.name,
    };
  });
  item.status = item.code ? 'ready' : 'unmatched';
  item.needsRename = item.suggestedName !== item.name;
  updateArchiveSuggestion(item);
}

function renderRows() {
  const items = filteredItems();
  rowsElement.replaceChildren();
  emptyState.hidden = state.items.length > 0;
  if (state.items.length && !items.length) {
    emptyState.hidden = false;
    emptyState.querySelector('strong').textContent = '没有符合条件的项目';
    emptyState.querySelector('span').textContent = '调整筛选条件后重试';
  } else if (!state.items.length) {
    emptyState.querySelector('strong').textContent = '尚未扫描目录';
    emptyState.querySelector('span').textContent = '选择下载目录后开始整理';
  }

  for (const item of items) {
    const row = document.createElement('tr');
    row.dataset.id = item.id;
    row.classList.toggle('active', item.id === state.activeId);

    const checkCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.selected.has(item.id);
    checkbox.setAttribute('aria-label', `选择 ${item.name}`);
    checkbox.addEventListener('change', () => toggleSelected(item.id, checkbox.checked));
    checkCell.append(checkbox);

    const sourceCell = create('td', 'file-cell');
    sourceCell.title = item.path;
    sourceCell.append(create('span', 'file-name', item.name));
    sourceCell.append(create('span', 'file-folder', `${item.folderName} · ${formatBytes(item.size)}`));
    if (item.cleanedAds?.length || item.junk?.length) {
      const cleanupFlags = create('div', 'cleanup-flags');
      if (item.cleanedAds?.length) cleanupFlags.append(create('span', 'cleanup-flag removed', `去广告：${item.cleanedAds.join('、')}`));
      if (item.junk?.length) cleanupFlags.append(create('span', 'cleanup-flag junk', `广告文件 ${item.junk.length}`));
      sourceCell.append(cleanupFlags);
    }
    sourceCell.addEventListener('click', () => openInspector(item.id));

    const codeCell = document.createElement('td');
    const codeEditor = create('div', `code-editor ${item.manualCorrection ? '' : 'solo'}`.trim());
    const codeInput = create('input', `code-input ${item.code ? '' : 'invalid'}`.trim());
    codeInput.value = item.code;
    codeInput.placeholder = '手动输入番号';
    codeInput.setAttribute('aria-label', `${item.name} 的番号`);
    const commitCodeCorrection = () => {
      if (codeInput.value.trim() === item.code) return;
      const previousCode = item.code;
      updateSuggestedNames(item, codeInput.value);
      if (item.code && item.code !== previousCode) {
        item.manualCorrection = {
          source: item.detectedCode || previousCode || item.cleanedStem,
          target: item.code,
        };
      }
      renderAll();
    };
    codeInput.addEventListener('change', commitCodeCorrection);
    codeInput.addEventListener('blur', commitCodeCorrection);
    codeEditor.append(codeInput);
    if (item.manualCorrection) {
      const rememberRule = create('button', 'icon-button remember-rule', '+');
      rememberRule.type = 'button';
      rememberRule.title = '记住这次矫正规则';
      rememberRule.setAttribute('aria-label', `记住 ${item.name} 的矫正规则`);
      rememberRule.addEventListener('click', () => openCorrectionDialog(item));
      codeEditor.append(rememberRule);
    }
    codeCell.append(codeEditor);

    const subtitleCell = document.createElement('td');
    subtitleCell.append(statusPill(item, 'subtitle'));
    if (item.subtitles.length) subtitleCell.title = item.subtitles.map((subtitle) => subtitle.name).join('\n');

    const metadataCell = create('td', 'meta-cell');
    metadataCell.append(create('span', 'meta-primary', item.metadata?.actors?.join('、') || '演员待补'));
    metadataCell.append(create('span', 'meta-secondary', item.metadata?.studio || item.rule));

    const targetCell = document.createElement('td');
    const targetInput = create('input', 'target-input');
    targetInput.value = item.suggestedName;
    targetInput.setAttribute('aria-label', `${item.name} 的目标文件名`);
    targetInput.addEventListener('change', () => { item.suggestedName = targetInput.value.trim() || item.name; });
    targetCell.append(targetInput);
    targetCell.append(create('span', `archive-path ${item.archiveRelativePath ? '' : 'missing'}`.trim(), item.archiveRelativePath ? `归档：${item.archiveRelativePath}` : '归档：等待演员资料'));

    const actionCell = document.createElement('td');
    const action = create('button', 'icon-button row-action', '›');
    action.type = 'button';
    action.title = '查看影片资料';
    action.setAttribute('aria-label', `查看 ${item.name} 的资料`);
    action.addEventListener('click', () => openInspector(item.id));
    actionCell.append(action);

    row.append(checkCell, sourceCell, codeCell, subtitleCell, metadataCell, targetCell, actionCell);
    rowsElement.append(row);
  }
  updateSelectionState();
}

function renderSummary() {
  const summary = state.summary || { videos: 0, folders: 0, missingSubtitles: 0, needsReview: 0, renameReady: 0, junk: 0, filenameAds: 0, archiveReady: 0 };
  $('#summary-videos').textContent = summary.videos;
  $('#summary-folders').textContent = summary.folders;
  $('#summary-subtitles').textContent = summary.missingSubtitles;
  $('#summary-review').textContent = summary.needsReview;
  $('#summary-ready').textContent = summary.renameReady;
  $('#summary-junk').textContent = (summary.junk || 0) + (summary.filenameAds || 0);
  $('#summary-archive').textContent = new Set(state.items.filter((item) => item.archiveTargetFolder).map((item) => item.folder)).size;
  $('#count-all').textContent = state.items.length;
  $('#count-ready').textContent = state.items.filter((item) => item.code && item.needsRename).length;
  $('#count-missing').textContent = state.items.filter((item) => !item.hasSubtitle).length;
  $('#count-review').textContent = state.items.filter((item) => item.status !== 'ready').length;
}

function renderAll() {
  renderSummary();
  renderRows();
}

function switchView(view) {
  const nextView = ['workspace', 'library', 'settings', 'guide'].includes(view) ? view : 'workspace';
  state.activeView = nextView;
  document.querySelectorAll('.app-view').forEach((element) => { element.hidden = element.id !== `${nextView}-view`; });
  document.querySelectorAll('.top-nav-button').forEach((button) => {
    const active = button.dataset.view === nextView;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  history.replaceState(null, '', `#${nextView}`);
  $('#inspector').classList.remove('open');
  updateSelectionState();
  if (nextView === 'settings') {
    renderCorrectionRules();
    scheduleSettingsPreview(0);
  }
  if (nextView === 'library') renderLibrary();
  else updateLibrarySelectionState();
}

function fillSettingsForm(settings) {
  $('#setting-video-template').value = settings.naming.videoTemplate;
  $('#setting-subtitle-template').value = settings.naming.subtitleTemplate;
  $('#setting-folder-template').value = settings.naming.folderTemplate;
  $('#setting-code-case').value = settings.naming.codeCase;
  $('#setting-scan-depth').value = String(settings.scan.maxDepth);
  $('#setting-rename-folders').checked = settings.renaming.renameFolders;
  $('#setting-ad-keywords').value = settings.cleanup.adKeywords.join('\n');
  $('#setting-quarantine-junk').checked = settings.cleanup.quarantineJunk;
  $('#setting-archive-by-actor').checked = settings.organization.archiveByActor;
  $('#setting-actor-folder-template').value = settings.organization.actorFolderTemplate;
  renderCorrectionRules();
}

function collectSettingsForm() {
  return {
    version: 2,
    naming: {
      videoTemplate: $('#setting-video-template').value.trim(),
      subtitleTemplate: $('#setting-subtitle-template').value.trim(),
      folderTemplate: $('#setting-folder-template').value.trim(),
      codeCase: $('#setting-code-case').value,
    },
    scan: {
      maxDepth: Number($('#setting-scan-depth').value),
      recursive: true,
    },
    renaming: {
      renameFolders: $('#setting-rename-folders').checked,
    },
    cleanup: {
      adKeywords: $('#setting-ad-keywords').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
      quarantineJunk: $('#setting-quarantine-junk').checked,
    },
    organization: {
      archiveByActor: $('#setting-archive-by-actor').checked,
      actorFolderTemplate: $('#setting-actor-folder-template').value.trim(),
    },
    library: {
      sources: state.librarySources,
      outputDirectory: state.libraryOutput,
      fileMode: state.libraryMode,
    },
    corrections: state.settings?.corrections || [],
  };
}

function currentBatchSamples() {
  if (!state.items.length) return [];
  const samples = [];
  const folders = new Set();
  for (const item of state.items.slice(0, 12)) {
    samples.push({ kind: 'video', name: item.name, code: item.code, detectedCode: item.detectedCode, part: item.part, metadata: item.metadata });
    for (const subtitle of item.subtitles.slice(0, 1)) {
      samples.push({ kind: 'subtitle', name: subtitle.name, code: item.code, detectedCode: item.detectedCode, part: item.part, metadata: item.metadata });
    }
    if (!folders.has(item.folder)) {
      folders.add(item.folder);
      samples.push({ kind: 'folder', name: item.folderName, code: item.code, detectedCode: item.detectedCode, part: item.part, metadata: item.metadata });
      samples.push({ kind: 'archive', name: item.folderName, code: item.code, detectedCode: item.detectedCode, part: item.part, metadata: item.metadata });
    }
    if (samples.length >= 24) break;
  }
  return samples;
}

function renderSettingsPreviewRows(preview) {
  const container = $('#settings-preview');
  container.replaceChildren();
  const labels = { video: '视频', subtitle: '字幕', folder: '文件夹', archive: '演员归档' };
  for (const entry of preview.slice(0, 16)) {
    const row = create('div', 'settings-preview-row');
    row.append(create('span', 'preview-kind', labels[entry.kind] || entry.kind));
    const names = create('div', 'preview-names');
    names.append(create('div', 'preview-source', entry.source));
    names.append(create('div', 'preview-target', entry.target));
    row.append(names);
    container.append(row);
  }
}

async function refreshSettingsPreview() {
  const requestId = ++state.settingsPreviewRequest;
  state.settings = collectSettingsForm();
  const samples = currentBatchSamples();
  $('#settings-preview-source').textContent = samples.length ? `当前扫描 · ${state.items.length} 部` : '内置样例';
  try {
    const result = await api('/api/settings/preview', { method: 'POST', body: { settings: state.settings, samples } });
    if (requestId !== state.settingsPreviewRequest) return;
    renderSettingsPreviewRows(result.preview);
  } catch (error) {
    if (requestId !== state.settingsPreviewRequest) return;
    const container = $('#settings-preview');
    container.replaceChildren(create('div', 'preview-error', error.message));
  }
}

function scheduleSettingsPreview(delay = 220) {
  clearTimeout(state.settingsPreviewTimer);
  state.settingsPreviewTimer = setTimeout(refreshSettingsPreview, delay);
}

function renderCorrectionRules() {
  const container = $('#correction-rules');
  if (!container || !state.settings) return;
  container.replaceChildren();
  const rules = state.settings.corrections || [];
  $('#correction-empty').hidden = rules.length > 0;
  for (const rule of rules) {
    const row = create('div', 'correction-rule-row');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = rule.enabled !== false;
    enabled.setAttribute('aria-label', `启用规则 ${rule.pattern}`);
    enabled.addEventListener('change', () => { rule.enabled = enabled.checked; scheduleSettingsPreview(); });
    const pattern = create('code', '', rule.pattern);
    pattern.title = rule.pattern;
    const replacement = create('code', '', rule.replacement);
    replacement.title = rule.replacement;
    const type = create('span', 'rule-type', rule.isRegex ? '正则' : '精确');
    const remove = create('button', 'icon-button delete-rule', '×');
    remove.type = 'button';
    remove.title = '删除规则';
    remove.setAttribute('aria-label', `删除规则 ${rule.pattern}`);
    remove.addEventListener('click', () => {
      state.settings.corrections = state.settings.corrections.filter((entry) => entry.id !== rule.id);
      renderCorrectionRules();
      scheduleSettingsPreview();
    });
    row.append(enabled, pattern, replacement, type, remove);
    container.append(row);
  }
}

async function saveNamingSettings() {
  const button = $('#save-settings');
  setBusy(button, true);
  try {
    const result = await api('/api/settings', { method: 'PUT', body: { settings: collectSettingsForm() } });
    state.settings = result.settings;
    state.savedSettings = structuredClone(result.settings);
    fillSettingsForm(state.settings);
    $('#scan-depth').value = String(state.settings.scan.maxDepth);
    $('#rename-folders').checked = state.settings.renaming.renameFolders;
    $('#quarantine-ads').checked = state.settings.cleanup.quarantineJunk;
    $('#archive-by-actor').checked = state.settings.organization.archiveByActor;
    syncArchiveControls();
    if (state.root) {
      switchView('workspace');
      await scan({ silent: true });
      toast('配置已保存，并已重新计算当前批次');
    } else {
      toast('命名配置已保存');
    }
  } catch (error) {
    toast(error.message, 'error');
    scheduleSettingsPreview(0);
  } finally {
    setBusy(button, false);
  }
}

function openCorrectionDialog(item = null) {
  state.correctionItemId = item?.id || '';
  $('#correction-dialog-title').textContent = item ? '记住这次矫正' : '新建矫正规则';
  $('#correction-pattern').value = item?.manualCorrection?.source || item?.detectedCode || item?.cleanedStem || '';
  $('#correction-replacement').value = item?.manualCorrection?.target || item?.code || '';
  $('#correction-type').value = 'exact';
  $('#correction-retrospective').checked = Boolean(state.root);
  $('#correction-retrospective').disabled = !state.root;
  $('#correction-dialog').showModal();
}

async function saveCorrectionRule() {
  const pattern = $('#correction-pattern').value.trim();
  const replacement = $('#correction-replacement').value.trim();
  if (!pattern || !replacement) return toast('匹配值和替换值都不能为空', 'error');
  const button = $('#save-correction');
  const retrospective = $('#correction-retrospective').checked && Boolean(state.root);
  setBusy(button, true);
  try {
    const isRegex = $('#correction-type').value === 'regex';
    const rule = {
      id: globalThis.crypto?.randomUUID?.() || `rule-${Date.now()}`,
      pattern,
      replacement,
      isRegex,
      enabled: true,
    };
    const result = await api('/api/settings/correction', { method: 'POST', body: { rule } });
    state.savedSettings = structuredClone(result.settings);
    state.settings.corrections = structuredClone(result.settings.corrections);
    const correctedItem = state.items.find((item) => item.id === state.correctionItemId);
    if (correctedItem) delete correctedItem.manualCorrection;
    $('#correction-dialog').close();
    renderCorrectionRules();
    scheduleSettingsPreview(0);
    if (retrospective) {
      switchView('workspace');
      await scan({ silent: true });
      toast('矫正规则已保存，并已回溯当前批次');
    } else {
      renderRows();
      toast('矫正规则已保存，将在后续扫描中生效');
    }
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function toggleSelected(id, selected) {
  if (selected) state.selected.add(id);
  else state.selected.delete(id);
  updateSelectionState();
}

function updateSelectionState() {
  const visible = filteredItems();
  const visibleSelected = visible.filter((item) => state.selected.has(item.id)).length;
  $('#select-all').checked = visible.length > 0 && visibleSelected === visible.length;
  $('#select-all').indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
  $('#selection-bar').hidden = state.selected.size === 0 || state.activeView !== 'workspace';
  $('#selected-count').textContent = state.selected.size;
}

function syncArchiveControls() {
  const archiveEnabled = $('#archive-by-actor').checked;
  const renameFolders = $('#rename-folders');
  renameFolders.disabled = archiveEnabled;
  if (archiveEnabled) renameFolders.checked = false;
  renameFolders.closest('label').title = archiveEnabled
    ? '按演员归档已经包含影片文件夹命名，因此无需再单独重命名所在文件夹'
    : '按文件夹模板修改当前影片文件夹名称，不改变上级目录';
}

function splitList(value) {
  return value.split(/[,，\n]/).map((entry) => entry.trim()).filter(Boolean);
}

function emptyMetadata(item) {
  return {
    code: item.code,
    title: '',
    originalTitle: '',
    releaseDate: '',
    runtime: null,
    studio: '',
    director: '',
    series: '',
    actors: [],
    genres: [],
    coverUrl: '',
    sourceUrl: '',
  };
}

function fillMetadataForm(item) {
  const metadata = item.metadata || emptyMetadata(item);
  $('#inspector-code').textContent = item.code || '番号待确认';
  $('#meta-title').value = metadata.title || '';
  $('#meta-date').value = metadata.releaseDate || '';
  $('#meta-runtime').value = metadata.runtime || '';
  $('#meta-studio').value = metadata.studio || '';
  $('#meta-director').value = metadata.director || '';
  $('#meta-series').value = metadata.series || '';
  $('#meta-actors').value = (metadata.actors || []).join('，');
  $('#meta-genres').value = (metadata.genres || []).join('，');
  $('#metadata-origin').textContent = metadata.sourceUrl ? '在线刮削' : item.metadata ? '本地资料' : '本地草稿';
  const image = $('#cover-image');
  const placeholder = $('#cover-placeholder');
  if (metadata.coverUrl) {
    image.src = metadata.coverUrl;
    image.hidden = false;
    placeholder.hidden = true;
    image.onerror = () => { image.hidden = true; placeholder.hidden = false; };
  } else {
    image.removeAttribute('src');
    image.hidden = true;
    placeholder.hidden = false;
  }
}

function collectMetadata(item) {
  const current = item.metadata || emptyMetadata(item);
  return {
    ...current,
    code: item.code,
    title: $('#meta-title').value.trim(),
    originalTitle: current.originalTitle || $('#meta-title').value.trim(),
    releaseDate: $('#meta-date').value.trim(),
    runtime: Number($('#meta-runtime').value) || null,
    studio: $('#meta-studio').value.trim(),
    director: $('#meta-director').value.trim(),
    series: $('#meta-series').value.trim(),
    actors: splitList($('#meta-actors').value),
    genres: splitList($('#meta-genres').value),
  };
}

function openInspector(id) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  if (state.activeId) {
    const previous = state.items.find((entry) => entry.id === state.activeId);
    if (previous && !$('#inspector-content').hidden) previous.metadata = collectMetadata(previous);
  }
  state.activeId = id;
  $('#inspector-empty').hidden = true;
  $('#inspector-content').hidden = false;
  $('#inspector').classList.add('open');
  fillMetadataForm(item);
  renderRows();
}

async function scan(options = {}) {
  const button = $('#scan-button');
  const root = $('#root-path').value.trim();
  if (!root) return toast('请先选择扫描目录', 'error');
  const logTask = options.logTask ?? !options.silent;
  if (logTask) startTask('扫描媒体目录', 1, `正在扫描 ${root}`);
  setBusy(button, true);
  try {
    const result = await api('/api/scan', {
      method: 'POST',
      body: { root, options: { recursive: true, maxDepth: Number($('#scan-depth').value) } },
    });
    state.root = result.root;
    state.items = result.items;
    state.summary = result.summary;
    state.selected.clear();
    state.activeId = '';
    $('#inspector-empty').hidden = false;
    $('#inspector-content').hidden = true;
    $('#scan-meta').textContent = `${new Date(result.scannedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${result.root}`;
    renderAll();
    if (logTask) {
      appendTaskLog(`找到 ${result.summary.videos} 个视频、${result.summary.folders} 个影片文件夹`);
      appendTaskLog(`缺字幕 ${result.summary.missingSubtitles} 项，广告杂质 ${(result.summary.junk || 0) + (result.summary.filenameAds || 0)} 项`, 'muted');
      finishTask('扫描完成');
    }
    if (!options.silent) toast(`扫描完成：找到 ${result.summary.videos} 个视频`);
  } catch (error) {
    if (logTask) finishTask(`扫描失败：${error.message}`, 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function buildRenameActions() {
  const activeItem = state.items.find((item) => item.id === state.activeId);
  if (activeItem && !$('#inspector-content').hidden) {
    activeItem.metadata = collectMetadata(activeItem);
    updateSuggestedNames(activeItem, activeItem.code);
  }
  const selectedItems = state.items.filter((item) => state.selected.has(item.id));
  const actions = [];
  const seenSources = new Set();
  for (const item of selectedItems) {
    actions.push({ source: item.path, targetName: item.suggestedName, kind: 'file' });
    seenSources.add(item.path.toLowerCase());
    for (const subtitle of item.subtitles) {
      if (seenSources.has(subtitle.path.toLowerCase())) continue;
      actions.push({ source: subtitle.path, targetName: subtitle.suggestedName, kind: 'file' });
      seenSources.add(subtitle.path.toLowerCase());
    }
  }

  if ($('#quarantine-ads').checked) {
    for (const item of selectedItems) {
      for (const junk of item.junk || []) {
        const source = typeof junk === 'string' ? joinLocalPath(item.folder, junk) : junk.path;
        if (!source || seenSources.has(source.toLowerCase())) continue;
        actions.push({ source, kind: 'quarantine' });
        seenSources.add(source.toLowerCase());
      }
    }
  }

  if ($('#archive-by-actor').checked) {
    const groups = new Map();
    for (const item of selectedItems) {
      if (!groups.has(item.folder)) groups.set(item.folder, []);
      groups.get(item.folder).push(item);
    }
    for (const [folder, items] of groups) {
      items.forEach(updateArchiveSuggestion);
      const allFolderItems = state.items.filter((item) => item.folder.toLowerCase() === folder.toLowerCase());
      const targets = new Set(items.map((item) => item.archiveTargetFolder).filter(Boolean));
      let error = '';
      if (allFolderItems.length !== items.length) error = '按演员归档需要选择该文件夹内的全部影片';
      else if (!targets.size) error = '缺少演员资料，请先刮削或手工补全演员';
      else if (targets.size !== 1) error = '同一文件夹内的影片会归档到不同演员目录';
      else if (folder.toLowerCase() === state.root.toLowerCase()) error = '扫描根目录不能作为单部影片文件夹移动';
      actions.push({
        source: folder,
        targetPath: targets.size === 1 ? [...targets][0] : folder,
        kind: 'directory-move',
        error,
      });
    }
  } else if ($('#rename-folders').checked) {
    const groups = new Map();
    for (const item of selectedItems) {
      if (!groups.has(item.folder)) groups.set(item.folder, []);
      groups.get(item.folder).push(item);
    }
    for (const [folder, items] of groups) {
      const targets = new Set(items.map((item) => item.folderSuggestedName).filter(Boolean));
      if (targets.size !== 1) continue;
      actions.push({ source: folder, targetName: [...targets][0], kind: 'directory' });
    }
  }
  return actions;
}

function renderPreview(preview) {
  const errors = preview.actions.filter((action) => action.error).length;
  $('#preview-summary').replaceChildren();
  const summary = document.createElement('span');
  const strong = create('strong', '', `${preview.changes} 项可执行`);
  summary.append(strong, document.createTextNode(errors ? `，${errors} 项将跳过` : '，未发现冲突'));
  $('#preview-summary').append(summary);
  const list = $('#preview-list');
  list.replaceChildren();
  for (const action of preview.actions) {
    const entry = create('div', `preview-entry ${action.error ? 'error' : ''} ${action.noop ? 'noop' : ''}`.trim());
    entry.append(create('span', 'entry-state', action.error ? '跳过' : action.noop ? '不变' : '执行'));
    const detail = document.createElement('div');
    const actionLabels = { quarantine: '隔离', 'directory-move': '归档', directory: '文件夹', file: '重命名' };
    detail.append(create('div', 'source-name', `${actionLabels[action.kind] || '整理'} · ${action.source}`));
    detail.append(create('div', 'target-name', action.noop ? '名称不变' : action.target));
    if (action.error) detail.append(create('div', 'entry-error', action.error));
    entry.append(detail);
    list.append(entry);
  }
  $('#apply-rename').disabled = preview.changes === 0;
  $('#apply-rename').textContent = preview.changes ? `执行 ${preview.changes} 项` : '没有可执行项';
}

async function previewRename() {
  const button = $('#preview-rename');
  const actions = buildRenameActions();
  if (!actions.length) return toast('所选项目没有可预览的文件', 'error');
  setBusy(button, true);
  try {
    const preview = await api('/api/rename/preview', { method: 'POST', body: { root: state.root, actions } });
    state.previewActions = actions;
    state.previewResult = preview;
    renderPreview(preview);
    $('#preview-dialog').showModal();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function applyRename() {
  const button = $('#apply-rename');
  const expected = state.previewResult?.changes || state.previewActions.length;
  startTask('执行整理', expected, '正在重新校验整理项');
  setBusy(button, true);
  try {
    const result = await api('/api/rename/apply', { method: 'POST', body: { root: state.root, actions: state.previewActions, skipErrors: true } });
    for (const action of result.actions) appendTaskLog(describeTaskAction(action), 'success');
    for (const action of result.skippedActions || []) appendTaskLog(`已跳过：${basename(action.source)}；${action.error}`, 'error');
    updateTaskProgress(result.renamed, result.renamed, '正在刷新扫描结果');
    const rootAction = result.actions.find((action) => action.kind === 'directory' && action.source.toLowerCase() === state.root.toLowerCase());
    if (rootAction) {
      state.root = rootAction.target;
      $('#root-path').value = state.root;
    }
    $('#preview-dialog').close();
    const resultMessage = `整理完成：执行 ${result.renamed} 项，跳过 ${result.skipped || 0} 项`;
    finishTask(resultMessage, result.skipped ? 'muted' : 'success');
    toast(resultMessage);
    await scan({ silent: true, logTask: false });
  } catch (error) {
    if (error.details) renderPreview(error.details);
    finishTask(`整理失败：${error.message}`, 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function scrapeItem(item, quiet = false) {
  if (!item.code) throw new Error(`${item.name} 尚未填写番号`);
  const result = await api('/api/scrape', {
    method: 'POST',
    body: { code: item.code, provider: $('#scrape-provider').value || 'javbus' },
  });
  item.metadata = result.metadata;
  updateSuggestedNames(item, item.code);
  if (item.id === state.activeId) fillMetadataForm(item);
  if (!quiet) toast(`${item.code} 刮削完成`);
  return result.metadata;
}

async function scrapeActive() {
  const item = state.items.find((entry) => entry.id === state.activeId);
  if (!item) return;
  const button = $('#scrape-button');
  startTask('刮削影片资料', 1, `正在查询 ${item.code || item.name}`);
  setBusy(button, true);
  try {
    await scrapeItem(item);
    appendTaskLog(`${item.code}：资料已更新`, 'success');
    finishTask('刮削完成');
    renderRows();
  } catch (error) {
    finishTask(`刮削失败：${error.message}`, 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function batchScrape() {
  const items = state.items.filter((item) => state.selected.has(item.id));
  const actionable = items.filter((item) => item.code);
  if (!actionable.length) return toast('所选项目没有可查询的番号', 'error');
  const button = $('#batch-scrape');
  startTask('批量刮削', actionable.length, `准备刮削 ${actionable.length} 个番号`);
  if (items.length > actionable.length) appendTaskLog(`忽略 ${items.length - actionable.length} 个未填写番号的项目`, 'muted');
  setBusy(button, true);
  let success = 0;
  const failures = [];
  for (const [index, item] of actionable.entries()) {
    updateTaskProgress(index, actionable.length, `正在刮削 ${item.code}`);
    appendTaskLog(`开始查询 ${item.code}`);
    try {
      await scrapeItem(item, true);
      success += 1;
      appendTaskLog(`${item.code}：刮削成功`, 'success');
    } catch (error) {
      failures.push(`${item.code}: ${error.message}`);
      appendTaskLog(`${item.code}：${error.message}`, 'error');
    }
    updateTaskProgress(index + 1, actionable.length, `已处理 ${index + 1} / ${actionable.length}`);
  }
  setBusy(button, false);
  renderRows();
  const message = failures.length ? `刮削完成：成功 ${success} 项，失败 ${failures.length} 项` : `刮削完成：成功 ${success} 项`;
  finishTask(message, failures.length ? 'error' : 'success');
  toast(message, failures.length ? 'error' : 'success');
}

async function saveActiveMetadata() {
  const item = state.items.find((entry) => entry.id === state.activeId);
  if (!item || !item.code) return toast('请先确认影片番号', 'error');
  const button = $('#save-metadata');
  item.metadata = collectMetadata(item);
  setBusy(button, true);
  try {
    const result = await api('/api/metadata/save', {
      method: 'POST',
      body: {
        folder: item.folder,
        code: item.code,
        metadata: item.metadata,
        overwrite: $('#overwrite-metadata').checked,
        downloadCover: $('#download-cover').checked,
      },
    });
    item.metadata = result.metadata;
    updateSuggestedNames(item, item.code);
    fillMetadataForm(item);
    renderRows();
    toast(result.coverError ? `资料已保存；${result.coverError}` : 'NFO、JSON 与封面已保存');
  } catch (error) {
    const message = /EEXIST/.test(error.message) ? '资料文件已存在；勾选覆盖后再保存' : error.message;
    toast(message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function libraryModeLabel(mode = state.libraryMode) {
  return { copy: '复制', move: '移动', hardlink: '硬链接' }[mode] || '复制';
}

function currentLibraryRequest() {
  return {
    sourceDirectories: [...state.librarySources],
    outputDirectory: state.libraryOutput.trim(),
    fileMode: state.libraryMode,
    maxDepth: Number(state.savedSettings?.scan?.maxDepth) || 3,
  };
}

async function persistLibraryConfiguration() {
  if (!state.savedSettings) return;
  const settings = structuredClone(state.savedSettings);
  settings.library = {
    sources: [...state.librarySources],
    outputDirectory: state.libraryOutput.trim(),
    fileMode: state.libraryMode,
  };
  const result = await api('/api/settings', { method: 'PUT', body: { settings } });
  state.savedSettings = structuredClone(result.settings);
  state.settings = structuredClone(result.settings);
}

function markLibraryConfigurationChanged() {
  state.libraryMovies = [];
  state.librarySummary = null;
  state.librarySelected.clear();
  state.libraryPreview = null;
  state.libraryEffectiveOutput = '';
  $('#library-index-meta').textContent = '目录配置已更改，请刷新片库';
  renderLibrary();
}

function renderLibraryConfiguration() {
  const list = $('#library-source-list');
  list.replaceChildren();
  for (const source of state.librarySources) {
    const row = create('div', 'library-source-row');
    const value = create('code', '', source);
    value.title = source;
    const remove = create('button', 'icon-button library-source-remove', '×');
    remove.type = 'button';
    remove.title = '移除此来源';
    remove.setAttribute('aria-label', `移除来源 ${source}`);
    remove.addEventListener('click', async () => {
      state.librarySources = state.librarySources.filter((entry) => entry !== source);
      markLibraryConfigurationChanged();
      renderLibraryConfiguration();
      try {
        await persistLibraryConfiguration();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    row.append(value, remove);
    list.append(row);
  }
  $('#library-source-empty').hidden = state.librarySources.length > 0;
  $('#library-output').value = state.libraryOutput;
  const effective = state.libraryEffectiveOutput
    || (state.libraryOutput.trim() || (state.librarySources[0] ? joinLocalPath(state.librarySources[0], '整理完成') : ''));
  $('#library-output-effective').textContent = effective ? `实际输出：${effective}` : '';
  document.querySelectorAll('input[name="library-mode"]').forEach((input) => { input.checked = input.value === state.libraryMode; });
}

function filteredLibraryMovies() {
  const query = state.libraryQuery.toLowerCase();
  if (!query) return state.libraryMovies;
  return state.libraryMovies.filter((movie) => {
    const text = [movie.code, movie.title, movie.studio, ...(movie.actors || [])].join(' ').toLowerCase();
    return text.includes(query);
  });
}

function updateLibrarySelectionState() {
  const validIds = new Set(state.libraryMovies.map((movie) => movie.id));
  for (const id of state.librarySelected) {
    if (!validIds.has(id)) state.librarySelected.delete(id);
  }
  const visible = filteredLibraryMovies();
  const selectedVisible = visible.filter((movie) => state.librarySelected.has(movie.id)).length;
  const selectAll = $('#library-select-all');
  selectAll.checked = visible.length > 0 && selectedVisible === visible.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  $('#library-selected-count').textContent = state.librarySelected.size;
  $('#library-selection-bar').hidden = state.activeView !== 'library' || state.librarySelected.size === 0;
}

function renderLibrarySummary() {
  const summary = state.librarySummary || { movies: 0, files: 0, duplicateFiles: 0, missingActors: 0, unmatchedFiles: 0 };
  $('#library-summary-movies').textContent = summary.movies;
  $('#library-summary-files').textContent = summary.files;
  $('#library-summary-duplicates').textContent = summary.duplicateFiles;
  $('#library-summary-actors').textContent = summary.missingActors;
  $('#library-summary-unmatched').textContent = summary.unmatchedFiles;
}

function renderLibraryCards() {
  const movies = filteredLibraryMovies();
  const grid = $('#library-grid');
  grid.replaceChildren();
  $('#library-result-count').textContent = `${movies.length} 部影片`;
  const empty = $('#library-empty');
  empty.hidden = movies.length > 0;
  if (!movies.length) {
    empty.querySelector('strong').textContent = state.libraryMovies.length ? '没有匹配的影片' : '片库尚未建立';
    empty.querySelector('span').textContent = state.libraryMovies.length ? '调整搜索条件后重试' : '添加来源目录后刷新片库';
  }

  for (const movie of movies) {
    const card = create('article', `library-card ${state.librarySelected.has(movie.id) ? 'selected' : ''}`.trim());
    const checkLabel = create('label', 'library-card-check');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.librarySelected.has(movie.id);
    checkbox.setAttribute('aria-label', `选择 ${movie.code}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.librarySelected.add(movie.id);
      else state.librarySelected.delete(movie.id);
      card.classList.toggle('selected', checkbox.checked);
      updateLibrarySelectionState();
    });
    checkLabel.append(checkbox);

    const poster = create('div', 'library-poster');
    const placeholder = create('div', 'library-poster-placeholder', movie.code);
    if (movie.posterUrl) {
      const image = document.createElement('img');
      image.src = movie.posterUrl;
      image.alt = `${movie.code} 海报`;
      image.loading = 'lazy';
      placeholder.hidden = true;
      image.addEventListener('error', () => { image.hidden = true; placeholder.hidden = false; });
      poster.append(image, placeholder);
    } else {
      poster.append(placeholder);
    }
    const badges = create('div', 'library-card-badges');
    if (movie.variants > 1) badges.append(create('span', '', `${movie.variants} 版本`));
    if (movie.duplicateFiles) badges.append(create('span', 'duplicate', `重复 ${movie.duplicateFiles}`));
    poster.append(badges);

    const body = create('div', 'library-card-body');
    body.append(create('div', 'library-card-code', movie.code));
    body.append(create('div', 'library-card-title', movie.title || movie.code));
    const actorText = movie.actors?.length ? movie.actors.join('、') : '待补演员';
    body.append(create('div', `library-card-actor ${movie.actors?.length ? '' : 'missing'}`.trim(), actorText));
    const meta = create('div', 'library-card-meta');
    meta.append(create('span', '', movie.studio || '未填写片商'), create('span', '', `${movie.files.length} 个文件`));
    body.append(meta);
    card.append(checkLabel, poster, body);
    grid.append(card);
  }
  updateLibrarySelectionState();
}

function renderLibrary() {
  renderLibraryConfiguration();
  renderLibrarySummary();
  renderLibraryCards();
}

async function refreshLibrary(options = {}) {
  if (!state.librarySources.length) return toast('请先添加至少一个来源目录', 'error');
  const button = $('#index-library');
  const logTask = options.logTask !== false;
  if (logTask) startTask('建立片库索引', state.librarySources.length + 2, `准备扫描 ${state.librarySources.length} 个来源目录`);
  setBusy(button, true);
  try {
    state.libraryOutput = $('#library-output').value.trim();
    await persistLibraryConfiguration();
    if (logTask) appendTaskLog(`输出目录：${state.libraryOutput || joinLocalPath(state.librarySources[0], '整理完成')}`, 'muted');
    const result = await api('/api/library/index', { method: 'POST', body: currentLibraryRequest() });
    state.libraryMovies = result.movies;
    state.librarySummary = result.summary;
    state.libraryEffectiveOutput = result.outputDirectory;
    state.librarySelected.clear();
    state.libraryPreview = null;
    $('#library-index-meta').textContent = `${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · ${result.sources.length} 个来源 · ${result.outputDirectory}`;
    renderLibrary();
    if (logTask) {
      result.logs.forEach((message, index) => {
        appendTaskLog(message, index === result.logs.length - 1 ? 'success' : '');
        updateTaskProgress(index + 1, result.logs.length, message);
      });
      finishTask(`索引完成：${result.summary.movies} 部影片`);
      toast(`片库已更新：${result.summary.movies} 部影片`);
    }
  } catch (error) {
    if (logTask) finishTask(`片库索引失败：${error.message}`, 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

function renderLibraryCollectionPreview(preview) {
  const summary = $('#library-collect-summary');
  summary.replaceChildren();
  const text = document.createElement('span');
  text.append(
    create('strong', '', `${preview.summary.ready} 项可${preview.fileModeLabel}`),
    document.createTextNode(`，${preview.summary.duplicates} 项重复跳过，${preview.summary.errors} 项错误`),
  );
  summary.append(text);
  const list = $('#library-collect-list');
  list.replaceChildren();
  const kindLabels = { video: '视频', subtitle: '字幕', companion: '资料' };
  for (const action of preview.actions) {
    const className = action.status === 'error' ? 'error' : action.status === 'duplicate' ? 'duplicate noop' : '';
    const entry = create('div', `preview-entry ${className}`.trim());
    const stateLabel = action.status === 'ready' ? preview.fileModeLabel : action.status === 'duplicate' ? '重复' : '跳过';
    entry.append(create('span', 'entry-state', stateLabel));
    const detail = document.createElement('div');
    detail.append(create('div', 'source-name', `${kindLabels[action.kind] || '文件'} · ${action.source}`));
    detail.append(create('div', 'target-name', action.target || '不创建目标文件'));
    if (action.reason) detail.append(create('div', 'entry-error', action.reason));
    entry.append(detail);
    list.append(entry);
  }
  $('#apply-library-collect').disabled = preview.summary.ready === 0;
  $('#apply-library-collect').textContent = preview.summary.ready
    ? `${preview.fileModeLabel} ${preview.summary.ready} 项`
    : '没有可执行项';
}

async function previewLibraryCollection() {
  if (!state.librarySelected.size) return toast('请先选择要归集的影片', 'error');
  const button = $('#preview-library-collect');
  startTask('生成归集预览', state.librarySelected.size + 1, `正在核对 ${state.librarySelected.size} 部影片`);
  setBusy(button, true);
  try {
    state.libraryOutput = $('#library-output').value.trim();
    await persistLibraryConfiguration();
    const result = await api('/api/library/collect/preview', {
      method: 'POST',
      body: { ...currentLibraryRequest(), movieIds: [...state.librarySelected] },
    });
    state.libraryPreview = result;
    result.logs.forEach((message, index) => {
      appendTaskLog(message, index === result.logs.length - 1 ? 'success' : '');
      updateTaskProgress(index + 1, result.logs.length, message);
    });
    finishTask(`预览完成：${result.summary.ready} 项可执行`);
    renderLibraryCollectionPreview(result);
    $('#library-collect-dialog').showModal();
  } catch (error) {
    finishTask(`归集预览失败：${error.message}`, 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function applyLibraryCollection() {
  const preview = state.libraryPreview;
  if (!preview?.summary.ready) return;
  const button = $('#apply-library-collect');
  startTask(`执行${libraryModeLabel(preview.fileMode)}`, preview.summary.ready, `准备处理 ${preview.summary.ready} 个文件`);
  setBusy(button, true);
  try {
    const result = await api('/api/library/collect/apply', { method: 'POST', body: preview });
    result.results.forEach((entry, index) => {
      const message = entry.status === 'done'
        ? `${entry.message}：${basename(entry.source)} → ${entry.target}`
        : `处理失败：${basename(entry.source)}；${entry.message}`;
      appendTaskLog(message, entry.status === 'done' ? 'success' : 'error');
      updateTaskProgress(index + 1, result.results.length, message);
    });
    $('#library-collect-dialog').close();
    const message = `归集完成：成功 ${result.completed} 项，失败 ${result.failed} 项`;
    finishTask(message, result.failed ? 'error' : 'success');
    toast(message, result.failed ? 'error' : 'success');
    await refreshLibrary({ logTask: false });
  } catch (error) {
    finishTask(`归集失败：${error.message}`, 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(button, false);
  }
}

async function initialize() {
  try {
    const [config, settingsResult] = await Promise.all([api('/api/config'), api('/api/settings')]);
    state.config = config;
    state.settings = settingsResult.settings;
    state.savedSettings = structuredClone(settingsResult.settings);
    state.defaultSettings = settingsResult.defaults;
    state.settingsFilePath = settingsResult.filePath;
    state.librarySources = [...(state.savedSettings.library?.sources || [])];
    state.libraryOutput = state.savedSettings.library?.outputDirectory || '';
    state.libraryMode = state.savedSettings.library?.fileMode || 'copy';
    $('#root-path').value = state.config.defaultRoot;
    $('#settings-path').textContent = state.settingsFilePath;
    fillSettingsForm(state.settings);
    $('#scan-depth').value = String(state.settings.scan.maxDepth);
    $('#rename-folders').checked = state.settings.renaming.renameFolders;
    $('#quarantine-ads').checked = state.settings.cleanup.quarantineJunk;
    $('#archive-by-actor').checked = state.settings.organization.archiveByActor;
    syncArchiveControls();
    renderLibrary();
    const providerSelect = $('#scrape-provider');
    for (const provider of state.config.providers) {
      const option = document.createElement('option');
      option.value = provider.id;
      option.textContent = provider.name;
      providerSelect.append(option);
    }
    const initialView = location.hash.replace('#', '');
    switchView(['workspace', 'library', 'settings', 'guide'].includes(initialView) ? initialView : 'workspace');
  } catch (error) {
    toast(`本地服务连接失败：${error.message}`, 'error');
  }
}

$('#scan-button').addEventListener('click', scan);
$('#root-path').addEventListener('keydown', (event) => { if (event.key === 'Enter') scan(); });
$('#pick-directory').addEventListener('click', async () => {
  const button = $('#pick-directory');
  setBusy(button, true);
  try {
    await openDirectoryBrowser();
  } finally {
    setBusy(button, false);
  }
});
$('#directory-path').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadDirectory(event.currentTarget.value.trim());
});
$('#directory-go').addEventListener('click', () => loadDirectory($('#directory-path').value.trim()));
$('#directory-up').addEventListener('click', () => {
  if (state.directoryBrowser?.parent) loadDirectory(state.directoryBrowser.parent);
});
$('#close-directory').addEventListener('click', () => $('#directory-dialog').close());
$('#cancel-directory').addEventListener('click', () => $('#directory-dialog').close());
$('#select-directory').addEventListener('click', () => {
  if (!state.directoryBrowser?.current) return;
  const selected = state.directoryBrowser.current;
  if (state.directoryPickerTarget === 'library-source') {
    if (state.librarySources.includes(selected)) {
      $('#directory-dialog').close();
      return toast('这个来源目录已经添加', 'error');
    }
    state.librarySources.push(selected);
    markLibraryConfigurationChanged();
    renderLibraryConfiguration();
    persistLibraryConfiguration().catch((error) => toast(error.message, 'error'));
    toast('已添加片库来源目录');
  } else if (state.directoryPickerTarget === 'library-output') {
    state.libraryOutput = selected;
    state.libraryEffectiveOutput = selected;
    state.libraryPreview = null;
    renderLibraryConfiguration();
    persistLibraryConfiguration().catch((error) => toast(error.message, 'error'));
    toast('已设置输出目录');
  } else {
    $('#root-path').value = selected;
    toast('已选择目录，可以开始扫描');
  }
  $('#directory-dialog').close();
});
$('#table-search').addEventListener('input', (event) => { state.query = event.target.value.trim(); renderRows(); });
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((entry) => { entry.classList.toggle('active', entry === tab); entry.setAttribute('aria-selected', entry === tab ? 'true' : 'false'); });
  state.filter = tab.dataset.filter;
  renderRows();
}));
$('#select-all').addEventListener('change', (event) => {
  for (const item of filteredItems()) {
    if (event.target.checked) state.selected.add(item.id);
    else state.selected.delete(item.id);
  }
  renderRows();
});
$('#preview-rename').addEventListener('click', previewRename);
$('#archive-by-actor').addEventListener('change', syncArchiveControls);
$('#close-task-panel').addEventListener('click', () => { $('#task-panel').hidden = true; });
$('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#cancel-preview').addEventListener('click', () => $('#preview-dialog').close());
$('#apply-rename').addEventListener('click', applyRename);
$('#scrape-button').addEventListener('click', scrapeActive);
$('#batch-scrape').addEventListener('click', batchScrape);
$('#save-metadata').addEventListener('click', saveActiveMetadata);
$('#close-inspector').addEventListener('click', () => $('#inspector').classList.remove('open'));
document.querySelectorAll('.top-nav-button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
document.querySelectorAll('[data-view-link]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.viewLink)));
document.querySelectorAll('.template-input').forEach((input) => {
  input.addEventListener('focus', () => { state.focusedTemplateInput = input; });
  input.addEventListener('input', () => scheduleSettingsPreview());
});
['#setting-code-case', '#setting-scan-depth', '#setting-rename-folders', '#setting-quarantine-junk', '#setting-archive-by-actor', '#setting-ad-keywords'].forEach((selector) => {
  $(selector).addEventListener('input', () => scheduleSettingsPreview());
});
document.querySelectorAll('.token-toolbar button').forEach((button) => button.addEventListener('click', () => {
  const input = state.focusedTemplateInput || $('#setting-video-template');
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = `${input.value.slice(0, start)}${button.dataset.token}${input.value.slice(end)}`;
  input.focus();
  input.setSelectionRange(start + button.dataset.token.length, start + button.dataset.token.length);
  scheduleSettingsPreview(0);
}));
$('#save-settings').addEventListener('click', saveNamingSettings);
$('#reset-settings').addEventListener('click', () => {
  state.settings = structuredClone(state.defaultSettings);
  fillSettingsForm(state.settings);
  scheduleSettingsPreview(0);
  toast('已恢复默认草稿，点击保存后生效');
});
$('#new-correction').addEventListener('click', () => openCorrectionDialog());
$('#close-correction').addEventListener('click', () => $('#correction-dialog').close());
$('#cancel-correction').addEventListener('click', () => $('#correction-dialog').close());
$('#save-correction').addEventListener('click', saveCorrectionRule);

$('#add-library-source').addEventListener('click', () => openDirectoryBrowser('library-source'));
$('#pick-library-output').addEventListener('click', () => openDirectoryBrowser('library-output'));
$('#library-output').addEventListener('change', async (event) => {
  state.libraryOutput = event.currentTarget.value.trim();
  state.libraryEffectiveOutput = '';
  state.libraryPreview = null;
  renderLibraryConfiguration();
  try {
    await persistLibraryConfiguration();
  } catch (error) {
    toast(error.message, 'error');
  }
});
document.querySelectorAll('input[name="library-mode"]').forEach((input) => input.addEventListener('change', async (event) => {
  if (!event.currentTarget.checked) return;
  state.libraryMode = event.currentTarget.value;
  state.libraryPreview = null;
  try {
    await persistLibraryConfiguration();
    toast(`文件处理方式已设为${libraryModeLabel()}`);
  } catch (error) {
    toast(error.message, 'error');
  }
}));
$('#index-library').addEventListener('click', () => refreshLibrary());
$('#library-search').addEventListener('input', (event) => {
  state.libraryQuery = event.currentTarget.value.trim();
  renderLibraryCards();
});
$('#library-select-all').addEventListener('change', (event) => {
  for (const movie of filteredLibraryMovies()) {
    if (event.currentTarget.checked) state.librarySelected.add(movie.id);
    else state.librarySelected.delete(movie.id);
  }
  renderLibraryCards();
});
$('#preview-library-collect').addEventListener('click', previewLibraryCollection);
$('#close-library-collect').addEventListener('click', () => $('#library-collect-dialog').close());
$('#cancel-library-collect').addEventListener('click', () => $('#library-collect-dialog').close());
$('#apply-library-collect').addEventListener('click', applyLibraryCollection);

initialize();
