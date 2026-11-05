#!/bin/sh
# 記事入稿環境の準備（Node.js がなくても動くよう POSIX sh で書いている）
#
#   sh scripts/setup/bootstrap.sh check                    環境を確認する（何も変更しない）
#   sh scripts/setup/bootstrap.sh install-mise --approved  mise を CMS 専用の場所（~/.est-rouge-cms/bin）に導入する
#   sh scripts/setup/bootstrap.sh install-node --approved  mise で、mise.toml に固定した Node.js を導入する
#   sh scripts/setup/bootstrap.sh mise-path                使用する mise のパスを表示する（scripts/cms-node.sh が使用）
#
# Node.js のバージョンは mise.toml を正とし、`mise exec` で CMS 専用の実行環境として使う。
# 依存関係（npm ci）とプレビューは scripts/setup-editor.mjs が扱う。
#
# 安全のための約束:
# - 既存の Node.js・npm・mise・PATH・シェルの設定ファイルは変更しない（mise activate も設定しない）
# - mise は GitHub の公式リリースから HTTPS で取得し、このファイルに固定した SHA-256 と照合する
#   （Node.js は mise が nodejs.org から取得し、チェックサムを検証する）
# - mise の自動インストールは無効にし、承認した手順以外でダウンロードが起きないようにする
# - 管理者権限は使わない（すべてユーザーのホームディレクトリ内に導入する）
#
# 終了コード:
#   0 成功 / 2 引数の誤り / 3 mise が見つからない / 4 未対応の OS・CPU / 5 ダウンロード・検証の失敗
#   6 承認がない / 9 空き容量の不足

set -u

# mise のバージョンと、公式リリースの SHASUMS256.txt に記載されたチェックサム（2026-10-20 公開の v2026.10.17）
MISE_VERSION=2026.10.17
MISE_SHA256_MACOS_ARM64=d7c50c1683524a764260986ccc9c41c0de5e1fcd491714b5640b657b76781af6
MISE_SHA256_MACOS_X64=e42418100e2f781f9be00b9feaa60378e77551741faececc2bf360992c5410c8
MISE_SHA256_LINUX_ARM64=cac510e51793ad45e65fe92305bdbe4309c9c60b5907badbc7eba111738ab08f
MISE_SHA256_LINUX_X64=17565e268c5542d8ce944321e17af81e0b741b65af4aa7e8e010ee77376a4aa3
PORT=4321
MIN_DISK_MB=1024

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# テストでは一時ディレクトリに差し替える（通常は既定値のまま）
CMS_HOME=${CMS_SETUP_HOME:-$HOME/.est-rouge-cms}
MISE_DIST=https://github.com/jdx/mise/releases/download

# mise の動作設定: 承認した手順以外でツールを自動ダウンロードしない・更新案内を出さない
MISE_AUTO_INSTALL=false
MISE_EXEC_AUTO_INSTALL=false
MISE_NOT_FOUND_AUTO_INSTALL=false
MISE_DISABLE_UPDATE_WARNING=1
export MISE_AUTO_INSTALL MISE_EXEC_AUTO_INSTALL MISE_NOT_FOUND_AUTO_INSTALL MISE_DISABLE_UPDATE_WARNING

say() { printf '%s\n' "$*"; }
ok() { say "✅ $*"; }
warn() { say "⚠️  $*"; }
ng() { say "❌ $*"; }
has() { command -v "$1" >/dev/null 2>&1; }

curl_get() { # curl_get <URL> <出力先>
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 2 --connect-timeout 20 -o "$2" "$1"
}

sha256_of() {
  if has shasum; then shasum -a 256 "$1" | cut -d' ' -f1
  elif has sha256sum; then sha256sum "$1" | cut -d' ' -f1
  else return 1
  fi
}

os_name() { uname -s 2>/dev/null; }
cpu_arch() { case $(uname -m 2>/dev/null) in arm64|aarch64) echo arm64 ;; x86_64|amd64) echo x64 ;; *) uname -m ;; esac; }
mise_platform() { case $(os_name) in Darwin) echo macos ;; Linux) echo linux ;; *) echo unsupported ;; esac; }
is_mdm() { profiles status -type enrollment 2>/dev/null | grep -Eq 'MDM enrollment: Yes|Enrolled via DEP: Yes'; }

# 空き容量（KB）。取得できなければ 0
free_kb() { kb=$(df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'); case $kb in ''|*[!0-9]*) echo 0 ;; *) echo "$kb" ;; esac; }

# mise.toml に固定した Node.js のバージョン
required_node() { sed -n 's/^node *= *"\(.*\)"/\1/p' "$ROOT/mise.toml" 2>/dev/null | head -1; }

# 使用する mise: ①既存の mise（PATH 上）②CMS 専用に導入した mise
find_mise() {
  if has mise; then command -v mise; return 0; fi
  if [ -x "$CMS_HOME/bin/mise" ]; then echo "$CMS_HOME/bin/mise"; return 0; fi
  return 1
}

mise_version() { "$1" --version 2>/dev/null | awk '{ print $1 }'; }

# ポート 4321 を使っているプロセス名（空なら未使用）
port_owner() {
  has lsof || { echo unknown; return; }
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1
}

# ---------------------------------------------------------------------------
# check: 環境を確認する（何も変更しない）
# ---------------------------------------------------------------------------

cmd_check() {
  os=$(os_name); arch=$(cpu_arch)
  say "── 環境の確認（変更はしません） ────────────"
  case $os in
    Darwin) osver=$(sw_vers -productVersion 2>/dev/null || echo unknown); ok "macOS $osver（$arch）" ;;
    Linux) osver=linux; ok "Linux（$arch）" ;;
    *) osver=unknown; warn "この OS（$os）では自動導入に対応していません。手順の案内のみ行います" ;;
  esac
  if [ "$os" = Darwin ] && is_mdm; then mdm=yes; warn "組織の端末管理（MDM）に登録されています（ソフトウェアの導入は組織のルールに従ってください）"; else mdm=no; fi
  disk_gb=$(( $(free_kb "$HOME") / 1024 / 1024 ))

  required=$(required_node)
  [ -n "$required" ] || ng "mise.toml に Node.js のバージョンがありません"

  if mise=$(find_mise); then
    mise_ver=$(mise_version "$mise")
    case $mise in
      "$CMS_HOME"/*) mise_source=cms; ok "mise $mise_ver（CMS 専用: $mise）" ;;
      *) mise_source=existing; ok "mise $mise_ver（既存のものを使用: $mise）" ;;
    esac
  else
    mise=; mise_ver=; mise_source=missing
    warn "mise がありません（CMS 専用の場所に導入できます。PATH やシェルの設定は変更しません）"
  fi

  # Node.js（mise が管理する CMS 用のもの。既存の Node.js とは別）
  node=missing
  if [ -n "$mise" ] && [ -n "$required" ]; then
    if (cd "$ROOT" && "$mise" where "node@$required" >/dev/null 2>&1); then
      node=ok; ok "Node.js $required（mise で管理）"
    else
      warn "Node.js $required がまだ mise に導入されていません"
    fi
  fi
  if has node; then node_system=$(node -v 2>/dev/null || echo unknown); else node_system=missing; fi

  # 依存関係（npm ci 済みか。ロックファイルとの一致は setup-editor.mjs が確認する）
  if [ -f "$ROOT/node_modules/.cms-install-stamp" ]; then deps=installed; else deps=missing; fi

  owner=$(port_owner)
  case $owner in
    '') port=free; ok "ポート $PORT は空いています" ;;
    unknown) port=unknown ;;
    node) port=node; say "ℹ️  ポート $PORT を Node.js が使用しています（CMS のプレビューかどうかは setup-editor.mjs が確認します）" ;;
    com.docke*|vpnkit*|docker*) port=docker; warn "ポート $PORT を Docker が使用しています（以前の Docker 版のプレビューの可能性があります）" ;;
    *) port="other:$owner"; warn "ポート $PORT を別のプログラム（$owner）が使用しています。CMS 側では停止しません" ;;
  esac

  say ""
  say "STATUS os=$os"
  say "STATUS arch=$arch"
  say "STATUS os_version=$osver"
  say "STATUS mdm=$mdm"
  say "STATUS disk_free_gb=$disk_gb"
  say "STATUS mise=$mise_source"
  say "STATUS mise_path=$mise"
  say "STATUS mise_version=$mise_ver"
  say "STATUS node_required=$required"
  say "STATUS node=$node"
  say "STATUS node_system=$node_system"
  say "STATUS dependencies=$deps"
  say "STATUS port_$PORT=$port"
  return 0
}

# ---------------------------------------------------------------------------
# install-mise: CMS 専用の mise を導入する
# ---------------------------------------------------------------------------

cmd_install_mise() {
  [ "${APPROVED:-no}" = yes ] || { ng "mise の導入には承認が必要です（--approved）"; return 6; }
  if mise=$(find_mise); then ok "mise は導入済みです（導入し直しません）: $mise"; say "MISE_PATH=$mise"; return 0; fi
  platform=$(mise_platform); arch=$(cpu_arch)
  case "$platform-$arch" in
    macos-arm64) expected=$MISE_SHA256_MACOS_ARM64 ;;
    macos-x64) expected=$MISE_SHA256_MACOS_X64 ;;
    linux-arm64) expected=$MISE_SHA256_LINUX_ARM64 ;;
    linux-x64) expected=$MISE_SHA256_LINUX_X64 ;;
    *) ng "この OS・CPU（$(os_name) $(uname -m)）には自動導入できません。https://mise.jdx.dev/getting-started.html を参照してください"; return 4 ;;
  esac
  [ "$(free_kb "$HOME")" -ge $((MIN_DISK_MB * 1024)) ] || { ng "空き容量が不足しています（${MIN_DISK_MB}MB 以上必要）"; return 9; }

  file="mise-v$MISE_VERSION-$platform-$arch.tar.gz"
  work=$(mktemp -d "${TMPDIR:-/tmp}/cms-mise.XXXXXX") || return 5
  trap 'rm -rf "$work"' EXIT INT TERM
  say "mise v$MISE_VERSION を公式リリース（github.com/jdx/mise）から取得しています..."
  curl_get "$MISE_DIST/v$MISE_VERSION/$file" "$work/$file" || { ng "mise をダウンロードできませんでした（ネットワーク接続を確認してください）"; return 5; }
  actual=$(sha256_of "$work/$file" || true)
  [ "$actual" = "$expected" ] || { ng "ダウンロードした mise のチェックサムが一致しません。導入を中止しました"; return 5; }
  ok "チェックサム（SHA-256）を確認しました"
  if ! tar -xzf "$work/$file" -C "$work" || [ ! -x "$work/mise/bin/mise" ]; then ng "展開に失敗しました"; return 5; fi
  got=$(mise_version "$work/mise/bin/mise")
  [ "$got" = "$MISE_VERSION" ] || { ng "展開した mise が正しく動きません（$got）"; return 5; }
  mkdir -p "$CMS_HOME/bin" && mv "$work/mise/bin/mise" "$CMS_HOME/bin/mise" || { ng "$CMS_HOME/bin に配置できませんでした"; return 5; }
  ok "mise v$MISE_VERSION を $CMS_HOME/bin/ に導入しました（PATH・シェルの設定は変更していません）"
  say "MISE_PATH=$CMS_HOME/bin/mise"
  return 0
}

# ---------------------------------------------------------------------------
# install-node: mise.toml の Node.js を mise で導入する
# ---------------------------------------------------------------------------

cmd_install_node() {
  [ "${APPROVED:-no}" = yes ] || { ng "Node.js の導入には承認が必要です（--approved）"; return 6; }
  mise=$(find_mise) || { ng "mise がありません。先に install-mise を実行してください"; return 3; }
  required=$(required_node)
  [ -n "$required" ] || { ng "mise.toml に Node.js のバージョンがありません"; return 2; }
  if (cd "$ROOT" && "$mise" where "node@$required" >/dev/null 2>&1); then ok "Node.js $required は導入済みです（導入し直しません）"; return 0; fi
  say "Node.js $required を mise で導入しています（nodejs.org から取得し、mise がチェックサムを検証します）..."
  (cd "$ROOT" && "$mise" install "node@$required") || { ng "Node.js $required を導入できませんでした"; return 5; }
  (cd "$ROOT" && "$mise" where "node@$required" >/dev/null 2>&1) || { ng "導入後の確認に失敗しました"; return 5; }
  got=$(cd "$ROOT" && "$mise" exec -- node -v 2>/dev/null)
  [ "$got" = "v$required" ] || { ng "mise exec の Node.js が想定と異なります（$got）"; return 5; }
  ok "Node.js $required を導入しました（既存の Node.js は変更していません）"
  return 0
}

# ---------------------------------------------------------------------------

[ $# -ge 1 ] || { say "使い方は scripts/setup/bootstrap.sh の先頭のコメントを参照してください"; exit 2; }
command=$1; shift
APPROVED=no
for arg in "$@"; do [ "$arg" = --approved ] && APPROVED=yes; done

case $command in
  check) cmd_check ;;
  install-mise) cmd_install_mise ;;
  install-node) cmd_install_node ;;
  mise-path) find_mise || exit 3 ;;
  *) say "不明なコマンドです: $command"; exit 2 ;;
esac
