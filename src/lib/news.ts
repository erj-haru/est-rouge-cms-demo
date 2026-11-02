import { getCollection, type CollectionEntry } from 'astro:content';
import { locales, type Locale } from '../i18n/config';
import { withBase } from './urls';

export type NewsEntry = CollectionEntry<'news'>;

/** 下書きは開発サーバーでのみ表示し、本番ビルドからは除外する */
const includeDrafts = import.meta.env.DEV;

export function newsListUrl(lang: Locale): string {
  return withBase(`/${lang}/news/`);
}

export function newsUrl(entry: NewsEntry): string {
  return withBase(`/${entry.data.lang}/news/${entry.data.slug}/`);
}

/**
 * 公開対象の全記事を新しい順に返す。
 * ファイル配置と frontmatter の整合性（言語・slug・articleId の重複）もここで検証し、
 * 不整合があればビルドを失敗させる。
 */
export async function getAllNews(): Promise<NewsEntry[]> {
  const entries = await getCollection('news', ({ data }) => includeDrafts || !data.draft);
  validate(entries);
  return entries.sort((a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf());
}

export async function getNewsByLocale(lang: Locale): Promise<NewsEntry[]> {
  return (await getAllNews()).filter((entry) => entry.data.lang === lang);
}

/** 共通IDで関連付けられた他言語版の記事を返す */
export function findTranslations(entry: NewsEntry, all: NewsEntry[]): Partial<Record<Locale, NewsEntry>> {
  const result: Partial<Record<Locale, NewsEntry>> = {};
  for (const lang of locales) {
    result[lang] = all.find((e) => e.data.lang === lang && e.data.articleId === entry.data.articleId);
  }
  return result;
}

function validate(entries: NewsEntry[]): void {
  const errors: string[] = [];
  const slugs = new Map<string, string>();
  const articleIds = new Map<string, string>();

  for (const entry of entries) {
    const { lang, slug, articleId } = entry.data;
    const folder = entry.id.split('/')[0];
    if (folder !== lang) {
      errors.push(`${entry.id}: lang "${lang}" がフォルダ "${folder}/" と一致しません`);
    }
    const slugKey = `${lang}/${slug}`;
    const dupSlug = slugs.get(slugKey);
    if (dupSlug) errors.push(`${entry.id}: slug "${slug}" が ${dupSlug} と重複しています`);
    slugs.set(slugKey, entry.id);

    const idKey = `${lang}/${articleId}`;
    const dupId = articleIds.get(idKey);
    if (dupId) errors.push(`${entry.id}: articleId "${articleId}" が ${dupId} と重複しています`);
    articleIds.set(idKey, entry.id);
  }

  if (errors.length > 0) {
    throw new Error(`NEWS コンテンツの検証に失敗しました:\n- ${errors.join('\n- ')}`);
  }
}
