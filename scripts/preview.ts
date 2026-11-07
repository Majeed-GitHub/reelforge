/**
 * Builds a contact sheet from a rendered demo so a human can eyeball the whole
 * video in one image (and so a non-vision agent can still hand over evidence).
 *
 *   node scripts/preview.ts data/videos/dem_xxx.mp4 [out.png] [cols] [rows]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../packages/core/src/config.ts';
import { ffmpegPath } from '../packages/render/src/ffmpeg.ts';

const [input, outputArg, colsArg, rowsArg] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/preview.ts <video.mp4> [out.png] [cols] [rows]');
  process.exit(1);
}
const video = path.resolve(input);
if (!fs.existsSync(video)) {
  console.error(`No such video: ${video}`);
  process.exit(1);
}
const cols = Number(colsArg ?? 3);
const rows = Number(rowsArg ?? 3);
const output = path.resolve(outputArg ?? path.join(PATHS.exports, `${path.basename(video, path.extname(video))}-sheet.png`));
fs.mkdirSync(path.dirname(output), { recursive: true });

const probe = spawnSync(ffmpegPath(), ['-hide_banner', '-i', video], { encoding: 'utf8' });
const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(probe.stderr ?? '');
const seconds = match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : 10;
// One frame per cell, evenly spaced across the video.
const interval = Math.max(0.5, seconds / (cols * rows));

const args = [
  '-y',
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  video,
  '-vf',
  `fps=1/${interval.toFixed(3)},scale=440:-2,tile=${cols}x${rows}:padding=6:margin=6:color=0x0b0d10`,
  '-frames:v',
  '1',
  output
];
const run = spawnSync(ffmpegPath(), args, { encoding: 'utf8' });
if (run.status !== 0) {
  console.error(run.stderr);
  process.exit(run.status ?? 1);
}
console.log(`contact sheet: ${output}  (${cols}x${rows} tiles, ${seconds.toFixed(1)}s video, 1 frame every ${interval.toFixed(1)}s)`);
console.log(`size: ${fs.statSync(output).size} bytes`);

