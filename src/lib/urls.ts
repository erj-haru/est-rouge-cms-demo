/**
 * サイト内 URL の生成。GitHub Pages ではサブパス（/est-rouge-cms-demo/）で公開するため、
 * ページへのリンクは必ずこの関数を通して base を付ける（画像は astro:assets が自動で付ける）。
 */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** `/ja/news/` → `/est-rouge-cms-demo/ja/news/`（ローカルではそのまま） */
export function withBase(path: string): string {
  if (!path.startsWith('/')) throw new Error(`サイト内のパスは / で始めてください: ${path}`);
  return `${BASE}${path}`;
}

/** hreflang・canonical 用の絶対 URL（astro.config.mjs の site を使用） */
export function absoluteUrl(path: string, site: URL | undefined): string {
  return site ? new URL(path, site).href : path;
}
