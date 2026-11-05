/**
 * 編集者向けスクリプト（news.mjs・publish-news.mjs）が使う Git / GitHub / プレビューの操作
 */
import { utimesSync } from 'node:fs';
import { join } from 'node:path';
import { getGitHubRepo, probe, ROOT, run, sleep } from './common.mjs';

/** 利用者の対応が必要なエラー（終了コード 1 で、内容をそのまま表示する） */
export class UserError extends Error {}

export const ok = (msg) => console.log(`✅ ${msg}`);
export const warn = (msg) => console.log(`⚠️  ${msg}`);
export const ng = (msg) => console.log(`❌ ${msg}`);
export const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 40 - title.length * 2))}`);

export function git(args, options) {
  return run('git', args, options);
}

/** 作業ツリーとインデックスで変更・追加・削除されたファイルのパス（未追跡を含む）。pathspec で絞り込める */
export function changedPaths(pathspec = []) {
  const opts = ['-c', 'core.quotePath=false'];
  const spec = pathspec.length > 0 ? ['--', ...pathspec] : [];
  const lists = [
    git([...opts, 'ls-files', '--modified', '--deleted', '--others', '--exclude-standard', ...spec]).stdout,
    git([...opts, 'diff', '--cached', '--name-only', ...spec]).stdout,
  ];
  return [...new Set(lists.join('\n').split('\n').filter(Boolean))].sort();
}

export function mustGit(args, message) {
  const res = git(args);
  if (!res.ok) throw new UserError(`${message}\n   ${res.stderr.split('\n').slice(0, 3).join('\n   ')}`);
  return res.stdout;
}

export function gh(args, options = {}) {
  return run('gh', args, { timeout: 60_000, ...options });
}

export function requireGitHub() {
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

export function findPullRequests(branch, state = 'all') {
  const res = gh(['pr', 'list', '--head', branch, '--state', state, '--json', 'number,url,state,headRefOid,title', '--limit', '10']);
  return res.ok && res.stdout ? JSON.parse(res.stdout) : [];
}

export function remoteBranchSha(branch) {
  const res = git(['ls-remote', '--heads', 'origin', branch], { timeout: 60_000 });
  return res.ok && res.stdout ? res.stdout.split(/\s+/)[0] : null;
}

/** git のコミット作成者が設定されているか、GitHub アカウントと対応しているかを確認する */
export function checkIdentity(login) {
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

export function ensurePreview(slug) {
  const args = ['scripts/setup-editor.mjs', '--preview', ...(slug ? ['--slug', slug] : [])];
  const res = run(process.execPath, args, { timeout: 10 * 60_000 });
  if (!res.ok) {
    console.log(res.stdout.split('\n').filter((l) => /❌|^\s{3}/.test(l)).join('\n'));
    throw new UserError('プレビューを表示できませんでした。上記の対応後にもう一度実行してください');
  }
}

/**
 * プレビューに記事のタイトルが表示されているか確認する。
 * ビルドやコミット直後は開発サーバーが再読み込み中のことがあり、短時間に続けて保存すると
 * ファイル変更の通知を取りこぼすこともあるため、更新日時を変えて再読み込みさせてから再確認する
 */
export async function previewShows(article) {
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

export function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'" })[m]);
}

export function firstLine(text) {
  return text.split(/\r?\n/).find((l) => l.trim()) ?? '';
}
