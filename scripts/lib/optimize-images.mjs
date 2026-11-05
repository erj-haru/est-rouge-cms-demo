/**
 * 記事画像の最適化（mise.toml の Node.js で実行する。sharp は Astro の依存関係に含まれ、npm ci で導入される）
 *
 *   node scripts/lib/optimize-images.mjs --out <dir> [--start <n>] [--overwrite] <file>...
 *
 * - EXIF の向きを反映したうえでメタデータ（撮影位置情報など）を削除する
 * - 長辺 2400px を上限に縮小する（拡大はしない）
 * - 写真は JPEG、透過や文字を含みやすい PNG は PNG のまま保存する
 * - 既存ファイルは --overwrite がない限り上書きしない
 *
 * 結果は JSON（[{ source, output, width, height, bytes }]）で標準出力に出す。
 * 表示サイズに合わせたリサイズと WebP 変換は、ビルド時に Astro が行う。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import sharp from 'sharp';

const MAX_EDGE = 2400;
const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff']);

const args = process.argv.slice(2);
let outDir = '';
let start = 1;
let overwrite = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outDir = args[++i];
  else if (args[i] === '--start') start = Number(args[++i]);
  else if (args[i] === '--overwrite') overwrite = true;
  else files.push(args[i]);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!outDir.startsWith('src/assets/news/')) fail('出力先は src/assets/news/ 配下を指定してください');
if (files.length === 0) fail('画像ファイルを指定してください');

/** 元のファイル名から URL・ファイル名に安全な英数字の名前を作る（日本語名などは image にする） */
function safeName(file) {
  const name = basename(file, extname(file))
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return name || 'image';
}

const plans = files.map((source, i) => {
  const ext = extname(source).toLowerCase();
  if (ext === '.heic' || ext === '.heif') {
    fail(`${basename(source)}: HEIC 形式は変換できません。写真アプリで JPEG として書き出してから指定してください`);
  }
  if (!SUPPORTED.has(ext)) fail(`${basename(source)}: 対応していない形式です（JPEG / PNG / WebP / AVIF / TIFF に対応）`);
  if (!existsSync(source)) fail(`${source}: ファイルが見つかりません`);
  const format = ext === '.png' ? 'png' : 'jpeg';
  const index = String(start + i).padStart(2, '0');
  const output = join(outDir, `${index}-${safeName(source)}.${format === 'png' ? 'png' : 'jpg'}`);
  if (existsSync(output) && !overwrite) fail(`${output} は既に存在します。上書きする場合は確認のうえ --overwrite を指定してください`);
  return { source, output, format };
});

mkdirSync(outDir, { recursive: true });
const results = [];
for (const { source, output, format } of plans) {
  const pipeline = sharp(source, { failOn: 'error' })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  const encoded = format === 'png' ? pipeline.png({ compressionLevel: 9, palette: false }) : pipeline.jpeg({ quality: 85, mozjpeg: true });
  const info = await encoded.toFile(output);
  results.push({ source: basename(source), output, width: info.width, height: info.height, bytes: statSync(output).size });
}
console.log(JSON.stringify(results, null, 2));
