import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readJson = async (relativePath) => {
  try {
    return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
  } catch {
    return null;
  }
};

test('catalog provides complete and high-frequency choices for all four word books', async () => {
  const catalog = await readJson('./data/catalog.json');

  assert.ok(catalog, 'data/catalog.json must exist');
  assert.deepEqual(Object.keys(catalog.books), ['ielts', 'cet6', 'postgrad', 'cet4']);
  const minimumFullCounts = { ielts: 8_000, cet6: 6_000, postgrad: 5_500, cet4: 4_500 };
  const frequentCounts = new Set();
  for (const [bookId, book] of Object.entries(catalog.books)) {
    assert.equal(typeof book.label, 'string');
    assert.equal(typeof book.scopes.full.file, 'string');
    assert.equal(typeof book.scopes.frequent.file, 'string');
    assert.ok(book.scopes.full.wordCount > book.scopes.frequent.wordCount);
    assert.ok(
      book.scopes.full.wordCount >= minimumFullCounts[bookId],
      `${bookId} complete vocabulary is below the agreed full-book size`,
    );
    frequentCounts.add(book.scopes.frequent.wordCount);
  }
  assert.ok(frequentCounts.size > 1, 'high-frequency counts must follow each book distribution');
});

test('every generated vocabulary is playable and references complete word details', async () => {
  const catalog = await readJson('./data/catalog.json');
  assert.ok(catalog, 'data/catalog.json must exist');

  for (const [bookId, book] of Object.entries(catalog.books)) {
    for (const [scope, scopeMeta] of Object.entries(book.scopes)) {
      const vocabulary = await readJson(`./${scopeMeta.file}`);
      assert.ok(vocabulary, `${bookId}/${scope} vocabulary must exist`);
      assert.equal(vocabulary.bookId, bookId);
      assert.equal(vocabulary.scope, scope);
      assert.equal(vocabulary.totalWords, Object.keys(vocabulary.entries).length);
      assert.ok(vocabulary.totalWords >= 500, `${bookId}/${scope} must contain a substantial word pool`);
      assert.ok(vocabulary.pairs.length >= 12, `${bookId}/${scope} must contain enough synonym pairs`);
      assert.ok(vocabulary.distractors.length >= 3, `${bookId}/${scope} must contain distractors`);

      for (const [word, details] of Object.entries(vocabulary.entries)) {
        assert.ok(word.length > 0);
        assert.ok(details.phonetic.length > 0, `${word} needs a phonetic`);
        assert.ok(details.meanings.length > 0, `${word} needs meanings`);
        assert.ok(details.meanings.every((meaning) => meaning.text && meaning.examFrequency > 0));
      }

      for (const pair of vocabulary.pairs) {
        assert.equal(pair.words.length, 2);
        assert.ok(pair.words.every((word) => vocabulary.entries[word]), `${pair.pairId} references a missing word`);
      }
      assert.ok(vocabulary.distractors.every((word) => vocabulary.entries[word]));
    }
  }
});

test('resolves a selected book and scope to its offline vocabulary file', async () => {
  const catalog = await readJson('./data/catalog.json');
  const module = await import('./vocabulary.js').catch(() => null);

  assert.ok(module, 'vocabulary.js must provide the selection loader');
  assert.equal(module.resolveVocabularyPath(catalog, 'ielts', 'full'), 'data/ielts-full.json');
  assert.equal(module.resolveVocabularyPath(catalog, 'cet6', 'frequent'), 'data/cet6-frequent.json');
  assert.throws(() => module.resolveVocabularyPath(catalog, 'unknown', 'full'), /未知词书/);
  assert.throws(() => module.resolveVocabularyPath(catalog, 'ielts', 'unknown'), /未知词库范围/);
});

test('generated pairs exclude known antonyms and merely related words', async () => {
  const catalog = await readJson('./data/catalog.json');
  const forbiddenPairs = new Set([
    'credible|incredible',
    'credulous|incredulous',
  ]);

  for (const book of Object.values(catalog.books)) {
    for (const scopeMeta of Object.values(book.scopes)) {
      const vocabulary = await readJson(`./${scopeMeta.file}`);
      for (const pair of vocabulary.pairs) {
        assert.equal(
          forbiddenPairs.has([...pair.words].sort().join('|')),
          false,
          `${pair.words.join(' / ')} is not a synonym pair`,
        );
      }
    }
  }
});
