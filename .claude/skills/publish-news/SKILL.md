---
name: publish-news
description: 確認が終わった記事を公開する（明確な承認が必要）。対象の記事 PR を特定し、編集者が確認した内容と PR のコミットが一致することを検証したうえで、明示的な公開の承認を得てから draft を false にして Push し、CI の成功とマージ条件をすべて確認してから PR をマージする。条件を満たさなければ理由を説明して停止する。
when_to_use: 編集者が「確認したので公開して」「この記事を公開して」「new-office-opening を公開したい」などと、入稿済み記事の公開を依頼したとき。記事の作成は draft-news、修正は edit-news を使う。
argument-hint: "[PR 番号 または slug]"
allowed-tools: Bash(node scripts/publish-news.mjs status *) Bash(node scripts/publish-news.mjs publish * --dry-run) Bash(node scripts/news.mjs find *) Bash(node scripts/deploy-status.mjs *)
---

# NEWS 記事の公開

編集者からの依頼: $ARGUMENTS

入稿済みの記事 PR を公開（`draft: false` にしてマージ）する Skill です。検証・公開フラグの変更・CI の確認・マージは
すべて `scripts/publish-news.mjs` が行います。あなたは手順の進行と、編集者への説明・承認の確認を担当します。
やり取りは日本語で行い、GitHub の画面操作は求めません。

## 手順

### 1. 対象の PR を特定する（1 回の依頼で 1 つだけ）

- PR 番号か slug が分かれば `node scripts/publish-news.mjs status --pr <番号>` または `--slug <slug>` を実行する。
- 分からなければ `node scripts/news.mjs find <キーワード>` で記事と進行中の PR を探し、どの記事か編集者に確認する。
- 複数の記事を一度に公開するよう頼まれても、1 つずつ順番に確認と承認を行う。

### 2. 公開前の確認内容を示す

`status` の結果から、次を編集者に示す。

- 記事のタイトル（日本語・英語）、公開日、カテゴリー
- プレビュー URL（`status` が「PR のコミットと同じ内容」と表示したもの）
- 確認対象のコミット（`REVIEWED_SHA` の先頭 7 文字）
- 公開すると何が起きるか: 日英の記事が `draft: false` になり、PR が main にマージされる。その後 GitHub Actions が Web サイト（GitHub Pages）へ自動でデプロイする
- ❌ の項目があれば、その理由と対処（下の「止まったとき」）。この場合は公開に進まない

手元のブランチが PR と一致しない警告が出た場合は、`node scripts/news.mjs start --slug <slug>` で PR のブランチに切り替え、
`status` をやり直してからプレビューを確認してもらう。

### 3. 公開の承認を得る

- **手順 2 で内容とコミットを示した後に**、編集者から「公開してください」のような明確な公開の指示を得る。
  依頼文に最初から「確認したので公開して」とあっても、手順 2 の提示の後にもう一度確認する（確認した内容と違うかもしれないため）。
- 「たぶん大丈夫」「あとで」など曖昧な返事は承認として扱わない。
- 承認した編集者の言葉を、そのまま `--approval` に渡す（PR に記録される）。

### 4. dry-run

`node scripts/publish-news.mjs publish --pr <番号> --reviewed-sha <REVIEWED_SHA> --approval "<編集者の言葉>" --dry-run`

❌ があれば停止して理由を説明する。すべて ✅ なら次へ進む。

### 5. 公開を実行する

`node scripts/publish-news.mjs publish --pr <番号> --reviewed-sha <REVIEWED_SHA> --approval "<編集者の言葉>" --ci-timeout-min 8`

- Bash のタイムアウトは 600000ms（10 分）にする。CI の待ち時間は `--ci-timeout-min 8` で 8 分以内にする。
- 途中で止まっても、同じコマンドをもう一度実行すれば続きから再開できる
  （公開フラグの変更が Push 済みなら、変更をやり直さずに CI の確認から再開する）。

### 6. Web サイトへの反映を確認する

マージの後、GitHub Actions が GitHub Pages（https://erj-haru.github.io/est-rouge-cms-demo/）へ自動でデプロイする。
`node scripts/deploy-status.mjs --sha <MERGE_COMMIT> --slug <slug> --wait --timeout-min 8` で反映を確認する
（Bash のタイムアウトは 600000ms）。読み取りだけで、何も変更しない。

- **マージの成功とデプロイの成功は別のこと**として報告する。マージできてもデプロイが失敗・実行中なら、
  「記事データには取り込まれたが、Web サイトにはまだ表示されていない」と伝える。
- デプロイが失敗した場合は、出力された Actions の URL を伝え、担当者への連絡を案内する（自分で再実行・修正しない）。

### 7. 報告

```
記事を公開しました 🎉

- 記事: <日本語タイトル> / <英語タイトル>
- PR: <PR_URL>（マージ済み）
- 公開承認: <アカウント> 「<編集者の言葉>」
- マージしたコミット: <MERGE_COMMIT 先頭 7 文字>
- Web サイトへの反映: <反映済み（記事の公開 URL）／ デプロイ実行中 ／ デプロイ失敗（Actions の URL）>
```

## 止まったとき

| 状況 | 説明と対処 |
| --- | --- |
| 確認したコミットと PR のコミットが一致しない | 確認後に記事が変更されている。`/preview` で最新の内容を確認し直してもらい、手順 2 からやり直す |
| 記事・画像以外の変更を含む / `content` ラベルがない | 記事 PR ではないため公開できない。リポジトリの担当者にレビューとマージを依頼するよう案内する |
| CI が失敗・タイムアウト | マージしていないので公開されていない。CI のリンクを伝え、修正が必要なら `/edit-news` を案内する。再実行は同じコマンドで続きから |
| マージ可能な状態ではない（コンフリクト等） | 担当者に相談するよう案内する。自分で解消しない |
| 公開処理のスクリプトが main と異なる | 手元のスクリプトが変更されている。担当者に相談するよう案内する |

## 守ること

- **承認なしに公開しない。** 手順 3 の承認を得ずに `--dry-run` なしの `publish` を実行しない。
- **`gh pr merge` を直接実行しない。** マージは `publish-news.mjs` だけが、すべての条件を確認したうえで行う。
  `--admin`・自動マージ・強制マージは使わない。
- **1 回の承認で 1 つの PR だけを公開する。** コード変更 PR（記事・画像以外を含む PR）は公開・マージしない。
- **記事を書き換えない。** 公開前に修正が必要なら `/edit-news` で修正し、確認からやり直す。
- **破壊的な Git 操作をしない。** `git reset`・`git push --force`・`git checkout -- <file>`・`git stash` などは実行しない。
- ❌ で止まった場合に、別のコマンドで回避しようとしない。理由を説明して編集者の判断を仰ぐ。
