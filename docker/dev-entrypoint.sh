#!/bin/sh
# node_modules ボリュームとロックファイルの整合性を確認してから開発サーバーを起動する。
# 名前付きボリュームは初回作成時にしかイメージの内容で初期化されないため、
# package-lock.json や Node.js のバージョンが変わった場合はここで再インストールする。
set -eu

cd /app
stamp_file=node_modules/.install-stamp
expected="$(sha256sum package-lock.json | cut -d' ' -f1) node-$(node -v) $(uname -m)"
current="$(cat "$stamp_file" 2>/dev/null || true)"

if [ "$expected" != "$current" ]; then
  echo "[dev-entrypoint] package-lock.json または Node.js の変更を検出しました。依存関係を再インストールします..."
  # node_modules はボリュームのマウントポイントのため、ディレクトリ自体ではなく中身だけを入れ替える
  find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  npm ci
  echo "$expected" > "$stamp_file"
  echo "[dev-entrypoint] 依存関係のインストールが完了しました"
fi

exec "$@"
