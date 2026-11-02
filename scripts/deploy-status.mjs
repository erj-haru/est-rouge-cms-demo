#!/usr/bin/env node
/**
 * GitHub Pages へのデプロイ状況を確認する（読み取りのみ。何も変更しない）
 *
 *   node scripts/deploy-status.mjs [--sha <コミット>] [--slug <slug>] [--wait] [--timeout-min <分>]
 *
 * - --sha   確認するコミット（省略時は origin/main の最新）。/publish-news の MERGE_COMMIT を指定する
 * - --slug  指定すると、その記事の日英ページが公開サイトに表示されているかも確認する
 * - --wait  デプロイが終わるまで待つ（既定 10 分まで）
 *
 * 「PR のマージ」と「Web サイトへの反映（デプロイ）」は別の段階として表示する。
 * 終了コード: 0 = サイトに反映済み / 1 = 未反映・失敗・確認できない / 2 = 想定外のエラー
 */
import { findArticleGroup, LANG_LABEL } from './lib/articles.mjs';
import { getGitHubRepo, sleep } from './lib/common.mjs';
import { decodeEntities, gh, git, ng, ok, section, UserError, warn } from './lib/workflow.mjs';

const WORKFLOW = 'deploy.yml';

function parseArgs(argv) {
  const opts = { sha: '', slug: '', wait: false, timeoutMin: 10 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--sha') opts.sha = argv[++i] ?? '';
    else if (argv[i] === '--slug') opts.slug = argv[++i] ?? '';
    else if (argv[i] === '--wait') opts.wait = true;
    else if (argv[i] === '--timeout-min') opts.timeoutMin = Number(argv[++i]);
    else throw new UserError(`不明な引数です: ${argv[i]}`);
  }
  return opts;
}

function ghJson(args) {
  const res = gh(args);
  return res.ok && res.stdout ? JSON.parse(res.stdout) : null;
}

/** そのコミットに対する Deploy ワークフローの最新の実行 */
function latestRun(repo, sha) {
  const runs = ghJson(['api', `repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&per_page=20`, '--jq', '.workflow_runs']);
  return runs?.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] ?? null;
}

const RUN_LABEL = { queued: '待機中', waiting: '承認待ち', pending: '待機中', requested: '待機中', in_progress: '実行中' };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = getGitHubRepo();
  if (!repo) throw new UserError('origin に GitHub のリポジトリが設定されていません');
  git(['fetch', '--quiet', 'origin', 'main']);
  const sha = opts.sha ? git(['rev-parse', '--verify', `${opts.sha}^{commit}`]).stdout : git(['rev-parse', 'origin/main']).stdout;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new UserError(`コミット「${opts.sha}」が見つかりません`);
  const siteUrl = ghJson(['api', `repos/${repo}/pages`, '--jq', '{html_url}'])?.html_url;

  section('1. PR のマージ（main への取り込み）');
  const onMain = git(['merge-base', '--is-ancestor', sha, 'origin/main']).ok;
  if (!onMain) {
    ng(`コミット ${sha.slice(0, 7)} はまだ main に取り込まれていません（マージ前のため、デプロイもされません）`);
    return 1;
  }
  ok(`コミット ${sha.slice(0, 7)} は main に取り込まれています`);

  section('2. GitHub Pages へのデプロイ');
  const started = Date.now();
  let run = latestRun(repo, sha);
  while (opts.wait && (!run || run.status !== 'completed') && Date.now() - started < opts.timeoutMin * 60_000) {
    process.stdout.write('.');
    await sleep(15_000);
    run = latestRun(repo, sha);
  }
  if (opts.wait) console.log('');
  if (!run) {
    warn('このコミットのデプロイはまだ始まっていません（main への Push から数十秒かかることがあります）');
    return 1;
  }
  if (run.status !== 'completed') {
    warn(`デプロイは${RUN_LABEL[run.status] ?? run.status}です: ${run.html_url}`);
    return 1;
  }
  if (run.conclusion !== 'success') {
    ng(`デプロイが失敗しました（${run.conclusion}）。記事は main に取り込まれていますが、Web サイトには反映されていません`);
    console.log(`   詳細: ${run.html_url}`);
    console.log('   担当者に連絡するか、Actions の画面から「Re-run jobs」で再実行してください');
    return 1;
  }
  ok(`デプロイが完了しました: ${run.html_url}`);

  if (!siteUrl) {
    warn('GitHub Pages の公開 URL を取得できませんでした');
    return 1;
  }
  section('3. 公開サイトでの表示');
  const targets = opts.slug ? findArticleGroup(opts.slug).map((a) => ({ label: `${LANG_LABEL[a.data.lang]}版「${a.data.title}」`, path: `${a.data.lang}/news/${a.data.slug}/`, title: a.data.title })) : [];
  if (opts.slug && targets.length === 0) warn(`slug「${opts.slug}」の記事が手元に見つからないため、一覧ページだけを確認します`);
  if (targets.length === 0) targets.push({ label: 'NEWS 一覧（日本語）', path: 'ja/news/' });
  let allShown = true;
  for (const t of targets) {
    const url = new URL(t.path, siteUrl).href;
    let shown = false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      shown = res.ok && (!t.title || decodeEntities(await res.text()).includes(t.title));
    } catch {
      shown = false;
    }
    (shown ? ok : ng)(`${t.label}: ${url}`);
    allShown &&= shown;
  }
  if (!allShown) console.log('   デプロイ直後は反映まで数分かかることがあります。少し待ってからもう一度確認してください');
  console.log(`\nSITE_URL=${siteUrl}`);
  return allShown ? 0 : 1;
}

main().then(
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
