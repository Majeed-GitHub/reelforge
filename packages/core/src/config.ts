import path from 'node:path';
import fs from 'node:fs';

/** Repo root: packages/core/src -> ../../.. */
export const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const DATA_DIR = path.resolve(env('REELFORGE_DATA_DIR', path.join(ROOT, 'data')));

export const PATHS = {
  data: DATA_DIR,
  db: path.join(DATA_DIR, 'reelforge.db'),
  secret: path.join(DATA_DIR, '.secret'),
  videos: path.join(DATA_DIR, 'videos'),
  raw: path.join(DATA_DIR, 'raw'),
  posters: path.join(DATA_DIR, 'posters'),
  screenshots: path.join(DATA_DIR, 'screenshots'),
  audio: path.join(DATA_DIR, 'audio'),
  exports: path.join(DATA_DIR, 'exports'),
  webDist: path.join(ROOT, 'packages', 'web', 'dist')
};

export const API_PORT = Number(env('REELFORGE_API_PORT', '4400'));
export const WEB_PORT = Number(env('REELFORGE_WEB_PORT', '4401'));
export const DEMO_SITE_PORT = Number(env('REELFORGE_DEMO_PORT', '4402'));
export const PUBLIC_BASE_URL = env('REELFORGE_PUBLIC_URL', `http://127.0.0.1:${API_PORT}`);
export const WEB_BASE_URL = env('REELFORGE_WEB_URL', `http://127.0.0.1:${WEB_PORT}`);

/** Browser viewport used for every recording (16:9). */
export const VIEWPORT = { width: 1280, height: 720 };

export const LLM = {
  provider: env('REELFORGE_LLM_PROVIDER', 'auto'), // auto | openai | none
  baseUrl: env('REELFORGE_LLM_BASE_URL', 'https://api.openai.com/v1'),
  apiKey: env('REELFORGE_LLM_API_KEY', env('OPENAI_API_KEY', '')),
  model: env('REELFORGE_LLM_MODEL', 'gpt-4.1-mini'),
  timeoutMs: Number(env('REELFORGE_LLM_TIMEOUT_MS', '60000'))
};

export const TTS = {
  provider: env('REELFORGE_TTS_PROVIDER', 'auto'), // auto | sapi | openai | edge | none
  voice: env('REELFORGE_TTS_VOICE', ''),
  openaiKey: env('OPENAI_API_KEY', ''),
  openaiModel: env('REELFORGE_TTS_MODEL', 'gpt-4o-mini-tts')
};

/** Plan limits. Mirrors Director's concurrency tiers. */
export const PLAN = {
  concurrency: Number(env('REELFORGE_CONCURRENCY', '3')),
  tunnelDemosPerDay: Number(env('REELFORGE_TUNNEL_PER_DAY', '30')),
  minBillableSeconds: 15,
  freeMinutesPerMonth: Number(env('REELFORGE_FREE_MINUTES', '5')),
  /** 0 disables the credit guard (useful while self-hosting/testing). */
  enforceCredits: env('REELFORGE_ENFORCE_CREDITS', 'false') === 'true'
};

export function ensureDirs(): void {
  for (const dir of Object.values(PATHS)) {
    if (dir === PATHS.db || dir.endsWith('.secret') || dir.endsWith('.db')) continue;
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function relativeToData(absPath: string | null | undefined): string | null {
  if (!absPath) return null;
  const rel = path.relative(DATA_DIR, absPath);
  if (rel.startsWith('..')) return absPath;
  return rel.split(path.sep).join('/');
}

export function absoluteFromData(relPath: string | null | undefined): string | null {
  if (!relPath) return null;
  if (path.isAbsolute(relPath)) return relPath;
  return path.join(DATA_DIR, relPath);
}
