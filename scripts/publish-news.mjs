#!/usr/bin/env node
/**
 * NEWS 記事の公開（/publish-news から利用する）
 *
 *   node scripts/publish-news.mjs status (--pr <番号> | --slug <slug>)
 *       公開前の確認。PR の状態・変更範囲・日英記事・CI を表示し、編集者が確認するコミット（REVIEWED_SHA）を出力する
 *
 *   node scripts/publish-news.mjs publish --pr <番号> --reviewed-sha <sha> --approval "<編集者の公開指示>" [--dry-run]
 *       1. マージ条件を検証（確認したコミットと PR が一致しているか等）
 *       2. draft: true → false に変更して PR に Push（CI が再実行される）
 *       3. 最新コミットで CI が成功するのを待つ（失敗・タイムアウトなら停止）
 *       4. マージ直前に PR の状態・差分・コミット SHA を再検証
 *       5. gh pr merge --merge --match-head-commit <sha> でマージ（--admin は使わない）
 *
 * 安全のための約束:
 * - 1 回の実行で扱う PR は 1 つだけ。コード変更 PR（記事・画像以外を含む PR）はマージしない
 * - main へ直接 Push しない。force push・reset などの破壊的な操作をしない
 * - 記事に未コミットの変更があれば停止する（ほかのファイルの未コミット変更には触れない）
 * - 条件を 1 つでも満たさなければ、理由を表示して停止する
 *
 * 終了コード: 0 = 成功（dry-run では条件をすべて満たす）/ 1 = 条件を満たさない・利用者の対応が必要 / 2 = 想定外のエラー
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageRefs, LANG_LABEL, readArticle } from './lib/articles.mjs';
import { LOCALES, PREVIEW_URL, ROOT, sleep } from './lib/common.mjs';
import { ARTICLE_PATH, checkContentScope, contentViolation, isDraftFlipOnly, parseRawDiff, setDraftFalse } from './lib/content-rules.mjs';
import { BASE_BRANCH, evaluateChecks, evaluateMergeConditions, waitForChecks } from './lib/merge-guard.mjs';
import { changedPaths, ensurePreview, gh, git, mustGit, ng, ok, previewShows, requireGitHub, section, UserError, warn } from './lib/workflow.mjs';

const TOOLING_PATHS = ['scripts', '.github', '.claude/skills'];

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command = '', ...rest] = argv;
  const opts = { command, pr: 0, slug: '', reviewedSha: '', approval: '', dryRun: false, devTooling: false, ciTimeoutMin: 20 };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--pr') {
      if (opts.pr) throw new UserError('1 回の実行で扱える PR は 1 つだけです');
      opts.pr = Number(rest[++i]);
    }
    else if (arg === '--slug') opts.slug = rest[++i] ?? '';
    else if (arg === '--reviewed-sha') opts.reviewedSha = (rest[++i] ?? '').toLowerCase();
    else if (arg === '--approval') opts.approval = rest[++i] ?? '';
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--dev-tooling') opts.devTooling = true;
    else if (arg === '--ci-timeout-min') opts.ciTimeoutMin = Number(rest[++i]);
    else throw new UserError(`不明な引数です: ${arg}（1 回の実行で扱える PR は 1 つだけです）`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// 事実の収集
// ---------------------------------------------------------------------------

/** コミット時点のファイルの内容（末尾の改行を含めてそのまま）を返す */
function showFile(sha, path) {
  const res = git(['show', `${sha}:${path}`], { encoding: 'buffer' });
  if (!res.ok) throw new UserError(`${path} を読み込めませんでした`);
  return res.stdout.toString('utf8');
}

function ghJson(args) {
  const res = gh(args);
  if (!res.ok) throw new UserError(`GitHub から情報を取得できませんでした: ${res.stderr.split('\n')[0]}`);
  return JSON.parse(res.stdout || 'null');
}

function getPr(repo, number) {
  return ghJson([
    'pr', 'view', String(number), '--repo', repo, '--json',
    'number,url,title,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,labels,isCrossRepository,author',
  ]);
}

/** GitHub API 上の PR の変更ファイル（status・旧ファイル名を含む） */
function getApiFiles(repo, number) {
  const res = gh(['api', '--paginate', `repos/${repo}/pulls/${number}/files?per_page=100`, '--jq', '.[] | [.status, .filename, (.previous_filename // "")] | @tsv']);
  if (!res.ok) throw new UserError(`PR #${number} の変更ファイルを取得できませんでした`);
  return res.stdout.split('\n').filter(Boolean).map((l) => {
    const [status, filename, previous] = l.split('\t');
    return { status, filename, previous };
  });
}

function getCiStatus(repo, sha) {
  const runs = gh(['api', '--paginate', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs[]']);
  const workflows = gh(['api', '--paginate', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, '--jq', '.workflow_runs[] | {check_suite_id, path, event}']);
  if (!runs.ok || !workflows.ok) return { state: 'missing', checks: [] };
  const parseLines = (text) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return evaluateChecks(parseLines(runs.stdout), parseLines(workflows.stdout), sha);
}

/** PR の head コミットを手元に取得する（ブランチが更新されていても PR の SHA を正しく扱う） */
function fetchPr(number, sha) {
  mustGit(['fetch', '--quiet', 'origin', BASE_BRANCH, `+refs/pull/${number}/head:refs/remotes/origin/pr/${number}`], 'GitHub から PR を取得できませんでした');
  if (!git(['cat-file', '-e', `${sha}^{commit}`]).ok) throw new UserError(`コミット ${sha} を取得できませんでした`);
}

/** 変更範囲（パス・種類・ファイルモード・中身）を Git のデータから判定する */
function inspectScope(headSha) {
  const raw = git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', `origin/${BASE_BRANCH}...${headSha}`], { timeout: 60_000 });
  if (!raw.ok) throw new UserError('差分を取得できませんでした');
  // run() は出力を trim するため、-z 出力の終端を補う
  const entries = parseRawDiff(`${raw.stdout}\0`);
  const scope = checkContentScope(entries);
  for (const path of [...scope.articles, ...scope.images]) {
    const blob = git(['cat-file', 'blob', `${headSha}:${path}`], { encoding: 'buffer' });
    const reason = contentViolation(path, Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.from(blob.stdout));
    if (reason) {
      scope.violations.push({ path, reason });
      scope.ok = false;
    }
  }
  return { entries, scope };
}

function compareApiFiles(entries, apiFiles) {
  const expected = { A: 'added', M: 'modified', D: 'removed' };
  const local = entries.map((e) => `${expected[e.status] ?? e.status}:${e.path}`).sort();
  // GitHub 側のリネームは「削除＋追加」に読み替えて比較する
  const remote = apiFiles.flatMap((f) => (f.status === 'renamed' ? [`removed:${f.previous}`, `added:${f.filename}`] : [`${f.status}:${f.filename}`])).sort();
  const same = local.length === remote.length && local.every((x, i) => x === remote[i]);
  return { ok: same, detail: same ? undefined : `手元: ${local.join(', ')} / GitHub: ${remote.join(', ')}` };
}

/** PR のコミット時点の日英記事を Git から読み、整合性を確認する */
function inspectArticles(headSha, scope) {
  const errors = [];
  const changed = scope.articles.map((path) => readArticle(path, git(['show', `${headSha}:${path}`]).stdout));
  const ids = [...new Set(changed.map((a) => a.data.articleId))];
  if (ids.length !== 1) {
    errors.push(ids.length === 0 ? '対象の記事がありません' : `複数の記事（共通記事ID: ${ids.join(', ')}）が含まれています。1 つの PR で公開できる記事は 1 つです`);
    return { errors, group: changed, summary: '' };
  }
  const all = git(['ls-tree', '-r', '--name-only', headSha, '--', 'src/content/news']).stdout.split('\n').filter((p) => ARTICLE_PATH.test(p));
  const group = all.map((path) => readArticle(path, git(['show', `${headSha}:${path}`]).stdout)).filter((a) => a.data.articleId === ids[0]);

  for (const lang of LOCALES) {
    const items = group.filter((a) => a.data.lang === lang);
    if (items.length !== 1) errors.push(`${LANG_LABEL[lang]}版が${items.length === 0 ? 'ありません' : ` ${items.length} 件あります`}`);
  }
  const values = (key) => [...new Set(group.map((a) => String(a.data[key] ?? (key === 'draft' ? 'false' : ''))))];
  if (values('slug').length !== 1) errors.push(`slug が日英で異なります（${values('slug').join(' / ')}）`);
  if (values('draft').length !== 1) errors.push(`公開状態（draft）が日英で異なります（${values('draft').join(' / ')}）`);
  for (const a of group) if (a.data.lang !== a.folder) errors.push(`${a.file}: lang と配置フォルダが一致しません`);

  // 追加・変更された画像は、この記事から参照されているものだけ
  const referenced = new Set(group.flatMap((a) => imageRefs(a).map((r) => r.path)));
  for (const image of scope.images) if (!referenced.has(image)) errors.push(`${image} はこの記事から参照されていません`);

  const draft = values('draft')[0] === 'true';
  const summary = `共通記事ID ${ids[0]} / slug ${values('slug').join(',')} / ${draft ? '下書き（公開時に draft: false に変更）' : '公開済み（draft: false）'}`;
  return { errors, group, summary, draft, articleId: ids[0], slug: values('slug')[0] };
}

/** 手元の作業ツリーがプレビューと PR を一致させているか（記事ファイルに未コミット変更がないか） */
function inspectLocal(pr, group) {
  const branch = git(['branch', '--show-current']).stdout;
  const head = git(['rev-parse', 'HEAD']).stdout;
  // pathspec が空だと全ファイルが対象になるため、記事がない場合は確認しない
  const dirty = group.length > 0 ? changedPaths(group.map((a) => a.file)) : [];
  const problems = [];
  if (branch !== pr.headRefName) problems.push(`手元のブランチが ${branch || 'detached'} です（PR は ${pr.headRefName}）`);
  if (head !== pr.headRefOid) problems.push(`手元のコミット ${head.slice(0, 7)} が PR の ${pr.headRefOid.slice(0, 7)} と異なります`);
  if (dirty.length > 0) problems.push(`記事ファイルに未コミットの変更があります: ${dirty.join(', ')}`);
  return { ok: problems.length === 0, detail: problems.join(' / ') || `${branch} @ ${head.slice(0, 7)}` };
}

async function collectFacts(repo, number, { phase, expectedHeadSha, approval, flipFrom }) {
  const pr = getPr(repo, number);
  pr.labels = pr.labels.map((l) => l.name);
  fetchPr(number, pr.headRefOid);
  const { entries, scope } = inspectScope(pr.headRefOid);
  const api = compareApiFiles(entries, getApiFiles(repo, number));
  const articles = scope.articles.length > 0 ? inspectArticles(pr.headRefOid, scope) : { errors: ['記事ファイルの変更がありません'], group: [] };
  const local = phase === 'review' ? { ok: true } : inspectLocal(pr, articles.group);
  let flip;
  if (flipFrom) {
    const parent = git(['rev-parse', `${pr.headRefOid}^`]).stdout;
    const diff = git(['diff', '--unified=0', '--no-ext-diff', flipFrom, pr.headRefOid]).stdout;
    flip = flipFrom === pr.headRefOid
      ? { ok: true, detail: '公開フラグの変更なし（既に公開状態）' }
      : parent !== flipFrom
        ? { ok: false, reason: `確認したコミット ${flipFrom.slice(0, 7)} の後に、公開フラグ以外のコミットが追加されています` }
        : isDraftFlipOnly(diff);
  }
  const ci = getCiStatus(repo, pr.headRefOid);
  const evaluation = evaluateMergeConditions({
    phase,
    pr,
    scope,
    apiFilesMatch: api.ok,
    apiFilesDetail: api.detail,
    articleErrors: articles.errors,
    articleSummary: articles.summary,
    expectedHeadSha,
    localOk: local.ok,
    localDetail: local.detail,
    flip,
    ci,
    approval,
  });
  return { pr, scope, articles, ci, evaluation };
}

function printConditions({ conditions }) {
  for (const c of conditions) {
    const icon = c.ok ? '✅' : c.required ? '❌' : '⚠️ ';
    console.log(`${icon} ${c.label}${c.detail ? `: ${c.detail}` : ''}`);
  }
}

function explainFailure({ conditions }) {
  const failed = conditions.filter((c) => c.required && !c.ok);
  console.log('\n公開を中止しました。次の条件を満たしていません:');
  for (const c of failed) console.log(`   - ${c.label}${c.detail ? `（${c.detail}）` : ''}`);
  if (failed.some((c) => c.id === 'sha' || c.id === 'flip')) {
    console.log('   記事の内容が確認後に変わっています。/preview で最新の内容を確認し直してから、もう一度公開を指示してください。');
  }
  if (failed.some((c) => c.id === 'scope' || c.id === 'label')) {
    console.log('   記事 PR ではないため、この Skill では公開できません。リポジトリの担当者にレビューとマージを依頼してください。');
  }
}

/** 実行中のスクリプトが main と同じであること（PR や手元で改変された公開処理では公開しない） */
function checkTooling(opts) {
  const differs = git(['diff', '--name-only', `origin/${BASE_BRANCH}`, '--', ...TOOLING_PATHS]).stdout.split('\n').filter(Boolean);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...TOOLING_PATHS]).stdout.split('\n').filter(Boolean);
  const changed = [...differs, ...untracked];
  if (changed.length === 0) return ok(`公開処理のスクリプトが ${BASE_BRANCH} と一致しています`);
  if (opts.devTooling && opts.dryRun) return warn(`開発中のスクリプトで dry-run しています（${BASE_BRANCH} と異なるファイル ${changed.length} 件）`);
  throw new UserError(`公開処理のスクリプトが ${BASE_BRANCH} と異なるため、公開できません: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' ほか' : ''}`);
}

// ---------------------------------------------------------------------------
// サブコマンド
// ---------------------------------------------------------------------------

async function cmdStatus(opts) {
  const { repo, login, permission } = requireGitHub();
  let number = opts.pr;
  if (!number) {
    if (!opts.slug) throw new UserError('--pr または --slug を指定してください');
    const prs = ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--label', 'content', '--json', 'number,files', '--limit', '50'])
      .filter((p) => p.files.some((f) => ARTICLE_PATH.test(f.path) && f.path.endsWith(`-${opts.slug}.md`)));
    if (prs.length !== 1) throw new UserError(prs.length === 0 ? `slug「${opts.slug}」の進行中の記事 PR が見つかりません` : `slug「${opts.slug}」の PR が複数あります（${prs.map((p) => `#${p.number}`).join(', ')}）。PR 番号で指定してください`);
    number = prs[0].number;
  }
  section('公開前の確認');
  ok(`GitHub アカウント: ${login}（権限: ${permission}）`);
  const facts = await collectFacts(repo, number, { phase: 'review', expectedHeadSha: undefined });
  facts.evaluation.conditions = facts.evaluation.conditions.filter((c) => c.id !== 'sha');
  console.log(`PR #${facts.pr.number}: ${facts.pr.title}\n${facts.pr.url}\n`);
  printConditions(facts.evaluation);

  section('記事');
  for (const a of facts.articles.group) {
    console.log(`- ${LANG_LABEL[a.data.lang]}: ${a.data.title}（${a.file}）`);
  }
  const local = inspectLocal(facts.pr, facts.articles.group);
  if (local.ok) {
    ensurePreview(facts.articles.slug);
    for (const a of facts.articles.group) {
      (await previewShows(a)) ? ok(`プレビュー（PR のコミットと同じ内容）: ${PREVIEW_URL}/${a.data.lang}/news/${a.data.slug}/`) : ng(`プレビューに${LANG_LABEL[a.data.lang]}版が表示されません`);
    }
  } else {
    warn(`手元の作業ツリーが PR と一致しないため、プレビューは PR の内容ではありません（${local.detail}）`);
    console.log(`   \`node scripts/news.mjs start --slug ${facts.articles.slug ?? '<slug>'}\` で PR のブランチに切り替えてから確認してください`);
  }
  console.log(`\nPR_NUMBER=${facts.pr.number}\nREVIEWED_SHA=${facts.pr.headRefOid}`);
  const blocking = facts.evaluation.conditions.filter((c) => c.required && !c.ok);
  return blocking.length === 0 && local.ok ? 0 : 1;
}

async function cmdPublish(opts) {
  if (!opts.pr) throw new UserError('--pr に PR 番号を 1 つ指定してください');
  if (!/^[0-9a-f]{40}$/.test(opts.reviewedSha)) throw new UserError('--reviewed-sha に、編集者が確認したコミット（status の REVIEWED_SHA）を指定してください');
  const { repo, login, canWrite, permission } = requireGitHub();
  if (!canWrite) throw new UserError(`${repo} への書き込み権限がありません（現在: ${permission}）`);

  section(opts.dryRun ? '公開条件の検証（dry-run: 変更・Push・マージはしません）' : '公開条件の検証');
  ok(`GitHub アカウント: ${login}（権限: ${permission}）`);
  mustGit(['fetch', '--quiet', 'origin', BASE_BRANCH], 'GitHub から最新の状態を取得できませんでした');
  checkTooling(opts);
  // 前回の実行で公開フラグの変更だけを Push 済み（CI 待ちで中断した等）なら、その続きから再開する
  let expectedHeadSha = opts.reviewedSha;
  const currentHead = getPr(repo, opts.pr).headRefOid;
  if (currentHead !== opts.reviewedSha) {
    fetchPr(opts.pr, currentHead);
    const parent = git(['rev-parse', `${currentHead}^`]).stdout;
    const flipOnly = isDraftFlipOnly(git(['diff', '--unified=0', '--no-ext-diff', opts.reviewedSha, currentHead]).stdout).ok;
    if (parent === opts.reviewedSha && flipOnly) {
      expectedHeadSha = currentHead;
      ok(`公開フラグの変更（${currentHead.slice(0, 7)}）は Push 済みのため、CI の確認から再開します`);
    }
  }
  const pre = await collectFacts(repo, opts.pr, { phase: 'pre-flip', expectedHeadSha, approval: opts.approval, flipFrom: expectedHeadSha === opts.reviewedSha ? undefined : opts.reviewedSha });
  console.log(`PR #${pre.pr.number}: ${pre.pr.title}`);
  printConditions(pre.evaluation);
  if (!pre.evaluation.ok) {
    explainFailure(pre.evaluation);
    return 1;
  }

  // 公開フラグの変更（draft: true → false）
  const targets = pre.articles.group.filter((a) => a.data.draft === 'true');
  section('公開フラグの変更');
  if (targets.length === 0) ok('既に公開状態（draft: false）のため、変更はありません');
  for (const a of targets) console.log(`- ${a.file}: draft: true → false`);

  if (opts.dryRun) {
    for (const a of targets) setDraftFalse(showFile(pre.pr.headRefOid, a.file)); // 変更できることだけ確認する
    section('この後の処理（dry-run のため実行しません）');
    console.log(`1. 公開フラグの変更をコミットし、${pre.pr.headRefName} に Push（CI が再実行されます）`);
    console.log(`2. 新しいコミットで CI（ci-required）が成功するまで最大 ${opts.ciTimeoutMin} 分待つ`);
    console.log('3. マージ直前に PR の状態・差分・コミット SHA を再検証');
    console.log(`4. gh pr merge ${pre.pr.number} --merge --match-head-commit <新しいコミット>`);
    console.log('\nDRY_RUN=ok');
    return 0;
  }

  let expectedHead = pre.pr.headRefOid;
  if (targets.length > 0) {
    const files = targets.map((a) => a.file);
    for (const a of targets) writeFileSync(join(ROOT, a.file), setDraftFalse(showFile(pre.pr.headRefOid, a.file)));
    mustGit(['add', '--', ...files], '公開フラグの変更をコミット対象にできませんでした');
    // コミット前に、変更が公開フラグだけであることを確認する（違えば自分が書き換えたファイルだけを元に戻して中止）
    const staged = git(['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean);
    const stagedFlip = isDraftFlipOnly(git(['diff', '--cached', '--unified=0', '--no-ext-diff']).stdout);
    if (staged.some((f) => !files.includes(f)) || !stagedFlip.ok) {
      git(['restore', '--staged', '--worktree', '--', ...files]);
      throw new UserError(`公開フラグ以外の変更が含まれるため中止しました: ${stagedFlip.reason ?? 'ほかのファイルがコミット対象になっています'}`);
    }
    mustGit(['commit', '-m', `news: publish ${pre.articles.slug}`, '-m', `公開承認: ${login}\n確認したコミット: ${opts.reviewedSha}`], 'コミットできませんでした');
    expectedHead = git(['rev-parse', 'HEAD']).stdout;
    const flip = isDraftFlipOnly(git(['diff', '--unified=0', '--no-ext-diff', opts.reviewedSha, expectedHead]).stdout);
    if (!flip.ok) throw new UserError(`公開フラグの変更以外が含まれています（Push はしていません）: ${flip.reason}`);
    const push = git(['push', 'origin', `HEAD:refs/heads/${pre.pr.headRefName}`], { timeout: 120_000 });
    if (!push.ok) {
      ng('Push が拒否されました。確認後に PR が更新された可能性があります。内容を確認し直してください');
      return 1;
    }
    ok(`公開フラグの変更を Push しました: ${expectedHead.slice(0, 7)}`);
  }

  // CI（公開フラグだけの変更でも再実行される）
  section('CI の確認');
  const ci = await waitForChecks(() => getCiStatus(repo, expectedHead), {
    timeoutMs: opts.ciTimeoutMin * 60_000,
    sleep,
    onPoll: (s) => process.stdout.write(s.state === 'success' || s.state === 'failure' ? '' : '.'),
  });
  console.log('');
  if (ci.state !== 'success') {
    ng(`CI が成功しませんでした（${ci.state}）。マージしません`);
    for (const c of ci.checks) if (c.url) console.log(`   ${c.name}: ${c.url}`);
    console.log('   公開フラグの変更は PR に残っています（マージされていないため公開はされていません）');
    return 1;
  }
  ok(`CI が成功しました（${expectedHead.slice(0, 7)}）`);

  // マージ直前の再検証
  section('マージ直前の再検証');
  const final = await collectFacts(repo, opts.pr, { phase: 'pre-merge', expectedHeadSha: expectedHead, approval: opts.approval, flipFrom: opts.reviewedSha });
  printConditions(final.evaluation);
  if (!final.evaluation.ok) {
    explainFailure(final.evaluation);
    return 1;
  }

  gh(['pr', 'comment', String(opts.pr), '--repo', repo, '--body', `## 公開承認\n\n- 承認者: @${login}\n- 公開の指示: 「${opts.approval}」\n- 確認したコミット: ${opts.reviewedSha}\n- マージするコミット: ${expectedHead}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`]);
  const merge = gh(['pr', 'merge', String(opts.pr), '--repo', repo, '--merge', '--match-head-commit', expectedHead]);
  if (!merge.ok) {
    ng(`マージできませんでした: ${merge.stderr.split('\n')[0]}`);
    return 1;
  }
  const merged = ghJson(['pr', 'view', String(opts.pr), '--repo', repo, '--json', 'state,mergeCommit,url']);
  if (merged.state !== 'MERGED') {
    ng(`PR の状態が ${merged.state} です。GitHub で確認してください`);
    return 1;
  }
  ok(`PR #${opts.pr} をマージしました（${merged.mergeCommit.oid.slice(0, 7)}）`);
  console.log(`\nPR_URL=${merged.url}\nMERGE_COMMIT=${merged.mergeCommit.oid}`);
  return 0;
}

// ---------------------------------------------------------------------------

const COMMANDS = { status: cmdStatus, publish: cmdPublish };
Promise.resolve()
  .then(() => {
    const opts = parseArgs(process.argv.slice(2));
    const handler = COMMANDS[opts.command];
    if (!handler) throw new UserError('使い方: node scripts/publish-news.mjs <status|publish> ...（詳細はファイル先頭のコメントを参照）');
    return handler(opts);
  })
  .then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof UserError) {
        ng(error.message);
        process.exit(1);
      }
      console.error('想定外のエラーが発生しました:', error instanceof Error ? error.stack : error);
      process.exit(2);
    },
  );
