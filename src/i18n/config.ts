export const locales = ['ja', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'ja';

export const categories = ['news', 'press', 'event', 'recruit'] as const;
export type Category = (typeof categories)[number];

export function isLocale(value: string | undefined): value is Locale {
  return locales.includes(value as Locale);
}
