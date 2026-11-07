#!/usr/bin/env node
/**
 * Publishes this repository to GitHub in one command.
 *
 *   node scripts/publish-github.mjs --owner YOUR_GITHUB_USER
 *   node scripts/publish-github.mjs --owner YOUR_GITHUB_USER --dry-run
 *
 * Needs one of:
 *   Â· `gh auth login` (recommended â€” also sets up git credentials), or
 *   Â· GH_TOKEN / GITHUB_TOKEN in the environment (a PAT with `repo` scope)
 *
 * It is idempotent: re-running pushes new commits, and only creates the repo,
 * topics, tag and release when they do not already exist.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);

function flag(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const next = args[index + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}

const DRY = Boolean(flag('dry-run', false));
const OWNER = flag('owner', process.env.REELFORGE_GH_OWNER ?? '');
const REPO = flag('repo', 'reelforge');
const PRIVATE = Boolean(flag('private', false));
const VERSION = flag('version', '0.2.0');

const DESCRIPTION =
  'Open-source, self-hosted Screenforge Director alternative: give it a URL and one sentence, it drives your product in a real browser and publishes a narrated demo video, help article and in-app guide. BYOK or fully local. REST + MCP.';
const TOPICS = [
  'ai-agents',
  'browser-automation',
  'playwright',
  'demo-video',
  'product-demos',
  'screen-recording',
  'mcp',
  'model-context-protocol',
  'ffmpeg',
  'text-to-speech',
  'developer-tools',
  'self-hosted',
  'open-source',
  'typescript',
  'nextjs-alternative'
];

function sh(command, argv, options = {}) {
  const rendered = `${command} ${argv.join(' ')}`;
  if (DRY) {
    console.log(`  [dry-run] ${rendered}`);
    return '';
  }
  return execFileSync(command, argv, { cwd: ROOT, encoding: 'utf8', stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Read-only command: always executes, even under --dry-run. */
function read(command, argv) {
  try {
    return execFileSync(command, argv, { cwd: ROOT, encoding: 'utf8', stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function trySh(command, argv) {
  if (DRY) return { ok: true, out: "" };
  try {
    return { ok: true, out: sh(command, argv) };
  } catch (error) {
    return { ok: false, out: String(error.stderr ?? error.message ?? error) };
  }
}

function step(title) {
  console.log(`\nâ–¸ ${title}`);
}

function fail(message) {
  console.error(`\nâœ– ${message}\n`);
  process.exit(1);
}

// --- 0. sanity ---------------------------------------------------------------
step('Checking repository state');
if (!fs.existsSync(path.join(ROOT, '.git'))) fail('Not a git repository. Run `git init -b main` first.');
const branch = read('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
const dirty = read('git', ['status', '--porcelain']);
if (dirty) {
  console.log('  uncommitted changes present:');
  for (const line of dirty.split('\n').slice(0, 12)) console.log(`    ${line}`);
  fail('Commit first (`git add -A && git commit -m "..."`), then re-run so the push is clean.');
}
console.log(`  branch ${branch}, clean tree, ${read('git', ['rev-list', '--count', 'HEAD'])} commit(s)`);

// --- 1. auth -----------------------------------------------------------------
step('Checking GitHub authentication');
const auth = DRY ? { ok: Boolean(read('gh', ['auth', 'status'])), out: '' } : trySh('gh', ['auth', 'status']);
if (!auth.ok) {
  console.error(`
  gh is not authenticated. Pick one:

    a) interactive (opens your browser, sets up git credentials too):
         gh auth login

    b) token (fine for CI or headless):
         $env:GH_TOKEN = "ghp_â€¦"        # Windows PowerShell
         export GH_TOKEN=ghp_â€¦          # bash
         # needs the "repo" scope; "workflow" too if you want CI files pushed

  Then re-run: node scripts/publish-github.mjs --owner YOUR_GITHUB_USER
`);
  process.exit(1);
}
const who = DRY ? { ok: true, out: read('gh', ['api', 'user', '--jq', '.login']) } : trySh('gh', ['api', 'user', '--jq', '.login']);
const login = who.ok ? who.out : '';
console.log(`  authenticated${login ? ` as ${login}` : ''}`);

const owner = String(OWNER || login || '');
if (!owner) fail('Could not determine the GitHub owner. Pass --owner YOUR_GITHUB_USER.');

// --- 2. repo -----------------------------------------------------------------
const full = `${owner}/${REPO}`;
step(`Ensuring ${full} exists`);
const exists = trySh('gh', ['repo', 'view', full, '--json', 'name']);
if (!exists.ok) {
  console.log(`  creating ${PRIVATE ? 'private' : 'public'} repository ${full}`);
  sh('gh', [
    'repo',
    'create',
    full,
    `--${PRIVATE ? 'private' : 'public'}`,
    '--source',
    '.',
    '--remote',
    'origin',
    '--description',
    DESCRIPTION,
    '--push'
  ]);
} else {
  console.log('  already exists â€” pushing to it');
  const remotes = trySh('git', ['remote']).out.split('\n').filter(Boolean);
  if (!remotes.includes('origin')) {
    sh('git', ['remote', 'add', 'origin', `https://github.com/${full}.git`]);
  } else {
    sh('git', ['remote', 'set-url', 'origin', `https://github.com/${full}.git`]);
  }
  sh('git', ['push', '-u', 'origin', branch]);
}

step('Setting repo metadata');
sh('gh', ['repo', 'edit', full, '--description', DESCRIPTION]);
sh('gh', ['repo', 'edit', full, '--add-topic', ...TOPICS]);
sh('gh', ['repo', 'edit', full, '--enable-issues', '--enable-discussions']);

// --- 3. release --------------------------------------------------------------
step(`Tagging v${VERSION}`);
const tags = read('git', ['tag', '--list']).split('\n').filter(Boolean);
if (tags.includes(`v${VERSION}`)) {
  console.log(`  v${VERSION} already tagged`);
} else {
  sh('git', ['tag', '-a', `v${VERSION}`, '-m', `Reelforge v${VERSION}`]);
  sh('git', ['push', 'origin', `v${VERSION}`]);
}

const releaseNotesPath = path.join(ROOT, 'docs', 'RELEASE-NOTES.md');
step('Publishing release');
const existingRelease = trySh('gh', ['release', 'view', `v${VERSION}`, '--repo', full]);
if (existingRelease.ok) {
  console.log(`  release v${VERSION} already exists`);
} else if (fs.existsSync(releaseNotesPath)) {
  sh('gh', ['release', 'create', `v${VERSION}`, '--repo', full, '--title', `Reelforge v${VERSION}`, '--notes-file', releaseNotesPath]);
} else {
  sh('gh', ['release', 'create', `v${VERSION}`, '--repo', full, '--title', `Reelforge v${VERSION}`, '--generate-notes']);
}

// --- 4. summary --------------------------------------------------------------
console.log(`
âœ” Published

  repo     https://github.com/${full}
  release  https://github.com/${full}/releases/tag/v${VERSION}
  clone    git clone https://github.com/${full}.git

Next, if you want the container image on GHCR, push a tag (the release workflow
builds and pushes ghcr.io/${full} automatically).
`);
