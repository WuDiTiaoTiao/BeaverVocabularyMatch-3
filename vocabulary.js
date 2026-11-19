const fetchJson = async (path, fetcher = globalThis.fetch) => {
  const response = await fetcher(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`词库加载失败（${response.status}）`);
  return response.json();
};

export const loadVocabularyCatalog = (fetcher) => fetchJson('./data/catalog.json?v=10', fetcher);

export const resolveVocabularyPath = (catalog, bookId, scope) => {
  const book = catalog.books[bookId];
  if (!book) throw new Error(`未知词书：${bookId}`);
  const scopeMeta = book.scopes[scope];
  if (!scopeMeta) throw new Error(`未知词库范围：${scope}`);
  return scopeMeta.file;
};

export const loadVocabulary = async (catalog, bookId, scope, fetcher) => {
  const [vocabulary, sharedMeanings] = await Promise.all([
    fetchJson(`./${resolveVocabularyPath(catalog, bookId, scope)}?v=10`, fetcher),
    fetchJson('./data/shared-meanings.json?v=29', fetcher),
  ]);
  return {
    ...vocabulary,
    pairs: vocabulary.pairs.map(pair => {
      const key = [...pair.words].sort().join('|');
      const senseId = sharedMeanings.pairs[key];
      const sense = sharedMeanings.senses[senseId];
      if (!sense?.text) throw new Error(`词对缺少共同释义：${pair.words.join(' / ')}`);
      return { ...pair, sharedMeaning: { senseId, ...sense } };
    }),
  };
};
