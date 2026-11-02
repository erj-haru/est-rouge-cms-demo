#!/usr/bin/env node
/**
 * PR の変更範囲を判定する（CI の content-scope ジョブ）。
 *
 *   node scripts/ci/content-scope.mjs --repo <PR のチェックアウト> --base <sha> --head <sha> --content-label <true|false>
 *
 * CI ではこのスクリプトを **ベースブランチ（main）側のチェックアウトから** 実行し、PR 側のコードは
 * Git のデータとしてだけ読む。PR でこのスクリプトや判定ルールを書き換えても判定は変わらない。
 *
 * - content ラベルあり: 記事・画像以外の変更、削除・リネーム、偽装されたファイルがあれば失敗
 * - content ラベルなし: 通常のコード変更 PR として扱い、判定結果を表示するだけ（失敗しない）
 */
import { spawnSync } from 'node:child_process';
import { checkContentScope, contentViolation, parseRawDiff } from '../lib/content-rules.mjs';
import { annotate, cell, summary } from './actions-output.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs), []),
);
const { repo, base, head } = args;
const hasLabel = args['content-label'] === 'true';
if (!repo || !/^[0-9a-f]{40}$/.test(base ?? '') || !/^[0-9a-f]{40}$/.test(head ?? '')) {
  console.error('使い方: content-scope.mjs --repo <dir> --base <sha> --head <sha> --content-label <true|false>');
  process.exit(2);
}

function git(gitArgs, encoding = 'utf8') {
  const res = spawnSync('git', ['-C', repo, ...gitArgs], { encoding, maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`git ${gitArgs.join(' ')} に失敗しました: ${res.stderr}`);
  return res.stdout;
}

const entries = parseRawDiff(git(['diff', '--raw', '-z', '--no-renames', '--no-ext-diff', `${base}...${head}`]));
const scope = checkContentScope(entries);
const violations = [...scope.violations];
for (const path of [...scope.articles, ...scope.images]) {
  const reason = contentViolation(path, git(['cat-file', 'blob', `${head}:${path}`], 'buffer'));
  if (reason) violations.push({ path, reason });
}
const isContent = violations.length === 0;

const rows = entries.map((e) => `| ${e.status} | \`${cell(e.path)}\` | ${cell(violations.find((v) => v.path === e.path)?.reason ?? 'OK')} |`);
summary(
  [
    `## 変更範囲の判定（content ラベル: ${hasLabel ? 'あり' : 'なし'}）`,
    '',
    isContent ? '✅ NEWS 記事・画像だけの変更です' : '⚠️ NEWS 記事・画像以外の変更を含みます（記事 PR としては扱えません）',
    '',
    '| 種別 | パス | 判定 |',
    '| --- | --- | --- |',
    ...rows,
    ...violations.filter((v) => v.path === '(全体)').map((v) => `| - | (全体) | ${cell(v.reason)} |`),
  ].join('\n'),
);

if (hasLabel && !isContent) {
  for (const v of violations) annotate('error', `記事 PR に含められない変更です: ${v.reason}`, v.path === '(全体)' ? undefined : v.path);
  process.exit(1);
}
if (!hasLabel) annotate('notice', isContent ? 'content ラベルはありませんが、記事・画像だけの変更です' : '通常のコード変更 PR として扱います（記事用の範囲チェックは適用しません）');
