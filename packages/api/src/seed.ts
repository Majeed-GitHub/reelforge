import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from '../../core/src/config.ts';
import { getDb } from '../../core/src/db.ts';
import { newId, nowIso } from '../../core/src/ids.ts';
import type { WorkspaceRow } from '../../core/src/types.ts';
import { generateApiKey } from './auth.ts';
import { one, run } from './dbq.ts';
import { DEFAULT_PRESET_CONFIG } from './services/presets.ts';

/**
 * Idempotent first-run seed.
 *
 *   node packages/api/src/seed.ts
 *
 * Reuses the FIRST existing workspace (root `scripts/seed.ts` creates one, and
 * a second "Personal" workspace would split the dashboard's data). A key is
 * minted only when the workspace has none, and its plaintext is written to
 * data/dev-api-key.txt (not overwritten if present) so `scripts/smoke.ts` and
 * the dashboard can pick it up without copy-paste.
 */

export const DEV_KEY_FILE = path.join(PATHS.data, 'dev-api-key.txt');

export type SeedResult = {
  workspaceId: string;
  workspaceName: string;
  workspaceCreated: boolean;
  apiKey: string | null;
  apiKeyId: string | null;
  apiKeyCreated: boolean;
  keyFile: string | null;
  presetId: string;
  presetCreated: boolean;
};

export function seedDefaultWorkspace(options: { quiet?: boolean } = {}): SeedResult {
  ensureDirs();
  getDb();
  const log = (line: string) => {
    if (!options.quiet) console.log(line);
  };

  // 1. Workspace: reuse the first one, create only if the table is empty.
  let workspace = one<WorkspaceRow>('SELECT * FROM workspaces ORDER BY created_at ASC, rowid ASC LIMIT 1');
  let workspaceCreated = false;
  if (!workspace) {
    const id = newId('ws');
    run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', id, 'Personal', nowIso());
    workspace = one<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', id)!;
    workspaceCreated = true;
    log(`[seed] created workspace "${workspace.name}" (${workspace.id})`);
  } else {
    log(`[seed] reusing workspace "${workspace.name}" (${workspace.id})`);
  }

  // 2. API key: only mint when this workspace has none left.
  let apiKey: string | null = null;
  let apiKeyId: string | null = null;
  let apiKeyCreated = false;
  const existingKey = one<{ id: string; name: string; prefix: string }>(
    'SELECT id, name, prefix FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY created_at ASC, rowid ASC LIMIT 1',
    workspace.id
  );
  if (existingKey) {
    apiKeyId = existingKey.id;
    log(`[seed] reusing API key "${existingKey.name}" (${existingKey.prefix}…, plaintext not recoverable)`);
    if (fs.existsSync(DEV_KEY_FILE)) {
      log(`[seed] dev key file already present: ${DEV_KEY_FILE}`);
    }
  } else {
    const generated = generateApiKey();
    const id = newId('key');
    run(
      'INSERT INTO api_keys (id, workspace_id, name, prefix, key_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)',
      id,
      workspace.id,
      'default',
      generated.prefix,
      generated.hash,
      nowIso()
    );
    apiKey = generated.key;
    apiKeyId = id;
    apiKeyCreated = true;
    fs.mkdirSync(path.dirname(DEV_KEY_FILE), { recursive: true });
    fs.writeFileSync(DEV_KEY_FILE, `${generated.key}\n`, { encoding: 'utf8', mode: 0o600 });
    log(`[seed] minted API key "default" ${generated.prefix}… — plaintext written to ${DEV_KEY_FILE}`);
  }

  // 3. Default recording preset.
  let preset = one<{ id: string }>(
    'SELECT id FROM presets WHERE workspace_id = ? AND is_default = 1 ORDER BY rowid ASC LIMIT 1',
    workspace.id
  );
  let presetCreated = false;
  if (!preset) {
    const id = newId('prs');
    run(
      'INSERT INTO presets (id, workspace_id, name, config_json, is_default) VALUES (?, ?, ?, ?, 1)',
      id,
      workspace.id,
      'Default',
      JSON.stringify(DEFAULT_PRESET_CONFIG)
    );
    preset = { id };
    presetCreated = true;
    log(`[seed] created default recording preset (${id})`);
  } else {
    log(`[seed] reusing default preset (${preset.id})`);
  }

  const result: SeedResult = {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceCreated,
    apiKey,
    apiKeyId,
    apiKeyCreated,
    keyFile: fs.existsSync(DEV_KEY_FILE) ? DEV_KEY_FILE : null,
    presetId: preset.id,
    presetCreated
  };

  if (apiKey) {
    log('');
    log('  ┌──────────────────────────────────────────────────────────────┐');
    log('  │  Reelforge API key — shown once, copy it now:                │');
    log('  └──────────────────────────────────────────────────────────────┘');
    log(`  ${apiKey}`);
    log('');
    log(`  curl -H "X-API-Key: ${apiKey}" http://127.0.0.1:4400/api/demos`);
  } else if (!workspaceCreated && !presetCreated) {
    log('[seed] nothing to do — workspace, key and preset already exist (idempotent).');
  }

  return result;
}

const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (invokedDirectly) {
  const result = seedDefaultWorkspace();
  if (result.apiKeyCreated) {
    console.log('[seed] done. The key above is stored hashed; it cannot be shown again.');
  } else {
    console.log(`[seed] done. ${result.keyFile ? `Key file: ${result.keyFile}` : 'No key file written.'}`);
  }
}