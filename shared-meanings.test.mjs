import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createGameState, selectTile, getTilePresentation, getWaveReview, WORD_DETAILS, SYNONYM_BANK } from './game.js';
import { loadVocabulary } from './vocabulary.js';
import { getReviewMeanings, getWordSharedMeaning } from './meanings.js';

const businessVocabulary = {
  bookId: 'test', scope: 'full', label: '测试', totalWords: 36,
  entries: {
    ...WORD_DETAILS,
    business: { phonetic: '/ˈbɪznəs/', meanings: [{ text: 'n. 生意, 商业\\n[经] 企业', examFrequency: 1 }] },
    line: { phonetic: '/laɪn/', meanings: [{ text: 'n. 线, 线路\\nvt. 排成一行', examFrequency: 1 }] },
  },
  pairs: [
    { pairId: 'business-line', words: ['business', 'line'], sharedMeaning: { text: '行业；职业', pos: 'n', senseId: 'n:00582388' } },
    ...SYNONYM_BANK.slice(0, 5),
  ],
  distractors: ['exercise', 'trigger', 'record'],
};

test('matching business and line reveals only their shared occupational sense on both tiles', () => {
  const initial = createGameState(7, 1, 0, businessVocabulary);
  const business = initial.tiles.find(tile => tile.word === 'business');
  const line = initial.tiles.find(tile => tile.word === 'line');
  assert.equal(getTilePresentation(initial, business).gloss, null);
  const selected = selectTile(initial, business.id, 1000);
  assert.equal(getTilePresentation(selected, business).gloss, null);
  const matched = selectTile(selected, line.id, 1200);
  assert.equal(getTilePresentation(matched, business).gloss, '行业；职业');
  assert.equal(getTilePresentation(matched, line).gloss, '行业；职业');
});

test('round review retains every original meaning and highlights a missing shared sense on both words', () => {
  const review = getWaveReview(createGameState(7, 1, 0, businessVocabulary));
  const business = review.allWords.find(entry => entry.word === 'business');
  const line = review.allWords.find(entry => entry.word === 'line');
  for (const [entry, originals] of [[business, ['n. 生意, 商业', '[经] 企业']], [line, ['n. 线, 线路', 'vt. 排成一行']]]) {
    assert.deepEqual(entry.meanings.slice(0, 2).map(meaning => meaning.text), originals);
    assert.equal(entry.meanings.flatMap(meaning => meaning.segments ?? []).filter(segment => segment.shared).map(segment => segment.text).join(''), '行业；职业');
    assert.equal(entry.meanings[0].segments.some(segment => segment.shared), false);
  }
  assert.equal(review.extras.every(entry => entry.meanings.every(meaning => meaning.segments.every(segment => !segment.shared))), true);
});

test('review highlights only the matching sense within the correct part of speech', () => {
  const vocabulary = {
    ...businessVocabulary,
    entries: {
      ...businessVocabulary.entries,
      business: { phonetic: '/test/', meanings: [{ text: 'n. 结束, 终点\\nv. 结束, 终止, 毁掉', examFrequency: 1 }] },
      line: { phonetic: '/test/', meanings: [{ text: 'v. 结束, 用完', examFrequency: 1 }] },
    },
    pairs: businessVocabulary.pairs.map(pair => pair.pairId === 'business-line'
      ? { ...pair, sharedMeaning: { text: '结束；终止', pos: 'v', senseId: 'v:02609764' } }
      : pair),
  };
  const entry = getWaveReview(createGameState(7, 1, 0, vocabulary)).allWords.find(entry => entry.word === 'business');
  assert.deepEqual(entry.meanings[0].segments, [{ text: 'n. 结束, 终点', shared: false }]);
  assert.deepEqual(entry.meanings[1].segments, [
    { text: 'v. ', shared: false }, { text: '结束', shared: true },
    { text: ', ', shared: false }, { text: '终止', shared: true }, { text: ', 毁掉', shared: false },
  ]);
});

test('a shared translation does not highlight a different sense merely containing the same characters', () => {
  const meanings = getReviewMeanings([{ text: 'adj. 不完整的, 完整的, 完整性', examFrequency: 1 }], { text: '完整的', pos: 'a' });
  assert.equal(meanings[0].segments.filter(segment => segment.shared).map(segment => segment.text).join(''), '完整的');
  assert.equal(meanings[0].segments.map(segment => segment.text).join(''), 'adj. 不完整的, 完整的, 完整性');
});

test('matched words can reveal different near meanings while review preserves unrelated definitions', () => {
  const vocabulary = {
    ...businessVocabulary,
    entries: {
      ...businessVocabulary.entries,
      accurate: { phonetic: '/ˈækjərət/', meanings: [{ text: 'adj. 准确的, 正确的', examFrequency: 1 }] },
      precise: { phonetic: '/prɪˈsaɪs/', meanings: [{ text: 'adj. 精确的, 苛刻的\\nv. 准确的', examFrequency: 1 }] },
    },
    pairs: [
      { pairId: 'accurate-precise', words: ['accurate', 'precise'], sharedMeaning: { text: '准确的', pos: 'a' } },
      ...businessVocabulary.pairs.slice(1),
    ],
  };
  const initial = createGameState(7, 1, 0, vocabulary);
  const accurate = initial.tiles.find(tile => tile.word === 'accurate');
  const precise = initial.tiles.find(tile => tile.word === 'precise');
  const matched = selectTile(selectTile(initial, accurate.id, 1000), precise.id, 1200);
  assert.equal(getTilePresentation(matched, accurate).gloss, '准确的');
  assert.equal(getTilePresentation(matched, precise).gloss, '精确的');
  const review = getWaveReview(matched).allWords.find(entry => entry.word === 'precise');
  assert.deepEqual(review.meanings.map(meaning => meaning.text), ['adj. 精确的, 苛刻的', 'v. 准确的']);
  assert.deepEqual(review.meanings[0].segments.filter(segment => segment.shared).map(segment => segment.text), ['精确的']);
  assert.equal(review.meanings[1].segments.some(segment => segment.shared), false);
});

test('near meanings keep the shared context and do not match negated definitions', () => {
  const originals = [{ text: 'adj. 不准确的, 精确的', examFrequency: 1 }];
  const shared = { text: '准确的（测量结果）', pos: 'a' };
  assert.equal(getWordSharedMeaning(originals, shared).text, '精确的（测量结果）');
  const meanings = getReviewMeanings(originals, shared);
  assert.equal(meanings[0].segments.filter(segment => segment.shared).map(segment => segment.text).join(''), '精确的');
  assert.equal(meanings[0].segments.map(segment => segment.text).join(''), 'adj. 不准确的, 精确的');
});

test('all loaded vocabulary pairs receive a Chinese meaning tied to their shared WordNet sense', async () => {
  const catalog = JSON.parse(await readFile(new URL('./data/catalog.json', import.meta.url), 'utf8'));
  const fetcher = async path => ({ ok: true, json: async () => JSON.parse(await readFile(new URL(path.split('?')[0], import.meta.url), 'utf8')) });
  for (const [bookId, book] of Object.entries(catalog.books)) {
    for (const scope of Object.keys(book.scopes)) {
      const vocabulary = await loadVocabulary(catalog, bookId, scope, fetcher);
      for (const pair of vocabulary.pairs) {
        assert.match(pair.sharedMeaning?.text ?? '', /[\u3400-\u9fff]/u, `${bookId}/${scope}: ${pair.words.join('/')} needs a shared Chinese sense`);
        assert.match(pair.sharedMeaning.senseId, /^[navrs]:\d{8}$/);
      }
      const pair = vocabulary.pairs.find(pair => [...pair.words].sort().join('|') === 'business|line');
      assert.equal(pair.sharedMeaning.text, '行业；职业');
    }
  }
});

test('noun shared senses describe the common concept instead of a homographic verb or adverb', async () => {
  const data = JSON.parse(await readFile(new URL('./data/shared-meanings.json', import.meta.url), 'utf8'));
  const sharedText = words => data.senses[data.pairs[[...words].sort().join('|')]].text;
  assert.match(sharedText(['environment', 'surround']), /环境|周边地区/);
  assert.match(sharedText(['balance', 'counterbalance']), /配重|平衡重物/);
  assert.match(sharedText(['match', 'mate']), /相同|复制|对应物/);
  assert.match(sharedText(['cycle', 'rhythm']), /周期|节律/);
});
