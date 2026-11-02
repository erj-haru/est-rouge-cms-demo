#!/usr/bin/env node
/**
 * NEWS 記事の入稿・修正（/draft-news・/edit-news から利用する）
 *
 *   node scripts/news.mjs find <slug|articleId>              記事ファイルと進行中の入稿 PR を探す
 *   node scripts/news.mjs check --slug <s> --article-id <id> [--edit]
 *                                                           slug・共通記事ID の重複を確認する
 *   node scripts/news.mjs start --slug <s> [--edit]          入稿用ブランチ（content/news-<slug>）を用意する
 *   node scripts/news.mjs images --slug <s> [--overwrite] <file>...
 *                                                           画像を最適化して src/assets/news/<slug>/ に配置する
 *   node scripts/news.mjs verify --slug <s>                  記事の検査・型チェック・本番ビルド・プレビュー確認
 *   node scripts/news.mjs pr --slug <s> --summary <text> [--translated] [--dry-run]
 *                                                           検証 → コミット → Push → PR 作成/更新 → 同期確認
 *
 * 安全のための約束:
 * - main（既定ブランチ）へは Push しない。force push・reset・stash・ファイル破棄は行わない
 * - コミットするのは対象記事の Markdown と、その記事が参照する画像だけ
 * - 記事・画像以外の変更がブランチに含まれる場合は PR を作成せずに報告する
 * - GitHub の操作は gh にログイン中の本人のアカウントで行い、認証情報は表示しない
 * - マージ（公開）は行わない
 *
 * 終了コード: 0 = 成功 / 1 = 利用者の対応・確認が必要 / 2 = 想定外のエラー
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, posix, relative } from 'node:path';
import { getGitHubRepo, LOCALES, PREVIEW_URL, probe, ROOT, run, SERVICE, sleep, SLUG_PATTERN } from './lib/common.mjs';

const CONTENT_DIR = 'src/content/news';
const ASSET_DIR = 'src/assets/news';
const INBOX_DIR = '.news-inbox';
const BRANCH_PREFIX = 'content/news-';
const LABEL = { name: 'content', color: '0E8A16', description: 'NEWS 記事の入稿・修正' };
const ALLOWED_PATHS = [/^src\/content\/news\/(ja|en)\/[^/]+\.md$/, /^src\/assets\/news\/.+\.(jpe?g|png|webp|avif)$/i];
const REQUIRED_FIELDS = ['title', 'publishedAt', 'category', 'slug', 'lang', 'articleId'];
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
];
const LANG_LABEL = { ja: '日本語', en: '英語' };

class UserError extends Error {}

// ---------------------------------------------------------------------------
// 引数・出力
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  const opts = { command, positional: [], slug: '', articleId: '', summary: '', edit: false, dryRun: false, translated: false, overwrite: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--slug') opts.slug = rest[++i] ?? '';
    else if (arg === '--article-id') opts.articleId = rest[++i] ?? '';
    else if (arg === '--summary') opts.summary = rest[++i] ?? '';
    else if (arg === '--edit') opts.edit = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--translated') opts.translated = true;
    else if (arg === '--overwrite') opts.overwrite = true;
    else opts.positional.push(arg);
  }
  return opts;
}

const ok = (msg) => console.log(`✅ ${msg}`);
const warn = (msg) => console.log(`⚠️  ${msg}`);
const ng = (msg) => console.log(`❌ ${msg}`);
const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 40 - title.length * 2))}`);

function requireSlug(slug) {
  if (!SLUG_PATTERN.test(slug)) throw new UserError(`slug「${slug}」の形式が正しくありません（小文字英数字とハイフンのみ。例: new-office-2026）`);
  return slug;
}

function git(args, options) {
  return run('git', args, options);
}

/** 作業ツリーとインデックスで変更・追加・削除されたファイルのパス（未追跡を含む）。pathspec で絞り込める */
function changedPaths(pathspec = []) {
  const opts = ['-c', 'core.quotePath=false'];
  const spec = pathspec.length > 0 ? ['--', ...pathspec] : [];
  const lists = [
    git([...opts, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', ...spec]).stdout,
    git([...opts, 'diff', '--cached', '--name-only', ...spec]).stdout,
  ];
  return [...new Set(lists.join('\n').split('\n').filter(Boolean))].sort();
}

function mustGit(args, message) {
  const res = git(args);
  if (!res.ok) throw new UserError(`${message}\n   ${res.stderr.split('\n').slice(0, 3).join('\n   ')}`);
  return res.stdout;
}

// ---------------------------------------------------------------------------
// 記事ファイル
// ---------------------------------------------------------------------------

function unquote(value) {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** frontmatter を読む（このプロジェクトの記事は 1 行 1 項目の単純な形式。厳密な検証は Astro のスキーマで行う） */
function readArticle(file) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const data = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z][\w]*):\s*(.*)$/);
      if (kv) data[kv[1]] = unquote(kv[2]);
    }
  }
  return { file, folder: file.split('/')[3], data, body: match ? match[2] : text, hasFrontmatter: Boolean(match) };
}

function listArticles() {
  return LOCALES.flatMap((lang) => {
    const dir = join(ROOT, CONTENT_DIR, lang);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => readArticle(`${CONTENT_DIR}/${lang}/${name}`));
  });
}

/** slug または共通記事ID に一致する記事と、共通IDで関連付けられた他言語版を返す */
function findArticleGroup(key, all = listArticles()) {
  const hits = all.filter((a) => a.data.slug === key || a.data.articleId === key);
  const ids = new Set(hits.map((a) => a.data.articleId).filter(Boolean));
  return all.filter((a) => hits.includes(a) || ids.has(a.data.articleId));
}

/** 記事が参照する画像（thumbnail と本文中の画像）をリポジトリ相対パスで返す */
function imageRefs(article) {
  const refs = [];
  if (article.data.thumbnail) refs.push(article.data.thumbnail);
  for (const m of article.body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?/g)) refs.push(m[1]);
  return refs
    .filter((ref) => !/^(https?:)?\/\//.test(ref))
    .map((ref) => ({ ref, path: posix.normalize(posix.join(posix.dirname(article.file), ref)) }));
}

/** ブランチ名に使う slug（日本語版を優先） */
function branchSlug(group, fallback) {
  return (group.find((a) => a.data.lang === 'ja') ?? group[0])?.data.slug ?? fallback;
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

function gh(args, options = {}) {
  return run('gh', args, { timeout: 60_000, ...options });
}

function requireGitHub() {
  const repo = getGitHubRepo();
  if (!repo) throw new UserError('origin に GitHub のリポジトリが設定されていません。/setup-editor で環境を確認してください');
  if (!gh(['auth', 'status', '--hostname', 'github.com']).ok) {
    throw new UserError('GitHub にログインしていません。ご自身のターミナルで `gh auth login --hostname github.com --git-protocol https --web` を実行してください');
  }
  const view = gh(['repo', 'view', repo, '--json', 'viewerPermission,defaultBranchRef', '--jq', '[.viewerPermission, .defaultBranchRef.name] | @tsv']);
  if (!view.ok) throw new UserError(`${repo} にアクセスできません。招待を承認しているか確認してください（/setup-editor で確認できます）`);
  const [permission, defaultBranch] = view.stdout.split('\t');
  const login = gh(['api', 'user', '--jq', '.login']).stdout;
  return { repo, permission, defaultBranch: defaultBranch || 'main', login, canWrite: ['ADMIN', 'MAINTAIN', 'WRITE'].includes(permission) };
}

function findPullRequests(branch, state = 'all') {
  const res = gh(['pr', 'list', '--head', branch, '--state', state, '--json', 'number,url,state,headRefOid,title', '--limit', '10']);
  return res.ok && res.stdout ? JSON.parse(res.stdout) : [];
}

/** 対象記事のファイルを変更している、進行中（Open）の入稿 PR を探す */
function findOpenContentPrs(files) {
  const res = gh(['pr', 'list', '--state', 'open', '--json', 'number,url,headRefName,title,files', '--limit', '50']);
  if (!res.ok || !res.stdout) return [];
  return JSON.parse(res.stdout).filter(
    (pr) => pr.headRefName.startsWith(BRANCH_PREFIX) && (pr.files ?? []).some((f) => files.includes(f.path)),
  );
}

function remoteBranchSha(branch) {
  const res = git(['ls-remote', '--heads', 'origin', branch], { timeout: 60_000 });
  return res.ok && res.stdout ? res.stdout.split(/\s+/)[0] : null;
}

/** git のコミット作成者が設定されているか、GitHub アカウントと対応しているかを確認する */
function checkIdentity(login) {
  const name = git(['config', 'user.name']).stdout;
  const email = git(['config', 'user.email']).stdout;
  if (!name || !email) {
    throw new UserError(
      'Git のコミット作成者（名前・メールアドレス）が設定されていません。ご自身のターミナルで次を実行してください:\n' +
        '     git config --global user.name "あなたの名前"\n' +
        '     git config --global user.email "GitHub に登録したメールアドレス"',
    );
  }
  const user = gh(['api', 'user', '--jq', '[.id, (.email // "")] | @tsv']).stdout.split('\t');
  const known = new Set([`${user[0]}+${login}@users.noreply.github.com`, `${login}@users.noreply.github.com`, user[1]].filter(Boolean));
  const emails = gh(['api', 'user/emails', '--jq', '.[].email']);
  if (emails.ok) for (const e of emails.stdout.split('\n')) known.add(e);
  return { name, email, matched: known.has(email), verifiable: emails.ok || known.has(email) };
}

// ---------------------------------------------------------------------------
// Docker / プレビュー（既存のセットアップスクリプトを再利用する）
// ---------------------------------------------------------------------------

function ensurePreview(slug) {
  const args = ['scripts/setup-editor.mjs', '--preview', ...(slug ? ['--slug', slug] : [])];
  const res = run(process.execPath, args, { timeout: 10 * 60_000 });
  if (!res.ok) {
    console.log(res.stdout.split('\n').filter((l) => /❌|^\s{3}/.test(l)).join('\n'));
    throw new UserError('プレビューを表示できませんでした。上記の対応後にもう一度実行してください');
  }
}

function compose(args, options = {}) {
  return run('docker', ['compose', ...args], { timeout: 10 * 60_000, ...options });
}

/**
 * プレビューに記事のタイトルが表示されているか確認する。
 * ビルドやコミット直後は開発サーバーが再読み込み中のことがあり、短時間に続けて保存すると
 * ファイル変更の通知を取りこぼすこともあるため、更新日時を変えて再読み込みさせてから再確認する
 */
async function previewShows(article) {
  const path = `/${article.data.lang}/news/${article.data.slug}/`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const page = await probe(path, 15_000);
    if (page.ok && decodeEntities(page.body).includes(article.data.title)) return true;
    const now = new Date();
    utimesSync(join(ROOT, article.file), now, now);
    await sleep(3000);
  }
  return false;
}

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" })[m]);
}

// ---------------------------------------------------------------------------
// サブコマンド
// ---------------------------------------------------------------------------

function cmdFind(opts) {
  const key = opts.positional[0] ?? opts.slug;
  if (!key) throw new UserError('slug または共通記事ID を指定してください');
  const group = findArticleGroup(key);
  if (group.length === 0) {
    const all = listArticles();
    ng(`「${key}」に一致する記事はありません`);
    console.log('   既存の記事（slug / 共通記事ID / タイトル）:');
    for (const a of all) console.log(`   - ${a.data.lang}: ${a.data.slug} / ${a.data.articleId} / ${a.data.title}`);
    return 1;
  }
  section('記事');
  for (const a of group) {
    console.log(`- ${LANG_LABEL[a.data.lang] ?? a.data.lang}: ${a.file}`);
    console.log(`    タイトル: ${a.data.title} / slug: ${a.data.slug} / 共通記事ID: ${a.data.articleId}`);
    console.log(`    公開日: ${a.data.publishedAt} / カテゴリー: ${a.data.category} / 下書き: ${a.data.draft === 'true' ? 'はい' : 'いいえ'}`);
    console.log(`    画像: ${imageRefs(a).map((r) => r.path).join(', ') || 'なし'}`);
  }
  for (const lang of LOCALES) if (!group.some((a) => a.data.lang === lang)) warn(`${LANG_LABEL[lang]}版はありません`);

  section('入稿 PR');
  const branch = BRANCH_PREFIX + branchSlug(group, key);
  const prs = findOpenContentPrs(group.map((a) => a.file));
  if (prs.length > 0) for (const pr of prs) console.log(`- 進行中: #${pr.number} ${pr.title}（ブランチ ${pr.headRefName}）${pr.url}`);
  else console.log(`- 進行中の PR はありません（修正すると ${branch} から新しい PR を作成します）`);
  console.log(`\n現在のブランチ: ${git(['branch', '--show-current']).stdout || '(detached)'}`);
  return 0;
}

function cmdCheck(opts) {
  const slug = requireSlug(opts.slug);
  const articleId = requireSlug(opts.articleId || opts.slug);
  const all = listArticles();
  const problems = [];
  for (const a of all) {
    const used = [];
    if (a.data.slug === slug && !(opts.edit && a.data.articleId === articleId)) used.push(`slug「${slug}」`);
    if (a.data.articleId === articleId && !opts.edit) used.push(`共通記事ID「${articleId}」`);
    if (used.length > 0) problems.push(`${used.join('・')}は ${a.file}（${a.data.title}）で使用されています`);
  }
  if (!opts.edit) {
    const branch = BRANCH_PREFIX + slug;
    if (remoteBranchSha(branch) && findPullRequests(branch, 'open').length > 0) {
      problems.push(`ブランチ ${branch} で進行中の入稿 PR があります（同じ slug の記事が入稿中です）`);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) ng(p);
    console.log('   別の slug・共通記事ID を提案するか、既存記事の修正であれば /edit-news を使ってください');
    return 1;
  }
  ok(`slug「${slug}」・共通記事ID「${articleId}」は重複していません`);
  return 0;
}

function cmdStart(opts) {
  const slug = requireSlug(opts.slug);
  const { defaultBranch } = requireGitHub();
  mustGit(['fetch', 'origin', '--prune'], 'GitHub から最新の状態を取得できませんでした');

  const current = git(['branch', '--show-current']).stdout;
  const dirtyTracked = git(['status', '--porcelain', '--untracked-files=no']).stdout;
  let branch = BRANCH_PREFIX + slug;

  // 対象記事を変更している進行中の PR があれば、そのブランチを使う（-update-YYYYMMDD などの名前でも）
  const group = findArticleGroup(slug);
  const existingPr = group.length > 0 ? findOpenContentPrs(group.map((a) => a.file))[0] : undefined;
  if (existingPr) branch = existingPr.headRefName;

  // 公開済み（PR がマージ・クローズ済み）のブランチは再利用せず、新しい名前で作る
  const prs = remoteBranchSha(branch) ? findPullRequests(branch) : [];
  const openPr = prs.find((pr) => pr.state === 'OPEN');
  if (!openPr && prs.length > 0) {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    branch = `${branch}-update-${date}`;
    for (let n = 2; remoteBranchSha(branch) || git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok; n++) {
      branch = `${BRANCH_PREFIX}${slug}-update-${date}-${n}`;
    }
  }

  if (current === branch) {
    ok(`入稿用ブランチ ${branch} で作業中です`);
  } else {
    if (dirtyTracked) {
      ng('コミットされていない変更があるため、ブランチを切り替えられません');
      console.log(dirtyTracked.split('\n').map((l) => `   ${l}`).join('\n'));
      console.log('   変更を勝手にコミット・破棄することはしません。内容を確認し、どうするか指示してください');
      return 1;
    }
    const localExists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
    if (localExists) mustGit(['switch', branch], `${branch} に切り替えられませんでした`);
    else if (openPr) mustGit(['switch', '--track', '-c', branch, `origin/${branch}`], `${branch} に切り替えられませんでした`);
    else mustGit(['switch', '--no-track', '-c', branch, `origin/${defaultBranch}`], `${branch} を作成できませんでした`);
    ok(`入稿用ブランチ ${branch} に切り替えました（${current || 'detached'} から）`);
  }

  // 進行中の PR がある場合は、ほかの人の修正を取り込んでから作業する（早送りできる場合のみ）
  if (remoteBranchSha(branch)) {
    const pull = git(['merge', '--ff-only', `origin/${branch}`]);
    if (!pull.ok) {
      ng(`${branch} の手元と GitHub の内容が分岐しています。自動では統合しません`);
      return 1;
    }
  }
  if (openPr) ok(`進行中の PR #${openPr.number} を更新します: ${openPr.url}`);
  else console.log(`   ベース: origin/${defaultBranch}（PR はまだありません）`);
  console.log(`BRANCH=${branch}`);
  return 0;
}

function cmdImages(opts) {
  const slug = requireSlug(opts.slug);
  const files = opts.positional;
  if (files.length === 0) throw new UserError('画像ファイルを指定してください');
  for (const f of files) if (!existsSync(f)) throw new UserError(`${f} が見つかりません`);
  ensurePreview();

  // コンテナからはリポジトリ内しか見えないため、一時フォルダ（Git 管理外）にコピーしてから処理する
  const inbox = join(ROOT, INBOX_DIR, slug);
  mkdirSync(inbox, { recursive: true });
  const staged = files.map((f, i) => {
    const target = join(inbox, `${String(i + 1).padStart(2, '0')}__${basename(f)}`);
    copyFileSync(f, target);
    return target;
  });

  const outDir = `${ASSET_DIR}/${slug}`;
  const existing = existsSync(join(ROOT, outDir)) ? readdirSync(join(ROOT, outDir)).filter((n) => /^\d{2}-/.test(n)) : [];
  const start = opts.overwrite ? 1 : existing.reduce((max, n) => Math.max(max, Number(n.slice(0, 2))), 0) + 1;
  const res = compose(
    ['exec', '-T', SERVICE, 'node', 'scripts/lib/optimize-images.mjs', '--out', outDir, '--start', String(start), ...(opts.overwrite ? ['--overwrite'] : []),
      ...staged.map((s) => relative(ROOT, s).split('\\').join('/'))],
  );
  for (const s of staged) rmSync(s, { force: true });
  if (!res.ok) throw new UserError(`画像を処理できませんでした: ${res.stderr || res.stdout}`);

  const results = JSON.parse(res.stdout);
  section('配置した画像');
  for (const r of results) {
    const original = r.source.replace(/^\d{2}__/, '');
    console.log(`- ${original} → ${r.output}（${r.width}×${r.height}px, ${Math.round(r.bytes / 1024)}KB）`);
    console.log(`    記事からの参照パス: ../../../assets/news/${slug}/${basename(r.output)}`);
  }
  console.log('\n位置情報などのメタデータは削除済みです。表示サイズに合わせた変換（WebP 等）はビルド時に行われます。');
  return 0;
}

/** 記事ファイルの静的検査（ビルド前に分かりやすいメッセージを出すため） */
function lintGroup(group) {
  const problems = [];
  for (const a of group) {
    if (!a.hasFrontmatter) problems.push(`${a.file}: frontmatter（--- で囲まれた部分）がありません`);
    for (const key of REQUIRED_FIELDS) if (!a.data[key]) problems.push(`${a.file}: ${key} がありません`);
    if (a.data.lang && a.data.lang !== a.folder) problems.push(`${a.file}: lang「${a.data.lang}」が配置フォルダ「${a.folder}」と一致しません`);
    for (const { ref, path } of imageRefs(a)) {
      if (!path.startsWith(`${ASSET_DIR}/`)) problems.push(`${a.file}: 画像「${ref}」は src/assets/news/ 配下に置いてください`);
      else if (!existsSync(join(ROOT, path))) problems.push(`${a.file}: 画像「${ref}」が見つかりません`);
    }
    const text = readFileSync(join(ROOT, a.file), 'utf8');
    if (SECRET_PATTERNS.some((p) => p.test(text))) problems.push(`${a.file}: トークン・秘密鍵のような文字列が含まれています。削除してください`);
  }
  return problems;
}

async function verifyGroup(slug, group) {
  section('記事の検査');
  if (group.length === 0) throw new UserError(`slug「${slug}」の記事ファイルが見つかりません`);
  const problems = lintGroup(group);
  if (problems.length > 0) {
    for (const p of problems) ng(p);
    return { ok: false, results: [] };
  }
  ok(`記事ファイル ${group.length} 件（${group.map((a) => LANG_LABEL[a.data.lang]).join('・')}）と参照画像を確認しました`);
  const results = ['記事ファイル・参照画像・機密情報の検査'];

  section('型チェック・本番ビルド');
  ensurePreview();
  // 開発サーバーと同じコンテナで、astro check（スキーマ検証を含む）と astro build を実行する。
  // コンテナは NODE_ENV=development のため、本番と同じく下書きが除外されるよう production を明示する
  const build = compose(['exec', '-T', '-e', 'NODE_ENV=production', SERVICE, 'npm', 'run', 'build']);
  if (!build.ok) {
    ng('型チェックまたは本番ビルドに失敗しました');
    const lines = `${build.stdout}\n${build.stderr}`.split('\n').filter((l) => /error|Error|invalid|Invalid|expected|✘/.test(l));
    console.log(lines.slice(0, 15).map((l) => `   ${l.trim()}`).join('\n'));
    return { ok: false, results };
  }
  const pages = build.stdout.match(/(\d+) page\(s\) built/);
  ok(`astro check・astro build に成功しました${pages ? `（${pages[1]} ページ）` : ''}`);
  results.push('型チェック（astro check）', `本番ビルド（astro build${pages ? `、${pages[1]} ページ` : ''}）`);

  // 下書きが本番ビルドに含まれていないこと / 公開記事が含まれていること
  for (const a of group) {
    const built = existsSync(join(ROOT, 'dist', a.data.lang, 'news', a.data.slug, 'index.html'));
    const draft = a.data.draft === 'true';
    if (draft === built) {
      ng(`${a.file}: ${draft ? '下書きなのに本番ビルドに含まれています' : '本番ビルドに記事ページがありません'}`);
      return { ok: false, results };
    }
  }
  const drafts = group.filter((a) => a.data.draft === 'true').length;
  ok(drafts > 0 ? `下書き ${drafts} 件が本番ビルドから除外されていることを確認しました` : '記事ページが本番ビルドに含まれていることを確認しました');
  results.push(drafts > 0 ? '下書きが本番ビルドから除外されている' : '記事ページが本番ビルドに含まれている');

  section('プレビュー');
  ensurePreview(slug);
  const urls = {};
  for (const a of group) {
    const path = `/${a.data.lang}/news/${a.data.slug}/`;
    if (!(await previewShows(a))) {
      ng(`${PREVIEW_URL}${path} に記事「${a.data.title}」が表示されていません`);
      return { ok: false, results };
    }
    urls[a.data.lang] = `${PREVIEW_URL}${path}`;
    ok(`${LANG_LABEL[a.data.lang]}: ${PREVIEW_URL}${path}${a.data.draft === 'true' ? '（下書き）' : ''}`);
  }
  results.push(`ローカルプレビューで${group.map((a) => LANG_LABEL[a.data.lang]).join('・')}の記事ページを表示`);
  return { ok: true, results, urls };
}

async function cmdVerify(opts) {
  const slug = requireSlug(opts.slug);
  const { ok: passed } = await verifyGroup(slug, findArticleGroup(slug));
  return passed ? 0 : 1;
}

function buildPrBody({ group, summary, results, files, translated, isEdit }) {
  const ja = group.find((a) => a.data.lang === 'ja');
  const base = ja ?? group[0];
  const rows = [
    ['共通記事ID', `\`${base.data.articleId}\``],
    ...group.map((a) => [`タイトル（${LANG_LABEL[a.data.lang]}）`, a.data.title]),
    ...group.map((a) => [`slug（${LANG_LABEL[a.data.lang]}）`, `\`${a.data.slug}\``]),
    ['言語', LOCALES.filter((l) => group.some((a) => a.data.lang === l)).map((l) => LANG_LABEL[l]).join('・')],
    ['公開日', base.data.publishedAt],
    ['カテゴリー', base.data.category],
    ['状態', base.data.draft === 'true' ? '下書き（`draft: true`。マージしても公開されません）' : '公開（マージ後に公開されます）'],
  ];
  const lines = [
    `## NEWS 記事の${isEdit ? '修正' : '入稿'}`,
    '',
    '| 項目 | 内容 |',
    '| --- | --- |',
    ...rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|')} |`),
    '',
    '## 変更内容',
    '',
    summary,
    '',
    '## 変更ファイル',
    '',
    ...files.map((f) => `- \`${f}\``),
    '',
    '## 検証結果',
    '',
    ...results.map((r) => `- [x] ${r}`),
    '- [x] 記事・画像以外のファイル変更なし',
    '',
  ];
  if (translated) {
    lines.push('## レビューのお願い', '', '- 英語版は Claude Code による翻訳案です。固有名詞・役職・数値・ニュアンスをご確認ください。', '');
  }
  lines.push(
    '## プレビュー',
    '',
    ...group.map((a) => `- ${LANG_LABEL[a.data.lang]}: ${PREVIEW_URL}/${a.data.lang}/news/${a.data.slug}/`),
    '',
    '> ローカルプレビューは入稿した編集者の PC で表示できます（このブランチを checkout して `/preview` でも確認できます）。',
    '',
    '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  );
  return lines.join('\n');
}

async function cmdPr(opts) {
  const slug = requireSlug(opts.slug);
  if (!opts.summary) throw new UserError('--summary に変更内容（日本語で 1〜3 行）を指定してください');
  const group = findArticleGroup(slug);
  if (group.length === 0) throw new UserError(`slug「${slug}」の記事ファイルが見つかりません`);

  section('GitHub・Git の確認');
  const { repo, defaultBranch, login, canWrite, permission } = requireGitHub();
  if (!canWrite) throw new UserError(`${repo} への書き込み権限がありません（現在: ${permission}）。管理者に Write 権限を依頼してください`);
  const identity = checkIdentity(login);
  const branch = git(['branch', '--show-current']).stdout;
  if (!branch.startsWith(BRANCH_PREFIX) || branch === defaultBranch) {
    throw new UserError(`現在のブランチ「${branch || 'detached'}」は入稿用ではありません。先に \`node scripts/news.mjs start --slug ${slug}\` を実行してください`);
  }
  mustGit(['fetch', 'origin', '--prune'], 'GitHub から最新の状態を取得できませんでした');

  // ブランチに記事・画像以外のコミットが含まれていないこと
  const committed = git(['diff', '--name-only', `origin/${defaultBranch}...HEAD`]).stdout.split('\n').filter(Boolean);
  const foreign = committed.filter((f) => !ALLOWED_PATHS.some((p) => p.test(f)));
  if (foreign.length > 0) {
    ng('このブランチには記事・画像以外の変更が含まれています。通常の入稿 PR としては扱えません');
    for (const f of foreign) console.log(`   - ${f}`);
    return 1;
  }

  // コミット対象: 対象記事の Markdown と、その記事が参照する画像のうち変更があるもの
  const targets = [...new Set(group.flatMap((a) => [a.file, ...imageRefs(a).map((r) => r.path)]))];
  const changed = changedPaths(targets);
  const preStaged = git(['diff', '--cached', '--name-only']).stdout.split('\n').filter((f) => f && !targets.includes(f));
  if (preStaged.length > 0) {
    ng('対象記事以外のファイルがコミット予定（ステージ済み）になっています。勝手には変更しません');
    for (const f of preStaged) console.log(`   - ${f}`);
    return 1;
  }
  const others = changedPaths().filter((f) => !targets.includes(f) && !f.startsWith(`${INBOX_DIR}/`));

  // 既定ブランチに既に存在する記事なら「修正」、なければ「新規入稿」
  const isEdit = group.some((a) => git(['cat-file', '-e', `origin/${defaultBranch}:${a.file}`]).ok);
  const remoteSha = remoteBranchSha(branch);
  const openPr = remoteSha ? findPullRequests(branch, 'open')[0] : undefined;
  const labelExists = gh(['label', 'list', '--search', LABEL.name, '--json', 'name', '--jq', '.[].name']).stdout.split('\n').includes(LABEL.name);
  ok(`リポジトリ ${repo}（権限: ${permission}）/ アカウント ${login}`);
  ok(`コミット作成者: ${identity.name} <${identity.email}>`);
  if (!identity.matched) warn('このメールアドレスが GitHub アカウントに登録されているか確認できませんでした。ご本人のものか確認してください');

  const verification = await verifyGroup(slug, group);
  if (!verification.ok) {
    console.log('\n検証に失敗したため、コミット・Push は行っていません。');
    return 1;
  }

  section(opts.dryRun ? '実行内容（まだ何も実行していません）' : '実行内容');
  console.log(`- リポジトリ: ${repo}`);
  console.log(`- ブランチ: ${branch} → ベース ${defaultBranch}（${defaultBranch} へ直接 Push はしません）`);
  console.log(`- PR: ${openPr ? `既存の #${openPr.number} を更新（${openPr.url}）` : '新規作成'}`);
  console.log(`- ラベル: ${LABEL.name}${labelExists ? '' : '（リポジトリに存在しないため新規作成）'}`);
  console.log(`- コミット作成者: ${identity.name} <${identity.email}>`);
  console.log(`- コミットするファイル${changed.length === 0 ? ': なし（変更済みの内容はコミット済み）' : ':'}`);
  for (const f of changed) console.log(`    ${f}`);
  if (others.length > 0) {
    console.log('- コミットしない変更（記事と無関係のため、そのまま残します）:');
    for (const f of others) console.log(`    ${f}`);
  }
  if (opts.dryRun) {
    console.log('\nDRY_RUN=ok');
    return 0;
  }

  // コミット（対象ファイルだけを明示的に追加する）
  if (changed.length > 0) {
    mustGit(['add', '--', ...changed], 'ファイルをコミット対象に追加できませんでした');
    const staged = git(['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean);
    if (staged.some((f) => !ALLOWED_PATHS.some((p) => p.test(f)))) throw new UserError('記事・画像以外のファイルがコミット対象に含まれています。中止しました');
    const title = (group.find((a) => a.data.lang === 'ja') ?? group[0]).data.title;
    // 既存記事の修正、または同じ PR への 2 回目以降のコミットは update
    const verb = isEdit || committed.length > 0 ? 'update' : 'add';
    mustGit(['commit', '-m', `news: ${verb} ${slug}`, '-m', `${title}\n\n${opts.summary}`], 'コミットできませんでした');
    ok(`コミットしました: ${git(['log', '-1', '--format=%h %s']).stdout}`);
  }

  // Push（通常の Push のみ。拒否された場合は自動で上書きしない）
  const push = git(['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`], { timeout: 120_000 });
  if (!push.ok) {
    ng('GitHub への Push が拒否されました。ほかの人が同じ PR を更新した可能性があります');
    console.log(`   \`node scripts/news.mjs start --slug ${slug}\` で最新の内容を取り込んでから、もう一度実行してください`);
    return 1;
  }
  ok(`Push しました: ${branch}`);

  if (!labelExists) {
    const created = gh(['label', 'create', LABEL.name, '--color', LABEL.color, '--description', LABEL.description]);
    if (created.ok) ok(`ラベル「${LABEL.name}」を作成しました`);
    else warn(`ラベル「${LABEL.name}」を作成できませんでした: ${firstLine(created.stderr)}`);
  }

  const allFiles = git(['diff', '--name-only', `origin/${defaultBranch}...HEAD`]).stdout.split('\n').filter(Boolean);
  const bodyFile = join(tmpdir(), `news-pr-${slug}-${process.pid}.md`);
  // 既存 PR の更新では、これまでの変更内容と翻訳レビューの依頼を残し、今回の修正を追記する
  let summary = opts.summary;
  let translated = opts.translated;
  if (openPr) {
    const previous = gh(['pr', 'view', String(openPr.number), '--json', 'body', '--jq', '.body']).stdout;
    const prevSummary = previous.match(/## 変更内容\n\n([\s\S]*?)\n\n## 変更ファイル/)?.[1];
    if (prevSummary) summary = `${prevSummary}\n\n**修正（${new Date().toISOString().slice(0, 10)}）**: ${opts.summary}`;
    translated ||= previous.includes('## レビューのお願い');
  }
  writeFileSync(bodyFile, buildPrBody({ group, summary, results: verification.results, files: allFiles, translated, isEdit }));
  let prUrl;
  try {
    if (openPr) {
      const edited = gh(['pr', 'edit', String(openPr.number), '--body-file', bodyFile, '--add-label', LABEL.name]);
      if (!edited.ok) throw new UserError(`PR #${openPr.number} を更新できませんでした: ${firstLine(edited.stderr)}`);
      writeFileSync(bodyFile, `## 修正内容\n\n${opts.summary}\n\n${verification.results.map((r) => `- [x] ${r}`).join('\n')}\n`);
      gh(['pr', 'comment', String(openPr.number), '--body-file', bodyFile]);
      prUrl = openPr.url;
      ok(`PR #${openPr.number} を更新しました`);
    } else {
      const ja = group.find((a) => a.data.lang === 'ja') ?? group[0];
      const created = gh(['pr', 'create', '--base', defaultBranch, '--head', branch, '--title', `[NEWS] ${ja.data.title}`, '--body-file', bodyFile, '--label', LABEL.name]);
      if (!created.ok) throw new UserError(`PR を作成できませんでした: ${firstLine(created.stderr)}`);
      prUrl = created.stdout.split('\n').find((l) => l.startsWith('https://')) ?? created.stdout;
      ok(`PR を作成しました: ${prUrl}`);
    }
  } finally {
    rmSync(bodyFile, { force: true });
  }

  // プレビュー（作業ツリー）と PR のコミットが一致していることを確認する
  section('プレビューと PR の一致確認');
  const head = git(['rev-parse', 'HEAD']).stdout;
  const pushed = remoteBranchSha(branch);
  const pr = findPullRequests(branch, 'open')[0];
  const labels = pr ? gh(['pr', 'view', String(pr.number), '--json', 'labels', '--jq', '.labels[].name']).stdout.split('\n') : [];
  const dirty = changedPaths(targets).length > 0;
  const checks = [
    [head === pushed, `手元のコミット ${head.slice(0, 7)} と GitHub のブランチが一致`],
    [pr?.headRefOid === head, `PR のコミットが ${head.slice(0, 7)} と一致`],
    [!dirty, 'プレビューが参照する記事ファイルに未コミットの変更なし'],
    [labels.includes(LABEL.name), `PR にラベル「${LABEL.name}」が設定済み`],
    [git(['branch', '--show-current']).stdout === branch, `作業ブランチは ${branch} のまま`],
  ];
  for (const a of group) checks.push([await previewShows(a), `プレビューに${LANG_LABEL[a.data.lang]}版の記事が表示されている`]);
  for (const [passed, label] of checks) (passed ? ok : ng)(label);

  console.log(`\nPR_URL=${prUrl}`);
  for (const [lang, url] of Object.entries(verification.urls ?? {})) console.log(`PREVIEW_${lang.toUpperCase()}=${url}`);
  return checks.every(([passed]) => passed) ? 0 : 1;
}

function firstLine(text) {
  return text.split(/\r?\n/).find((l) => l.trim()) ?? '';
}

// ---------------------------------------------------------------------------

const COMMANDS = { find: cmdFind, check: cmdCheck, start: cmdStart, images: cmdImages, verify: cmdVerify, pr: cmdPr };
const opts = parseArgs(process.argv.slice(2));
const handler = COMMANDS[opts.command];
if (!handler) {
  console.error(`使い方: node scripts/news.mjs <${Object.keys(COMMANDS).join('|')}> ...（詳細はファイル先頭のコメントを参照）`);
  process.exit(1);
}
Promise.resolve()
  .then(() => handler(opts))
  .then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof UserError) {
        ng(error.message);
        process.exit(1);
      }
      console.error('想定外のエラーが発生しました:', error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
