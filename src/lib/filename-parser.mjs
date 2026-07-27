/**
 * 纯函数形式的文件名领域服务：输入字符串和配置，输出解析/命名结果，不访问文件系统。
 * Java 开发中可以把它理解为无状态的 Parser + NamingPolicy。
 */
import path from 'node:path';

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s[\](){}]+|\b[a-z0-9-]+\.(?:com|net|org|cc|xyz|top|me|tv|cn)\b/gi;
const AD_PATTERN = /\b(?:hexjs|hhd800|bbs2048|thzu|javbus|javdb|sexinsex|sis001|yase|u9a9|fulibus|1024)\b/gi;
const INVALID_FILENAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/g;

// 规则按“供应商专用 -> 通用 -> 紧凑通用”排序；首次命中即返回，调整顺序会改变识别结果。
const CODE_RULES = [
  {
    id: 'fc2',
    pattern: /\bfc2(?:[-_.\s]*ppv)?[-_.\s]*(\d{5,9})\b/i,
    normalize: ([number]) => `FC2-PPV-${number}`,
    confidence: 0.99,
  },
  {
    id: '1pondo',
    pattern: /\b1pondo[-_.\s]*(\d{4,8})[-_.\s]+(\d{2,4})\b/i,
    normalize: ([date, sequence]) => `1PONDO-${date}-${sequence}`,
    confidence: 0.99,
  },
  {
    id: 'caribbeancom',
    pattern: /\b(?:caribbeancom|carib)[-_.\s]*(\d{4,8})[-_.\s]+(\d{2,4})\b/i,
    normalize: ([date, sequence]) => `CARIB-${date}-${sequence}`,
    confidence: 0.98,
  },
  {
    id: '10musume',
    pattern: /\b10musume[-_.\s]*(\d{4,8})[-_.\s]+(\d{1,4})\b/i,
    normalize: ([date, sequence]) => `10MUSUME-${date}-${sequence.padStart(2, '0')}`,
    confidence: 0.98,
  },
  {
    id: 'pacopacomama',
    pattern: /\b(?:pacopacomama|paco)[-_.\s]*(\d{4,8})[-_.\s]+(\d{1,4})\b/i,
    normalize: ([date, sequence]) => `PACOPACOMAMA-${date}-${sequence}`,
    confidence: 0.98,
  },
  {
    id: 'heyzo',
    pattern: /\bheyzo[-_.\s]*(\d{3,6})\b/i,
    normalize: ([number]) => `HEYZO-${number}`,
    confidence: 0.99,
  },
  {
    id: 'tokyo-hot',
    pattern: /\b(?:tokyo[-_.\s]*hot[-_.\s]*)?(n\d{3,6})\b/i,
    normalize: ([number]) => `TOKYO-HOT-${number.toUpperCase()}`,
    confidence: 0.93,
  },
  {
    id: 'standard',
    pattern: /(?:^|[^a-z0-9])([a-z]{2,12})[-_.\s]+(\d{2,7})(?!\d)/i,
    normalize: ([prefix, number]) => `${prefix.toUpperCase()}-${number}`,
    confidence: 0.94,
  },
  {
    id: 'standard-compact',
    pattern: /(?:^|[^a-z0-9])([a-z]{2,8})(\d{3,6})(?!\d)/i,
    normalize: ([prefix, number]) => `${prefix.toUpperCase()}-${number}`,
    confidence: 0.82,
  },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findAdvertisingMatches(input, extraAdKeywords = []) {
  const source = String(input ?? '');
  const matches = [
    ...(source.match(URL_PATTERN) ?? []),
    ...(source.match(AD_PATTERN) ?? []),
  ];
  const customKeywords = extraAdKeywords.map((value) => String(value).trim()).filter(Boolean);
  if (customKeywords.length) {
    matches.push(...(source.match(new RegExp(customKeywords.map(escapeRegExp).join('|'), 'gi')) ?? []));
  }
  const unique = [...new Set(matches.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
  return unique.filter((value, index) => {
    const normalized = value.toLowerCase();
    return !unique.slice(0, index).some((candidate) => candidate.toLowerCase().includes(normalized));
  });
}

// 清理只作用于用于识别的 stem，不直接改文件名；最终名称仍需通过模板和预览生成。
export function cleanStem(input, extraAdKeywords = []) {
  let cleaned = input
    .replace(URL_PATTERN, ' ')
    .replace(/[\[【(（{].*?(?:https?:\/\/|www\.|\.com|\.net|广告|发布|最新地址).*?[\]】)）}]/gi, ' ')
    .replace(AD_PATTERN, ' ')
    .replace(/(?:^|[\s._-])(?:uncensored|leak|破解|无码|有码|中文字幕|中字|高清|hd|fhd|4k)(?=$|[\s._-])/gi, ' ')
    .replace(/[._]+/g, ' ');
  const customKeywords = extraAdKeywords.map((value) => String(value).trim()).filter(Boolean);
  if (customKeywords.length) cleaned = cleaned.replace(new RegExp(customKeywords.map(escapeRegExp).join('|'), 'gi'), ' ');
  return cleaned
    .replace(/\s+/g, ' ')
    .trim();
}

// 人工矫正规则优先于自动识别结果，相当于可持久化的 override policy。
function applyCorrectionRules(parsed, corrections = []) {
  const detectedCode = parsed.code;
  const source = detectedCode || parsed.cleanedStem;
  for (const correction of corrections) {
    if (!correction?.enabled || !correction.pattern || !correction.replacement) continue;
    if (correction.isRegex) {
      let expression;
      try {
        expression = new RegExp(correction.pattern, 'i');
      } catch {
        continue;
      }
      if (!expression.test(source)) continue;
      return {
        ...parsed,
        code: source.replace(expression, correction.replacement).trim(),
        confidence: 1,
        rule: `correction:${correction.id}`,
        detectedCode,
        correctionRuleId: correction.id,
      };
    }
    if (source.localeCompare(correction.pattern, undefined, { sensitivity: 'accent' }) !== 0) continue;
    return {
      ...parsed,
      code: correction.replacement.trim(),
      confidence: 1,
      rule: `correction:${correction.id}`,
      detectedCode,
      correctionRuleId: correction.id,
    };
  }
  return { ...parsed, detectedCode, correctionRuleId: '' };
}

/** 解析单个名称并返回番号、置信度、命中规则、分段号等结构化结果。 */
export function parseMediaName(filename, options = {}) {
  const extension = path.extname(filename);
  const originalStem = path.basename(filename, extension);
  const cleanedStem = cleanStem(originalStem, options.adKeywords ?? []);
  const partMatch = originalStem.match(/(?:^|[-_.\s])(?:cd|disc|part|pt)[-_.\s]*([1-9])(?:$|[-_.\s])/i);

  for (const rule of CODE_RULES) {
    const match = cleanedStem.match(rule.pattern) ?? originalStem.match(rule.pattern);
    if (!match) continue;

    const code = rule.normalize(match.slice(1));
    return applyCorrectionRules({
      code,
      confidence: rule.confidence,
      rule: rule.id,
      cleanedStem,
      part: partMatch ? Number(partMatch[1]) : null,
      extension: extension.toLowerCase(),
      matchedText: match[0].trim(),
    }, options.corrections);
  }

  return applyCorrectionRules({
    code: '',
    confidence: 0,
    rule: 'unmatched',
    cleanedStem,
    part: partMatch ? Number(partMatch[1]) : null,
    extension: extension.toLowerCase(),
    matchedText: '',
  }, options.corrections);
}

function formatCode(code, mode) {
  if (mode === 'lower') return code.toLowerCase();
  if (mode === 'preserve') return code;
  return code.toUpperCase();
}

function safeToken(value) {
  return String(value ?? '').replace(INVALID_FILENAME_CHARACTERS, '-').trim();
}

// 模板渲染前后都清理 Windows 非法字符，避免预览通过后在执行阶段才失败。
export function renderNamingTemplate(template, context) {
  const values = {
    code: formatCode(safeToken(context.code), context.codeCase),
    part: context.part ? `-CD${context.part}` : '',
    title: safeToken(context.metadata?.title),
    actor: safeToken(context.metadata?.actors?.[0]),
    studio: safeToken(context.metadata?.studio),
    year: safeToken(String(context.metadata?.releaseDate ?? '').match(/^\d{4}/)?.[0]),
    lang: safeToken(context.lang),
    ext: safeToken(context.ext),
    original: safeToken(context.original),
  };
  const rendered = String(template).replace(/\{([a-z]+)\}/g, (_, token) => values[token] ?? '');
  return rendered
    .replace(INVALID_FILENAME_CHARACTERS, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim();
}

export function suggestedMediaName(filename, parsed = parseMediaName(filename), naming = {}, metadata = null) {
  if (!parsed.code) return filename;
  const original = path.basename(filename, path.extname(filename));
  return renderNamingTemplate(naming.videoTemplate ?? '{code}{part}{ext}', {
    code: parsed.code,
    codeCase: naming.codeCase ?? 'upper',
    part: parsed.part,
    ext: parsed.extension,
    original,
    metadata,
  }) || filename;
}

export function subtitleLanguageSuffix(filename) {
  const stem = path.basename(filename, path.extname(filename));
  const match = stem.match(/(?:^|[._-])(zh[-_]?cn|zh[-_]?tw|chs|cht|eng?|ja|jp)(?:$|[._-])/i);
  if (!match) return '';
  const normalized = match[1].toLowerCase().replace('_', '-');
  const aliases = { chs: 'zh-CN', cht: 'zh-TW', zhcn: 'zh-CN', zhtw: 'zh-TW', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', en: 'en', eng: 'en', ja: 'ja', jp: 'ja' };
  return `.${aliases[normalized] ?? normalized}`;
}

export function suggestedSubtitleName(filename, parsed, naming = {}, metadata = null) {
  if (!parsed.code) return filename;
  const extension = path.extname(filename).toLowerCase();
  const original = path.basename(filename, extension);
  return renderNamingTemplate(naming.subtitleTemplate ?? '{code}{part}{lang}{ext}', {
    code: parsed.code,
    codeCase: naming.codeCase ?? 'upper',
    part: parsed.part,
    lang: subtitleLanguageSuffix(filename),
    ext: extension,
    original,
    metadata,
  }) || filename;
}

export function suggestedFolderName(folderName, parsed, naming = {}, metadata = null) {
  if (!parsed.code) return folderName;
  return renderNamingTemplate(naming.folderTemplate ?? '{code}', {
    code: parsed.code,
    codeCase: naming.codeCase ?? 'upper',
    part: parsed.part,
    ext: '',
    original: folderName,
    metadata,
  }) || folderName;
}
