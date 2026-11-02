import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkArticleConsistency,
  checkContentScope,
  contentViolation,
  isDraftFlipOnly,
  parseRawDiff,
  setDraftFalse,
} from '../lib/content-rules.mjs';

const entry = (path, { status = 'A', dstMode = '100644' } = {}) => ({ srcMode: status === 'A' ? '000000' : '100644', dstMode, status, path });
const JA = 'src/content/news/ja/2026-11-20-new-office.md';
const EN = 'src/content/news/en/2026-11-20-new-office.md';
const IMG = 'src/assets/news/new-office/01-cover.jpg';

describe('parseRawDiff', () => {
  it('git diff --raw -z の出力を解析する', () => {
    const out = `:000000 100644 0000000 1111111 A\0${JA}\0:100644 100644 2222222 3333333 M\0${IMG}\0`;
    assert.deepEqual(parseRawDiff(out).map((e) => [e.status, e.path]), [['A', JA], ['M', IMG]]);
  });
});

describe('checkContentScope', () => {
  const violation = (entries) => checkContentScope(entries).violations.map((v) => v.reason).join(' / ');

  it('日英の記事と画像の追加・更新だけなら記事 PR', () => {
    const result = checkContentScope([entry(JA), entry(EN), entry(IMG), entry('src/assets/news/new-office/02-floor-map.png', { status: 'M' })]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.articles, [JA, EN]);
  });

  const rejected = {
    'スクリプトの変更': [entry(JA), entry('scripts/news.mjs', { status: 'M' })],
    'ワークフローの変更': [entry(JA), entry('.github/workflows/ci.yml', { status: 'M' })],
    '記事の削除': [entry(JA, { status: 'D', dstMode: '000000' })],
    'リネーム（削除＋追加）': [entry('src/content/news/ja/2026-11-20-old.md', { status: 'D', dstMode: '000000' }), entry(JA)],
    'シンボリックリンク': [entry(JA), entry(IMG, { dstMode: '120000' })],
    '実行可能ファイル': [entry(JA, { dstMode: '100755' })],
    'サブモジュール': [entry(JA), entry('src/assets/news/new-office/01-x.jpg', { dstMode: '160000' })],
    '種類の変更': [entry(JA, { status: 'T' })],
    '大文字の拡張子': [entry(JA), entry('src/assets/news/new-office/01-cover.JPG')],
    '二重拡張子': [entry(JA), entry('src/assets/news/new-office/01-cover.jpg.js')],
    '画像フォルダ外の画像': [entry(JA), entry('src/assets/news/cover.jpg')],
    '記事フォルダの階層違い': [entry('src/content/news/ja/sub/2026-11-20-x.md')],
    '言語フォルダ以外': [entry('src/content/news/fr/2026-11-20-x.md')],
    'ディレクトリ外参照': [entry('src/content/news/ja/../../../scripts/2026-11-20-x.md')],
    '全角の紛らわしい文字': [entry('src/content/news/ja/2026-11-20-ｎews.md')],
    '空白を含むパス': [entry('src/content/news/ja/2026-11-20-a b.md')],
    'バックスラッシュ': [entry('src\\content\\news\\ja\\2026-11-20-x.md')],
    '改行を含むパス': [entry('src/content/news/ja/2026-11-20-x.md\n::error::x')],
    '画像だけ（記事なし）': [entry(IMG)],
    '変更なし': [],
  };
  for (const [name, entries] of Object.entries(rejected)) {
    it(`拒否: ${name}`, () => {
      const result = checkContentScope(entries);
      assert.equal(result.ok, false, violation(entries));
    });
  }
});

describe('contentViolation', () => {
  const md = (front, body = '本文') => Buffer.from(`---\n${front}\n---\n\n${body}\n`);
  const valid = 'title: "t"\npublishedAt: 2026-11-20\ncategory: news\nslug: new-office\nlang: ja\narticleId: new-office\ndraft: true';
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

  it('正しい記事・画像は通す', () => {
    assert.equal(contentViolation(JA, md(valid)), null);
    assert.equal(contentViolation(IMG, jpg), null);
    assert.equal(contentViolation('src/assets/news/new-office/02-map.png', png), null);
  });
  it('拡張子と中身が違う画像を拒否', () => assert.match(contentViolation(IMG, png), /画像形式ではありません/));
  it('画像に見せかけたテキストを拒否', () => assert.match(contentViolation(IMG, Buffer.from('<script>')), /画像形式ではありません/));
  it('バイナリを含む記事を拒否', () => assert.match(contentViolation(JA, Buffer.concat([md(valid), Buffer.from([0])])), /テキストではない/));
  it('UTF-8 でない記事を拒否', () => assert.match(contentViolation(JA, Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe])), /UTF-8/));
  it('必須項目のない記事を拒否', () => assert.match(contentViolation(JA, md('title: "t"\nlang: ja')), /必須項目/));
  it('lang とフォルダの不一致を拒否', () => assert.match(contentViolation(EN, md(valid)), /一致しません/));
});

describe('checkArticleConsistency', () => {
  const a = (lang, data) => ({ path: `${lang}.md`, data: { articleId: 'x', slug: 'x', publishedAt: '2026-11-20', category: 'news', draft: 'true', lang, ...data } });
  it('日英が一致していれば問題なし', () => assert.deepEqual(checkArticleConsistency([a('ja'), a('en')]), { errors: [], warnings: [] }));
  it('公開状態の不一致はエラー', () => assert.match(checkArticleConsistency([a('ja'), a('en', { draft: 'false' })]).errors[0], /draft/));
  it('slug の不一致はエラー', () => assert.match(checkArticleConsistency([a('ja'), a('en', { slug: 'y' })]).errors[0], /slug/));
  it('翻訳がない記事は警告', () => assert.match(checkArticleConsistency([a('ja')]).warnings[0], /英語版がありません/));
  it('同じ言語の重複はエラー', () => assert.match(checkArticleConsistency([a('ja'), a('ja')]).errors[0], /複数/));
});

describe('setDraftFalse', () => {
  it('frontmatter の draft 行だけを変える', () => {
    const text = '---\ntitle: "draft: true の話"\ndraft: true\n---\n\ndraft: true は本文中なので変えない\n';
    assert.equal(setDraftFalse(text), '---\ntitle: "draft: true の話"\ndraft: false\n---\n\ndraft: true は本文中なので変えない\n');
  });
  it('draft: true がなければ変更しない', () => assert.throws(() => setDraftFalse('---\ndraft: false\n---\n'), /0 件/));
});

describe('isDraftFlipOnly', () => {
  const header = (path) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}`;
  const flip = (path) => `${header(path)}\n@@ -9 +9 @@\n-draft: true\n+draft: false`;

  it('日英の公開フラグだけの変更を許可', () => assert.deepEqual(isDraftFlipOnly(`${flip(JA)}\n${flip(EN)}\n`), { ok: true, files: [JA, EN] }));
  it('本文の変更を拒否', () => assert.equal(isDraftFlipOnly(`${flip(JA)}\n@@ -20 +20 @@\n-古い本文\n+新しい本文\n`).ok, false));
  it('「-- 」で始まる行の削除を見逃さない', () => assert.equal(isDraftFlipOnly(`${header(JA)}\n@@ -9,2 +9 @@\n-draft: true\n--- 隠れた行\n+draft: false\n`).ok, false));
  it('画像の変更を拒否', () => assert.equal(isDraftFlipOnly(`${flip(JA)}\n${header(IMG)}\nBinary files differ\n`).ok, false));
  it('ファイルの追加を拒否', () => assert.equal(isDraftFlipOnly(`diff --git a/${JA} b/${JA}\nnew file mode 100644\n--- /dev/null\n+++ b/${JA}\n@@ -0,0 +1 @@\n+draft: false\n`).ok, false));
  it('公開フラグの追加だけ（削除行なし）を拒否', () => assert.equal(isDraftFlipOnly(`${header(JA)}\n@@ -9,0 +10 @@\n+draft: false\n`).ok, false));
});
