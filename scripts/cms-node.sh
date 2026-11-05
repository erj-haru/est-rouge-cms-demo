#!/bin/sh
# 編集者向けスクリプトを、mise.toml に固定した Node.js（mise exec）で実行する
#
#   sh scripts/cms-node.sh scripts/setup-editor.mjs [引数...]
#
# - mise は既存のもの（PATH 上）か、/setup-editor で CMS 専用に導入したもの（~/.est-rouge-cms/bin/mise）を使う
# - 固定した Node.js が mise に導入されていない場合は実行しない
#   （mise は未導入だと PATH 上の別の Node.js で動いてしまうため、先に確認する）
# - mise の自動インストールは無効にする（導入は /setup-editor で承認を得てから行う）
# - 既存の Node.js・PATH・シェルの設定は変更しない
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/.." && pwd)

MISE_AUTO_INSTALL=false
MISE_EXEC_AUTO_INSTALL=false
MISE_NOT_FOUND_AUTO_INSTALL=false
MISE_DISABLE_UPDATE_WARNING=1
export MISE_AUTO_INSTALL MISE_EXEC_AUTO_INSTALL MISE_NOT_FOUND_AUTO_INSTALL MISE_DISABLE_UPDATE_WARNING

guide="Claude Code に「記事入稿環境をセットアップして」と伝えると、確認のうえ準備します（/setup-editor）"

if ! MISE=$(sh "$DIR/setup/bootstrap.sh" mise-path); then
  echo "❌ mise が見つかりません。$guide" >&2
  exit 3
fi
NODE_VERSION=$(sed -n 's/^node *= *"\(.*\)"/\1/p' "$ROOT/mise.toml" | head -1)
if ! "$MISE" where --cd "$ROOT" "node@$NODE_VERSION" >/dev/null 2>&1; then
  echo "❌ Node.js $NODE_VERSION が mise に導入されていません。$guide" >&2
  exit 3
fi

exec "$MISE" exec --cd "$ROOT" -- node "$@"
