// @ts-check
import { defineConfig } from 'astro/config';

// https://docs.astro.build/en/reference/configuration-reference/
export default defineConfig({
  // 本番ドメイン確定後に設定する（canonical / hreflang の絶対URL生成に使用）
  // site: 'https://www.est-rouge.com',
  output: 'static',
  trailingSlash: 'always',
  redirects: {
    '/': '/ja/news/',
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
