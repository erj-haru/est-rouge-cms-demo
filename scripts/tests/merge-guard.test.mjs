import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateChecks, evaluateMergeConditions, waitForChecks } from '../lib/merge-guard.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const workflowRuns = [{ check_suite_id: 1, path: '.github/workflows/ci.yml', event: 'pull_request' }];
const run = (over = {}) => ({ id: 1, name: 'ci-required', head_sha: SHA, status: 'completed', conclusion: 'success', started_at: '2026-11-02T00:00:00Z', app: { slug: 'github-actions' }, check_suite: { id: 1 }, ...over });

describe('evaluateChecks', () => {
  it('最新コミットで成功', () => assert.equal(evaluateChecks([run()], workflowRuns, SHA).state, 'success'));
  it('失敗', () => assert.equal(evaluateChecks([run({ conclusion: 'failure' })], workflowRuns, SHA).state, 'failure'));
  it('キャンセル・タイムアウトも失敗扱い', () => {
    assert.equal(evaluateChecks([run({ conclusion: 'cancelled' })], workflowRuns, SHA).state, 'failure');
    assert.equal(evaluateChecks([run({ conclusion: 'timed_out' })], workflowRuns, SHA).state, 'failure');
  });
  it('実行中', () => assert.equal(evaluateChecks([run({ status: 'in_progress', conclusion: null })], workflowRuns, SHA).state, 'pending'));
  it('未実行', () => assert.equal(evaluateChecks([], workflowRuns, SHA).state, 'missing'));
  it('古いコミットの成功は数えない', () => assert.equal(evaluateChecks([run({ head_sha: OTHER })], workflowRuns, SHA).state, 'missing'));
  it('別のワークフローの同名ジョブは数えない', () => {
    const spoofed = [{ check_suite_id: 2, path: '.github/workflows/evil.yml', event: 'pull_request' }];
    assert.equal(evaluateChecks([run({ check_suite: { id: 2 } })], spoofed, SHA).state, 'missing');
  });
  it('GitHub Actions 以外のアプリのチェックは数えない', () => assert.equal(evaluateChecks([run({ app: { slug: 'other-app' } })], workflowRuns, SHA).state, 'missing'));
  it('再実行では最新の結果を使う', () => {
    const runs = [run({ id: 1, conclusion: 'failure', started_at: '2026-11-02T00:00:00Z' }), run({ id: 2, started_at: '2026-11-02T00:10:00Z' })];
    assert.equal(evaluateChecks(runs, workflowRuns, SHA).state, 'success');
  });
});

describe('waitForChecks', () => {
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms) => void (t += ms) };
  };
  it('公開フラグ変更後、CI が登録・実行・成功するまで待つ', async () => {
    const states = ['missing', 'pending', 'pending', 'success'];
    const c = clock();
    const result = await waitForChecks(() => ({ state: states.shift(), checks: [] }), { ...c, intervalMs: 15_000, timeoutMs: 60_000 });
    assert.equal(result.state, 'success');
  });
  it('失敗したらすぐ止まる', async () => {
    const result = await waitForChecks(() => ({ state: 'failure', checks: [] }), { ...clock() });
    assert.equal(result.state, 'failure');
  });
  it('終わらなければタイムアウト', async () => {
    const result = await waitForChecks(() => ({ state: 'pending', checks: [] }), { ...clock(), intervalMs: 15_000, timeoutMs: 60_000 });
    assert.equal(result.state, 'timeout');
  });
});

describe('evaluateMergeConditions', () => {
  const base = () => ({
    phase: 'pre-merge',
    pr: { labels: ['content'], state: 'OPEN', baseRefName: 'main', isDraft: false, isCrossRepository: false, headRefOid: SHA, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    scope: { ok: true, violations: [], articles: ['a', 'b'], images: [] },
    apiFilesMatch: true,
    articleErrors: [],
    expectedHeadSha: SHA,
    localOk: true,
    flip: { ok: true },
    ci: { state: 'success', checks: [] },
    approval: '確認したので公開して',
  });
  const failedIds = (f) => evaluateMergeConditions(f).conditions.filter((c) => c.required && !c.ok).map((c) => c.id);

  it('すべての条件を満たせばマージ可能', () => assert.equal(evaluateMergeConditions(base()).ok, true));

  const cases = {
    label: (f) => (f.pr.labels = []),
    scope: (f) => (f.scope = { ok: false, violations: [{ path: 'scripts/x.mjs', reason: 'x' }], articles: [], images: [] }),
    'api-files': (f) => (f.apiFilesMatch = false),
    articles: (f) => (f.articleErrors = ['英語版がありません']),
    open: (f) => (f.pr.state = 'CLOSED'),
    base: (f) => (f.pr.baseRefName = 'develop'),
    'not-draft-pr': (f) => (f.pr.isDraft = true),
    'same-repo': (f) => (f.pr.isCrossRepository = true),
    sha: (f) => (f.pr.headRefOid = OTHER),
    local: (f) => (f.localOk = false),
    flip: (f) => (f.flip = { ok: false, reason: '本文が変更されています' }),
    mergeable: (f) => (f.pr.mergeStateStatus = 'BLOCKED'),
    ci: (f) => (f.ci = { state: 'failure', checks: [] }),
    approval: (f) => (f.approval = ''),
  };
  for (const [id, mutate] of Object.entries(cases)) {
    it(`条件「${id}」を満たさなければマージしない`, () => {
      const f = base();
      mutate(f);
      assert.equal(evaluateMergeConditions(f).ok, false);
      assert.deepEqual(failedIds(f), [id]);
    });
  }
  it('CI 実行中・タイムアウトはマージしない', () => {
    for (const state of ['pending', 'missing', 'timeout']) {
      const f = base();
      f.ci = { state, checks: [] };
      assert.deepEqual(failedIds(f), ['ci']);
    }
  });
  it('コンフリクト・ベースより遅れ・不明な状態はマージしない', () => {
    for (const [mergeable, status] of [['CONFLICTING', 'DIRTY'], ['MERGEABLE', 'BEHIND'], ['UNKNOWN', 'UNKNOWN'], ['MERGEABLE', 'UNSTABLE']]) {
      const f = base();
      Object.assign(f.pr, { mergeable, mergeStateStatus: status });
      assert.deepEqual(failedIds(f), ['mergeable']);
    }
  });
  it('公開フラグ変更前は CI を参考表示にとどめる（変更後に再実行されるため）', () => {
    const f = base();
    f.phase = 'pre-flip';
    f.ci = { state: 'missing', checks: [] };
    assert.equal(evaluateMergeConditions(f).ok, true);
  });
});
