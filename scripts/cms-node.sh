#!/bin/sh
# 編集者向けスクリプトを、このプロジェクトで使える Node.js で実行する
#
#   sh scripts/cms-node.sh scripts/setup-editor.mjs [引数...]
#
# Node.js の選び方（scripts/setup/bootstrap.sh node-path と同じ）:
#   ① 既存の Node.js（20 以上）があればそれを使う
#   ② なければ /setup-editor で導入したこのプロジェクト専用の Node.js（~/.est-rouge-cms/node/）を使う
# 既存の Node.js・PATH・シェルの設定は変更しない。
# Docker Desktop の導入直後で docker コマンドが PATH にない場合は、このコマンドの実行中だけ PATH の末尾に補う。
DIR=$(cd "$(dirname "$0")" && pwd)

if ! NODE=$(sh "$DIR/setup/bootstrap.sh" node-path); then
  echo "❌ 使用できる Node.js（20 以上）が見つかりません。Claude Code に「記事入稿環境をセットアップして」と伝えると、確認のうえ準備します（/setup-editor）" >&2
  exit 3
fi

if ! command -v docker >/dev/null 2>&1; then
  if DOCKER_DIR=$(sh "$DIR/setup/bootstrap.sh" docker-bin-dir 2>/dev/null); then
    PATH="$PATH:$DOCKER_DIR"
    export PATH
  fi
fi

exec "$NODE" "$@"
