import { maskKey } from '../api.ts';
import { href } from '../router.ts';
import { Icon } from './icons.tsx';
import { PrivacyToggle } from './Privacy.tsx';

export type HealthState = {
  status: 'checking' | 'online' | 'offline';
  version?: string;
  features?: string[];
};

/**
 * Top bar: who you are recording for (workspace), whether the API is answering,
 * which key this browser is using, and the privacy-screen switch that hides
 * demo content from anyone watching your shared screen.
 */
export function TopBar({
  workspace,
  health,
  apiKey,
  privacy,
  onTogglePrivacy
}: {
  workspace: string;
  health: HealthState;
  apiKey: string;
  privacy: boolean;
  onTogglePrivacy: () => void;
}) {
  const healthLabel = health.status === 'online' ? 'API online' : health.status === 'offline' ? 'API unreachable' : 'Checking API';
  const healthClass =
    health.status === 'online' ? 'pill pill-complete' : health.status === 'offline' ? 'pill pill-failed' : 'pill pill-neutral';

  return (
    <header className="topbar">
      <div className="workspace">
        <span className="eyebrow">Workspace</span>
        <span className="workspace-name">{workspace}</span>
      </div>
      <div className="topbar-right">
        <span className={healthClass} title={health.version ? `Reelforge API v${health.version}` : 'GET /api/health'}>
          <span className="dot" />
          {healthLabel}
        </span>
        {apiKey ? (
          <a className="pill pill-neutral" href={href.settings()} title="API key in use — click to manage">
            <Icon name="key" size={12} />
            <span className="mono">{maskKey(apiKey)}</span>
          </a>
        ) : (
          <a className="pill pill-failed" href={href.settings()} title="No API key stored in this browser">
            <Icon name="warning" size={12} />
            No API key
          </a>
        )}
        <PrivacyToggle enabled={privacy} onToggle={onTogglePrivacy} />
      </div>
    </header>
  );
}
