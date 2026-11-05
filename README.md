# est-rouge-cms-demo

AI-native content publishing demo built with Astro and Claude Code

Est Rouge コーポレートサイトを STUDIO から Astro + GitHub + Claude Code へ移行するための技術検証デモです。NEWS の一覧・詳細ページ（日本語・英語）に絞って実装しています。

**公開サイト: https://erj-haru.github.io/est-rouge-cms-demo/**（main へのマージ後に GitHub Pages へ自動デプロイ）

## 編集者向け: はじめてのセットアップ

### 1. 事前に用意するもの

- [Claude Desktop](https://claude.com/download)（Code タブを使います）
- このリポジトリへの招待を承認した GitHub アカウント

Docker Desktop・管理者権限は不要です。Node.js は次の手順で Claude Code が mise を使って準備します。
すでに入っている Node.js・ツール・シェルの設定は変更しません。

### 2. Claude Code に頼む

Claude Desktop の Code タブで、このリポジトリのフォルダを開いて（Local セッション）、次のように話しかけてください。

> このプロジェクトの記事入稿環境をセットアップして

Claude Code が次の順に進めます。**ターミナルを開く必要は、原則ありません。**

1. Mac の状態（macOS・CPU・mise・Node.js・Git・GitHub・ポート 4321 など）を確認する
2. 足りないものをまとめて表示する
3. 導入してよいか確認する
4. 承認されたものを準備する
   - mise: CMS 専用の場所（`~/.est-rouge-cms/bin`）に導入（GitHub の公式リリースから取得し、リポジトリに固定したチェックサムで検証）
   - Node.js: mise で `mise.toml` に固定したバージョンを導入（mise が nodejs.org から取得し、チェックサムを検証）
5. `npm ci` で依存関係を `package-lock.json` どおりに再現する
6. プレビュー（Astro の開発サーバー）を起動し、日本語・英語の NEWS ページが表示できることを確かめる
7. プレビューの URL（http://localhost:4321/ja/news/）と次の操作を表示する

- スクリプトはすべて `mise exec` で、`mise.toml` の Node.js を使って実行します（PATH の `node` は使いません）。
- 組織の端末管理（MDM）に登録された Mac では、導入してよいか組織のルールを確認してください。
- 何度頼んでも問題ありません。起動済みのプレビューはそのまま使われます（依存関係が変わったときだけ入れ直して再起動します）。
- `src/content/news/` の記事を編集すると、プレビューに自動で反映されます。
- 以前の Docker 版のプレビューが動いている場合は、ポート 4321 が使えないため、止めてよいか確認されます（`docker compose stop`）。

### 3. スラッシュコマンド

自然言語のかわりに、`/` から始まるコマンドでも操作できます（`/` を入力すると一覧に表示されます）。
**使い方に迷ったら `/cms-help`**（または「使い方を教えて」）で、コマンドの一覧と説明を確認できます。
`/cms-help publish-news` のようにコマンド名を付けると、そのコマンドの詳しい説明が表示されます（表示するだけで、何も変更しません）。

| コマンド | 内容 | 話しかける例 |
| --- | --- | --- |
| `/cms-help [コマンド名]` | 使えるコマンドの一覧と、それぞれの使い方を表示 | 「何ができるの？」「記事を公開するには？」 |
| `/setup-editor` | 環境（mise・Node.js・Git・GitHub）を確認・準備し、プレビューを起動 | 「記事入稿環境をセットアップして」 |
| `/preview [slug]` | プレビューの状態を確認し、停止していれば起動して URL を表示。slug を付けると記事詳細の URL も表示 | 「site-renewal の記事をプレビューで見たい」 |
| `/draft-news` | 原稿と画像から日英の記事を作成し、検証して入稿 PR（`content` ラベル）を作成 | 「この原稿と画像でお知らせを入稿して」 |
| `/edit-news [slug]` | 既存記事の必要な箇所だけを修正。進行中の PR があればその PR を更新 | 「new-office-opening の公開日を 11/21 に直して」 |
| `/publish-news [PR 番号 or slug]` | 確認した記事を公開（`draft: false` にして CI 成功を確認後にマージ） | 「確認したので公開して」 |

`/setup-editor` と `/preview` は何度実行しても安全です（起動中のプレビューは再起動しません）。

### 4. 記事の入稿と修正

原稿（テキストやファイル）と画像のパスを渡して「この内容で NEWS を入稿して」と頼むと、Claude Code が次のように進めます。

1. 不足している情報（公開日・カテゴリー・サムネイルなど）を質問し、slug を提案
2. 日本語版と英語版（翻訳案）の記事を作成し、画像を最適化して配置
3. 型チェック・本番ビルド・プレビュー表示を確認
4. **Push 先のリポジトリ・ブランチ・コミットするファイルを提示し、了承を得てから** PR を作成
5. PR の URL と、日英のプレビュー URL を報告

- 新しい記事は **下書き（`draft: true`）** で入稿され、PR をマージしても公開されません。
- `/draft-news`・`/edit-news` は PR をマージしません。

### 5. 記事の公開

プレビューで内容を確認したら「確認したので公開して」と頼みます。Claude Code は公開する記事と確認対象のコミットを示し、
**あらためて公開の指示をもらってから**、次の順に進めます。

1. 記事 PR であること（`content` ラベル、記事・画像だけの変更、ベースが main など）と、確認した内容から変わっていないことを検証
2. 日英の記事を `draft: false` に変更して PR に Push（CI が再実行される）
3. 最新のコミットで CI が成功したことを確認し、マージ直前にもう一度すべての条件を検証
4. 条件がそろった場合だけ PR をマージ（そろわなければ理由を説明して停止）
5. マージ後、GitHub Actions が Web サイトへ自動でデプロイ。Claude Code が反映まで確認し、**マージの結果とデプロイの結果を分けて**報告

マージ（記事データへの取り込み）とデプロイ（Web サイトへの反映）は別の段階です。反映状況は
`node scripts/deploy-status.mjs --slug <slug>` でも確認できます（読み取りのみ）。
- 修正は「〇〇の記事の△△を直して」と頼むと、同じ PR に反映されます。公開済みの記事も PR 経由で修正します。

Claude Code を使わずに実行する場合（CLI 利用者）:

- 環境の確認だけ: `sh scripts/setup/bootstrap.sh check`（Node.js がなくても動きます）
- mise・Node.js の導入: `sh scripts/setup/bootstrap.sh install-mise --approved` → `install-node --approved`（mise が既にあれば install-mise は不要）
- セットアップ: `sh scripts/cms-node.sh scripts/setup-editor.mjs`（確認のみは `--check`、プレビューのみは `--preview [--slug <slug>]`、停止は `--stop`、ログは `--logs`）
- mise を使い慣れている場合は `mise exec -- node scripts/setup-editor.mjs` でも同じです

## 開発者向け

### 開発環境（mise + Node.js）

- Node.js のバージョンは `mise.toml` を正とします（ローカル・CI・デプロイ・`Dockerfile.dev` で共通。不一致はテストで検出）。
- `mise install` → `mise exec -- npm ci` → `mise exec -- npm run dev` で、編集者と同じ環境で開発できます。
- 編集者向けスクリプトは `scripts/cms-node.sh` 経由で実行します。mise の自動インストールを無効にし、`mise.toml` の Node.js が
  導入されていなければ実行しません（mise は未導入時に PATH 上の別の Node.js で動いてしまうため）。
- プレビューは Astro の開発サーバーをバックグラウンドで起動します（`astro dev --background`。状態は `.astro/dev.json`、ログは `.astro/dev.log`）。
- 依存関係は `node_modules/.cms-install-stamp`（`package-lock.json`・Node.js・OS の組み合わせ）で管理し、変わったときだけ `npm ci` します。

### Docker によるプレビュー環境（任意）

標準の開発環境は mise + Node.js に移行しました。Docker の構成は比較・予備のために残しています（mise 版と同時には起動できません）。

| コマンド | 内容 |
| --- | --- |
| `docker compose up -d` | 開発サーバーを起動（`http://localhost:4321`） |
| `docker compose logs -f astro` | ログを表示 |
| `docker compose stop` | 停止 |
| `docker compose up -d --build` | `Dockerfile.dev` の変更を反映して作り直す |

- ソースはバインドマウントされ、`node_modules` と `.astro` はコンテナ専用ボリュームです。`package-lock.json` が変わると、起動時に自動で `npm ci` し直します。
- コンテナは非 root ユーザー（`node`）で動作し、ポートは `127.0.0.1` にのみ公開されます。

### CI（GitHub Actions）

`.github/workflows/ci.yml` が PR の作成・更新・ラベル変更のたびに実行されます。

| ジョブ | 内容 |
| --- | --- |
| `build` | `npm ci`、`astro sync`（frontmatter のスキーマ検証）、`astro check`、記事の整合性（日英）、スクリプトのテスト、本番ビルド、下書き除外の確認 |
| `content-scope` | 変更範囲の判定。**main 側の判定スクリプト**で PR の差分を検査し、`content` ラベル付きの PR に記事・画像以外の変更・削除・リネーム・偽装ファイルがあれば失敗 |
| `ci-required` | 上記の集約。ブランチ保護と公開スクリプトはこのチェックだけを参照する |

`build` では通常のビルドに加えて、GitHub Pages と同じサブパス（`/est-rouge-cms-demo/`）でもビルドし、
リンク・画像の参照切れとサブパスの不整合を `scripts/ci/check-links.mjs` で検査します。
権限は `contents: read` のみで、シークレットは使いません。外部 Action はコミット SHA で固定しています。

### CD（GitHub Pages への自動デプロイ）

`.github/workflows/deploy.yml` が main への Push（PR のマージを含む）で実行されます。Actions 画面の「Run workflow」から手動でも再実行できます。

| ジョブ | 内容 | 権限 |
| --- | --- | --- |
| `build` | `withastro/action` で依存関係のインストールと `npm run build:verify`（型チェック → ビルド → 下書き除外の確認 → リンク・画像・サブパスの検査）を行い、成果物をアップロード。ロックファイルが変わった場合は失敗 | `contents: read` |
| `deploy` | `actions/deploy-pages` で GitHub Pages（environment: `github-pages`）へ公開 | `pages: write`・`id-token: write` |

- サブパスは `astro.config.mjs` で、`DEPLOY_TARGET=github-pages` のときだけ有効になります（ローカルの `localhost:4321` はルートのまま）。
- サイト内リンクは `src/lib/urls.ts` の `withBase()` で生成します（画像は Astro が自動で base を付けます）。
- サブパス付きのビルドを手元で確認する場合: `DEPLOY_TARGET=github-pages npm run build:verify`
- デプロイ状況の確認: `node scripts/deploy-status.mjs [--sha <コミット>] [--slug <slug>] [--wait]`

### GitHub 側で必要な設定（管理者）

- main のブランチ保護（またはルールセット）: PR 必須、必須チェック `ci-required`、Code Owners のレビュー必須、force push・削除の禁止、管理者も例外にしない
  - プライベートリポジトリで利用するには GitHub Pro / Team 以上が必要です
- Settings → Actions → General: ワークフローの権限は「Read repository contents」、「Allow GitHub Actions to create and approve pull requests」はオフ
- 自動マージ（Allow auto-merge）はオフのまま
- Settings → Pages: Source は「GitHub Actions」。Settings → Environments → `github-pages` のデプロイ元ブランチは `main` のみ

### ホストで直接動かす場合

- Node.js 22.22.0 以上（Astro 7.4 の要件）。通常は `mise.toml` のバージョンを mise で使ってください

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm install` | 依存パッケージのインストール |
| `npm run dev` | 開発サーバーを `http://localhost:4321` で起動（下書き記事も表示） |
| `npm run check` | `astro check` による型チェック・コンテンツ検証 |
| `npm run build` | 型チェック後に本番ビルドを `dist/` へ出力（下書き記事は除外） |
| `npm run build:verify` | 本番ビルドに加えて、下書き除外とリンク・画像の参照切れを検査（CI・デプロイで使用） |
| `npm run preview` | ビルド結果のプレビュー |

## URL 構造

| ページ | 日本語 | 英語 |
| --- | --- | --- |
| NEWS 一覧 | `/ja/news/` | `/en/news/` |
| NEWS 詳細 | `/ja/news/{slug}/` | `/en/news/{slug}/` |

`/` は `/ja/news/` へリダイレクトします。GitHub Pages では全体が `/est-rouge-cms-demo/` の下になります（例: `https://erj-haru.github.io/est-rouge-cms-demo/ja/news/`）。

## 記事の追加方法

`src/content/news/{ja|en}/` に Markdown ファイルを追加するだけで、一覧と詳細ページが自動生成されます。ファイル名は `YYYY-MM-DD-{slug}.md` を推奨します。

```md
---
title: 記事タイトル
description: 一覧や meta description に使う概要（任意）
publishedAt: 2026-10-28
category: news          # news | press | event | recruit
slug: example-article   # URL に使用（小文字英数字とハイフン）
lang: ja                # ja | en（配置フォルダと一致させる）
articleId: example-article  # 日英で同じ値にすると翻訳として関連付けられる
draft: false            # true の場合は本番ビルドから除外
thumbnail: ../../../assets/news/example.jpg  # 任意
thumbnailAlt: 画像の代替テキスト
---

本文（Markdown）

![本文画像の代替テキスト](../../../assets/news/example-body.jpg)
```

- 画像は `src/assets/news/` に置き、記事からは相対パスで参照します。ビルド時に WebP へ変換・リサイズされます。
- frontmatter は `src/content.config.ts` の Zod スキーマで検証され、必須項目の欠落や未定義のカテゴリーはビルドエラーになります。
- 同一言語内での `slug` / `articleId` の重複、`lang` と配置フォルダの不一致も `src/lib/news.ts` で検出してビルドを止めます。
- 翻訳が存在しない記事では、言語切り替えリンクは切り替え先言語の NEWS 一覧へ遷移します。

## ディレクトリ構成

```
.claude/skills/
├── setup-editor/SKILL.md   # /setup-editor（初回セットアップ）
├── preview/SKILL.md        # /preview（プレビューの確認・起動）
├── draft-news/             # /draft-news（新規入稿）
│   └── references/article-format.md  # 記事の書き方（/edit-news と共通）
├── edit-news/SKILL.md      # /edit-news（既存記事の修正）
├── publish-news/SKILL.md   # /publish-news（公開）
└── cms-help/               # /cms-help（使い方の案内。表示のみ）
    └── references/commands.md  # 各コマンドの説明（scripts/tests/skills-help.test.mjs で Skill との一致を確認）
.github/
├── workflows/ci.yml        # CI
├── workflows/deploy.yml    # GitHub Pages への自動デプロイ
└── CODEOWNERS              # ワークフロー・スクリプトの変更は管理者レビュー
scripts/
├── setup/bootstrap.sh      # Node.js がなくても動く環境確認・mise / Node.js の導入
├── cms-node.sh             # mise.toml の Node.js（mise exec）でスクリプトを実行（Skill はこれ経由で呼ぶ）
├── setup-editor.mjs        # 環境確認とプレビュー起動
├── news.mjs                # 記事の検索・重複確認・ブランチ・画像・検証・PR 作成
├── publish-news.mjs        # 公開（検証・公開フラグ変更・CI 確認・マージ）
├── deploy-status.mjs       # GitHub Pages へのデプロイ状況の確認（読み取りのみ）
├── ci/                     # CI 用（content-scope.mjs・content-check.mjs・check-links.mjs）
├── tests/                  # node:test による単体テスト（npm run test:scripts）
└── lib/
    ├── common.mjs          # 共通処理（コマンド実行・プレビュー URL など）
    ├── workflow.mjs        # Git / GitHub / プレビューの操作
    ├── articles.mjs        # 記事ファイルの読み込み
    ├── content-rules.mjs   # 記事 PR の判定ルール（ローカル・CI 共通）
    ├── merge-guard.mjs     # マージ条件・CI 結果の判定
    └── optimize-images.mjs # 画像の最適化（コンテナ内で実行）
mise.toml                   # Node.js のバージョン（ローカル・CI・デプロイで共通）
compose.yaml / Dockerfile.dev / docker/dev-entrypoint.sh  # Docker 開発環境（任意）
src/
├── assets/news/            # 記事画像（Astro の画像最適化対象）
├── components/
│   ├── LanguageSwitcher.astro
│   ├── NewsCard.astro      # 一覧のカード
│   ├── NewsMeta.astro      # 公開日・カテゴリー・下書き表示
│   ├── SiteFooter.astro
│   └── SiteHeader.astro
├── content/news/
│   ├── en/*.md
│   └── ja/*.md
├── content.config.ts       # Content Collections と Zod スキーマ
├── i18n/
│   ├── config.ts           # 対応言語・カテゴリーの定義
│   └── ui.ts               # UI 文言・カテゴリー表示名・日付フォーマット
├── layouts/BaseLayout.astro
├── lib/news.ts             # 記事取得・下書き除外・整合性チェック・URL 生成
├── pages/
│   └── [lang]/news/
│       ├── index.astro     # NEWS 一覧
│       └── [slug].astro    # NEWS 詳細
└── styles/global.css       # デザイントークンと最小限のベーススタイル
```

※ 同梱のサンプル記事・画像は技術検証用のダミーです。
