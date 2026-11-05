---
name: setup-editor
description: 記事を書く準備をする（初回セットアップ・環境の確認）。Mac の環境（mise・Node.js・Git・GitHub CLI・GitHub へのログインとリポジトリ権限・ポート 4321）を自動で確認し、不足をまとめて示す。承認を得たうえで、mise と Node.js（mise.toml の固定バージョン）を Claude が導入し、npm ci で依存関係を再現して、プレビュー（http://localhost:4321）を起動し URL を表示する。Docker は使わない。何度実行しても安全。
when_to_use: 編集者が「このプロジェクトの記事入稿環境をセットアップして」「初期設定をして」「環境を確認して」「Node.js を準備して」「GitHub にログインできているか確認して」などと依頼したとき。プレビューの起動や記事 URL の確認だけなら preview を使う。
argument-hint: "[--check]"
allowed-tools: Bash(sh scripts/setup/bootstrap.sh check) Bash(sh scripts/cms-node.sh scripts/setup-editor.mjs) Bash(sh scripts/cms-node.sh scripts/setup-editor.mjs *)
---

# 記事入稿環境のセットアップ

編集者（エンジニアではない人も含む）が、Claude Desktop の Code タブ（Local セッション）から、**ターミナルを開かずに**
記事のプレビューまで進められるようにする Skill です。

- 環境の確認と、mise・Node.js の導入は `scripts/setup/bootstrap.sh`（Node.js がなくても動く）が行う。
- 依存関係（`npm ci`）・GitHub・プレビューは `scripts/setup-editor.mjs` が行い、`scripts/cms-node.sh` 経由で
  **mise.toml に固定した Node.js（`mise exec`）**で実行する。
- 既存の Node.js・PATH・シェルの設定は使わず、変更もしない。Docker・Docker Desktop は使わない。

やり取りは日本語で、専門用語は必要最小限にする（mise は「Node.js のバージョンをプロジェクトごとに管理する道具」と説明する）。

## 流れ

### 1. 環境を自動で確認する

`sh scripts/setup/bootstrap.sh check` を実行する（何も変更しない）。末尾の `STATUS` 行を読み取る。
macOS のバージョンと CPU（Apple シリコン / Intel）もここで分かる。

### 2. 不足しているものをまとめて示す

次の表の形で、**一度にまとめて**示す（1 つずつ小出しにしない）。

| 項目 | 状態 | これから行うこと |
| --- | --- | --- |
| mise | `mise`=missing | CMS 専用の場所（`~/.est-rouge-cms/bin`）に導入（約 50MB。公式リリースから取得し、チェックサムを確認） |
| Node.js | `node`=missing | mise で Node.js（`node_required`）を導入（約 50MB。既存の Node.js は変更しない） |
| 依存関係 | `dependencies`=missing | `npm ci` で、ロックファイルどおりに再現（数分） |
| プレビュー | `port_4321` | 起動済みなら再利用、空いていれば起動 |

- 既存の mise（`mise=existing`）があればそれを使い、導入し直さない。
- `mdm=yes`（組織の端末管理に登録）の場合は、導入してよいか組織のルールを確認してもらう（分からなければ導入しない）。
- macOS・Linux 以外（`os`）は自動導入しない。https://mise.jdx.dev/ の手順を案内する。
- `port_4321=docker` は以前の Docker 版のプレビューの可能性が高い。止めてよいか確認し、了承があればこのフォルダで
  `docker compose stop` を実行する（ほかのコンテナには触れない）。`port_4321=other:…` のプログラムは止めない。

### 3. 承認を得る

導入する内容（mise・Node.js・依存関係のダウンロード）をまとめて示し、**明示的な承認**を得る
（AskUserQuestion などで選択肢を示す）。承認が得られなかった項目は実行しない。
「やめておく」と言われたら、その時点の状態と、後から再開する方法だけを伝える。

### 4. mise と Node.js を導入する

承認された項目だけを、次の順に実行する（各タイムアウトは 600000ms）。

| 操作 | コマンド |
| --- | --- |
| mise の導入 | `sh scripts/setup/bootstrap.sh install-mise --approved` |
| Node.js の導入 | `sh scripts/setup/bootstrap.sh install-node --approved` |

終了コード: `5` ダウンロード・検証の失敗（何も導入していない。ネットワークを確認して再実行を提案）、
`6` 承認がない（手順 3 に戻る）、`4` 未対応の OS・CPU、`9` 空き容量の不足、`3` mise がない（install-mise を先に）。

### 5〜7. 依存関係の再現・プレビューの起動・ページの確認

`sh scripts/cms-node.sh scripts/setup-editor.mjs` を実行する（タイムアウトは 600000ms）。このスクリプトが次を行う。

- 固定した Node.js で動いているか、GitHub へのログインとリポジトリ権限を確認する
- 依存関係が未インストール、またはロックファイルが変わっていれば `npm ci` で再現する
- プレビュー（Astro の開発サーバー）を起動する。起動済みなら再利用し、依存関係を入れ直したときだけ再起動する
- 日本語・英語の NEWS 一覧と詳細ページが表示できることを確認する

環境の確認だけを頼まれた場合、または引数に `--check` が指定された場合（引数: `$ARGUMENTS`）は `--check` を付ける
（インストール・起動はしない）。

- `0`: 準備完了。手順 8 へ。
- `1`: 「対応が必要な項目」を、番号付きの手順で簡潔に伝える。
- `3`（`cms-node.sh`）: mise または Node.js がない。手順 2 に戻る。

本人の操作が必要な部分（GitHub へのログイン、macOS の許可ダイアログが出た場合など）は、**何を・どこで・なぜ**を伝えて任せる。
終わったら、もう一度この手順を実行して確認する。**失敗した操作を成功として報告しない。**

### 8. 報告する

```
セットアップが完了しました 🎉

- GitHub アカウント: <アカウント名>（<権限>）
- Node.js: v<バージョン>（mise で管理）
- プレビュー（日本語）: http://localhost:4321/ja/news/
- プレビュー（英語）: http://localhost:4321/en/news/

次は「新しいお知らせを入稿したい」と伝えると、記事を作れます。使い方は /cms-help で確認できます。
```

対応が必要な項目が残っている場合は、完了した項目を短く伝えたうえで、残りを「何をすればよいか」が分かる手順として示す。

## 守ること

- **承認なしに導入しない。** `install-mise`・`install-node` は手順 3 の承認を得てから実行する。
- **既存のものを変更しない。** 既存の Node.js・npm・mise・PATH・シェルの設定ファイルを変更しない。`mise activate` を
  シェルに設定しない。`mise use --global` など、プロジェクトの外に影響する mise の操作をしない。
- **未確認のものを導入しない。** 導入は `bootstrap.sh` の検証（チェックサム）を通したものだけ。Homebrew など別の経路で勝手に導入しない。
- **管理者権限・組織のルールを回避しない。** `sudo` を使わない（mise・Node.js はホームディレクトリ内に導入するため不要）。
- **ほかのプログラムを止めない。** ポート 4321 を使うほかのプログラムは停止しない。Docker のリソースを変更・削除しない
  （以前の Docker 版プレビューの停止は、了承を得た場合に `docker compose stop` のみ）。
- **認証情報を扱わない。** `gh auth token` などを実行しない。パスワード・トークンを尋ねない・表示しない。
  GitHub のログイン中のアカウントを勝手に切り替えない。
- **破壊的な操作をしない。** ソースコードや未コミットの変更を破棄しない。`git reset`・`git clean`・`git stash` などは実行しない。
- **ターミナル操作はフォールバック。** Claude から実行できない場合（コマンドが許可されない、Local セッションではない等）に限り、
  実行するコマンドと目的を示して、本人にターミナルで実行してもらう。

## よくある問題と対処

| 状況 | 対処 |
| --- | --- |
| mise・Node.js がない | 手順 2〜4 で、承認を得て導入する |
| 「v22.x で実行されています」と表示される | `sh scripts/cms-node.sh` を経由せずに実行している。必ず `cms-node.sh` 経由で実行する |
| GitHub にログインしていない | 組織の Skill `setup-workspace` が使える場合はそちらを案内する。使えない場合のみ、ご自身のターミナルで `gh auth login --hostname github.com --git-protocol https --web` を実行してもらう |
| リポジトリにアクセスできない・閲覧のみ | 招待の承認、または管理者に Write 権限を依頼する。別のアカウントに切り替える場合は本人に確認してから |
| ポート 4321 が使用中 | 使用中のプログラムを伝え、止めるかどうかは本人に判断してもらう（Docker 版のプレビューなら手順 2 のとおり） |
| 起動後に応答がない・npm ci の失敗 | `sh scripts/cms-node.sh scripts/setup-editor.mjs --logs` でログを確認し、記事の frontmatter エラーなら該当ファイルと項目を伝える |
| プレビューを止めたい | `sh scripts/cms-node.sh scripts/setup-editor.mjs --stop` |
