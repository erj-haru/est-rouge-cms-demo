import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { categories, locales } from './i18n/config';

const kebabCase = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const news = defineCollection({
  // src/content/news/{lang}/*.md を読み込む
  loader: glob({
    pattern: '**/*.md',
    base: './src/content/news',
    // frontmatter の slug は日英で共有できるため、ID はファイルパス（例: ja/2026-10-01-site-renewal）にする
    generateId: ({ entry }) => entry.replace(/\.md$/, ''),
  }),
  schema: ({ image }) =>
    z.object({
      title: z.string().min(1),
      description: z.string().min(1).optional(),
      publishedAt: z.coerce.date(),
      category: z.enum(categories),
      slug: z.string().regex(kebabCase, 'slug は小文字英数字とハイフンのみ使用できます'),
      lang: z.enum(locales),
      // 日英の記事を関連付ける共通ID
      articleId: z.string().regex(kebabCase, 'articleId は小文字英数字とハイフンのみ使用できます'),
      draft: z.boolean().default(false),
      thumbnail: image().optional(),
      thumbnailAlt: z.string().default(''),
    }),
});

export const collections = { news };
