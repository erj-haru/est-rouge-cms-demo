---
name: edit-news
description: すでにある記事の一部を直す（PR を更新）。slug または共通記事ID から記事を特定し、必要な箇所だけを変更して検証する。進行中の入稿 PR があればその PR を更新し、なければ公開済み記事でも新しい PR を作成する。修正後のプレビュー URL を返す。マージ・公開はしない。
when_to_use: 編集者が「site-renewal の記事の日付を直して」「さっき入稿した記事の画像を差し替えて」「英語版のタイトルを修正して」「公開済みのお知らせを修正したい」などと、既存記事の修正を依頼したとき。新しい記事の作成は draft-news を使う。
argument-hint: "[slug または共通記事ID] [修正内容]"
allowed-tools: Bash(sh scripts/cms-node.sh scripts/news.mjs find *) Bash(sh scripts/cms-node.sh scripts/news.mjs check *) Bash(sh scripts/cms-node.sh scripts/news.mjs verify *) Bash(sh scripts/cms-node.sh scripts/news.mjs pr * --dry-run) Bash(sh scripts/cms-node.sh scripts/setup-editor.mjs --preview *) Bash(git status *) Bash(git diff *)
---

# NEWS 記事の修正

編集者からの依頼: $ARGUMENTS

既存記事を修正し、PR 経由で反映する Skill です。処理は `/draft-news` と同じ `scripts/news.mjs` を使い、
記事の書き方は [../draft-news/references/article-format.md](../draft-news/references/article-format.md) に従います。
やり取りは日本語で行い、GitHub の画面操作は求めません。

## 手順

### 1. 対象記事を特定する

`sh scripts/cms-node.sh scripts/news.mjs find <slug または共通記事ID>`

- 見つからない場合は、出力された既存記事の一覧から候補を示して確認する。タイトルで指定された場合も一覧から探す。
- 出力の「入稿 PR」で、進行中の PR があるか確認する。

### 2. 修正範囲を確認する

- 修正内容を具体的に確認し、**変更するのは依頼された箇所だけ**にする（関係ない文言の言い換えや整形をしない）。
- 日英の両方に影響する修正（日付・数値・固有名詞・タイトル・画像など）は、もう一方の言語版の修正案も示して確認する。
  英訳の修正は翻訳案として扱う。
- `slug` と `articleId` は URL と日英の関連付けに使うため、原則として変更しない。変更を求められた場合は影響（URL が変わる）を
  説明して確認する。
- 公開済み記事（`draft: false`）の修正も、必ず PR 経由で行う。

### 3. ブランチを用意する

`sh scripts/cms-node.sh scripts/news.mjs start --slug <日本語版の slug>`

- 進行中の PR があればそのブランチに切り替え、GitHub 上の最新内容を取り込む。なければ新しいブランチを作る。
- 未コミットの変更があって止まった場合は、勝手にコミット・破棄せず、編集者に指示を仰ぐ。

### 4. 修正する

- 記事ファイルは Edit で該当箇所だけを書き換える。
- 画像の追加・差し替えは `sh scripts/cms-node.sh scripts/news.mjs images --slug <slug> <画像>` で新しいファイルとして配置し、参照を書き換える。
  既存画像の上書き（`--overwrite`）は了承がある場合のみ。古い画像ファイルは削除しない。

### 5. 検証と PR の更新

1. `sh scripts/cms-node.sh scripts/news.mjs verify --slug <slug>`
2. 修正前後の差分（`git diff -- <記事ファイル>`）の要点とプレビュー URL を編集者に示す。
3. `sh scripts/cms-node.sh scripts/news.mjs pr --slug <slug> --summary "<修正内容>" --dry-run`（英語版を新たに翻訳した場合は `--translated`）
   で、リポジトリ・ブランチ・更新する PR・コミットするファイルを提示し、了承を得てから `--dry-run` なしで実行する。
   同じ会話の中で同じ PR を続けて更新する場合も、提示は省略しない（了承の確認は簡潔でよい）。

### 6. 報告

```
記事を修正しました ✏️

- PR: <PR_URL>（既存の PR を更新 / 新しい PR を作成）
- プレビュー（日本語）: <PREVIEW_JA>
- プレビュー（英語）: <PREVIEW_EN>
- 修正内容: <要約>
```

## 守ること

`/draft-news` の「守ること」と同じ（マージしない・`main` に直接 Push しない・破壊的な Git 操作をしない・
記事と画像以外を変更しない・認証情報を扱わない・`news.mjs` が止まったら回避策をとらず報告する）。
