/**
 * Build the promo's audio: narration (edge-tts), sound effects and an ambient
 * bed (both synthesized with ffmpeg), then mix and normalise.
 *
 *   node docs/media/lux/audio/build-audio.mjs
 *
 * Nothing here is sampled or licensed: the narration is a neural TTS voice,
 * and every effect is generated from oscillators and filtered noise.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const outDir = here;
const sfxDir = path.join(outDir, 'sfx');
fs.mkdirSync(sfxDir, { recursive: true });

const FFMPEG = (await import('../../../../packages/render/src/ffmpeg.ts')).ffmpegPath();
const FFPROBE = (await import('../../../../packages/render/src/ffmpeg.ts')).ffprobePath();

function run(bin, args, label) {
  const result = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    console.error(`\n✖ ${label} failed\n${(result.stderr || '').slice(-1500)}`);
    process.exit(1);
  }
  return result;
}

function durationOf(file) {
  const out = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], `probe ${path.basename(file)}`).stdout.trim();
  return Number(out);
}

/* ------------------------------------------------------------------ voices */
const VOICE = process.env.LUX_VOICE ?? 'en-US-AriaNeural';
const LINES = [
  { id: 'vo1', at: 0.9, text: 'Reelforge.' },
  { id: 'vo2', at: 3.95, text: 'Give it a URL, and one sentence.' },
  { id: 'vo3', at: 8.6, text: 'It drives your product in a real browser.' },
  { id: 'vo4', at: 11.7, text: 'A video, an article, a walkthrough, a guide.' },
  { id: 'vo5', at: 15.6, text: 'One capture. Your own model, or fully offline.' },
  { id: 'vo6', at: 25.5, text: 'Free forever.' }
];

const clipDir = path.join(outDir, 'vo');
fs.mkdirSync(clipDir, { recursive: true });

console.log('· narration');
for (const line of LINES) {
  const file = path.join(clipDir, `${line.id}.mp3`);
  const result = spawnSync(
    'python',
    ['-m', 'edge_tts', '--voice', VOICE, '--rate=+10%', '--text', line.text, '--write-media', file],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    console.error(`\n✖ edge-tts failed for "${line.text}"\n${(result.stderr || '').slice(-800)}`);
    process.exit(1);
  }
  line.file = file;
  line.duration = durationOf(file);
  console.log(`  ${line.id.padEnd(4)} ${line.duration.toFixed(2)}s @ ${line.at}s  "${line.text.slice(0, 48)}"`);
}

const voEnd = Math.max(...LINES.map((l) => l.at + l.duration));
if (voEnd > 28.4) {
  console.error(`✖ narration runs to ${voEnd.toFixed(1)}s and would collide with the end card fade (28.4s)`);
  process.exit(1);
}

/* -------------------------------------------------------------------- sfx */
console.log('· sound effects');
const sfx = [];
function synth(name, filter, seconds, extra = []) {
  const file = path.join(sfxDir, `${name}.wav`);
  run(
    FFMPEG,
    ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', filter, '-t', String(seconds), ...extra, '-ac', '2', '-ar', '48000', file],
    `sfx ${name}`
  );
  return file;
}

const S = (n) => String(n);

// low impact / sub thump: a short sine drop plus a noise transient
sfx.push({
  file: synth(
    'impact',
    `aevalsrc=0.9*sin(2*PI*(76-38*t)*t)*exp(-6*t)+0.35*(random(0)-0.5)*exp(-40*t):s=48000:d=1.4`,
    1.4,
    ['-af', 'lowpass=f=220,volume=1.0']
  ),
  at: 3.2,
  gain: 0.95
});

// whoosh: band-passed noise sweeping upward, amplitude bell
sfx.push({
  file: synth('whoosh', `anoisesrc=color=pink:amplitude=0.65:d=1.1`, 1.1, ['-af', 'highpass=f=300,lowpass=f=6000,afade=t=in:st=0:d=0.35,afade=t=out:st=0.55:d=0.5,volume=0.55']),
  at: 8.1,
  gain: 0.8
});
sfx.push({
  file: synth('whoosh2', `anoisesrc=color=pink:amplitude=0.65:d=1.0`, 1.0, ['-af', 'highpass=f=420,lowpass=f=5200,afade=t=in:st=0:d=0.3,afade=t=out:st=0.5:d=0.45,volume=0.5']),
  at: 14.5,
  gain: 0.7
});

// UI ticks (short filtered clicks)
for (const [i, at] of [4.05, 4.4, 4.75, 5.1, 5.45, 5.8, 6.15].entries()) {
  sfx.push({
    file: synth(
      `tick${i}`,
      `aevalsrc=0.5*sin(2*PI*2400*t)*exp(-90*t)+0.2*(random(0)-0.5)*exp(-140*t):s=48000:d=0.12`,
      0.12,
      ['-af', 'highpass=f=1400,volume=0.5']
    ),
    at,
    gain: 0.45
  });
}

// soft card arrivals for the four outputs
for (const [i, at] of [12.15, 12.37, 12.59, 12.81].entries()) {
  sfx.push({
    file: synth(
      `card${i}`,
      `aevalsrc=0.4*sin(2*PI*${320 + i * 60}*t)*exp(-26*t)+0.12*sin(2*PI*${640 + i * 120}*t)*exp(-40*t):s=48000:d=0.6`,
      0.6,
      ['-af', 'lowpass=f=3200,volume=0.5']
    ),
    at,
    gain: 0.5
  });
}

// beat punctuations
for (const [i, at] of [20.25, 21.75, 23.25].entries()) {
  sfx.push({
    file: synth(
      `beat${i}`,
      `aevalsrc=0.35*sin(2*PI*180*t)*exp(-16*t)+0.15*(random(0)-0.5)*exp(-50*t):s=48000:d=0.8`,
      0.8,
      ['-af', 'lowpass=f=1800,volume=0.6']
    ),
    at,
    gain: 0.55
  });
}

// end impact + tail
sfx.push({
  file: synth(
    'end',
    `aevalsrc=0.7*sin(2*PI*(60-18*t)*t)*exp(-4.5*t)+0.25*sin(2*PI*120*t)*exp(-5*t)+0.2*(random(0)-0.5)*exp(-26*t):s=48000:d=3.2`,
    3.2,
    ['-af', 'lowpass=f=260,volume=0.85']
  ),
  at: 24.7,
  gain: 0.85
});

/* ------------------------------------------------------------------- music */
console.log('· ambient bed');
const padFile = path.join(sfxDir, 'pad.wav');
run(
  FFMPEG,
  [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `aevalsrc=0.16*sin(2*PI*110*t)+0.11*sin(2*PI*164.81*t)*(0.6+0.4*sin(2*PI*0.05*t))+0.08*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*0.037*t+1.2))+0.05*sin(2*PI*329.63*t):s=48000:d=31`,
    '-f', 'lavfi', '-i', 'anoisesrc=color=brown:amplitude=0.12:d=31',
    '-filter_complex',
    '[0:a]lowpass=f=1200,highpass=f=70[a];[1:a]lowpass=f=800,volume=0.5[b];[a][b]amix=inputs=2:normalize=0,' +
      'afade=t=in:st=0:d=2.5,afade=t=out:st=28.5:d=2.2,volume=0.5[out]',
    '-map', '[out]', '-ac', '2', '-ar', '48000', padFile
  ],
  'ambient pad'
);

/* --------------------------------------------------------------------- mix */
console.log('· mixing');
const inputs = [];
const chains = [];
let index = 0;

const voLabels = [];
for (const line of LINES) {
  inputs.push('-i', line.file);
  const delay = Math.round(line.at * 1000);
  chains.push(`[${index}:a]aresample=48000,volume=1.35,adelay=${delay}|${delay}[${line.id}]`);
  voLabels.push(`[${line.id}]`);
  index += 1;
}
chains.push(`${voLabels.join('')}amix=inputs=${voLabels.length}:normalize=0,alimiter=limit=0.95[vo]`);

inputs.push('-i', padFile);
const padIndex = index;
index += 1;
chains.push(`[${padIndex}:a]volume=0.30[mus]`);
// narration ducks the bed: music is compressed *by* the voice bus
chains.push(`[vo]asplit=2[voMix][voKey]`);
chains.push(`[mus][voKey]sidechaincompress=threshold=0.045:ratio=7:attack=18:release=520:makeup=1[musduck]`);

const sfxLabels = [];
for (const [i, effect] of sfx.entries()) {
  inputs.push('-i', effect.file);
  const delay = Math.round(effect.at * 1000);
  chains.push(`[${index}:a]aresample=48000,volume=${S(effect.gain)},adelay=${delay}|${delay}[s${i}]`);
  sfxLabels.push(`[s${i}]`);
  index += 1;
}
chains.push(`${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:normalize=0,alimiter=limit=0.9[sfx]`);

chains.push(`[voMix][musduck][sfx]amix=inputs=3:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.98[out]`);

const mixFile = path.join(outDir, 'mix.wav');
run(
  FFMPEG,
  ['-y', '-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', chains.join(';'), '-map', '[out]', '-t', '30', '-ac', '2', '-ar', '48000', mixFile],
  'final mix'
);

/* --------------------------------------------------------------- loudness */
const report = spawnSync(
  FFMPEG,
  ['-hide_banner', '-i', mixFile, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'],
  { encoding: 'utf8' }
);
const json = /{[^{}]*"input_i"[\s\S]*?}/.exec(report.stderr || '');
let summary = 'loudness: unavailable';
if (json) {
  try {
    const m = JSON.parse(json[0]);
    summary = `integrated ${Number(m.input_i).toFixed(1)} LUFS · true peak ${Number(m.input_tp).toFixed(1)} dBTP · LRA ${Number(m.input_lra).toFixed(1)}`;
  } catch {
    /* keep the fallback */
  }
}

console.log(`\n✔ audio: ${mixFile}`);
console.log(`  ${summary}`);
console.log(`  narration ends at ${voEnd.toFixed(2)}s · ${sfx.length} effects · bed ${durationOf(padFile).toFixed(1)}s`);
console.log(`  voice: ${VOICE}`);
