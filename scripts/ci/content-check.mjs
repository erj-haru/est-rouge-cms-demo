#!/usr/bin/env node
/**
 * 記事の整合性チェック（CI の build ジョブ）。
 *
 *   node scripts/ci/content-check.mjs            frontmatter の必須項目・日英の整合性を確認する
 *   node scripts/ci/content-check.mjs --dist     本番ビルド（dist/）に下書きが含まれず、公開記事が含まれることを確認する
 *
 * スキーマ（型・カテゴリー・日付形式など）の厳密な検証は astro sync / astro check が行う。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listArticles } from '../lib/articles.mjs';
import { ROOT } from '../lib/common.mjs';
import { checkArticleConsistency, contentViolation } from '../lib/content-rules.mjs';
import { annotate } from './actions-output.mjs';

const articles = listArticles();
let failed = false;

if (process.argv.includes('--dist')) {
  for (const a of articles) {
    const built = existsSync(join(ROOT, 'dist', a.data.lang, 'news', a.data.slug, 'index.html'));
    const draft = a.data.draft === 'true';
    if (draft && built) {
      annotate('error', '下書きの記事が本番ビルドに含まれています', a.file);
      failed = true;
    } else if (!draft && !built) {
      annotate('error', '公開記事のページが本番ビルドにありません', a.file);
      failed = true;
    }
  }
  console.log(failed ? '❌ 本番ビルドの内容に問題があります' : `✅ 本番ビルド: 公開 ${articles.filter((a) => a.data.draft !== 'true').length} 件・下書き除外 ${articles.filter((a) => a.data.draft === 'true').length} 件`);
} else {
  for (const a of articles) {
    const reason = contentViolation(a.file, readFileSync(join(ROOT, a.file)));
    if (reason) {
      annotate('error', reason, a.file);
      failed = true;
    }
  }
  const { errors, warnings } = checkArticleConsistency(articles.map((a) => ({ path: a.file, data: a.data })));
  for (const w of warnings) annotate('warning', w);
  for (const e of errors) annotate('error', e);
  failed ||= errors.length > 0;
  console.log(failed ? '❌ 記事の整合性に問題があります' : `✅ 記事 ${articles.length} 件の frontmatter と日英の整合性を確認しました`);
}
process.exit(failed ? 1 : 0);
