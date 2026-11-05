// scripts/setup/bootstrap.sh と scripts/cms-node.sh の検証。
// 外部コマンド（uname・mise・curl・lsof など）はすべて一時ディレクトリのモックに差し替え、
// 実際の mise・Node.js・認証情報には触れない。リポジトリも一時ディレクトリに複製した最小構成を使う。
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SH = execFileSync('sh', ['-c', 'command -v sh'], { encoding: 'utf8' }).trim();
const SYSTEM_TOOLS = ['sh', 'cat', 'grep', 'sed', 'awk', 'tr', 'cut', 'head', 'tail', 'mkdir', 'mktemp', 'mv', 'rm', 'cp', 'ls', 'dirname', 'basename', 'tar', 'gzip', 'chmod', 'touch', 'wc', 'sort', 'env', 'date', 'find', 'shasum', 'sha256sum', 'perl'];
const REQUIRED_NODE = readFileSync(join(ROOT, 'mise.toml'), 'utf8').match(/^node\s*=\s*"([^"]+)"/m)[1];
const MISE_VERSION = readFileSync(join(ROOT, 'scripts/setup/bootstrap.sh'), 'utf8').match(/^MISE_VERSION=(\S+)/m)[1];

const roots = [];
after(() => roots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function writeExec(path, body) {
  writeFileSync(path, `#!${SH}\n${body}\n`);
  chmodSync(path, 0o755);
}

// mise のモック（$MOCK_STATE/node_installed があれば Node.js が導入済み）
const MISE_MOCK = `
[ "$1" = --version ] && { echo "${MISE_VERSION} mock (2026-10-20)"; exit 0; }
cmd=$1; shift
while [ $# -gt 0 ]; do case "$1" in --cd) shift 2 ;; *) break ;; esac; done
case "$cmd" in
  where) [ -f "$MOCK_STATE/node_installed" ] ;;
  install) echo "$*" >> "$MOCK_STATE/mise-install.log"; [ "\${MOCK_MISE_INSTALL_FAIL:-}" = 1 ] && exit 1; touch "$MOCK_STATE/node_installed" ;;
  exec)
    [ "$1" = -- ] && shift
    [ "$1" = node ] && shift
    [ "$1" = -v ] && { echo "\${MOCK_EXEC_NODE_VERSION:-v${REQUIRED_NODE}}"; exit 0; }
    echo "MISE_NODE auto_install=$MISE_EXEC_AUTO_INSTALL $*" ;;
  *) exit 1 ;;
esac`;

/** モックと最小構成のリポジトリを用意して、bootstrap.sh を実行する関数を返す */
function sandbox({ os = 'Darwin', arch = 'arm64', miseOnPath = false, systemNode, matchFixtureChecksum = true, env: extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cms-bootstrap-test-'));
  roots.push(dir);
  const p = (...parts) => join(dir, ...parts);
  for (const d of ['mockbin', 'sysbin', 'home', 'state', 'fixtures', 'tmp', 'repo/scripts/setup']) mkdirSync(p(d), { recursive: true });

  // 必要な標準コマンドだけを使えるようにする（実際の node・mise は PATH に入れない）
  for (const tool of SYSTEM_TOOLS) {
    const res = spawnSync(SH, ['-c', `command -v ${tool}`], { encoding: 'utf8' });
    const real = res.stdout.trim();
    if (res.status === 0 && real.startsWith('/')) writeExec(p('sysbin', tool), `exec "${real}" "$@"`);
  }
  const mock = (name, body) => writeExec(p('mockbin', name), body);
  mock('uname', `case "$1" in -m) echo "${arch}" ;; *) echo "${os}" ;; esac`);
  mock('sw_vers', 'echo 15.1');
  mock('profiles', 'echo "Enrolled via DEP: No"; echo "MDM enrollment: ${MOCK_MDM:-No}"');
  mock('df', `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n/dev/disk1 999 1 %s 1%% /\\n' "\${MOCK_DISK_KB:-104857600}"`);
  mock('lsof', '[ -n "${MOCK_LSOF:-}" ] && printf "p123\\nc%s\\n" "$MOCK_LSOF"; exit 0');
  mock('curl', `
echo "$*" >> "$MOCK_STATE/curl.log"
[ "\${MOCK_CURL_FAIL:-}" = 1 ] && exit 22
out=; url=
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift ;; https://*) url=$1 ;; esac; shift; done
src="$MOCK_FIXTURES/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"`);
  if (miseOnPath) mock('mise', MISE_MOCK);
  if (systemNode) mock('node', `[ "$1" = -v ] && echo "${systemNode}"`);

  // mise の公式リリースと同じ名前の tar.gz（中身は mise のモック）
  const platform = os === 'Darwin' ? 'macos' : 'linux';
  const file = `mise-v${MISE_VERSION}-${platform}-${arch === 'x86_64' ? 'x64' : 'arm64'}.tar.gz`;
  mkdirSync(p('fixtures', 'build', 'mise', 'bin'), { recursive: true });
  writeExec(p('fixtures', 'build', 'mise', 'bin', 'mise'), MISE_MOCK);
  execFileSync('tar', ['-czf', p('fixtures', file), '-C', p('fixtures', 'build'), 'mise']);
  const hash = createHash('sha256').update(readFileSync(p('fixtures', file))).digest('hex');

  // 最小構成のリポジトリ（bootstrap.sh・cms-node.sh・mise.toml）。
  // 成功系では、埋め込みのチェックサムをフィクスチャのものに置き換えた複製を使う（本体には手を加えない）
  let bootstrap = readFileSync(join(ROOT, 'scripts/setup/bootstrap.sh'), 'utf8');
  if (matchFixtureChecksum) bootstrap = bootstrap.replace(/^(MISE_SHA256_\w+)=\w+$/gm, `$1=${hash}`);
  writeFileSync(p('repo', 'scripts', 'setup', 'bootstrap.sh'), bootstrap);
  copyFileSync(join(ROOT, 'scripts/cms-node.sh'), p('repo', 'scripts', 'cms-node.sh'));
  copyFileSync(join(ROOT, 'mise.toml'), p('repo', 'mise.toml'));

  const env = {
    PATH: `${p('mockbin')}:${p('sysbin')}`,
    HOME: p('home'),
    TMPDIR: p('tmp'),
    CMS_SETUP_HOME: p('home', '.est-rouge-cms'),
    MOCK_STATE: p('state'),
    MOCK_FIXTURES: p('fixtures'),
    ...extra,
  };
  const exec = (file, args) => {
    const res = spawnSync(SH, [p('repo', file), ...args], { cwd: p('repo'), encoding: 'utf8', env });
    const out = `${res.stdout}${res.stderr}`;
    const status = Object.fromEntries([...out.matchAll(/^STATUS (\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
    return { code: res.status, out, status };
  };
  const run = (...args) => exec('scripts/setup/bootstrap.sh', args);
  const cmsNode = (...args) => exec('scripts/cms-node.sh', args);
  const state = (name) => (existsSync(p('state', name)) ? readFileSync(p('state', name), 'utf8') : '');
  return { p, run, cmsNode, state, file };
}

describe('mise', () => {
  it('mise 未導入: 確認すると missing、承認後に CMS 専用の場所へ導入する（PATH は変更しない）', () => {
    const s = sandbox();
    assert.equal(s.run('check').status.mise, 'missing');
    const res = s.run('install-mise', '--approved');
    assert.equal(res.code, 0, res.out);
    assert.match(s.state('curl.log'), new RegExp(`https://github\\.com/jdx/mise/releases/download/v${MISE_VERSION}/${s.file}`));
    assert.ok(existsSync(s.p('home', '.est-rouge-cms', 'bin', 'mise')));
    assert.equal(s.run('mise-path').out.trim(), s.p('home', '.est-rouge-cms', 'bin', 'mise'));
    assert.equal(s.run('check').status.mise, 'cms');
    assert.deepEqual(readdirSync(s.p('home')), ['.est-rouge-cms'], 'ホームディレクトリにほかのファイル（シェルの設定など）を作らない');
  });

  it('リポジトリに固定したチェックサムと一致しなければ導入しない', () => {
    const s = sandbox({ matchFixtureChecksum: false });
    const res = s.run('install-mise', '--approved');
    assert.equal(res.code, 5);
    assert.match(res.out, /チェックサムが一致しません/);
    assert.ok(!existsSync(s.p('home', '.est-rouge-cms', 'bin', 'mise')));
    assert.deepEqual(readdirSync(s.p('tmp')), [], '一時ファイルを残さない');
  });

  it('承認がなければ導入しない（ユーザーが拒否）', () => {
    const s = sandbox();
    assert.equal(s.run('install-mise').code, 6);
    assert.equal(s.state('curl.log'), '');
  });

  it('ダウンロードに失敗したら導入しない（途中で失敗）', () => {
    const s = sandbox({ env: { MOCK_CURL_FAIL: '1' } });
    assert.equal(s.run('install-mise', '--approved').code, 5);
    assert.ok(!existsSync(s.p('home', '.est-rouge-cms', 'bin', 'mise')));
  });

  it('既存の mise があればそれを使い、導入し直さない（再実行）', () => {
    const s = sandbox({ miseOnPath: true });
    const check = s.run('check');
    assert.equal(check.status.mise, 'existing');
    const res = s.run('install-mise', '--approved');
    assert.equal(res.code, 0);
    assert.match(res.out, /導入し直しません/);
    assert.equal(s.state('curl.log'), '');
  });

  it('未対応の OS では導入しない', () => {
    assert.equal(sandbox({ os: 'FreeBSD' }).run('install-mise', '--approved').code, 4);
  });

  it('空き容量が足りなければ導入しない', () => {
    assert.equal(sandbox({ env: { MOCK_DISK_KB: '1024' } }).run('install-mise', '--approved').code, 9);
  });

  it('Intel Mac では x64 版を取得する', () => {
    const s = sandbox({ arch: 'x86_64' });
    assert.equal(s.run('install-mise', '--approved').code, 0);
    assert.match(s.state('curl.log'), /macos-x64\.tar\.gz/);
  });
});

describe('Node.js（mise）', () => {
  it('Node.js 未導入: check は missing、cms-node.sh は実行しない（PATH 上の別の Node.js で動かさない）', () => {
    const s = sandbox({ miseOnPath: true, systemNode: 'v22.22.2' });
    const { status } = s.run('check');
    assert.equal(status.node, 'missing');
    assert.equal(status.node_required, REQUIRED_NODE);
    assert.equal(status.node_system, 'v22.22.2');
    const res = s.cmsNode('scripts/x.mjs');
    assert.equal(res.code, 3);
    assert.match(res.out, new RegExp(`Node\\.js ${REQUIRED_NODE.replace(/\./g, '\\.')} が mise に導入されていません`));
  });

  it('承認後に mise で導入し、cms-node.sh は自動インストールを無効にした mise exec で実行する', () => {
    const s = sandbox({ miseOnPath: true });
    const res = s.run('install-node', '--approved');
    assert.equal(res.code, 0, res.out);
    assert.match(s.state('mise-install.log'), new RegExp(`node@${REQUIRED_NODE}`));
    assert.equal(s.run('check').status.node, 'ok');
    assert.match(s.cmsNode('scripts/x.mjs', '--flag').out, /MISE_NODE auto_install=false scripts\/x\.mjs --flag/);
  });

  it('Node.js のバージョンが一致しなければ失敗として扱う', () => {
    const s = sandbox({ miseOnPath: true, env: { MOCK_EXEC_NODE_VERSION: 'v22.22.2' } });
    const res = s.run('install-node', '--approved');
    assert.equal(res.code, 5);
    assert.match(res.out, /想定と異なります/);
  });

  it('mise での導入に失敗したら失敗として扱う', () => {
    const s = sandbox({ miseOnPath: true, env: { MOCK_MISE_INSTALL_FAIL: '1' } });
    assert.equal(s.run('install-node', '--approved').code, 5);
    assert.equal(s.run('check').status.node, 'missing');
  });

  it('承認がなければ導入しない・mise がなければ先に導入を求める', () => {
    assert.equal(sandbox({ miseOnPath: true }).run('install-node').code, 6);
    assert.equal(sandbox().run('install-node', '--approved').code, 3);
  });

  it('導入済みなら導入し直さない（再実行）', () => {
    const s = sandbox({ miseOnPath: true });
    s.run('install-node', '--approved');
    const again = s.run('install-node', '--approved');
    assert.equal(again.code, 0);
    assert.match(again.out, /導入し直しません/);
    assert.equal(s.state('mise-install.log').trim().split('\n').length, 1);
  });

  it('mise がなければ cms-node.sh は実行しない', () => {
    const res = sandbox().cmsNode('scripts/x.mjs');
    assert.equal(res.code, 3);
    assert.match(res.out, /mise が見つかりません/);
  });
});

describe('依存関係・ポート', () => {
  it('依存関係が未インストールなら missing、npm ci 済みの印があれば installed', () => {
    const s = sandbox({ miseOnPath: true });
    assert.equal(s.run('check').status.dependencies, 'missing');
    mkdirSync(s.p('repo', 'node_modules'));
    writeFileSync(s.p('repo', 'node_modules', '.cms-install-stamp'), 'x');
    assert.equal(s.run('check').status.dependencies, 'installed');
  });

  it('ポート 4321 の使用状況を判別し、ほかのプログラムは止めない', () => {
    assert.equal(sandbox().run('check').status.port_4321, 'free');
    assert.equal(sandbox({ env: { MOCK_LSOF: 'node' } }).run('check').status.port_4321, 'node');
    assert.equal(sandbox({ env: { MOCK_LSOF: 'com.docker.backend' } }).run('check').status.port_4321, 'docker');
    const other = sandbox({ env: { MOCK_LSOF: 'python3' } }).run('check');
    assert.equal(other.status.port_4321, 'other:python3');
    assert.match(other.out, /CMS 側では停止しません/);
  });

  it('MDM 登録を報告する', () => {
    assert.equal(sandbox({ env: { MOCK_MDM: 'Yes' } }).run('check').status.mdm, 'yes');
  });
});
