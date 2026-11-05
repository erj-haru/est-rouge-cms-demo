#!/bin/sh
# 記事入稿環境の準備（Node.js がなくても動くよう POSIX sh で書いている）
#
#   sh scripts/setup/bootstrap.sh check                         環境を確認する（何も変更しない）
#   sh scripts/setup/bootstrap.sh install-node --approved       このプロジェクト専用の Node.js を導入する
#   sh scripts/setup/bootstrap.sh install-docker --approved [--license-confirmed]
#                                                               Docker Desktop を導入する（macOS のみ）
#   sh scripts/setup/bootstrap.sh start-docker                  Docker Desktop を起動し、Engine の準備完了を待つ
#   sh scripts/setup/bootstrap.sh node-path                     使用する Node.js のパスを表示する（scripts/cms-node.sh が使用）
#   sh scripts/setup/bootstrap.sh docker-bin-dir                Docker CLI のあるディレクトリを表示する
#   sh scripts/setup/bootstrap.sh verify-docker-app <Docker.app>
#                                                               Docker.app の署名・公証を検証する（何も変更しない）
#
# 安全のための約束:
# - 既存の Node.js・npm・アプリ・PATH・シェルの設定ファイルは変更しない（Node.js は ~/.est-rouge-cms/ に置く）
# - ダウンロードは公式配布元（nodejs.org・desktop.docker.com）から HTTPS で行い、チェックサム・署名を検証する
# - 管理者権限は回避しない。管理者でない端末・MDM 管理端末では Docker Desktop を導入しない
# - Docker Desktop の利用規約への同意は、初回起動時に本人が行う（--accept-license は使わない）
# - Docker のコンテナ・イメージ・ボリュームには一切触れない
#
# 終了コード:
#   0 成功 / 2 引数の誤り / 3 Node.js が見つからない / 4 未対応の OS / 5 ダウンロード・検証の失敗
#   6 承認・ライセンス確認がない / 7 管理者権限がない / 8 MDM 管理端末 / 9 メモリ・空き容量の不足
#   10 Docker Desktop が未導入 / 11 起動の待ち時間切れ / 12 起動後に異常終了 / 13 インストールの中断

set -u

NODE_VERSION=22.23.4
HOST_NODE_MIN_MAJOR=20
DOCKER_TEAM_ID=9BNSXJN65R
DOCKER_BUNDLE_ID=com.docker.docker
PORT=4321
MIN_MEMORY_GB=4
MIN_DISK_GB_DOCKER=6
MIN_DISK_MB_NODE=300

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
# テストでは以下を一時ディレクトリに差し替える（通常は既定値のまま）
CMS_HOME=${CMS_SETUP_HOME:-$HOME/.est-rouge-cms}
APPS_DIR=${CMS_SETUP_APPS_DIR:-/Applications}
USER_APPS_DIR=${CMS_SETUP_USER_APPS_DIR:-$HOME/Applications}
SYSTEM_BIN=${CMS_SETUP_SYSTEM_BIN:-/usr/local/bin}
DOCKER_TIMEOUT=${CMS_SETUP_DOCKER_TIMEOUT:-240}
POLL_SECONDS=${CMS_SETUP_POLL:-3}
POLICY_FILE="$ROOT/config/editor-setup.env"
NODE_DIST=https://nodejs.org/dist
DOCKER_DIST=https://desktop.docker.com/mac/main

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

# バージョン比較: version_ge 14.2 14.0 → 真
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, x, "."); nb = split(b, y, "."); n = na > nb ? na : nb
    for (i = 1; i <= n; i++) { xi = x[i] + 0; yi = y[i] + 0; if (xi > yi) exit 0; if (xi < yi) exit 1 }
    exit 0 }'
}

# ---------------------------------------------------------------------------
# 環境の情報
# ---------------------------------------------------------------------------

os_name() { uname -s 2>/dev/null; }
cpu_arch() { case $(uname -m 2>/dev/null) in arm64|aarch64) echo arm64 ;; x86_64|amd64) echo x64 ;; *) uname -m ;; esac; }
node_platform() { case $(os_name) in Darwin) echo darwin ;; Linux) echo linux ;; *) echo unsupported ;; esac; }
is_admin() { id -Gn 2>/dev/null | tr ' ' '\n' | grep -qx admin; }
is_mdm() { profiles status -type enrollment 2>/dev/null | grep -Eq 'MDM enrollment: Yes|Enrolled via DEP: Yes'; }

memory_gb() {
  if [ "$(os_name)" = Darwin ]; then
    bytes=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
  else
    bytes=$(awk '/^MemTotal:/ { print $2 * 1024 }' /proc/meminfo 2>/dev/null || echo 0)
  fi
  awk -v b="${bytes:-0}" 'BEGIN { printf "%d", b / 1024 / 1024 / 1024 }'
}

# 空き容量（KB）。取得できなければ 0
free_kb() { kb=$(df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }'); case $kb in ''|*[!0-9]*) echo 0 ;; *) echo "$kb" ;; esac; }

# "v22.12.0" → 22（解釈できなければ 0）
node_major() { m=$(printf '%s' "$1" | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p'); echo "${m:-0}"; }

managed_node_dir() { echo "$CMS_HOME/node/node-v$NODE_VERSION-$(node_platform)-$(cpu_arch)"; }

# 使用する Node.js: ①十分に新しい既存の node ②このプロジェクト専用に導入した node
select_node() {
  if has node; then
    major=$(node_major "$(node -v 2>/dev/null)")
    if [ "$major" -ge "$HOST_NODE_MIN_MAJOR" ]; then command -v node; return 0; fi
  fi
  managed="$(managed_node_dir)/bin/node"
  if [ -x "$managed" ]; then echo "$managed"; return 0; fi
  return 1
}

find_docker() {
  if has docker; then command -v docker; return 0; fi
  for candidate in "$SYSTEM_BIN/docker" "$HOME/.docker/bin/docker" "$APPS_DIR/Docker.app/Contents/Resources/bin/docker" "$USER_APPS_DIR/Docker.app/Contents/Resources/bin/docker"; do
    if [ -x "$candidate" ]; then echo "$candidate"; return 0; fi
  done
  return 1
}

find_docker_app() {
  for app in "$APPS_DIR/Docker.app" "$USER_APPS_DIR/Docker.app"; do
    if [ -d "$app" ]; then echo "$app"; return 0; fi
  done
  return 1
}

docker_app_running() { pgrep -f 'Docker.app/Contents/MacOS/' >/dev/null 2>&1; }
engine_ready() { [ -n "${DOCKER:-}" ] && "$DOCKER" info --format '{{.ServerVersion}}' >/dev/null 2>&1; }
license_policy_confirmed() { [ -f "$POLICY_FILE" ] && grep -Eq '^DOCKER_DESKTOP_LICENSE_CONFIRMED=yes[[:space:]]*$' "$POLICY_FILE"; }

# ポート 4321 を使っているプロセス（空なら未使用）
port_owner() {
  has lsof || { echo unknown; return; }
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -Fc 2>/dev/null | sed -n 's/^c//p' | head -1
}

# ---------------------------------------------------------------------------
# check: 環境を確認する
# ---------------------------------------------------------------------------

cmd_check() {
  os=$(os_name); arch=$(cpu_arch)
  say "── 環境の確認（変更はしません） ────────────"

  case $os in
    Darwin) osver=$(sw_vers -productVersion 2>/dev/null || echo unknown); ok "macOS $osver（$arch）" ;;
    Linux) osver=linux; ok "Linux（$arch）" ;;
    *) osver=unknown; warn "この OS（$os）では自動導入に対応していません。手順の案内のみ行います" ;;
  esac
  if [ "$os" = Darwin ]; then
    if is_admin; then admin=yes; ok "管理者権限のあるアカウントです"; else admin=no; warn "管理者権限のないアカウントです（Docker Desktop の導入は IT 担当に依頼が必要です）"; fi
    if is_mdm; then mdm=yes; warn "組織の端末管理（MDM）に登録されています（ソフトウェアの導入は組織のルールに従ってください）"; else mdm=no; fi
  else
    admin=unknown; mdm=unknown
  fi
  mem=$(memory_gb)
  disk_gb=$(( $(free_kb "$HOME") / 1024 / 1024 ))

  # Node.js（ホスト側。Docker 内の Node.js とは別）
  node_system=missing
  if has node; then
    node_system=$(node -v 2>/dev/null || echo unknown)
    if [ "$(node_major "$node_system")" -ge "$HOST_NODE_MIN_MAJOR" ]; then ok "Node.js $node_system（既存のものを使用します）"
    else warn "Node.js $node_system は古いため使用しません（既存の Node.js は変更しません）"; fi
  fi
  if node_path=$(select_node); then
    case $node_path in "$CMS_HOME"/*) ok "Node.js v$NODE_VERSION（このプロジェクト専用）" ;; esac
    node_status=ok
  else
    node_path=; node_status=missing
    [ "$node_system" = missing ] && warn "Node.js がありません（このプロジェクト専用の Node.js を導入できます）"
  fi

  # Docker
  DOCKER=$(find_docker || true)
  app=$(find_docker_app || true)
  if [ -n "$DOCKER" ]; then ok "Docker CLI: $DOCKER"; docker_cli=yes; else docker_cli=no; fi
  if [ "$os" = Darwin ]; then
    if [ -n "$app" ]; then
      appver=$(defaults read "$app/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)
      ok "Docker Desktop $appver: $app"; docker_app=yes
    else
      warn "Docker Desktop がインストールされていません"; docker_app=no
    fi
  else
    docker_app=n/a
  fi
  engine=stopped
  if engine_ready; then engine=running; ok "Docker Engine が起動しています"
  elif [ "$os" = Darwin ] && docker_app_running; then engine=starting; warn "Docker Desktop は起動中ですが、Engine の準備ができていません"
  elif [ -n "$DOCKER" ] || [ -n "$app" ]; then warn "Docker Engine が起動していません"
  fi
  compose=unavailable
  if [ "$engine" = running ] || [ -n "$DOCKER" ]; then
    if [ -n "$DOCKER" ] && "$DOCKER" compose version --short >/dev/null 2>&1; then compose=ok; ok "Docker Compose $("$DOCKER" compose version --short 2>/dev/null)"
    elif [ -n "$DOCKER" ]; then ng "Docker Compose が使えません"
    fi
  fi

  # プレビュー用コンテナとポート
  container=unknown
  if [ "$engine" = running ] && [ "$compose" = ok ]; then
    container=$(cd "$ROOT" && "$DOCKER" compose ps --all --format '{{.State}}' astro 2>/dev/null | head -1)
    container=${container:-none}
    case $container in
      running) ok "CMS のプレビュー用コンテナが起動しています" ;;
      none) say "ℹ️  CMS のプレビュー用コンテナはまだありません（初回起動時に作成します）" ;;
      *) say "ℹ️  CMS のプレビュー用コンテナは停止中です（$container）" ;;
    esac
  fi
  owner=$(port_owner)
  if [ -z "$owner" ]; then port=free; ok "ポート $PORT は空いています"
  elif [ "$container" = running ]; then port=cms; ok "ポート $PORT は CMS のプレビューが使用しています"
  elif [ "$owner" = unknown ]; then port=unknown
  else port="other:$owner"; warn "ポート $PORT を別のプログラム（$owner）が使用しています。CMS 側では停止しません"
  fi

  if license_policy_confirmed; then license=confirmed; else license=unconfirmed; fi

  say ""
  say "STATUS os=$os"
  say "STATUS arch=$arch"
  say "STATUS os_version=$osver"
  say "STATUS admin=$admin"
  say "STATUS mdm=$mdm"
  say "STATUS memory_gb=$mem"
  say "STATUS disk_free_gb=$disk_gb"
  say "STATUS node=$node_status"
  say "STATUS node_system=$node_system"
  say "STATUS node_path=$node_path"
  say "STATUS docker_cli=$docker_cli"
  say "STATUS docker_app=$docker_app"
  say "STATUS docker_engine=$engine"
  say "STATUS docker_compose=$compose"
  say "STATUS preview_container=$container"
  say "STATUS port_$PORT=$port"
  say "STATUS docker_license_policy=$license"
  return 0
}

# ---------------------------------------------------------------------------
# install-node: このプロジェクト専用の Node.js を導入する
# ---------------------------------------------------------------------------

cmd_install_node() {
  [ "${APPROVED:-no}" = yes ] || { ng "Node.js の導入には承認が必要です（--approved）"; return 6; }
  if node_path=$(select_node); then
    ok "使用できる Node.js があるため、導入は不要です: $node_path"
    say "NODE_PATH=$node_path"
    return 0
  fi
  platform=$(node_platform); arch=$(cpu_arch)
  if [ "$platform" = unsupported ] || { [ "$arch" != arm64 ] && [ "$arch" != x64 ]; }; then
    ng "この OS・CPU（$(os_name) $(uname -m)）には自動導入できません。https://nodejs.org/ja/download から Node.js 22 LTS を導入してください"
    return 4
  fi
  free=$(free_kb "$HOME")
  if [ "$free" -lt $((MIN_DISK_MB_NODE * 1024)) ]; then ng "空き容量が不足しています（${MIN_DISK_MB_NODE}MB 以上必要）"; return 9; fi

  name="node-v$NODE_VERSION-$platform-$arch"
  file="$name.tar.gz"
  work=$(mktemp -d "${TMPDIR:-/tmp}/cms-node.XXXXXX") || return 5
  trap 'rm -rf "$work"' EXIT INT TERM
  say "Node.js v$NODE_VERSION を公式配布元（$NODE_DIST）から取得しています..."
  if ! curl_get "$NODE_DIST/v$NODE_VERSION/SHASUMS256.txt" "$work/SHASUMS256.txt" || ! curl_get "$NODE_DIST/v$NODE_VERSION/$file" "$work/$file"; then
    ng "Node.js をダウンロードできませんでした（ネットワーク接続を確認してください）"; return 5
  fi
  expected=$(awk -v f="$file" '$2 == f { print $1 }' "$work/SHASUMS256.txt")
  actual=$(sha256_of "$work/$file" || true)
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    ng "ダウンロードした Node.js のチェックサムが一致しません。導入を中止しました"; return 5
  fi
  ok "チェックサム（SHA-256）を確認しました"
  if ! tar -xzf "$work/$file" -C "$work" || [ ! -x "$work/$name/bin/node" ]; then ng "展開に失敗しました"; return 5; fi
  got=$("$work/$name/bin/node" -v 2>/dev/null || true)
  if [ "$got" != "v$NODE_VERSION" ]; then ng "展開した Node.js が正しく動きません（$got）"; return 5; fi
  mkdir -p "$CMS_HOME/node" && mv "$work/$name" "$CMS_HOME/node/$name" || { ng "$CMS_HOME/node に配置できませんでした"; return 5; }
  ok "Node.js v$NODE_VERSION を $CMS_HOME/node/ に導入しました（既存の Node.js・PATH は変更していません）"
  say "NODE_PATH=$CMS_HOME/node/$name/bin/node"
  return 0
}

# ---------------------------------------------------------------------------
# Docker Desktop の検証・導入・起動（macOS）
# ---------------------------------------------------------------------------

# 署名（Docker Inc のチーム ID）・Apple の公証・バンドル ID・対応 macOS を確認する
cmd_verify_docker_app() {
  app=$1
  [ -d "$app" ] || { ng "$app がありません"; return 5; }
  codesign --verify --deep --strict "$app" >/dev/null 2>&1 || { ng "コード署名を検証できませんでした: $app"; return 5; }
  team=$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
  [ "$team" = "$DOCKER_TEAM_ID" ] || { ng "署名者が Docker Inc（$DOCKER_TEAM_ID）ではありません（$team）"; return 5; }
  spctl --assess --type execute "$app" >/dev/null 2>&1 || { ng "Apple の公証（Gatekeeper）を確認できませんでした"; return 5; }
  bundle=$(defaults read "$app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)
  [ "$bundle" = "$DOCKER_BUNDLE_ID" ] || { ng "アプリの識別子が想定と異なります（$bundle）"; return 5; }
  min=$(defaults read "$app/Contents/Info.plist" LSMinimumSystemVersion 2>/dev/null || echo 0)
  cur=$(sw_vers -productVersion 2>/dev/null || echo 0)
  version_ge "$cur" "$min" || { ng "この macOS（$cur）は Docker Desktop の動作条件（$min 以上）を満たしていません"; return 4; }
  ok "Docker Desktop の署名（Docker Inc / $DOCKER_TEAM_ID）・公証・対応 macOS（$min 以上）を確認しました"
  return 0
}

cmd_install_docker() {
  [ "$(os_name)" = Darwin ] || { ng "Docker Desktop の自動導入は macOS のみ対応しています。https://docs.docker.com/get-docker/ の手順で導入してください"; return 4; }
  [ "${APPROVED:-no}" = yes ] || { ng "Docker Desktop の導入には承認が必要です（--approved）"; return 6; }
  if [ "${LICENSE_CONFIRMED:-no}" != yes ] && ! license_policy_confirmed; then
    ng "Docker Desktop の利用条件（組織での利用可否）が確認できていないため、導入を保留しました"
    say "   組織の規模によっては有料のサブスクリプションが必要です: https://www.docker.com/pricing/faq/"
    return 6
  fi
  if app=$(find_docker_app); then ok "Docker Desktop は導入済みです（上書きしません）: $app"; return 0; fi
  is_admin || { ng "管理者権限のないアカウントのため、Docker Desktop を導入できません。IT 担当に導入を依頼してください"; return 7; }
  if is_mdm; then ng "組織の端末管理（MDM）に登録された Mac のため、自動導入は行いません。IT 担当に導入を依頼してください"; return 8; fi
  mem=$(memory_gb)
  [ "${mem:-0}" -ge "$MIN_MEMORY_GB" ] || { ng "メモリが不足しています（${MIN_MEMORY_GB}GB 以上必要、現在 ${mem}GB）"; return 9; }
  free=$(free_kb "$HOME")
  [ "$free" -ge $((MIN_DISK_GB_DOCKER * 1024 * 1024)) ] || { ng "空き容量が不足しています（${MIN_DISK_GB_DOCKER}GB 以上必要）"; return 9; }
  [ -d "$APPS_DIR" ] || { ng "$APPS_DIR がありません"; return 13; }

  case $(cpu_arch) in arm64) darch=arm64 ;; x64) darch=amd64 ;; *) ng "この CPU には対応していません"; return 4 ;; esac
  work=$(mktemp -d "${TMPDIR:-/tmp}/cms-docker.XXXXXX") || return 13
  mnt="$work/mnt"
  cleanup_docker() { hdiutil detach "$mnt" -quiet >/dev/null 2>&1 || true; rm -rf "$work"; }
  trap cleanup_docker EXIT INT TERM

  say "Docker Desktop（$darch 版）を公式配布元（$DOCKER_DIST）から取得しています（約 600MB）..."
  curl_get "$DOCKER_DIST/$darch/Docker.dmg" "$work/Docker.dmg" || { ng "Docker Desktop をダウンロードできませんでした（ネットワーク接続を確認してください）"; return 5; }
  mkdir -p "$mnt"
  hdiutil attach "$work/Docker.dmg" -nobrowse -readonly -noautoopen -mountpoint "$mnt" >/dev/null 2>&1 || { ng "ダウンロードしたディスクイメージを開けませんでした"; return 5; }
  cmd_verify_docker_app "$mnt/Docker.app"; rc=$?
  [ "$rc" -eq 0 ] || { ng "検証に失敗したため、インストールを中止しました"; return "$rc"; }

  dest="$APPS_DIR/Docker.app"
  [ -e "$dest" ] && { ng "$dest が既に存在するため上書きしません"; return 13; }
  if [ -w "$APPS_DIR" ]; then
    ditto "$mnt/Docker.app" "$dest" || { rm -rf "$dest"; ng "$APPS_DIR へのコピーに失敗しました"; return 13; }
  else
    # macOS 標準の認証ダイアログで本人に許可してもらう（権限の回避はしない）
    say "macOS の認証ダイアログが表示されます。内容を確認して、許可する場合はパスワードを入力してください"
    osascript - "$mnt/Docker.app" "$dest" <<'APPLESCRIPT' >/dev/null 2>&1 || { ng "認証がキャンセルされたか、コピーに失敗しました"; return 13; }
on run argv
  do shell script "/usr/bin/ditto " & quoted form of (item 1 of argv) & " " & quoted form of (item 2 of argv) with administrator privileges
end run
APPLESCRIPT
  fi
  cmd_verify_docker_app "$dest" >/dev/null || { ng "インストール後の検証に失敗しました: $dest（自動では削除しません。IT 担当に確認してください）"; return 13; }
  ok "Docker Desktop を $dest に導入しました"
  say "   初回の起動時に、利用規約への同意と、必要に応じて macOS の権限の許可を本人が行います"
  return 0
}

cmd_start_docker() {
  DOCKER=$(find_docker || true)
  if engine_ready; then ok "Docker Engine は既に起動しています（再起動はしません）"; return 0; fi
  [ "$(os_name)" = Darwin ] || { ng "Docker Engine が起動していません。お使いの OS の手順で起動してください（Linux: sudo systemctl start docker）"; return 4; }
  app=$(find_docker_app) || { ng "Docker Desktop がインストールされていません"; return 10; }
  if docker_app_running; then
    say "Docker Desktop は起動処理中です。Engine の準備ができるまで待ちます..."
  else
    say "Docker Desktop を起動します..."
    open -a "$app" || { ng "Docker Desktop を起動できませんでした"; return 12; }
  fi
  waited=0
  while [ "$waited" -lt "$DOCKER_TIMEOUT" ]; do
    [ -z "${DOCKER:-}" ] && DOCKER=$(find_docker || true)
    if engine_ready; then ok "Docker Engine の準備ができました（約 ${waited} 秒）"; return 0; fi
    sleep "$POLL_SECONDS"
    waited=$((waited + POLL_SECONDS))
    # 起動直後に終了した場合は待たない（2 回目以降の確認で判定）
    if [ "$waited" -ge $((POLL_SECONDS * 3)) ] && ! docker_app_running; then
      ng "Docker Desktop が起動後に終了しました。Docker Desktop を開いてエラー表示を確認してください"
      return 12
    fi
  done
  ng "${DOCKER_TIMEOUT} 秒待っても Docker Engine の準備ができませんでした"
  say "   Docker Desktop の画面で、利用規約への同意や macOS の権限の許可を求められていないか確認してください"
  say "   （初回起動時は本人の操作が必要です。操作のあと、もう一度実行すれば続きから確認します）"
  return 11
}

# ---------------------------------------------------------------------------

[ $# -ge 1 ] || { say "使い方は scripts/setup/bootstrap.sh の先頭のコメントを参照してください"; exit 2; }
command=$1; shift
APPROVED=no; LICENSE_CONFIRMED=no
for arg in "$@"; do
  case $arg in
    --approved) APPROVED=yes ;;
    --license-confirmed) LICENSE_CONFIRMED=yes ;;
  esac
done

case $command in
  check) cmd_check ;;
  install-node) cmd_install_node ;;
  install-docker) cmd_install_docker ;;
  start-docker) cmd_start_docker ;;
  verify-docker-app) [ $# -ge 1 ] || exit 2; cmd_verify_docker_app "$1" ;;
  node-path) select_node || exit 3 ;;
  docker-bin-dir) d=$(find_docker) || exit 1; dirname "$d" ;;
  *) say "不明なコマンドです: $command"; exit 2 ;;
esac
