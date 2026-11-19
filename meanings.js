const POS_LABELS = { n: 'n.', v: 'v.', a: 'adj.', s: 'adj.', r: 'adv.' };

const splitDefinitionTerms = (text) => {
  const parts = [];
  const closing = [];
  const brackets = { '(': ')', '（': '）', '[': ']', '【': '】' };
  let start = 0;
  let separator = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (brackets[character]) closing.push(brackets[character]);
    else if (character === closing.at(-1)) closing.pop();
    if (closing.length || !/[;,，；、]/u.test(character)) continue;
    parts.push({ text: text.slice(start, index).trim(), separator });
    let next = index + 1;
    while (/\s/u.test(text[next] ?? '') && next < text.length) next += 1;
    separator = text.slice(index, next);
    start = next;
    index = next - 1;
  }
  parts.push({ text: text.slice(start).trim(), separator });
  return parts;
};

const readDefinitionPrefix = (text) => {
  let body = text;
  let prefix = '';
  const labels = [];
  let match;
  while ((match = body.match(/^(\[[^\]]+\]|(?:n|v|vt|vi|a|adj|s|ad|adv|r|pron|num|prep|conj|interj|phr|pl)\.)(\s*)/iu))) {
    const label = match[1].toLowerCase();
    const normalized = ['a.', 'adj.', 's.'].includes(label) ? 'adj.' : match[1];
    prefix += normalized + match[2];
    if (!label.startsWith('[')) labels.push(normalized.toLowerCase());
    body = body.slice(match[0].length);
  }
  return { body, prefix, pos: labels.sort().join('') };
};

export const splitMeanings = (meanings) => {
  const result = [];
  const seen = new Map();
  for (const meaning of meanings) {
    for (const line of meaning.text.split(/(?:\\n|\r?\n)+/u)) {
      let text = '';
      let prefix = '';
      let pos = '';
      let groupSeparator = '';
      let groupStarted = false;
      for (const part of splitDefinitionTerms(line.trim())) {
        const parsed = readDefinitionPrefix(part.text);
        if (parsed.prefix) {
          prefix = parsed.prefix;
          pos = parsed.pos;
          groupSeparator = part.separator;
          groupStarted = false;
        }
        if (!parsed.body) continue;
        const key = parsed.body.normalize('NFKC').replace(/\s+/gu, ' ');
        const previous = seen.get(key);
        // An untyped specialist gloss adds no new definition if already listed.
        // Explicit noun, verb, transitive and intransitive uses stay distinct.
        if (previous && (!pos || previous.has(pos))) continue;
        if (!previous) seen.set(key, new Set());
        seen.get(key).add(pos);
        text += (text ? (groupStarted ? part.separator : groupSeparator) : '')
          + (groupStarted ? '' : prefix) + parsed.body;
        groupStarted = true;
      }
      if (text) result.push({ ...meaning, text });
    }
  }
  return result;
};

const getPos = (text) => {
  const prefix = text.match(/^(n|v|vt|vi|a|adj|ad|adv|r|s|pron|num|prep|conj|interj|phr|pl)\./iu)?.[1].toLowerCase();
  if (['v', 'vt', 'vi'].includes(prefix)) return 'v';
  if (['a', 'adj', 's'].includes(prefix)) return 'a';
  if (['adv', 'ad', 'r'].includes(prefix)) return 'r';
  return prefix ?? null;
};

const meaningTerms = (text) => text
  .replace(/[（(][^）)]*[）)]/gu, '')
  .split(/[；;,，、/]/u)
  .map(term => term.trim())
  .filter(term => /[\u3400-\u9fff]/u.test(term));

// Only reviewed equivalents within the same part of speech may expand a sense.
// Character overlap alone is not evidence that two Chinese definitions are close.
const NEAR_MEANINGS = {
  v: [
    ['开始', '着手'],
    ['结束', '终止'],
    ['允许', '容许', '准许', '许可'],
    ['帮助', '协助', '援助', '支援'],
    ['选择', '挑选', '选取'],
    ['扩大', '扩展', '扩张'],
    ['保存', '保藏'],
    ['躲避', '避开', '回避', '逃避'],
    ['加速', '加快'],
    ['减少', '缩减', '削减'],
  ],
  a: [
    ['准确的', '精确的', '确切的'],
    ['必不可少的', '必要的', '必需的'],
  ],
  n: [['行业', '职业', '行当']],
};

export const getWordSharedMeaning = (meanings, sharedMeaning) => {
  if (!sharedMeaning?.text) return null;
  const pos = sharedMeaning.pos === 's' ? 'a' : sharedMeaning.pos;
  const terms = new Set(meaningTerms(sharedMeaning.text));
  for (const equivalents of NEAR_MEANINGS[pos] ?? []) {
    if (equivalents.some(term => terms.has(term))) {
      for (const term of equivalents) terms.add(term);
    }
  }
  const matched = splitMeanings(meanings)
    .filter(meaning => getPos(meaning.text) === pos)
    .flatMap(meaning => meaningTerms(meaning.text.replace(/^[a-z]+\.\s*/iu, '')))
    .filter(term => terms.has(term));
  if (!matched.length) return { ...sharedMeaning };
  const context = sharedMeaning.text.match(/[（(][^）)]*[）)]/gu)?.join('') ?? '';
  return { ...sharedMeaning, text: [...new Set(matched)].slice(0, 3).join('；') + context };
};

// Legacy/custom books may supply identical translations without sense metadata.
// Never fall back to a word's first (potentially unrelated) dictionary meaning.
export const resolveSharedMeaning = (pair, entries) => {
  if (pair.sharedMeaning?.text) return { ...pair.sharedMeaning };
  const [left, right] = pair.words.map(word => splitMeanings(entries[word].meanings));
  for (const meaning of left) {
    const pos = getPos(meaning.text);
    const terms = meaningTerms(meaning.text.replace(/^[a-z]+\.\s*/iu, ''));
    const common = terms.filter(term => right.some(other => getPos(other.text) === pos
      && meaningTerms(other.text.replace(/^[a-z]+\.\s*/iu, '')).includes(term)));
    if (common.length) return { text: common.join('；'), pos };
  }
  return null;
};

const highlightMeaning = (text, sharedMeaning) => {
  const pos = getPos(text);
  const sharedPos = sharedMeaning?.pos === 's' ? 'a' : sharedMeaning?.pos;
  if (!sharedMeaning || (pos && sharedPos && pos !== sharedPos)) return [{ text, shared: false }];
  const terms = meaningTerms(sharedMeaning.text).sort((a, b) => b.length - a.length);
  const segments = [];
  let plain = '';
  for (let index = 0; index < text.length;) {
    const term = terms.find(term => text.startsWith(term, index)
      && !/[\u3400-\u9fff]/u.test(text[index - 1] ?? '')
      && !/[\u3400-\u9fff]/u.test(text[index + term.length] ?? ''));
    if (term) {
      if (plain) segments.push({ text: plain, shared: false });
      plain = '';
      segments.push({ text: term, shared: true });
      index += term.length;
    } else {
      plain += text[index++];
    }
  }
  if (plain) segments.push({ text: plain, shared: false });
  return segments;
};

export const getReviewMeanings = (meanings, sharedMeaning) => {
  const wordMeaning = getWordSharedMeaning(meanings, sharedMeaning);
  const result = splitMeanings(meanings).map(meaning => ({
    ...meaning,
    segments: highlightMeaning(meaning.text, wordMeaning),
  }));
  if (wordMeaning && !result.some(meaning => meaning.segments.some(segment => segment.shared))) {
    const prefix = POS_LABELS[wordMeaning.pos] ? `${POS_LABELS[wordMeaning.pos]} ` : '';
    result.push({
      text: `${prefix}${wordMeaning.text}`,
      examFrequency: 0,
      segments: [
        ...(prefix ? [{ text: prefix, shared: false }] : []),
        { text: wordMeaning.text, shared: true },
      ],
    });
  }
  return result;
};
