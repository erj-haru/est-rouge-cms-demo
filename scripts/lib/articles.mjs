/**
 * 記事ファイルの読み込み（作業ツリー、または Git のコミットから）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { LOCALES, ROOT } from './common.mjs';
import { parseFrontmatter } from './content-rules.mjs';

export const CONTENT_DIR = 'src/content/news';
export const LANG_LABEL = { ja: '日本語', en: '英語' };

/** frontmatter を読む（このプロジェクトの記事は 1 行 1 項目の単純な形式。厳密な検証は Astro のスキーマで行う） */
export function readArticle(file, text = readFileSync(join(ROOT, file), 'utf8')) {
  return { file, folder: file.split('/')[3], ...parseFrontmatter(text) };
}

export function listArticles() {
  return LOCALES.flatMap((lang) => {
    const dir = join(ROOT, CONTENT_DIR, lang);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => readArticle(`${CONTENT_DIR}/${lang}/${name}`));
  });
}

/** slug または共通記事ID に一致する記事と、共通IDで関連付けられた他言語版を返す */
export function findArticleGroup(key, all = listArticles()) {
  const hits = all.filter((a) => a.data.slug === key || a.data.articleId === key);
  const ids = new Set(hits.map((a) => a.data.articleId).filter(Boolean));
  return all.filter((a) => hits.includes(a) || ids.has(a.data.articleId));
}

/** 記事が参照する画像（thumbnail と本文中の画像）をリポジトリ相対パスで返す */
export function imageRefs(article) {
  const refs = [];
  if (article.data.thumbnail) refs.push(article.data.thumbnail);
  for (const m of article.body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) refs.push(m[1]);
  return refs
    .filter((ref) => !/^(https?:)?\/\//.test(ref))
    .map((ref) => ({ ref, path: posix.normalize(posix.join(posix.dirname(article.file), ref)) }));
}
