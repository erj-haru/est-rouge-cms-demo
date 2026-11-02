/**
 * 記事 PR のマージ可否の判定（純粋な関数。GitHub や Git からの情報収集は publish-news.mjs が行う）
 *
 * content ラベルだけでは判断せず、変更範囲・PR の状態・CI・人の承認・コミット SHA をすべて確認する。
 */
import { CONTENT_LABEL } from './content-rules.mjs';

/** 公開に必要な CI のチェック（.github/workflows/ci.yml の集約ジョブ） */
export const REQUIRED_CHECKS = ['ci-required'];
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
export const BASE_BRANCH = 'main';
/** マージしてよい mergeStateStatus（BEHIND・BLOCKED・DIRTY・UNSTABLE・UNKNOWN などは不可） */
const MERGEABLE_STATES = ['CLEAN', 'HAS_HOOKS'];

/**
 * 指定コミットの CI 結果を判定する。
 * - GitHub Actions が実行し、かつ ci.yml のワークフロー実行に属するチェックだけを数える
 *   （別のワークフローで同名のジョブを作ってもごまかせないようにする）
 * - 同名のチェックが複数ある場合は最新のものを使う（再実行に対応）
 * @param {{ name: string, head_sha: string, status: string, conclusion: string|null, started_at?: string, id: number, app?: { slug?: string }, check_suite?: { id: number }, html_url?: string }[]} checkRuns
 * @param {{ check_suite_id: number, path: string, event: string }[]} workflowRuns
 * @returns {{ state: 'success'|'failure'|'pending'|'missing', checks: { name: string, state: string, conclusion?: string|null, url?: string }[] }}
 */
export function evaluateChecks(checkRuns, workflowRuns, headSha, required = REQUIRED_CHECKS) {
  const trustedSuites = new Set(
    workflowRuns.filter((r) => r.path === CI_WORKFLOW_PATH && r.event === 'pull_request').map((r) => r.check_suite_id),
  );
  const checks = required.map((name) => {
    const runs = checkRuns
      .filter((c) => c.name === name && c.head_sha === headSha && c.app?.slug === 'github-actions' && trustedSuites.has(c.check_suite?.id))
      .sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')) || b.id - a.id);
    const latest = runs[0];
    if (!latest) return { name, state: 'missing' };
    if (latest.status !== 'completed') return { name, state: 'pending', url: latest.html_url };
    return { name, state: latest.conclusion === 'success' ? 'success' : 'failure', conclusion: latest.conclusion, url: latest.html_url };
  });
  const state = checks.some((c) => c.state === 'failure')
    ? 'failure'
    : checks.every((c) => c.state === 'success')
      ? 'success'
      : checks.some((c) => c.state === 'pending')
        ? 'pending'
        : 'missing';
  return { state, checks };
}

/**
 * CI の完了を待つ。成功・失敗が確定するか、タイムアウトするまで繰り返し確認する。
 * CI がまだ登録されていない（missing）状態も、タイムアウトまでは待つ。
 * @param {() => Promise<ReturnType<typeof evaluateChecks>> | ReturnType<typeof evaluateChecks>} fetchStatus
 */
export async function waitForChecks(fetchStatus, { timeoutMs = 20 * 60_000, intervalMs = 15_000, sleep, now = Date.now, onPoll } = {}) {
  const started = now();
  for (;;) {
    const status = await fetchStatus();
    onPoll?.(status);
    if (status.state === 'success' || status.state === 'failure') return status;
    if (now() - started >= timeoutMs) return { ...status, state: 'timeout' };
    await sleep(intervalMs);
  }
}

/**
 * マージ条件をすべて評価する。
 * @param {object} f 収集した事実
 * @param {'review'|'pre-flip'|'pre-merge'} f.phase review: 確認用の表示 / pre-flip: 公開フラグ変更の前 / pre-merge: マージ直前
 * @returns {{ ok: boolean, conditions: { id: string, label: string, ok: boolean, detail?: string, required: boolean }[] }}
 */
export function evaluateMergeConditions(f) {
  const { phase, pr } = f;
  const c = [];
  const add = (id, label, ok, detail, required = true) => c.push({ id, label, ok: Boolean(ok), detail, required });

  add('label', `「${CONTENT_LABEL}」ラベルが付いている`, pr.labels.includes(CONTENT_LABEL));
  add('scope', '変更が許可された NEWS 記事・画像だけ', f.scope.ok, f.scope.ok ? `${f.scope.articles.length} 記事ファイル・${f.scope.images.length} 画像` : f.scope.violations.map((v) => `${v.path}: ${v.reason}`).join(' / '));
  add('api-files', 'GitHub 上の変更ファイルと手元の差分が一致', f.apiFilesMatch, f.apiFilesMatch ? undefined : f.apiFilesDetail);
  add('articles', '日英記事の共通ID・slug・公開状態が正しい', f.articleErrors.length === 0, f.articleErrors.join(' / ') || f.articleSummary);
  add('open', 'PR が Open', pr.state === 'OPEN', pr.state);
  add('base', `ベースブランチが ${BASE_BRANCH}`, pr.baseRefName === BASE_BRANCH, pr.baseRefName);
  add('not-draft-pr', 'Draft PR ではない', !pr.isDraft);
  add('same-repo', '同じリポジトリのブランチからの PR', !pr.isCrossRepository);
  add('sha', '確認したコミットと PR のコミットが一致', pr.headRefOid === f.expectedHeadSha, `PR: ${short(pr.headRefOid)} / 確認: ${short(f.expectedHeadSha)}`);
  if (phase !== 'review') {
    add('local', '手元のブランチ・コミットが PR と一致し、記事に未コミットの変更がない', f.localOk, f.localDetail);
  }
  if (phase === 'pre-merge' || f.flip) {
    add('flip', '確認後の変更が公開フラグ（draft: true → false）だけ', f.flip?.ok, f.flip?.reason ?? f.flip?.detail);
  }
  if (phase === 'pre-merge') {
    add('mergeable', 'マージ可能な状態', pr.mergeable === 'MERGEABLE' && MERGEABLE_STATES.includes(pr.mergeStateStatus), `${pr.mergeable} / ${pr.mergeStateStatus}`);
    add('ci', `CI（${REQUIRED_CHECKS.join(', ')}）が最新コミットで成功`, f.ci?.state === 'success', describeCi(f.ci));
  } else {
    add('ci', `CI（${REQUIRED_CHECKS.join(', ')}）の現在の状態`, f.ci?.state === 'success', describeCi(f.ci), false);
  }
  add('approval', '編集者から明示的な公開の指示がある', Boolean(f.approval?.trim()), f.approval ? `「${f.approval}」` : '公開の指示がありません', phase !== 'review');

  return { ok: c.every((x) => x.ok || !x.required), conditions: c };
}

function describeCi(ci) {
  if (!ci) return '未確認';
  const label = { success: '成功', failure: '失敗', pending: '実行中', missing: '未実行（CI が登録されていません）', timeout: 'タイムアウト' }[ci.state] ?? ci.state;
  const failed = ci.checks?.filter((x) => x.state !== 'success').map((x) => `${x.name}: ${x.conclusion ?? x.state}`) ?? [];
  return failed.length > 0 ? `${label}（${failed.join(', ')}）` : label;
}

const short = (sha) => (sha ? sha.slice(0, 7) : '-');
