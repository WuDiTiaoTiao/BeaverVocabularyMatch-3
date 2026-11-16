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

export const loadVocabulary = (catalog, bookId, scope, fetcher) =>
  fetchJson(`./${resolveVocabularyPath(catalog, bookId, scope)}?v=10`, fetcher);
