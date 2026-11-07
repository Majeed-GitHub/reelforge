import { ApiError } from '../../../core/src/http.ts';
import { newId } from '../../../core/src/ids.ts';
import type { PresetRow } from '../../../core/src/types.ts';
import type { AuthContext } from '../auth.ts';
import { many, one, run } from '../dbq.ts';
import { safeJson } from '../util.ts';

export const DEFAULT_PRESET_CONFIG = {
  fps: 30,
  scaleHeight: 720,
  zoom: 1.6,
  watermark: true,
  language: 'en',
  voice: 'auto',
  maxSteps: 40,
  headless: true
};

export type PresetView = { id: string; name: string; config: Record<string, unknown>; isDefault: boolean };

function toView(row: PresetRow): PresetView {
  return {
    id: row.id,
    name: row.name,
    config: safeJson<Record<string, unknown>>(row.config_json) ?? {},
    isDefault: Boolean(row.is_default)
  };
}

export function listPresets(auth: AuthContext): PresetView[] {
  return many<PresetRow>(
    'SELECT * FROM presets WHERE workspace_id = ? ORDER BY is_default DESC, name ASC',
    auth.workspaceId
  ).map(toView);
}

export function getDefaultPreset(auth: AuthContext): PresetView | null {
  const row = one<PresetRow>(
    'SELECT * FROM presets WHERE workspace_id = ? ORDER BY is_default DESC, rowid ASC LIMIT 1',
    auth.workspaceId
  );
  return row ? toView(row) : null;
}

export function createPreset(
  auth: AuthContext,
  input: { name: string; config?: Record<string, unknown>; isDefault?: boolean }
): PresetView {
  const id = newId('prs');
  const makeDefault = input.isDefault === true;
  if (makeDefault) {
    run('UPDATE presets SET is_default = 0 WHERE workspace_id = ?', auth.workspaceId);
  }
  run(
    'INSERT INTO presets (id, workspace_id, name, config_json, is_default) VALUES (?, ?, ?, ?, ?)',
    id,
    auth.workspaceId,
    input.name,
    JSON.stringify({ ...DEFAULT_PRESET_CONFIG, ...(input.config ?? {}) }),
    makeDefault ? 1 : 0
  );
  const row = one<PresetRow>('SELECT * FROM presets WHERE id = ?', id);
  if (!row) throw new ApiError('INTERNAL_ERROR', 'Preset insert failed.');
  return toView(row);
}

/**
 * Narration voices, mirroring ARCHITECTURE §6's offline-first ladder. The list
 * is static on purpose: it describes what the renderer *can* do, and the
 * dashboard only needs labels + ids.
 */
const VOICES = [
  { id: 'auto', label: 'Auto (best available)', provider: 'auto', language: 'en' },
  { id: 'sapi', label: 'System Speech (offline)', provider: 'sapi', language: 'en' },
  { id: 'sapi:en-US', label: 'System Speech · English (US)', provider: 'sapi', language: 'en-US' },
  { id: 'sapi:en-GB', label: 'System Speech · English (UK)', provider: 'sapi', language: 'en-GB' },
  { id: 'sapi:hi-IN', label: 'System Speech · Hindi', provider: 'sapi', language: 'hi-IN' },
  { id: 'edge', label: 'Edge neural (edge-tts)', provider: 'edge', language: 'en-US' },
  { id: 'openai:alloy', label: 'OpenAI · alloy', provider: 'openai', language: 'en' },
  { id: 'openai:nova', label: 'OpenAI · nova', provider: 'openai', language: 'en' },
  { id: 'openai:shimmer', label: 'OpenAI · shimmer', provider: 'openai', language: 'en' },
  { id: 'none', label: 'Silent (burned captions only)', provider: 'none', language: 'en' }
] as const;

export function listVoices(): { voices: typeof VOICES; defaultVoice: string } {
  return { voices: VOICES, defaultVoice: 'auto' };
}