# NEWS 記事の書き方（/draft-news・/edit-news 共通）

スキーマの正本は `src/content.config.ts`、カテゴリーの一覧は `src/i18n/config.ts`。この文書と食い違う場合はそちらに従う。

## ファイルの配置

| 種類 | 場所 |
| --- | --- |
| 日本語記事 | `src/content/news/ja/YYYY-MM-DD-<slug>.md`（YYYY-MM-DD は公開日） |
| 英語記事 | `src/content/news/en/YYYY-MM-DD-<slug>.md` |
| 画像 | `src/assets/news/<slug>/NN-<name>.jpg`（`node scripts/news.mjs images` が配置する。手で置かない） |

記事から画像への参照は相対パス `../../../assets/news/<slug>/NN-<name>.jpg`。

## frontmatter

```md
---
title: "記事タイトル"
description: "一覧や検索結果に出る概要（1〜2 文、任意）"
publishedAt: 2026-11-20
category: news
slug: example-article
lang: ja
articleId: example-article
draft: true
thumbnail: ../../../assets/news/example-article/01-cover.jpg
thumbnailAlt: "サムネイル画像の内容を説明する文"
---
```

| 項目 | ルール |
| --- | --- |
| `title` / `description` / `thumbnailAlt` | 必ずダブルクォートで囲む（`:` や `#` を含んでも壊れないように）。`"` は `\"` にする |
| `publishedAt` | `YYYY-MM-DD`。原稿にない場合は推測せず編集者に確認する |
| `category` | `news`（お知らせ）/ `press`（プレスリリース）/ `event`（イベント）/ `recruit`（採用）のいずれか |
| `slug` | 小文字英数字とハイフン。英語タイトルから 3〜6 語程度で作り、編集者に確認する。日英で同じ値にする |
| `lang` | `ja` / `en`。配置フォルダと一致させる |
| `articleId` | 日英で同じ値。新規記事では slug と同じ値にする。**既存記事では変更しない** |
| `draft` | 新規入稿は `true`（マージしても公開されない。公開は後続の /publish-news で行う）。編集者が明示した場合のみ `false` |
| `thumbnail` / `thumbnailAlt` | 任意。サムネイルにする画像は編集者に確認する |

## 本文

- 見出しは `##` から始める（`#` はページタイトルで使用済み）。
- 画像: `![画像の内容を説明する代替テキスト](../../../assets/news/<slug>/02-xxx.jpg)`。代替テキストは「写真」「画像」だけにしない。
- 表は Markdown の表、日時や会場などの要項は表または箇条書きにする。
- 原稿にない事実（日時・数値・人名・役職・社名・URL）を補わない。不明点は `【要確認: …】` と書かず、執筆前に編集者へ質問する。

## 英語版

- 日本語原稿からの翻訳は「翻訳案」として作り、PR 作成時に `--translated` を付ける（PR にレビュー依頼が入る）。
- 人名の表記、役職名、製品・サービスの正式英語名、社内用語の訳は推測で確定しない。訳語の候補を示して編集者に確認する。
- 日本特有の表現（「平素より格別のご高配を…」等）は直訳せず、英語のプレスリリースとして自然な表現にする。
- 日付は `November 20, 2026`、時刻は `14:00 JST` の形式。
