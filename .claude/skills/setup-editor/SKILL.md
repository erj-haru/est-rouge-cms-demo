---
name: setup-editor
description: 記事入稿環境の初回セットアップ。Git・GitHub CLI・GitHub へのログインとリポジトリ権限・Docker を確認し、不足があれば日本語で手順を案内する。準備が整っていれば Docker Compose で Astro 開発サーバーを起動し、プレビュー URL を表示する。何度実行しても安全。
when_to_use: 編集者が「このプロジェクトの記事入稿環境をセットアップして」「初期設定をして」「環境を確認して」「GitHub にログインできているか確認して」などと依頼したとき。プレビューの起動や記事 URL の確認だけなら preview を使う。
argument-hint: "[--check]"
allowed-tools: Bash(node --version) Bash(node scripts/setup-editor.mjs) Bash(node scripts/setup-editor.mjs *) Bash(docker compose ps *) Bash(docker compose logs *)
---

# 記事入稿環境のセットアップ

編集者（エンジニアではない人も含む）が、記事をローカルでプレビューできる状態にするための Skill です。
確認と起動は `scripts/setup-editor.mjs` が行います。あなたの役割は、その実行と結果の分かりやすい案内です。
やり取りはすべて日本語で、専門用語は必要最小限にしてください。

## 手順

1. **Node.js の確認**: `node --version` を実行する。
   - 見つからない場合はスクリプトを実行できないため、Node.js 22 LTS 以上のインストールを案内して終了する
     （macOS: `brew install node@22` または https://nodejs.org/ja/download 、Windows: `winget install OpenJS.NodeJS.LTS`）。
   - Node.js はセットアップスクリプトのためだけに使う。Astro 自体は Docker 上で動くため、バージョンが低くても 18 以上なら続行してよい。
2. **セットアップの実行**: プロジェクトのルートで `node scripts/setup-editor.mjs` を実行する。
   - 初回は Docker イメージの作成に数分かかるため、タイムアウトは 10 分（600000ms）にする。
   - 環境の確認だけを頼まれた場合、または引数に `--check` が指定された場合（引数: `$ARGUMENTS`）は
     `node scripts/setup-editor.mjs --check` を使う（起動はしない）。
3. **結果の判定**（終了コードと出力の ✅ / ⚠️ / ❌ を見る）
   - `0`: 準備完了。「報告」へ進む。
   - `1`: 利用者の対応が必要。「対応が必要な項目」の内容を、手順ごとに番号付きで簡潔に伝える。
     ユーザーが対応を終えたと言ったら、もう一度スクリプトを実行して確認する。
   - `2`: 想定外のエラー。エラー内容を要約し、必要なら `docker compose logs astro --tail 50` で原因を調べる。
4. **報告**: 下の「報告の形式」に従って結果をまとめる。

## 守ること

- **本人認証はユーザー自身に行ってもらう。** `gh auth login` をあなたが実行しない。
  ユーザー自身のターミナル（Claude Code の外）で実行するよう案内する。
- **認証情報を扱わない。** `gh auth token`、`gh auth status --show-token` などトークンを表示するコマンドは実行しない。
  パスワード・トークン・認証コードを尋ねたり、貼り付けを求めたりしない。ユーザーが貼り付けてしまった場合は、
  その値を繰り返さず、トークンを無効化（再発行）するよう勧める。
- **ソフトウェアのインストールやアプリの起動は、ユーザーの了承を得てから。**
  Git・GitHub CLI・Docker Desktop が不足している場合は手順を案内する。ユーザーが「やって」と明示した場合のみ実行してよい
  （例: macOS で Docker Desktop を起動する `open -a Docker`）。
- **破壊的な操作は、内容を説明してユーザーの明示的な確認を得るまで実行しない。**
  例: `docker compose down -v`、`docker volume rm`、`docker system prune`、プロセスの `kill`、`git reset` / `git clean`、ファイルの削除。
- **起動中のプレビューは再起動しない。** スクリプトは冪等で、起動済みなら状態の確認だけを行う。何度実行してもよい。
- 記事の作成・GitHub への PR 作成はこの Skill の対象外。セットアップが終わったら、次に何ができるかを一言添える程度にとどめる。
- 2 回目以降にプレビューだけを開きたい場合は `/preview`（`/preview <slug>` で記事詳細の URL も表示）を案内する。

## よくある問題と対処

| 状況 | 対処 |
| --- | --- |
| Docker Engine が起動していない | Docker Desktop を起動し、クジラのアイコンが「running」になってから再実行 |
| GitHub にログインしていない | ユーザー自身のターミナルで `gh auth login --hostname github.com --git-protocol https --web` |
| リポジトリにアクセスできない | 招待メールまたは `https://github.com/<owner>/<repo>/invitations` から招待を承認。別アカウントなら `gh auth switch` |
| ポート 4321 が使用中 | 使用中のプロセスをユーザーに確認してもらう（あなたが勝手に停止しない）。別ターミナルの `npm run dev` が多い |
| 起動後に応答がない | `docker compose logs astro --tail 50` を確認。記事の frontmatter エラーなら該当ファイルと項目を伝える |
| Windows で編集が反映されない | リポジトリを WSL 2 側（`\\wsl$\...`）に置くことを推奨。難しい場合は `ASTRO_USE_POLLING=true` を設定して起動し直す（再起動になるため確認を取る） |
| `package-lock.json` が更新された | 対応不要。コンテナ起動時に依存関係が自動で再インストールされる |

## 報告の形式

準備完了時は次の形でまとめる（URL はスクリプトの出力に合わせる）。

```
セットアップが完了しました 🎉

- GitHub アカウント: <アカウント名>（<権限>）
- プレビュー（日本語）: http://localhost:4321/ja/news/
- プレビュー（英語）: http://localhost:4321/en/news/

src/content/news/ の記事を編集すると、プレビューに自動で反映されます。
次回からは /preview でプレビューを開けます（/preview <slug> で記事詳細の URL も表示）。
```

対応が必要な項目が残っている場合は、完了した項目を短く伝えたうえで、
残りの項目を「何をすればよいか」が分かる手順として番号付きで示す。
