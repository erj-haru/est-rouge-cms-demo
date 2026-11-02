#!/usr/bin/env node
/**
 * 記事入稿環境のセットアップとローカルプレビュー
 *
 *   node scripts/setup-editor.mjs                    環境を確認し、問題がなければプレビューを起動する（/setup-editor）
 *   node scripts/setup-editor.mjs --check            環境の確認だけを行う（起動しない）
 *   node scripts/setup-editor.mjs --preview          プレビューの状態確認・起動だけを行う（/preview）
 *   node scripts/setup-editor.mjs --preview --slug <slug>   記事詳細ページの URL も表示する
 *
 * - 何度実行しても既存環境を壊さない（起動中のプレビューは再起動しない）
 * - コンテナ・ボリューム・ファイルの削除やプロセスの停止は行わない
 * - GitHub の認証情報（トークン等）は取得・保存・表示しない
 *
 * 終了コード: 0 = 準備完了 / 1 = 利用者の対応が必要 / 2 = 想定外のエラー
 */
import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { getGitHubRepo, LOCALES, PORT, PREVIEW_URL, probe, ROOT, run, SERVICE, sleep, SLUG_PATTERN } from './lib/common.mjs';

const STARTUP_TIMEOUT_MS = 5 * 60 * 1000;

const REQUIRED_FILES = [
  'package.json',
  'package-lock.json',
  'compose.yaml',
  'Dockerfile.dev',
  'docker/dev-entrypoint.sh',
  'astro.config.mjs',
  'src/content.config.ts',
];

const platform = process.platform; // 'darwin' | 'win32' | 'linux' など
const options = parseArgs(process.argv.slice(2));

/** @typedef {{ label: string, status: 'ok' | 'warn' | 'fail', detail?: string, fix?: string[], blocking?: boolean }} CheckResult */
/** @type {CheckResult[]} */
const results = [];

// ---------------------------------------------------------------------------
// ユーティリティ
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const parsed = { check: false, preview: false, slug: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') parsed.check = true;
    else if (arg === '--preview') parsed.preview = true;
    else if (arg === '--slug') parsed.slug = argv[++i] ?? '';
    else if (arg.startsWith('--slug=')) parsed.slug = arg.slice('--slug='.length);
  }
  parsed.slug = parsed.slug.trim().replace(/^\/+|\/+$/g, '');
  return parsed;
}

function firstLine(text) {
  return text.split(/\r?\n/).find((line) => line.trim()) ?? '';
}

function byPlatform({ darwin, win32, linux }) {
  if (platform === 'darwin') return darwin;
  if (platform === 'win32') return win32;
  return linux;
}

function add(result) {
  results.push(result);
  const icon = { ok: '✅', warn: '⚠️ ', fail: '❌' }[result.status];
  console.log(`${icon} ${result.label}${result.detail ? `: ${result.detail}` : ''}`);
  return result;
}

/** localhost は IPv4 / IPv6 のどちらにも解決され得るため、両方を確認する */
async function isPortInUse(port) {
  const results = await Promise.all(['127.0.0.1', '::1'].map((host) => canConnect(host, port)));
  return results.some(Boolean);
}

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.setTimeout(2000);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// 環境チェック
// ---------------------------------------------------------------------------

function checkNode() {
  add({ label: 'Node.js（セットアップスクリプト用）', status: 'ok', detail: process.version });
}

function checkGit() {
  const git = run('git', ['--version']);
  if (!git.ok) {
    add({
      label: 'Git',
      status: 'fail',
      blocking: true,
      detail: 'インストールされていません',
      fix: byPlatform({
        darwin: ['ターミナルで `xcode-select --install`（または `brew install git`）を実行してください'],
        win32: ['PowerShell で `winget install --id Git.Git -e` を実行してください（https://git-scm.com/ からも入手できます）'],
        linux: ['パッケージマネージャーで git をインストールしてください（例: `sudo apt install git`）'],
      }),
    });
    return null;
  }
  add({ label: 'Git', status: 'ok', detail: git.stdout.replace(/^git version /, '') });

  const repo = getGitHubRepo();
  if (!repo) {
    add({
      label: 'GitHub リポジトリ',
      status: 'fail',
      blocking: true,
      detail: 'origin に GitHub のリポジトリが設定されていません',
      fix: ['招待されたリポジトリを `gh repo clone <owner>/<repo>` で取得し、そのフォルダで実行してください'],
    });
    return null;
  }
  return repo;
}

function checkGitHub(repo) {
  const gh = run('gh', ['--version']);
  if (!gh.ok) {
    return add({
      label: 'GitHub CLI (gh)',
      status: 'fail',
      blocking: true,
      detail: 'インストールされていません',
      fix: byPlatform({
        darwin: ['ターミナルで `brew install gh` を実行してください（https://cli.github.com/ からも入手できます）'],
        win32: ['PowerShell で `winget install --id GitHub.cli -e` を実行し、ターミナルを開き直してください'],
        linux: ['https://github.com/cli/cli#installation の手順でインストールしてください'],
      }),
    });
  }
  add({ label: 'GitHub CLI (gh)', status: 'ok', detail: firstLine(gh.stdout).replace(/^gh version /, '') });

  // 認証状態は終了コードだけで判定し、gh の出力（トークン情報を含み得る）は表示しない
  const auth = run('gh', ['auth', 'status', '--hostname', 'github.com'], { timeout: 20_000 });
  if (!auth.ok) {
    return add({
      label: 'GitHub へのログイン',
      status: 'fail',
      blocking: true,
      detail: 'ログインしていません（またはログインの有効期限が切れています）',
      fix: [
        'ご自身のターミナル（Claude Code の外）で次を実行し、表示される手順に従ってブラウザで認証してください:',
        '    gh auth login --hostname github.com --git-protocol https --web',
        '認証は本人のアカウントで行ってください。パスワードやトークンを Claude Code に貼り付けないでください。',
        '完了したら、もう一度セットアップを実行してください。',
      ],
    });
  }
  add({ label: 'GitHub へのログイン', status: 'ok', detail: 'ログイン済み' });

  const user = run('gh', ['api', 'user', '--jq', '.login'], { timeout: 20_000 });
  add({
    label: 'GitHub アカウント',
    status: user.ok ? 'ok' : 'warn',
    detail: user.ok ? user.stdout : 'アカウント名を取得できませんでした（ネットワーク接続を確認してください）',
  });

  if (!repo) return;
  const view = run('gh', ['repo', 'view', repo, '--json', 'nameWithOwner,viewerPermission', '--jq', '.viewerPermission'], {
    timeout: 20_000,
  });
  if (!view.ok) {
    return add({
      label: 'リポジトリへのアクセス権限',
      status: 'fail',
      blocking: true,
      detail: `${repo} にアクセスできません`,
      fix: [
        `招待メール、または https://github.com/${repo}/invitations から招待を承認してください`,
        `別のアカウントでログインしている場合は \`gh auth switch\` で招待されたアカウントに切り替えてください`,
      ],
    });
  }
  const permission = view.stdout;
  const canWrite = ['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission);
  add({
    label: 'リポジトリへのアクセス権限',
    status: canWrite ? 'ok' : 'warn',
    detail: `${repo}（${permission}）`,
    fix: canWrite ? undefined : ['閲覧はできますが、記事の公開には書き込み権限が必要です。リポジトリ管理者に Write 権限の付与を依頼してください'],
  });
}

function checkDocker() {
  const cli = run('docker', ['--version']);
  if (!cli.ok) {
    add({
      label: 'Docker CLI',
      status: 'fail',
      blocking: true,
      detail: 'インストールされていません',
      fix: byPlatform({
        darwin: ['Docker Desktop をインストールしてください: https://docs.docker.com/desktop/setup/install/mac-install/'],
        win32: ['Docker Desktop（WSL 2 バックエンド）をインストールしてください: https://docs.docker.com/desktop/setup/install/windows-install/'],
        linux: ['Docker Engine をインストールしてください: https://docs.docker.com/engine/install/'],
      }),
    });
    return false;
  }
  add({ label: 'Docker CLI', status: 'ok', detail: cli.stdout.replace(/^Docker version /, '') });

  const engine = run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 20_000 });
  if (!engine.ok || !engine.stdout) {
    const permissionDenied = /permission denied/i.test(engine.stderr);
    add({
      label: 'Docker Engine',
      status: 'fail',
      blocking: true,
      detail: permissionDenied ? 'Docker に接続する権限がありません' : '起動していません',
      fix: permissionDenied
        ? ['`sudo usermod -aG docker $USER` を実行し、ログインし直してください']
        : byPlatform({
            darwin: ['Docker Desktop を起動してください（ターミナルで `open -a Docker` でも起動できます）', 'メニューバーのクジラのアイコンが「Docker Desktop is running」になったら、もう一度実行してください'],
            win32: ['スタートメニューから Docker Desktop を起動してください', 'タスクトレイのクジラのアイコンが「Docker Desktop is running」になったら、もう一度実行してください'],
            linux: ['`sudo systemctl start docker` で Docker Engine を起動してください'],
          }),
    });
    return false;
  }
  add({ label: 'Docker Engine', status: 'ok', detail: engine.stdout });

  const compose = run('docker', ['compose', 'version', '--short']);
  if (!compose.ok) {
    add({
      label: 'Docker Compose',
      status: 'fail',
      blocking: true,
      detail: '利用できません',
      fix: ['Docker Desktop を最新版に更新してください（Linux の場合は docker-compose-plugin をインストールしてください）'],
    });
    return false;
  }
  add({ label: 'Docker Compose', status: 'ok', detail: compose.stdout });
  return true;
}

function checkProjectFiles() {
  const missing = REQUIRED_FILES.filter((file) => !existsSync(join(ROOT, file)));
  if (missing.length > 0) {
    return add({
      label: 'プロジェクトの設定ファイル',
      status: 'fail',
      blocking: true,
      detail: `不足: ${missing.join(', ')}`,
      fix: ['`git status` で変更内容を確認し、`git pull` で最新の状態に更新してください（ファイルを削除した覚えがなければリポジトリを取得し直してください）'],
    });
  }
  add({ label: 'プロジェクトの設定ファイル', status: 'ok', detail: `${REQUIRED_FILES.length} 件確認` });
}

// ---------------------------------------------------------------------------
// プレビュー（Docker Compose）
// ---------------------------------------------------------------------------

/** @returns {{ state: string, health: string } | null} */
function getServiceState() {
  const ps = run('docker', ['compose', 'ps', '--all', '--format', 'json', SERVICE], { timeout: 20_000 });
  if (!ps.ok || !ps.stdout) return null;
  // Compose のバージョンにより JSON 配列または 1 行 1 オブジェクトで出力される
  const text = ps.stdout.trim();
  const items = text.startsWith('[') ? JSON.parse(text) : text.split(/\r?\n/).map((line) => JSON.parse(line));
  const item = items.find((i) => i.Service === SERVICE);
  return item ? { state: String(item.State ?? ''), health: String(item.Health ?? '') } : null;
}

async function waitForPreview() {
  const started = Date.now();
  process.stdout.write('   プレビューの起動を待っています');
  while (Date.now() - started < STARTUP_TIMEOUT_MS) {
    if ((await probe('/ja/news/')).ok) {
      process.stdout.write(' 完了\n');
      return true;
    }
    const state = getServiceState();
    if (state && !['running', 'restarting'].includes(state.state)) break;
    process.stdout.write('.');
    await sleep(3000);
  }
  process.stdout.write('\n');
  return false;
}

async function ensurePreview() {
  const state = getServiceState();

  if (state?.state === 'running') {
    if ((await probe('/ja/news/')).ok) {
      add({ label: 'Astro 開発サーバー', status: 'ok', detail: '既に起動しています（再起動はしません）' });
      return true;
    }
    console.log('   コンテナは起動していますが、まだ応答がありません。');
  } else {
    // 自分のコンテナが再起動を繰り返している場合はポートを保持しているため、ポート確認は行わない
    if (state?.state !== 'restarting' && (await isPortInUse(PORT))) {
      add({
        label: 'Astro 開発サーバー',
        status: 'fail',
        detail: `ポート ${PORT} を別のプロセスが使用しています`,
        fix: [
          byPlatform({
            darwin: `\`lsof -i :${PORT}\` で使用中のプロセスを確認し、不要であれば終了してください`,
            win32: `\`netstat -ano | findstr :${PORT}\` で使用中のプロセスを確認し、不要であれば終了してください`,
            linux: `\`lsof -i :${PORT}\` で使用中のプロセスを確認し、不要であれば終了してください`,
          }),
          '（別のターミナルで `npm run dev` を起動している場合は、それを停止してください）',
        ],
      });
      return false;
    }
    console.log(state ? '   停止中のプレビュー環境を起動します...' : '   プレビュー環境を作成して起動します（初回は数分かかります）...');
    // --build は変更がなければキャッシュで即座に終わる。来歴情報（attestation）を付けると
    // ビルドのたびにイメージ ID が変わりコンテナが作り直されるため、付けない
    const up = run('docker', ['compose', 'up', '--detach', '--build', SERVICE], {
      timeout: STARTUP_TIMEOUT_MS,
      inherit: true,
      env: { BUILDX_NO_DEFAULT_ATTESTATIONS: '1' },
    });
    if (!up.ok) {
      add({
        label: 'Astro 開発サーバー',
        status: 'fail',
        detail: 'Docker Compose での起動に失敗しました',
        fix: ['上に表示されたエラーを確認してください', 'ログの確認: `docker compose logs astro --tail 50`'],
      });
      return false;
    }
  }

  if (!(await waitForPreview())) {
    add({
      label: 'Astro 開発サーバー',
      status: 'fail',
      detail: `${PREVIEW_URL} から応答がありません`,
      fix: [
        'ログを確認してください: `docker compose logs astro --tail 50`',
        '記事の frontmatter にエラーがあると起動に失敗します。ログに表示されたファイルを修正すると自動で再読み込みされます',
      ],
    });
    return false;
  }
  add({ label: 'Astro 開発サーバー', status: 'ok', detail: `${PREVIEW_URL} で起動しました` });
  return true;
}

/** 一覧 HTML から記事詳細へのリンクを取り出す（下書きかどうかも判定する） */
function extractArticles(listHtml, lang) {
  const linkPattern = new RegExp(`href="(/${lang}/news/([a-z0-9-]+)/)"`);
  return listHtml
    .split('<article')
    .slice(1)
    .map((card) => {
      const link = card.match(linkPattern);
      return link ? { path: link[1], slug: link[2], draft: /class="draft"/.test(card) } : null;
    })
    .filter((a) => a !== null);
}

/** 一覧・詳細ページが実際に表示できることを確認する */
async function verifyPages() {
  const failures = [];
  /** @type {Record<string, { path: string, slug: string, draft: boolean }[]>} */
  const articles = {};
  for (const lang of LOCALES) {
    const list = await probe(`/${lang}/news/`);
    if (!list.ok) {
      failures.push(`/${lang}/news/（HTTP ${list.status || '応答なし'}）`);
      continue;
    }
    articles[lang] = extractArticles(list.body, lang);
    const sample = articles[lang].find((a) => !a.draft) ?? articles[lang][0];
    if (!sample) continue;
    const detail = await probe(sample.path);
    if (!detail.ok) failures.push(`${sample.path}（HTTP ${detail.status || '応答なし'}）`);
  }
  if (failures.length > 0) {
    add({
      label: 'ページ表示の確認',
      status: 'fail',
      detail: `表示できないページがあります: ${failures.join(', ')}`,
      fix: ['ログを確認してください: `docker compose logs astro --tail 50`'],
    });
    return { ok: false, articles };
  }
  add({ label: 'ページ表示の確認', status: 'ok', detail: 'NEWS 一覧・詳細（日本語・英語）' });
  return { ok: true, articles };
}

/**
 * slug に対応する記事詳細ページを探す。
 * 見つかったページの hreflang から、共通IDで関連付けられた他言語版の URL も取得する
 */
async function findArticle(slug, articles) {
  if (!SLUG_PATTERN.test(slug)) {
    add({
      label: `記事「${slug}」`,
      status: 'fail',
      detail: 'slug の形式が正しくありません',
      fix: ['slug は記事ファイルの frontmatter にある `slug:` の値です（小文字英数字とハイフンのみ。例: site-renewal）'],
    });
    return null;
  }

  /** @type {Record<string, string>} */
  const found = {};
  let draft = false;
  for (const lang of LOCALES) {
    const page = await probe(`/${lang}/news/${slug}/`);
    if (!page.ok) continue;
    found[lang] = `/${lang}/news/${slug}/`;
    draft ||= /class="draft"/.test(page.body);
    for (const [, hreflang, href] of page.body.matchAll(/<link rel="alternate" hreflang="([a-z]+)" href="([^"]+)"/g)) {
      // 絶対 URL（公開用ビルド）でもパスだけを使う。翻訳がない場合の切り替え先（一覧ページ）は除外する
      const path = new URL(href, PREVIEW_URL).pathname;
      if (!found[hreflang] && /\/news\/[a-z0-9-]+\/$/.test(path)) found[hreflang] = path;
    }
  }

  if (Object.keys(found).length === 0) {
    const available = [...new Set(Object.values(articles).flat().map((a) => a.slug))];
    add({
      label: `記事「${slug}」`,
      status: 'fail',
      detail: '見つかりません',
      fix: [
        '記事ファイルの frontmatter にある `slug:` の値を指定してください（ファイル名ではありません）',
        available.length > 0 ? `現在表示できる記事の slug: ${available.join(', ')}` : '現在表示できる記事がありません',
        'frontmatter に誤りがあると記事は表示されません。`docker compose logs astro --tail 50` でエラーを確認してください',
      ],
    });
    return null;
  }

  const missing = LOCALES.filter((lang) => !found[lang]);
  const languages = missing.length > 0 ? `${missing.map((l) => (l === 'ja' ? '日本語' : '英語')).join('・')}版はありません` : '日本語・英語';
  add({
    label: `記事「${slug}」`,
    status: 'ok',
    detail: draft ? `${languages}（下書きのため、本番サイトには公開されません）` : languages,
  });
  return found;
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

function printFixes() {
  const pending = results.filter((r) => r.status !== 'ok' && r.fix?.length);
  if (pending.length === 0) return;
  console.log('\n── 対応が必要な項目 ─────────────────────────');
  for (const r of pending) {
    console.log(`\n${r.status === 'fail' ? '❌' : '⚠️ '} ${r.label}`);
    for (const line of r.fix ?? []) console.log(`   ${line}`);
  }
}

const isBlocked = () => results.some((r) => r.status === 'fail' && r.blocking);

/** プレビューを起動・確認し、URL を表示する（/setup-editor と /preview の共通処理） */
async function startAndReport({ completionMessage }) {
  if (!(await ensurePreview())) {
    printFixes();
    return 1;
  }
  const { ok: pagesOk, articles } = await verifyPages();
  const article = options.slug ? await findArticle(options.slug, articles) : null;
  printFixes();
  if (!pagesOk) return 1;

  console.log(`\n${completionMessage}`);
  console.log(`   NEWS 一覧（日本語）: ${PREVIEW_URL}/ja/news/`);
  console.log(`   NEWS 一覧（英語）  : ${PREVIEW_URL}/en/news/`);
  if (article) {
    if (article.ja) console.log(`   記事詳細（日本語）: ${PREVIEW_URL}${article.ja}`);
    if (article.en) console.log(`   記事詳細（英語）  : ${PREVIEW_URL}${article.en}`);
  } else if (!options.slug) {
    const sample = articles.ja?.find((a) => !a.draft);
    if (sample) console.log(`   記事詳細の例       : ${PREVIEW_URL}${sample.path}`);
  }
  console.log('   src/content/news/ の Markdown を編集すると、プレビューに自動で反映されます。');
  console.log('   プレビューの停止: docker compose stop');
  // slug を指定して見つからなかった場合は、プレビュー自体は起動済みでも対応が必要として扱う
  return options.slug && !article ? 1 : 0;
}

async function runSetup() {
  console.log('Est Rouge 記事入稿環境のセットアップ\n');
  console.log('── 環境の確認 ───────────────────────────────');
  checkNode();
  const repo = checkGit();
  checkGitHub(repo);
  const dockerReady = checkDocker();
  checkProjectFiles();

  if (options.check) {
    if (dockerReady) {
      const state = getServiceState();
      const running = state?.state === 'running' && (await probe('/ja/news/')).ok;
      add({ label: 'Astro 開発サーバー', status: running ? 'ok' : 'warn', detail: running ? `${PREVIEW_URL} で起動中` : '起動していません' });
    }
    printFixes();
    console.log(isBlocked() ? '\n対応が必要な項目があります。' : '\n確認が完了しました（--check のため起動はしていません）。');
    return isBlocked() ? 1 : 0;
  }

  if (isBlocked()) {
    printFixes();
    console.log('\n上記の対応後、もう一度セットアップを実行してください。プレビューはまだ起動していません。');
    return 1;
  }

  console.log('\n── プレビューの起動 ─────────────────────────');
  return startAndReport({ completionMessage: '🎉 セットアップが完了しました。' });
}

/** プレビューに必要な Docker 周りだけを確認する（GitHub の確認は /setup-editor で行う） */
async function runPreview() {
  console.log('Est Rouge ローカルプレビュー\n');
  console.log('── 環境の確認 ───────────────────────────────');
  checkDocker();
  checkProjectFiles();
  if (isBlocked()) {
    printFixes();
    console.log('\n上記の対応後、もう一度実行してください。初めての場合は /setup-editor で環境全体を確認できます。');
    return 1;
  }

  console.log('\n── プレビュー ───────────────────────────────');
  return startAndReport({ completionMessage: '👀 プレビューを表示できます。' });
}

(options.preview ? runPreview() : runSetup()).then(
  (code) => process.exit(code),
  (error) => {
    console.error('\n想定外のエラーが発生しました:', error instanceof Error ? error.message : error);
    process.exit(2);
  },
);
