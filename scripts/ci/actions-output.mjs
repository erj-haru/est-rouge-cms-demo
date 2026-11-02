/**
 * GitHub Actions への出力（アノテーションとジョブサマリー）。
 * ファイル名などに改行や記号が含まれてもワークフローコマンドとして解釈されないようにエスケープする。
 */
import { appendFileSync } from 'node:fs';

const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function annotate(level, message, file) {
  const props = file ? ` file=${escapeProperty(file)}` : '';
  console.log(`::${level}${props}::${escapeData(message)}`);
}

/** Markdown の表に入れても崩れないようにする（パイプ・改行・バッククォート） */
export const cell = (s) => String(s).replace(/[|`\r\n]/g, (c) => ({ '|': '\\|', '`': "'", '\r': ' ', '\n': ' ' })[c]);

export function summary(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
