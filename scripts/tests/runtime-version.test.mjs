// Node.js のバージョンが mise.toml・Dockerfile.dev・package.json・GitHub Actions で食い違っていないかを確認する
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const NODE = read('mise.toml').match(/^node\s*=\s*"([^"]+)"/m)?.[1];

/** "22.23.4" が ">=22.22.0" を満たすか（このプロジェクトで使う >= の形式のみ） */
function satisfiesMin(version, range) {
  const min = range.match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/);
  assert.ok(min, `想定外の範囲指定: ${range}`);
  const v = version.split('.').map(Number);
  const m = min.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (v[i] !== m[i]) return v[i] > m[i];
  return true;
}

describe('Node.js のバージョン', () => {
  it('mise.toml で厳密なバージョンに固定されている', () => assert.match(NODE ?? '', /^\d+\.\d+\.\d+$/));

  it('package.json の engines を満たす', () => {
    assert.ok(satisfiesMin(NODE, JSON.parse(read('package.json')).engines.node));
  });

  it('Astro の要件を満たす', () => {
    assert.ok(satisfiesMin(NODE, JSON.parse(read('node_modules/astro/package.json')).engines.node));
  });

  it('Dockerfile.dev（任意の Docker 構成）と同じ', () => {
    assert.equal(read('Dockerfile.dev').match(/^ARG NODE_VERSION=(\S+)$/m)?.[1], NODE);
  });

  for (const workflow of ['ci.yml', 'deploy.yml']) {
    it(`${workflow} は mise.toml からバージョンを読む（ハードコードしない）`, () => {
      const text = read(`.github/workflows/${workflow}`);
      assert.match(text, /mise\.toml/);
      assert.match(text, /node-version: \$\{\{ steps\.node\.outputs\.version \}\}/);
      assert.doesNotMatch(text, /node-version: \d/);
    });
  }
});
