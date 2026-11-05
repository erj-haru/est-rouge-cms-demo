// scripts/setup/bootstrap.sh と scripts/cms-node.sh の検証。
// 外部コマンド（uname・docker・curl・hdiutil・codesign など）はすべて一時ディレクトリのモックに差し替え、
// 実際の Node.js・Docker・アプリ・認証情報には触れない。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BOOTSTRAP = join(ROOT, 'scripts/setup/bootstrap.sh');
const CMS_NODE = join(ROOT, 'scripts/cms-node.sh');
const SH = execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim();
const NODE_VERSION = '22.23.4';
const SYSTEM_TOOLS = ['sh', 'cat', 'grep', 'sed', 'awk', 'tr', 'cut', 'head', 'tail', 'mkdir', 'mktemp', 'mv', 'rm', 'cp', 'ls', 'dirname', 'basename', 'tar', 'gzip', 'chmod', 'touch', 'wc', 'sort', 'env', 'date', 'find', 'shasum', 'sha256sum', 'perl'];

const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function writeExec(path, body) {
  writeFileSync(path, `#!${SH}\n${body}\n`);
  chmodSync(path, 0o755);
}

/** モックと一時ディレクトリを用意して、bootstrap.sh を実行する関数を返す */
function sandbox({ os = 'Darwin', arch = 'arm64', nodeVersion, dockerOnPath = false, dockerApp = false, env: extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cms-bootstrap-test-'));
  roots.push(dir);
  const p = (...parts) => join(dir, ...parts);
  for (const d of ['mockbin', 'sysbin', 'home', 'apps', 'userapps', 'state', 'fixtures', 'tmp', 'empty']) mkdirSync(p(d), { recursive: true });

  // 必要な標準コマンドだけを使えるようにする（実際の node・docker は PATH に入れない）
  for (const tool of SYSTEM_TOOLS) {
    const res = spawnSync(SH, ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    const real = res.stdout.trim();
    if (res.status === 0 && real.startsWith('/')) writeExec(p('sysbin', tool), `exec "${real}" "$@"`);
  }

  const mock = (name, body) => writeExec(p('mockbin', name), body);
  mock('uname', `case "$1" in -m) echo "${arch}" ;; *) echo "${os}" ;; esac`);
  mock('sw_vers', 'echo "${MOCK_MACOS:-15.1}"');
  mock('id', 'echo "staff everyone ${MOCK_ADMIN:+admin}"');
  mock('profiles', 'echo "Enrolled via DEP: No"; echo "MDM enrollment: ${MOCK_MDM:-No}"');
  mock('sysctl', 'echo "${MOCK_MEM:-17179869184}"');
  mock('df', `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/disk1 999 1 %s 1%% /\\n' "\${MOCK_DISK_KB:-104857600}"`);
  mock('lsof', '[ -n "${MOCK_LSOF:-}" ] && printf "p123\\nc%s\\n" "$MOCK_LSOF"; exit 0');
  mock('pgrep', '[ -f "$MOCK_STATE/app_running" ]');
  mock('sleep', 'exit 0');
  mock('open', 'echo "$*" >> "$MOCK_STATE/open.log"; [ "${MOCK_OPEN_CRASH:-}" = 1 ] || touch "$MOCK_STATE/app_running"');
  mock('curl', `
echo "$*" >> "$MOCK_STATE/curl.log"
[ "\${MOCK_CURL_FAIL:-}" = 1 ] && exit 22
out=; url=
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; https://*) url=$1 ;; esac; shift; done
src="$MOCK_FIXTURES/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"`);
  mock('hdiutil', `
[ "$1" = detach ] && { rm -rf "$2"/*; exit 0; }
[ "\${MOCK_HDIUTIL_FAIL:-}" = 1 ] && exit 1
mp=; while [ $# -gt 0 ]; do [ "$1" = -mountpoint ] && mp=$2; shift; done
mkdir -p "$mp" && cp -R "$MOCK_FIXTURES/Docker.app" "$mp/Docker.app"`);
  mock('codesign', 'case " $* " in *" --verify "*) exit "${MOCK_CODESIGN_VERIFY:-0}" ;; esac; echo "TeamIdentifier=${MOCK_TEAM:-9BNSXJN65R}" >&2');
  mock('spctl', 'exit "${MOCK_SPCTL:-0}"');
  mock('defaults', 'case "$3" in CFBundleIdentifier) echo "${MOCK_BUNDLE:-com.docker.docker}" ;; LSMinimumSystemVersion) echo "${MOCK_MIN_OS:-14.0}" ;; *) echo 4.58.1 ;; esac');
  mock('ditto', '[ "${MOCK_DITTO_FAIL:-}" = 1 ] && exit 1; cp -R "$1" "$2"');
  mock('osascript', 'cat >/dev/null; echo "$*" >> "$MOCK_STATE/osascript.log"; [ "${MOCK_OSASCRIPT:-1}" = 0 ] || exit 1; cp -R "$2" "$3"');
  if (nodeVersion) mock('node', `[ "$1" = -v ] && { echo "${nodeVersion}"; exit 0; }; echo "SYSTEM_NODE $*"`);

  // Docker CLI のモック（Engine は $MOCK_STATE/engine_up があるときだけ応答する）
  const dockerMock = `
case "$1" in
  info)
    [ -f "$MOCK_STATE/engine_up" ] && { echo 29.1.5; exit 0; }
    if [ -f "$MOCK_STATE/app_running" ] && [ "\${MOCK_ENGINE_NEVER:-}" != 1 ]; then
      n=$(( $(cat "$MOCK_STATE/info_count" 2>/dev/null || echo 0) + 1 )); echo $n > "$MOCK_STATE/info_count"
      [ $n -ge "\${MOCK_ENGINE_AFTER:-2}" ] && { touch "$MOCK_STATE/engine_up"; echo 29.1.5; exit 0; }
    fi
    exit 1 ;;
  compose)
    case "$2" in
      version) [ "\${MOCK_COMPOSE:-ok}" = ok ] && { echo 2.30.0; exit 0; }; exit 1 ;;
      ps) echo "\${MOCK_CONTAINER:-}"; exit 0 ;;
    esac ;;
esac
exit 1`;
  if (dockerOnPath) mock('docker', dockerMock);

  // Docker.app のフィクスチャ（ディスクイメージの中身・インストール済みのアプリ）
  mkdirSync(p('fixtures', 'Docker.app', 'Contents', 'Resources', 'bin'), { recursive: true });
  writeFileSync(p('fixtures', 'Docker.app', 'Contents', 'Info.plist'), '<plist/>');
  writeExec(p('fixtures', 'Docker.app', 'Contents', 'Resources', 'bin', 'docker'), dockerMock);
  writeFileSync(p('fixtures', 'Docker.dmg'), 'dmg');
  if (dockerApp) execFileSync('cp', ['-R', p('fixtures', 'Docker.app'), p('apps', 'Docker.app')]);

  // Node.js のフィクスチャ（公式と同じ名前の tar.gz と SHASUMS256.txt）
  const platform = os === 'Darwin' ? 'darwin' : 'linux';
  const nodeName = `node-v${NODE_VERSION}-${platform}-${arch === 'x86_64' ? 'x64' : 'arm64'}`;
  mkdirSync(p('fixtures', 'build', nodeName, 'bin'), { recursive: true });
  writeExec(p('fixtures', 'build', nodeName, 'bin', 'node'), `[ "$1" = -v ] && { echo v${NODE_VERSION}; exit 0; }; echo "MANAGED_NODE $*"`);
  execFileSync('tar', ['-czf', p('fixtures', `${nodeName}.tar.gz`), '-C', p('fixtures', 'build'), nodeName]);
  const hash = createHash('sha256').update(readFileSync(p('fixtures', `${nodeName}.tar.gz`))).digest('hex');
  writeFileSync(p('fixtures', 'SHASUMS256.txt'), `${extra.MOCK_BAD_CHECKSUM ? '0'.repeat(64) : hash}  ${nodeName}.tar.gz\n`);

  const env = {
    PATH: `${p('mockbin')}:${p('sysbin')}`,
    HOME: p('home'),
    TMPDIR: p('tmp'),
    CMS_SETUP_HOME: p('home', '.est-rouge-cms'),
    CMS_SETUP_APPS_DIR: p('apps'),
    CMS_SETUP_USER_APPS_DIR: p('userapps'),
    CMS_SETUP_SYSTEM_BIN: p('empty'),
    CMS_SETUP_POLL: '1',
    CMS_SETUP_DOCKER_TIMEOUT: '6',
    MOCK_STATE: p('state'),
    MOCK_FIXTURES: p('fixtures'),
    MOCK_ADMIN: '1',
    ...extra,
  };
  const exec = (file, args, envOverride = {}) => {
    const res = spawnSync(SH, [file, ...args], { cwd: ROOT, encoding: 'utf8', env: { ...env, ...envOverride } });
    const out = `${res.stdout}${res.stderr}`;
    const status = Object.fromEntries([...out.matchAll(/^STATUS (\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
    return { code: res.status, out, status };
  };
  const run = (...args) => exec(BOOTSTRAP, args);
  const state = (name) => (existsSync(p('state', name)) ? readFileSync(p('state', name), 'utf8') : '');
  return { dir, p, env, run, exec, state, nodeName };
}

describe('Node.js', () => {
  it('Node.js 未導入: 確認すると missing、承認後に専用の Node.js を導入し、cms-node.sh がそれを使う', () => {
    const s = sandbox();
    assert.equal(s.run('check').status.node, 'missing');
    const res = s.run('install-node', '--approved');
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /チェックサム（SHA-256）を確認しました/);
    assert.match(s.state('curl.log'), /https:\/\/nodejs\.org\/dist\/v22\.23\.4\/SHASUMS256\.txt/);
    const managed = s.p('home', '.est-rouge-cms', 'node', s.nodeName, 'bin', 'node');
    assert.equal(s.run('node-path').out.trim(), managed);
    assert.match(s.exec(CMS_NODE, ['scripts/x.mjs', '--flag']).out, /MANAGED_NODE scripts\/x\.mjs --flag/);
  });

  it('Node.js が古い: 既存の Node.js は使わず・変更せず、専用の Node.js を導入する', () => {
    const s = sandbox({ nodeVersion: 'v16.20.0' });
    const check = s.run('check');
    assert.equal(check.status.node, 'missing');
    assert.equal(check.status.node_system, 'v16.20.0');
    assert.match(check.out, /古いため使用しません（既存の Node.js は変更しません）/);
    assert.equal(s.exec(CMS_NODE, ['x.mjs']).code, 3);
    assert.equal(s.run('install-node', '--approved').code, 0);
    assert.match(s.exec(CMS_NODE, ['x.mjs']).out, /MANAGED_NODE/);
    assert.match(readFileSync(s.p('mockbin', 'node'), 'utf8'), /v16\.20\.0/, '既存の node は変更されていない');
  });

  it('十分に新しい Node.js があれば導入しない', () => {
    const s = sandbox({ nodeVersion: 'v22.12.0' });
    const res = s.run('install-node', '--approved');
    assert.equal(res.code, 0);
    assert.match(res.out, /導入は不要です/);
    assert.equal(s.state('curl.log'), '', 'ダウンロードしない');
    assert.match(s.exec(CMS_NODE, ['x.mjs']).out, /SYSTEM_NODE x\.mjs/);
  });

  it('承認がなければ導入しない', () => {
    const s = sandbox();
    assert.equal(s.run('install-node').code, 6);
    assert.equal(s.state('curl.log'), '');
  });

  it('チェックサムが一致しなければ導入しない（途中で失敗）', () => {
    const s = sandbox({ env: { MOCK_BAD_CHECKSUM: '1' } });
    const res = s.run('install-node', '--approved');
    assert.equal(res.code, 5);
    assert.match(res.out, /チェックサムが一致しません/);
    assert.ok(!existsSync(s.p('home', '.est-rouge-cms', 'node', s.nodeName)));
    assert.deepEqual(readdirSync(s.p('tmp')), [], '一時ファイルを残さない');
  });

  it('ダウンロードに失敗したら導入しない', () => {
    const s = sandbox({ env: { MOCK_CURL_FAIL: '1' } });
    assert.equal(s.run('install-node', '--approved').code, 5);
    assert.ok(!existsSync(s.p('home', '.est-rouge-cms', 'node')));
  });

  it('再実行しても導入し直さない', () => {
    const s = sandbox();
    assert.equal(s.run('install-node', '--approved').code, 0);
    const downloads = s.state('curl.log').split('\n').filter(Boolean).length;
    const again = s.run('install-node', '--approved');
    assert.equal(again.code, 0);
    assert.match(again.out, /導入は不要です/);
    assert.equal(s.state('curl.log').split('\n').filter(Boolean).length, downloads);
  });
});

describe('Docker の確認', () => {
  it('Docker CLI・Docker Desktop 未導入', () => {
    const { status } = sandbox().run('check');
    assert.equal(status.docker_cli, 'no');
    assert.equal(status.docker_app, 'no');
    assert.equal(status.docker_engine, 'stopped');
  });

  it('Docker Desktop 導入済み・Engine 停止（CLI は PATH になくてもアプリ内から見つける）', () => {
    const { status } = sandbox({ dockerApp: true }).run('check');
    assert.equal(status.docker_cli, 'yes');
    assert.equal(status.docker_app, 'yes');
    assert.equal(status.docker_engine, 'stopped');
  });

  it('Docker Compose が使えない', () => {
    const s = sandbox({ dockerOnPath: true, env: { MOCK_COMPOSE: 'fail' } });
    s.run('start-docker'); // Engine がなくても Compose の判定はできる
    assert.equal(s.run('check').status.docker_compose, 'unavailable');
  });

  it('ポート 4321 をほかのプログラムが使用中（止めない）', () => {
    const s = sandbox({ env: { MOCK_LSOF: 'python3' } });
    const res = s.run('check');
    assert.equal(res.status.port_4321, 'other:python3');
    assert.match(res.out, /CMS 側では停止しません/);
  });

  it('CMS のプレビューが起動中ならポートは CMS のもの', () => {
    const s = sandbox({ dockerApp: true, env: { MOCK_LSOF: 'com.docker.backend', MOCK_CONTAINER: 'running' } });
    writeFileSync(s.p('state', 'engine_up'), '');
    const { status } = s.run('check');
    assert.equal(status.preview_container, 'running');
    assert.equal(status['port_4321'], 'cms');
  });

  it('管理者権限・MDM・ライセンス方針を報告する', () => {
    const { status } = sandbox({ env: { MOCK_ADMIN: '', MOCK_MDM: 'Yes' } }).run('check');
    assert.equal(status.admin, 'no');
    assert.equal(status.mdm, 'yes');
    assert.equal(status.docker_license_policy, 'unconfirmed');
  });
});

describe('Docker Desktop の起動', () => {
  it('導入済み・Engine 停止なら起動して準備完了まで待つ', () => {
    const s = sandbox({ dockerApp: true });
    const res = s.run('start-docker');
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /Docker Engine の準備ができました/);
    assert.match(s.state('open.log'), /Docker\.app/);
  });

  it('既に起動していれば再起動しない（再実行）', () => {
    const s = sandbox({ dockerApp: true });
    s.run('start-docker');
    const again = s.run('start-docker');
    assert.equal(again.code, 0);
    assert.match(again.out, /既に起動しています（再起動はしません）/);
    assert.equal(s.state('open.log').split('\n').filter(Boolean).length, 1, 'open は 1 回だけ');
  });

  it('Engine の準備が終わらなければタイムアウトし、本人の操作を案内する', () => {
    const s = sandbox({ dockerApp: true, env: { MOCK_ENGINE_NEVER: '1' } });
    const res = s.run('start-docker');
    assert.equal(res.code, 11);
    assert.match(res.out, /利用規約への同意や macOS の権限の許可/);
  });

  it('起動後に終了したら異常終了として報告する', () => {
    const res = sandbox({ dockerApp: true, env: { MOCK_OPEN_CRASH: '1' } }).run('start-docker');
    assert.equal(res.code, 12);
  });

  it('未導入なら起動しない', () => {
    assert.equal(sandbox().run('start-docker').code, 10);
  });
});

describe('Docker Desktop の導入', () => {
  const licensed = ['install-docker', '--approved', '--license-confirmed'];

  it('正常: 公式配布元から取得し、署名・公証を検証して /Applications に配置する（起動・規約同意はしない）', () => {
    const s = sandbox();
    const res = s.run(...licensed);
    assert.equal(res.code, 0, res.out);
    assert.match(s.state('curl.log'), /https:\/\/desktop\.docker\.com\/mac\/main\/arm64\/Docker\.dmg/);
    assert.match(res.out, /Docker Inc \/ 9BNSXJN65R/);
    assert.ok(existsSync(s.p('apps', 'Docker.app')));
    assert.equal(s.state('open.log'), '', '起動はしない');
    assert.doesNotMatch(s.state('curl.log') + res.out, /accept-license/);
    assert.deepEqual(readdirSync(s.p('tmp')), [], '一時ファイルを残さない');
  });

  it('Intel Mac では amd64 版を取得する', () => {
    const s = sandbox({ arch: 'x86_64' });
    assert.equal(s.run(...licensed).code, 0);
    assert.match(s.state('curl.log'), /\/mac\/main\/amd64\/Docker\.dmg/);
  });

  it('ユーザーが承認しなければ導入しない', () => {
    const s = sandbox();
    assert.equal(s.run('install-docker', '--license-confirmed').code, 6);
    assert.equal(s.state('curl.log'), '');
  });

  it('ライセンス（組織での利用可否）が未確認なら保留する', () => {
    const s = sandbox();
    const res = s.run('install-docker', '--approved');
    assert.equal(res.code, 6);
    assert.match(res.out, /導入を保留しました/);
    assert.equal(s.state('curl.log'), '');
  });

  it('管理者権限がなければ導入しない', () => {
    const s = sandbox({ env: { MOCK_ADMIN: '' } });
    assert.equal(s.run(...licensed).code, 7);
    assert.equal(s.state('curl.log'), '');
  });

  it('MDM 管理端末では導入しない', () => {
    assert.equal(sandbox({ env: { MOCK_MDM: 'Yes' } }).run(...licensed).code, 8);
  });

  it('メモリ不足なら導入しない', () => {
    assert.equal(sandbox({ env: { MOCK_MEM: String(2 * 1024 ** 3) } }).run(...licensed).code, 9);
  });

  it('署名者が Docker Inc でなければ導入しない（途中で失敗）', () => {
    const s = sandbox({ env: { MOCK_TEAM: 'XXXXXXXXXX' } });
    const res = s.run(...licensed);
    assert.equal(res.code, 5);
    assert.ok(!existsSync(s.p('apps', 'Docker.app')));
    assert.deepEqual(readdirSync(s.p('tmp')), []);
  });

  it('公証（Gatekeeper）を確認できなければ導入しない', () => {
    const s = sandbox({ env: { MOCK_SPCTL: '3' } });
    assert.equal(s.run(...licensed).code, 5);
    assert.ok(!existsSync(s.p('apps', 'Docker.app')));
  });

  it('macOS が古ければ導入しない', () => {
    const s = sandbox({ env: { MOCK_MIN_OS: '99.0' } });
    assert.equal(s.run(...licensed).code, 4);
    assert.ok(!existsSync(s.p('apps', 'Docker.app')));
  });

  it('ダウンロードに失敗したら導入しない', () => {
    const s = sandbox({ env: { MOCK_CURL_FAIL: '1' } });
    assert.equal(s.run(...licensed).code, 5);
    assert.ok(!existsSync(s.p('apps', 'Docker.app')));
  });

  it('/Applications に書き込めない場合は macOS の認証ダイアログを使い、キャンセルされたら中止する', () => {
    const s = sandbox();
    chmodSync(s.p('apps'), 0o555);
    try {
      const res = s.run(...licensed);
      assert.equal(res.code, 13);
      assert.match(s.state('osascript.log'), /Docker\.app/);
      assert.ok(!existsSync(s.p('apps', 'Docker.app')));
    } finally {
      chmodSync(s.p('apps'), 0o755);
    }
  });

  it('導入済みなら上書きしない（再実行）', () => {
    const s = sandbox({ dockerApp: true });
    const res = s.run(...licensed);
    assert.equal(res.code, 0);
    assert.match(res.out, /上書きしません/);
    assert.equal(s.state('curl.log'), '');
  });

  it('macOS 以外では自動導入しない', () => {
    assert.equal(sandbox({ os: 'Linux' }).run(...licensed).code, 4);
  });
});
