---
name: preview
description: 記事の見た目を手元で確認する（ローカルプレビュー）。プレビュー用の Astro 開発サーバーの起動状態を確認し、停止していれば Docker Compose で起動して NEWS 一覧の URL を表示する。記事の slug を指定すると、その記事の詳細ページ（日本語・英語）の URL も表示する。起動中なら再起動しない。
when_to_use: 編集者が「プレビューを開いて」「プレビューを起動して」「開発サーバーは動いてる？」「site-renewal の記事を確認したい」「さっき書いた記事をプレビューで見たい」などと依頼したとき。初回セットアップや GitHub の確認は setup-editor を使う。
argument-hint: "[記事のslug]"
allowed-tools: Bash(node scripts/setup-editor.mjs --preview) Bash(node scripts/setup-editor.mjs --preview *) Bash(docker compose ps *) Bash(docker compose logs *)
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
   - 記事の指定なし: `node scripts/setup-editor.mjs --preview`
   - 記事の指定あり: `node scripts/setup-editor.mjs --preview --slug <slug>`
3. **結果の判定**
   - 終了コード `0`: 表示された URL を報告する。
   - 終了コード `1`: 「対応が必要な項目」の内容を、番号付きの手順で簡潔に伝える。
     - 記事が見つからない場合は、出力された「現在表示できる記事の slug」から近いものを提案する。
     - Docker が起動していない・ポートが使用中などの環境の問題は、`.claude/skills/setup-editor/SKILL.md` の「よくある問題と対処」に従って案内する。
       環境全体を確認したほうがよさそうなら `/setup-editor` を勧める。
   - 終了コード `2`: エラー内容を要約し、必要なら `docker compose logs astro --tail 50` で原因を調べる。

## 守ること

- 起動中のプレビューは再起動しない（スクリプトは起動済みなら状態確認だけを行う）。
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
