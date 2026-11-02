// @ts-check
import { defineConfig } from 'astro/config';

/** GitHub Pages の公開先（https://erj-haru.github.io/est-rouge-cms-demo/） */
const PAGES_SITE = 'https://erj-haru.github.io';
const PAGES_BASE = '/est-rouge-cms-demo';

// GitHub Pages 向けのビルド（.github/workflows/deploy.yml で DEPLOY_TARGET=github-pages を指定）のときだけ
// サブパスで公開する。ローカルの開発サーバー（localhost:4321）と通常のビルドはルート（/）のまま
const isGitHubPages = process.env.DEPLOY_TARGET === 'github-pages';

// https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  // canonical / hreflang の絶対 URL に使用（ローカルでは相対パスのまま）
  site: isGitHubPages ? PAGES_SITE : undefined,
  base: isGitHubPages ? PAGES_BASE : '/',
  output: 'static',
  trailingSlash: 'always',
  redirects: {
    // redirects の転送先には base が自動で付かないため、明示的に付ける
    '/': `${isGitHubPages ? PAGES_BASE : ''}/ja/news/`,
  },
  vite: {
    server: {
      watch: {
        // Docker 上でファイル変更イベントが届かない環境向け（compose.yaml の ASTRO_USE_POLLING を参照）
        usePolling: process.env.ASTRO_USE_POLLING === 'true',
      },
    },
  },
});
