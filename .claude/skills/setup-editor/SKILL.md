---
name: setup-editor
description: 記事を書く準備をする（初回セットアップ・環境の確認）。Mac の環境（Node.js・Docker Desktop・Git・GitHub CLI・GitHub へのログインとリポジトリ権限）を自動で確認し、不足をまとめて示す。承認を得たうえで、このプロジェクト専用の Node.js の導入、Docker Desktop の導入・起動を Claude が行い、Docker Compose でプレビュー（http://localhost:4321）を起動して URL を表示する。何度実行しても安全。
when_to_use: 編集者が「このプロジェクトの記事入稿環境をセットアップして」「初期設定をして」「環境を確認して」「Docker を準備して」「GitHub にログインできているか確認して」などと依頼したとき。プレビューの起動や記事 URL の確認だけなら preview を使う。
argument-hint: "[--check]"
allowed-tools: Bash(sh scripts/setup/bootstrap.sh check) Bash(sh scripts/setup/bootstrap.sh verify-docker-app *) Bash(sh scripts/cms-node.sh scripts/setup-editor.mjs) Bash(sh scripts/cms-node.sh scripts/setup-editor.mjs *) Bash(docker compose ps *) Bash(docker compose logs *)
---

# 記事入稿環境のセットアップ

編集者（エンジニアではない人も含む）が、Claude Desktop の Code タブ（Local セッション）から、**ターミナルを開かずに**
記事のプレビューまで進められるようにする Skill です。

- 環境の確認・導入・起動は `scripts/setup/bootstrap.sh`（Node.js がなくても動く）が行う。
- GitHub・プレビューの確認と起動は `scripts/setup-editor.mjs` が行い、`scripts/cms-node.sh` 経由で実行する
  （既存の Node.js が古い・ない場合は、このプロジェクト専用の Node.js を使う）。
- ホストの Node.js は、編集者向けスクリプトを動かすためのもの。Astro は Docker の中の Node.js で動く。この 2 つを混同しない。

やり取りは日本語で、専門用語は必要最小限にする。

## 流れ

### 1. 環境を自動で確認する

`sh scripts/setup/bootstrap.sh check` を実行する（何も変更しない）。末尾の `STATUS` 行を読み取る。

### 2. 不足しているものをまとめて示す

次の表の形で、**一度にまとめて**示す（1 つずつ小出しにしない）。

| 項目 | 状態 | これから行うこと |
| --- | --- | --- |
| Node.js | `node`=missing（または古い） | このプロジェクト専用の Node.js v22 を導入（約 50MB。既存の Node.js・PATH は変更しない） |
| Docker Desktop | `docker_app`=no | 公式サイトから導入（約 600MB。署名と公証を確認してから入れる） |
| Docker の起動 | `docker_engine`=stopped / starting | Docker Desktop を起動して準備完了まで待つ |
| プレビュー | `preview_container` / `port_4321` | 既存のプレビューを再利用、または起動 |

- Docker Desktop が必要な理由: 記事のプレビュー（Astro）を、どの Mac でも同じ条件で動かすため。
- 次の場合は**導入を行わず**、理由を説明して止まる（IT 担当・管理者への相談を案内する）。
  - `admin=no`（管理者権限がない）→ Docker Desktop を導入できない
  - `mdm=yes`（組織の端末管理に登録）→ Node.js・Docker Desktop とも自動導入しない
  - macOS 以外（`os`≠Darwin）→ 公式サイトの手順を案内する
- `port_4321=other:…` の場合は、そのプログラムを止めない。何が使っているかを伝え、編集者に判断してもらう。

### 3. 承認を得る

導入・起動する内容をまとめて示し、**明示的な承認**を得る（AskUserQuestion などで選択肢を示す）。

- **Docker Desktop を導入する場合**、`docker_license_policy=unconfirmed` なら、承認と合わせて次も確認する。
  > Docker Desktop は、組織の規模によっては有料の契約が必要です（https://www.docker.com/pricing/faq/）。
  > この Mac での利用は、会社の契約・ルールで認められていますか？

  「認められている」以外（「わからない」など）の場合は、**Docker Desktop の導入を保留**し、管理者への確認を案内する。
- 承認が得られなかった項目は実行しない。「やめておく」と言われたら、その時点の状態と、後から再開する方法だけを伝える。
- Docker Desktop の起動だけの場合は、承認は不要。「Docker Desktop を起動します（初回は利用規約の画面が表示されます）」と説明してから実行する。

### 4. Claude が実行する

承認された項目だけを、次の順に実行する。

| 操作 | コマンド | 注意 |
| --- | --- | --- |
| Node.js の導入 | `sh scripts/setup/bootstrap.sh install-node --approved` | 公式配布元から取得し、SHA-256 を検証する。タイムアウトは 600000ms |
| Docker Desktop の導入 | `sh scripts/setup/bootstrap.sh install-docker --approved --license-confirmed` | 約 600MB のダウンロードがあるため、Bash の `run_in_background` で実行し、完了の通知を待つ。`--license-confirmed` は手順 3 で「認められている」と確認できた場合だけ付ける |
| Docker Desktop の起動 | `sh scripts/setup/bootstrap.sh start-docker` | 最大 4 分待つ。タイムアウトは 600000ms。起動済みなら何もしない |

終了コードと対処:

| 終了コード | 意味 | 対処 |
| --- | --- | --- |
| 5 | ダウンロード・検証の失敗 | 何もインストールしていない。ネットワークを確認して再実行を提案する |
| 6 | 承認・ライセンス確認がない | 手順 3 に戻る |
| 7 / 8 | 管理者権限がない / MDM 管理端末 | 導入しない。IT 担当への依頼を案内する |
| 9 | メモリ・空き容量の不足 | 必要な容量を伝える |
| 11 | Docker の起動待ちがタイムアウト | 手順 5 の本人操作を案内し、終わったら `start-docker` を再実行する |
| 12 | Docker Desktop が起動後に終了 | Docker Desktop の画面のエラーを確認してもらう |
| 13 | インストールの中断（認証のキャンセルなど） | 状態を `check` で確認し、再実行するか相談する |

### 5. 本人の操作が必要な部分だけを案内する

Claude からは行えない（行ってはいけない）操作は、**何を・どこで・なぜ**を具体的に伝えて本人に任せる。

- Docker Desktop の初回起動時に表示される**利用規約への同意**
- macOS のパスワード入力・権限の許可ダイアログ（Docker Desktop が必要とする場合）
- GitHub へのログイン（未ログインの場合）。組織の Skill `setup-workspace` が使える場合は「CMS を使えるようにして」と伝えると、
  画面内でログインを始められる（アカウントの切り替えもこちらで本人に確認しながら行う）

本人の操作が終わったら、該当する手順（`start-docker` など）を再実行して続きから確認する。

### 6. 結果を再検証する

`sh scripts/setup/bootstrap.sh check` をもう一度実行し、導入・起動が実際に成功したことを確認する。
**失敗した操作を成功として報告しない。**

### 7. プレビューを起動する

`sh scripts/cms-node.sh scripts/setup-editor.mjs` を実行する（タイムアウトは 600000ms）。
GitHub・Docker・プレビューを確認し、既存のプレビューが正常なら再利用、停止していれば起動する。
依存関係（package-lock.json など）が変わっていれば、必要なときだけ作り直す。
環境の確認だけを頼まれた場合、または引数に `--check` が指定された場合（引数: `$ARGUMENTS`）は `--check` を付ける。

- `0`: 準備完了。手順 8 へ。
- `1`: 「対応が必要な項目」を、番号付きの手順で簡潔に伝える。
- `3`（`cms-node.sh`）: Node.js がない。手順 2 に戻って Node.js の導入を提案する。

### 8. 報告する

```
セットアップが完了しました 🎉

- GitHub アカウント: <アカウント名>（<権限>）
- Node.js: <既存の vXX ／ このプロジェクト専用 v22.23.4>
- Docker Desktop: <バージョン>（起動中）
- プレビュー（日本語）: http://localhost:4321/ja/news/
- プレビュー（英語）: http://localhost:4321/en/news/

次は「新しいお知らせを入稿したい」と伝えると、記事を作れます。使い方は /cms-help で確認できます。
```

対応が必要な項目が残っている場合は、完了した項目を短く伝えたうえで、残りを「何をすればよいか」が分かる手順として示す。

## 守ること

- **承認なしに導入しない。** `install-node`・`install-docker` は手順 3 の承認を得てから実行する。
- **既存のものを変更しない。** 既存の Node.js・npm・アプリ・PATH・シェルの設定ファイルを変更・上書き・アップグレードしない。
- **権限や組織のルールを回避しない。** `sudo` を使わない。管理者権限が必要な場面は macOS 標準の認証ダイアログに任せる。
  管理者でない・MDM 管理端末・ライセンス未確認の場合は導入しない。
- **未確認のインストーラーを実行しない。** 導入は `bootstrap.sh` の検証（チェックサム・署名・公証）を通したものだけ。
  Homebrew など別の経路で勝手に導入しない。
- **ほかのプロジェクトに触れない。** ほかのコンテナ・イメージ・ボリュームの停止・削除、`docker system prune`、
  ポート 4321 を使うほかのプログラムの停止は行わない。
- **認証情報を扱わない。** `gh auth token` などを実行しない。パスワード・トークンを尋ねない・表示しない。
  GitHub のログイン中のアカウントを勝手に切り替えない。
- **破壊的な操作をしない。** ソースコードや未コミットの変更を破棄しない。`git reset`・`git clean`・`git stash` などは実行しない。
- **ターミナル操作はフォールバック。** Claude から実行できない場合（コマンドが許可されない、Local セッションではない等）に限り、
  実行するコマンドと目的を示して、本人にターミナルで実行してもらう。

## よくある問題と対処

| 状況 | 対処 |
| --- | --- |
| Docker Desktop は導入済みだが Engine が停止 | `start-docker` で起動する（手順 4） |
| Docker の起動が終わらない | Docker Desktop の画面で利用規約・権限の許可を求められていないか確認してもらう |
| GitHub にログインしていない | `setup-workspace` が使える場合はそちらを案内する。使えない場合のみ、ご自身のターミナルで `gh auth login --hostname github.com --git-protocol https --web` を実行してもらう |
| リポジトリにアクセスできない・閲覧のみ | 招待の承認、または管理者に Write 権限を依頼する。別のアカウントに切り替える場合は本人に確認してから |
| ポート 4321 が使用中 | 使用中のプログラムを伝え、止めるかどうかは本人に判断してもらう |
| 起動後に応答がない | `docker compose logs astro --tail 50` を確認し、記事の frontmatter エラーなら該当ファイルと項目を伝える |
| Windows で編集が反映されない | リポジトリを WSL 2 側に置くか、`ASTRO_USE_POLLING=true` で起動し直す（再起動になるため確認を取る） |
