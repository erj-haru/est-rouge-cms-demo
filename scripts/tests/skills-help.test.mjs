// /cms-help の説明（references/commands.md）が、実際の Skill と食い違っていないかを確認する
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS_DIR = join(ROOT, '.claude/skills');
const HELP = readFileSync(join(SKILLS_DIR, 'cms-help/references/commands.md'), 'utf8');
const HEADINGS = ['何ができるか', 'いつ使うか', '必要な情報', '実行例', '処理の流れ', '注意事項'];

const skills = readdirSync(SKILLS_DIR)
  .filter((name) => name !== 'cms-help' && existsSync(join(SKILLS_DIR, name, 'SKILL.md')))
  .map((name) => {
    const text = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    return { dir: name, name: text.match(/^name:\s*(.+)$/m)?.[1].trim() };
  });

/** "## /<name> ..." の節の本文 */
const section = (name) => HELP.split(/\n(?=## \/)/).find((s) => new RegExp(`^## /${name}(\\s|$)`).test(s));

describe('/cms-help の説明', () => {
  it('Skill がある', () => assert.ok(skills.length >= 5));

  for (const skill of skills) {
    it(`/${skill.name} の説明がそろっている`, () => {
      assert.equal(skill.name, skill.dir, 'name とフォルダ名が一致すること');
      assert.match(HELP, new RegExp(`\\| \`/${skill.name}( [^\`]*)?\` \\|`), '一覧の表にあること');
      const body = section(skill.name);
      assert.ok(body, '詳しい説明の節があること');
      for (const heading of HEADINGS) assert.ok(body.includes(`**${heading}**`), `「${heading}」があること`);
      assert.ok(body.includes(`\`/${skill.name}`), '実行例にコマンドがあること');
    });
  }

  it('存在しない Skill の説明がない', () => {
    const documented = [...HELP.matchAll(/^## \/([a-z-]+)/gm)].map((m) => m[1]);
    assert.deepEqual(documented.sort(), skills.map((s) => s.name).sort());
  });

  it('/publish-news で承認とデプロイの違いを説明している', () => {
    const body = section('publish-news');
    assert.match(body, /明確な承認が必要/);
    assert.match(body, /マージとデプロイは別/);
  });

  it('Claude Code 標準の /help を上書きしない', () => assert.ok(!skills.some((s) => s.name === 'help') && !existsSync(join(SKILLS_DIR, 'help'))));
});
