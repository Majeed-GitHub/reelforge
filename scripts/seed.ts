/**
 * Creates the local workspace + API key so the dashboard and API are usable
 * immediately. Idempotent: re-running prints the existing key.
 *
 *   npm run seed
 */
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../packages/core/src/db.ts';
import { PATHS, ensureDirs } from '../packages/core/src/config.ts';
import { newId, nowIso, sha256 } from '../packages/core/src/ids.ts';

const KEY_FILE = path.join(PATHS.data, 'dev-api-key.txt');

function main() {
  ensureDirs();
  const db = getDb();

  let workspace = db.prepare('SELECT * FROM workspaces ORDER BY created_at LIMIT 1').get() as
    | { id: string; name: string }
    | undefined;

  if (!workspace) {
    const id = newId('ws');
    db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)').run(id, 'Personal', nowIso());
    workspace = { id, name: 'Personal' };
    console.log(`Created workspace ${workspace.name} (${workspace.id})`);
  } else {
    console.log(`Using workspace ${workspace.name} (${workspace.id})`);
  }

  let key: string | null = null;
  if (fs.existsSync(KEY_FILE)) {
    key = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const found = db.prepare('SELECT id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL').get(sha256(key));
    if (!found) key = null;
  }

  if (!key) {
    const raw = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    key = `rg_${raw}`;
    db.prepare('INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      newId('key'),
      workspace.id,
      'default',
      key.slice(0, 11),
      sha256(key),
      nowIso()
    );
    fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
    console.log('Created API key (saved to data/dev-api-key.txt)');
  }

  const preset = db.prepare('SELECT id FROM presets WHERE workspace_id = ?').get(workspace.id);
  if (!preset) {
    db.prepare('INSERT INTO presets (id, workspace_id, name, config_json, is_default) VALUES (?, ?, ?, ?, 1)').run(
      newId('pre'),
      workspace.id,
      'Default',
      JSON.stringify({ zoom: 1.6, watermark: true, language: 'en', voice: 'auto', fps: 30 })
    );
    console.log('Created default recording preset');
  }

  console.log('\nAPI key (send as X-API-Key):\n');
  console.log(`  ${key}\n`);
  console.log(`Dashboard: http://127.0.0.1:${process.env.REELFORGE_WEB_PORT ?? 4401}`);
  console.log('API docs : docs/API.md');
}

main();
