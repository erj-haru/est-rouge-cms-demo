/**
 * 編集者向けスクリプト（setup-editor.mjs / news.mjs）の共通処理。
 * Node.js の標準モジュールだけを使い、ホスト OS 上で動作する。
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVICE = 'astro';
export const PORT = 4321;
export const PREVIEW_URL = `http://localhost:${PORT}`;
// ヘルスチェックは IPv4 で行う（compose.yaml で 127.0.0.1 にのみ公開しているため）
export const PROBE_ORIGIN = `http://127.0.0.1:${PORT}`;
export const LOCALES = ['ja', 'en'];
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** コマンドを実行して結果を返す。出力は呼び出し側で必要な部分だけを表示する */
export function run(cmd, args, { timeout = 30_000, inherit = false, env = {}, input, encoding = 'utf8' } = {}) {
  const binary = encoding === 'buffer';
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: binary ? 'buffer' : 'utf8',
    timeout,
    windowsHide: true,
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? 'inherit' : 'pipe',
    // gh が対話プロンプトを出して止まらないようにする
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', ...env },
  });
  return {
    ok: res.status === 0,
    // encoding: 'buffer' の場合はバイナリのまま返す（画像の中身の検査用）
    stdout: binary ? (res.stdout ?? Buffer.alloc(0)) : (res.stdout ?? '').trim(),
    stderr: binary ? String(res.stderr ?? '').trim() : (res.stderr ?? '').trim(),
  };
}

export async function probe(path, timeoutMs = 5000) {
  try {
    const res = await fetch(new URL(path, PROBE_ORIGIN), { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    return { ok: res.ok, status: res.status, body: res.ok ? await res.text() : '' };
  } catch {
    return { ok: false, status: 0, body: '' };
  }
}

/** origin の GitHub リポジトリを `owner/repo` 形式で返す */
export function getGitHubRepo() {
  // remote get-url は url.*.insteadOf の書き換え後を返すため、設定値そのものを読む
  const remote = run('git', ['config', '--get', 'remote.origin.url']);
  const match = remote.ok ? remote.stdout.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/) : null;
  return match ? `${match[1]}/${match[2]}` : null;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
