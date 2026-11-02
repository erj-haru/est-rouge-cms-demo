/**
 * NEWS 記事 PR の判定ルール（ローカルの news.mjs・publish-news.mjs と GitHub Actions の CI で共通）。
 * Node.js の標準機能だけで動き、ファイルシステムや Git には触れない純粋な関数で構成する。
 */

export const LOCALES = ['ja', 'en'];
export const CONTENT_LABEL = 'content';

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
/** 記事: src/content/news/{ja|en}/YYYY-MM-DD-<slug>.md */
export const ARTICLE_PATH = new RegExp(`^src/content/news/(ja|en)/\\d{4}-\\d{2}-\\d{2}-${SLUG}\\.md$`);
/** 画像: src/assets/news/<slug>/NN-<name>.<ext>（scripts/news.mjs images が作る形式。拡張子は小文字のみ） */
export const IMAGE_PATH = new RegExp(`^src/assets/news/${SLUG}/\\d{2}-${SLUG}\\.(jpg|png|webp|avif)$`);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const REQUIRED_FIELDS = ['title', 'publishedAt', 'category', 'slug', 'lang', 'articleId'];

// ---------------------------------------------------------------------------
// frontmatter
// ---------------------------------------------------------------------------

function unquote(value) {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/** 1 行 1 項目の frontmatter を読む（厳密なスキーマ検証は Astro の Content Collections で行う） */
export function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const data = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z][\w]*):\s*(.*)$/);
      if (kv) data[kv[1]] = unquote(kv[2]);
    }
  }
  return { data, body: match ? match[2] : text, hasFrontmatter: Boolean(match) };
}

/** frontmatter の draft: true を draft: false に変える（他の行・本文は一切変えない） */
export function setDraftFalse(text) {
  const match = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (!match) throw new Error('frontmatter がありません');
  const lines = match[2].split(/(\r?\n)/);
  let changed = 0;
  const updated = lines.map((line) => {
    if (/^draft:\s*true\s*$/.test(line)) {
      changed++;
      return 'draft: false';
    }
    return line;
  });
  if (changed !== 1) throw new Error(`draft: true の行が ${changed} 件あります（1 件のみ変更できます）`);
  return match[1] + updated.join('') + text.slice(match[1].length + match[2].length);
}

// ---------------------------------------------------------------------------
// 変更範囲（git diff --raw -z --no-renames の結果を判定する）
// ---------------------------------------------------------------------------

/**
 * `git diff --raw -z --no-renames <base>...<head>` の出力を解析する。
 * @returns {{ srcMode: string, dstMode: string, status: string, path: string }[]}
 */
export function parseRawDiff(output) {
  const parts = output.split('\0');
  const entries = [];
  for (let i = 0; i < parts.length - 1; i += 2) {
    const meta = parts[i].replace(/^\n/, '');
    if (!meta) break;
    const m = meta.match(/^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/);
    if (!m) throw new Error(`git diff の出力を解析できません: ${meta}`);
    entries.push({ srcMode: m[1], dstMode: m[2], status: m[3], path: parts[i + 1] });
  }
  return entries;
}

/** パスとして安全か（偽装・ディレクトリ外参照・制御文字・非 ASCII を拒否） */
export function unsafePathReason(path) {
  if (!path) return 'パスが空です';
  if (/[^\x21-\x7e]/.test(path)) return 'ASCII 以外の文字・空白・制御文字を含むパスは扱えません';
  if (path.includes('\\')) return 'バックスラッシュを含むパスは扱えません';
  if (path.startsWith('/') || path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) {
    return '不正なパス（絶対パス・相対参照・空の階層）です';
  }
  return null;
}

/**
 * 変更が「NEWS 記事と画像の追加・更新だけ」かを判定する。
 * - 削除・リネーム（--no-renames により削除＋追加として現れる）・種類変更は記事 PR では扱わない
 * - シンボリックリンク・サブモジュール・実行可能ファイルは拒否する
 */
export function checkContentScope(entries) {
  const violations = [];
  const articles = [];
  const images = [];
  for (const entry of entries) {
    const reason = scopeViolation(entry);
    if (reason) violations.push({ path: entry.path, reason });
    else if (ARTICLE_PATH.test(entry.path)) articles.push(entry.path);
    else images.push(entry.path);
  }
  if (entries.length > 0 && articles.length === 0 && violations.length === 0) {
    violations.push({ path: '(全体)', reason: '記事ファイル（.md）の変更が含まれていません' });
  }
  if (entries.length === 0) violations.push({ path: '(全体)', reason: '変更がありません' });
  return { ok: violations.length === 0, violations, articles, images };
}

function scopeViolation({ status, dstMode, path }) {
  const unsafe = unsafePathReason(path);
  if (unsafe) return unsafe;
  if (status === 'D') return '削除は記事 PR では扱えません（リネームも削除＋追加として扱います）';
  if (status === 'T') return 'ファイルの種類の変更は記事 PR では扱えません';
  if (status !== 'A' && status !== 'M') return `この変更（${status}）は記事 PR では扱えません`;
  if (dstMode === '120000') return 'シンボリックリンクは記事 PR では扱えません';
  if (dstMode === '160000') return 'サブモジュールは記事 PR では扱えません';
  if (dstMode !== '100644') return `ファイルモード ${dstMode}（実行可能ファイルなど）は記事 PR では扱えません`;
  if (!ARTICLE_PATH.test(path) && !IMAGE_PATH.test(path)) {
    return '許可されたパスではありません（記事: src/content/news/{ja,en}/YYYY-MM-DD-<slug>.md、画像: src/assets/news/<slug>/NN-<name>.{jpg,png,webp,avif}）';
  }
  return null;
}

const MAGIC = {
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  avif: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && /avi[fs]/.test(b.subarray(8, 12).toString('latin1')),
};

/** ファイルの中身が拡張子どおりか（画像に見せかけた別形式・記事に見せかけたバイナリを拒否） */
export function contentViolation(path, buffer) {
  if (ARTICLE_PATH.test(path)) {
    if (buffer.includes(0)) return 'テキストではないデータを含んでいます';
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return 'UTF-8 のテキストではありません';
    }
    const { data, hasFrontmatter } = parseFrontmatter(text);
    if (!hasFrontmatter) return 'frontmatter がありません';
    const missing = REQUIRED_FIELDS.filter((key) => !data[key]);
    if (missing.length > 0) return `frontmatter の必須項目がありません: ${missing.join(', ')}`;
    const folder = path.split('/')[3];
    if (data.lang !== folder) return `lang「${data.lang}」が配置フォルダ「${folder}」と一致しません`;
    return null;
  }
  const ext = path.split('.').pop();
  if (buffer.length > MAX_IMAGE_BYTES) return `画像が大きすぎます（${Math.round(buffer.length / 1024 / 1024)}MB。上限 10MB）`;
  if (!MAGIC[ext]?.(buffer)) return `中身が拡張子 .${ext} の画像形式ではありません`;
  return null;
}

// ---------------------------------------------------------------------------
// 日英の整合性
// ---------------------------------------------------------------------------

/**
 * 共通記事ID ごとに日英の記事が矛盾していないかを確認する。
 * @param {{ path: string, data: Record<string, string> }[]} articles
 */
export function checkArticleConsistency(articles) {
  const errors = [];
  const warnings = [];
  const groups = new Map();
  for (const a of articles) {
    const id = a.data.articleId;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(a);
  }
  for (const [id, group] of groups) {
    for (const lang of LOCALES) {
      const same = group.filter((a) => a.data.lang === lang);
      if (same.length > 1) errors.push(`共通記事ID「${id}」の${lang}版が複数あります: ${same.map((a) => a.path).join(', ')}`);
    }
    const ja = group.find((a) => a.data.lang === 'ja');
    const en = group.find((a) => a.data.lang === 'en');
    if (!ja || !en) {
      warnings.push(`共通記事ID「${id}」は${ja ? '英語' : '日本語'}版がありません`);
      continue;
    }
    for (const key of ['slug', 'publishedAt', 'category', 'draft']) {
      const jv = key === 'draft' ? String(ja.data.draft ?? 'false') : ja.data[key];
      const ev = key === 'draft' ? String(en.data.draft ?? 'false') : en.data[key];
      if (jv !== ev) errors.push(`共通記事ID「${id}」の ${key} が日英で異なります（日本語: ${jv} / 英語: ${ev}）`);
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// 公開フラグの変更
// ---------------------------------------------------------------------------

/**
 * `git diff --unified=0 <reviewed> <head>` が「記事の draft: true → false だけ」の変更かを判定する。
 * @returns {{ ok: boolean, reason?: string, files: string[] }}
 */
export function isDraftFlipOnly(diff) {
  const files = [];
  const fail = (reason) => ({ ok: false, reason, files });
  let file = null;
  let inHunk = false;
  let removed = 0;
  let added = 0;
  const closeFile = () => (file && (removed !== 1 || added !== 1) ? `${file} で公開フラグ以外の変更があります` : null);
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const error = closeFile();
      if (error) return fail(error);
      file = null;
      inHunk = false;
      removed = added = 0;
      continue;
    }
    if (!inHunk) {
      // ファイルヘッダー（最初の @@ まで）
      if (line.startsWith('+++ ')) {
        file = line.replace(/^\+\+\+ b\//, '');
        if (!ARTICLE_PATH.test(file)) return fail(`記事以外のファイル（${file}）が変更されています`);
        files.push(file);
      } else if (/^(new|deleted) file mode|^(old|new) mode|^similarity|^rename|^copy|^Binary|^\+\+\+ \/dev\/null|^--- \/dev\/null/.test(line)) {
        return fail('ファイルの追加・削除・リネーム・モード変更が含まれています');
      } else if (line.startsWith('@@')) {
        if (!file) return fail('差分を解析できません');
        inHunk = true;
      }
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('-')) {
      if (!/^-draft:\s*true\s*$/.test(line)) return fail(`公開フラグ以外の行が変更されています: ${line}`);
      removed++;
    } else if (line.startsWith('+')) {
      if (!/^\+draft:\s*false\s*$/.test(line)) return fail(`公開フラグ以外の行が変更されています: ${line}`);
      added++;
    } else if (line.startsWith('\\')) {
      return fail('改行コードや末尾改行の変更が含まれています');
    }
  }
  const error = closeFile();
  if (error) return fail(error);
  return { ok: true, files };
}
