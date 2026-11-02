#!/usr/bin/env node
/**
 * 本番ビルド（dist/）のリンク・画像の参照切れとサブパスの不整合を検査する。
 *
 *   node scripts/ci/check-links.mjs
 *
 * astro.config.mjs と同じ環境変数（DEPLOY_TARGET）で実行すると、同じ base / site で検査する。
 * - サイト内の href / src / srcset / meta refresh がすべて base（例: /est-rouge-cms-demo/）で始まること
 * - 参照先のページ・画像が dist/ に存在すること
 * - 公開記事の日英の詳細ページと、日英の一覧ページが生成されていること
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import config from '../../astro.config.mjs';
import { listArticles } from '../lib/articles.mjs';
import { LOCALES, ROOT } from '../lib/common.mjs';
import { annotate } from './actions-output.mjs';

const DIST = join(ROOT, 'dist');
const base = `/${(config.base ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
const site = config.site ? new URL(config.site) : null;

if (!existsSync(DIST)) {
  console.error('dist/ がありません。先に astro build を実行してください');
  process.exit(2);
}

function htmlFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? htmlFiles(path) : name.endsWith('.html') ? [path] : [];
  });
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** HTML からリンク・画像の参照を取り出す */
function references(html) {
  const refs = [];
  for (const m of html.matchAll(/\s(href|src)="([^"]*)"/g)) refs.push(decode(m[2]));
  for (const m of html.matchAll(/\ssrcset="([^"]*)"/g)) {
    for (const candidate of decode(m[1]).split(',')) refs.push(candidate.trim().split(/\s+/)[0]);
  }
  for (const m of html.matchAll(/<meta[^>]+http-equiv="refresh"[^>]+content="[^"]*url=([^"]+)"/gi)) refs.push(decode(m[1]));
  return refs.filter(Boolean);
}

/** 参照を dist/ 内のファイルに対応させる。サイト外・ページ内リンクは null */
function resolve(ref, pagePath) {
  if (/^(#|mailto:|tel:|data:|javascript:)/i.test(ref)) return null;
  let url;
  try {
    url = new URL(ref, new URL(pagePath, 'http://site.invalid'));
  } catch {
    return { error: `URL として解釈できません: ${ref}` };
  }
  const external = /^[a-z]+:/i.test(ref) || ref.startsWith('//');
  if (external && !(site && url.origin === site.origin)) return null;
  const path = decodeURIComponent(url.pathname);
  if (!path.startsWith(base)) return { error: `サブパス ${base} で始まっていません: ${ref}` };
  const local = path.slice(base.length);
  const file = local === '' || local.endsWith('/') ? join(DIST, local, 'index.html') : join(DIST, local);
  return existsSync(file) ? { file } : { error: `参照先がありません: ${ref}` };
}

const errors = [];
const pages = htmlFiles(DIST);
let checked = 0;
for (const page of pages) {
  const rel = relative(DIST, page).split('\\').join('/');
  const pagePath = `${base}${rel.replace(/index\.html$/, '')}`;
  for (const ref of references(readFileSync(page, 'utf8'))) {
    const result = resolve(ref, pagePath);
    if (!result) continue;
    checked++;
    if (result.error) errors.push({ file: `dist/${rel}`, message: result.error });
  }
}

// 生成されているべきページ（日英の一覧と、公開記事の日英の詳細）
const expected = [...LOCALES.map((lang) => `${lang}/news/index.html`)];
for (const a of listArticles()) if (a.data.draft !== 'true') expected.push(`${a.data.lang}/news/${a.data.slug}/index.html`);
for (const path of expected) if (!existsSync(join(DIST, path))) errors.push({ file: `dist/${path}`, message: 'ページが生成されていません' });

for (const e of errors) annotate('error', e.message, e.file);
const where = site ? `${site.origin}${base}` : base;
if (errors.length > 0) {
  console.log(`❌ リンク・画像の検査で ${errors.length} 件の問題が見つかりました（公開先: ${where}）`);
  process.exit(1);
}
console.log(`✅ ${pages.length} ページ・${checked} 件のサイト内リンク／画像を確認しました（公開先: ${where}）`);
