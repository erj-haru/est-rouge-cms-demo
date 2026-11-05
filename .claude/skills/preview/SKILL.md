---
name: preview
description: 記事の見た目を手元で確認する（ローカルプレビュー）。プレビュー用の Astro 開発サーバーの起動状態を確認し、停止していれば Docker Compose で起動して NEWS 一覧の URL を表示する。記事の slug を指定すると、その記事の詳細ページ（日本語・英語）の URL も表示する。起動中なら再起動しない。
when_to_use: 編集者が「プレビューを開いて」「プレビューを起動して」「開発サーバーは動いてる？」「site-renewal の記事を確認したい」「さっき書いた記事をプレビューで見たい」などと依頼したとき。初回セットアップや GitHub の確認は setup-editor を使う。
argument-hint: "[記事のslug]"
allowed-tools: Bash(sh scripts/cms-node.sh scripts/setup-editor.mjs --preview) Bash(sh scripts/cms-node.sh scripts/setup-editor.mjs --preview *) Bash(sh scripts/setup/bootstrap.sh check) Bash(docker compose ps *) Bash(docker compose logs *)
---

# ローカルプレビュー

指定された記事: `$ARGUMENTS`（空の場合は指定なし）

プレビューの状態確認と起動は `scripts/setup-editor.mjs --preview` が行います（`/setup-editor` と同じ処理を再利用）。
あなたの役割は、対象記事の特定・スクリプトの実行・結果の案内です。やり取りは日本語で行ってください。

## 手順

1. **対象記事の特定**（記事の指定がなければこの手順は飛ばす）
   - slug は記事ファイルの frontmatter にある `slug:` の値（例: `site-renewal`）。
   - タイトル・ファイル名・「さっき書いた記事」などで指定された場合は、`src/content/news/` の Markdown を検索して該当記事の `slug:` を調べる。
     候補が複数あるときは、どれを表示するかユーザーに確認する。
2. **実行**: プロジェクトのルートで次を実行する（タイムアウトは 10 分 = 600000ms。停止中からの起動には時間がかかる場合がある）。
   - 記事の指定なし: `sh scripts/cms-node.sh scripts/setup-editor.mjs --preview`
   - 記事の指定あり: `sh scripts/cms-node.sh scripts/setup-editor.mjs --preview --slug <slug>`
3. **結果の判定**
   - 終了コード `0`: 表示された URL を報告する。
   - 終了コード `1`: 「対応が必要な項目」の内容を、番号付きの手順で簡潔に伝える。
     - 記事が見つからない場合は、出力された「現在表示できる記事の slug」から近いものを提案する。
     - **Docker Engine が起動していない**（Docker Desktop は導入済み）場合は、「Docker Desktop を起動します」と説明してから
       `sh scripts/setup/bootstrap.sh start-docker` を実行し（タイムアウト 600000ms。起動済みなら何もしない）、成功したら手順 2 をやり直す。
       タイムアウトした場合は、Docker Desktop の画面で利用規約・権限の許可を求められていないか確認してもらう。
     - Docker Desktop が未導入、ポートが使用中などの環境の問題は、`.claude/skills/setup-editor/SKILL.md` の流れに従う
       （導入には承認が必要なため、`/setup-editor` を勧める）。
   - 終了コード `3`（`cms-node.sh`）: 使える Node.js がない。`/setup-editor` で準備できることを伝える。
   - 終了コード `2`: エラー内容を要約し、必要なら `docker compose logs astro --tail 50` で原因を調べる。

## 守ること

- 起動中のプレビューは再起動しない（スクリプトは、依存関係や設定が変わったときだけ作り直す）。
- Docker Desktop・Node.js の導入はこの Skill では行わない（`/setup-editor` で承認を得て行う）。ほかのプログラムやコンテナは止めない。
- コンテナやボリュームの削除、プロセスの停止などの破壊的な操作は、ユーザーの明示的な確認なしに行わない。
- 記事ファイルの内容は変更しない（この Skill は表示の確認のみ）。

## 報告の形式

```
プレビューを表示できます 👀

- NEWS 一覧（日本語）: http://localhost:4321/ja/news/
- NEWS 一覧（英語）: http://localhost:4321/en/news/
- 記事詳細（日本語）: http://localhost:4321/ja/news/<slug>/   ← 記事を指定した場合
- 記事詳細（英語）: http://localhost:4321/en/news/<slug>/     ← 英語版がある場合
```

下書き記事の場合は「下書きのため本番サイトには公開されない」ことを添える。
すでに起動していた場合は「起動済みのプレビューをそのまま使っています」と一言添える。
