import type { Category, Locale } from './config';

export const localeLabels: Record<Locale, string> = {
  ja: '日本語',
  en: 'English',
};

export const categoryLabels: Record<Locale, Record<Category, string>> = {
  ja: {
    news: 'お知らせ',
    press: 'プレスリリース',
    event: 'イベント',
    recruit: '採用',
  },
  en: {
    news: 'News',
    press: 'Press Release',
    event: 'Event',
    recruit: 'Careers',
  },
};

const ui = {
  ja: {
    'site.name': 'Est Rouge',
    'site.skip': '本文へスキップ',
    'nav.news': 'ニュース',
    'nav.language': '言語の切り替え',
    'news.title': 'NEWS',
    'news.lead': 'Est Rouge からのお知らせ、プレスリリース、イベント情報をお届けします。',
    'news.empty': '公開中の記事はありません。',
    'news.back': 'NEWS 一覧に戻る',
    'news.published': '公開日',
    'news.category': 'カテゴリー',
    'news.draft': '下書き',
    'footer.note': 'Astro + Content Collections による技術検証デモ',
  },
  en: {
    'site.name': 'Est Rouge',
    'site.skip': 'Skip to content',
    'nav.news': 'News',
    'nav.language': 'Change language',
    'news.title': 'NEWS',
    'news.lead': 'Announcements, press releases and events from Est Rouge.',
    'news.empty': 'No articles have been published yet.',
    'news.back': 'Back to NEWS',
    'news.published': 'Published',
    'news.category': 'Category',
    'news.draft': 'Draft',
    'footer.note': 'Technical demo built with Astro + Content Collections',
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type UIKey = keyof (typeof ui)['ja'];

export function useTranslations(lang: Locale) {
  return (key: UIKey): string => ui[lang][key];
}

export function formatDate(date: Date, lang: Locale): string {
  return new Intl.DateTimeFormat(lang === 'ja' ? 'ja-JP' : 'en-US', {
    year: 'numeric',
    month: lang === 'ja' ? '2-digit' : 'short',
    day: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(date);
}

/** <time datetime> 用の YYYY-MM-DD（日本時間） */
export function toISODate(date: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(date);
}
