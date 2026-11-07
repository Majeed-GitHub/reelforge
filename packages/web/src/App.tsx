import { Component, useCallback, useEffect, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { api, getApiKey, hasSeenOnboarding, markOnboarded, setApiKey } from './api.ts';
import { privacyEnabled, setPrivacyEnabled, usePrivacy } from './privacy.ts';
import type { Route } from './router.ts';
import { navigate, sectionOf, useRoute } from './router.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { TopBar } from './components/TopBar.tsx';
import type { HealthState } from './components/TopBar.tsx';
import { PrivacyBanner } from './components/Privacy.tsx';
import { Banner } from './components/ui.tsx';
import { Icon } from './components/icons.tsx';
import { DemosScreen } from './screens/DemosScreen.tsx';
import { NewDemoScreen } from './screens/NewDemoScreen.tsx';
import { DemoDetailScreen } from './screens/DemoDetailScreen.tsx';
import { GraphScreen } from './screens/GraphScreen.tsx';
import { ArticlesScreen } from './screens/ArticlesScreen.tsx';
import { GuidesScreen } from './screens/GuidesScreen.tsx';
import { EnvironmentsScreen } from './screens/EnvironmentsScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import { OnboardingScreen } from './screens/OnboardingScreen.tsx';

export function App() {
  const route = useRoute();
  const [apiKey, setKey] = useState<string>(() => getApiKey());
  const [onboarded, setOnboarded] = useState<boolean>(() => hasSeenOnboarding());
  const [health, setHealth] = useState<HealthState>({ status: 'checking' });
  const [workspace, setWorkspace] = useState('Default workspace');
  const privacy = usePrivacy();
  const [toast, setToast] = useState<string | null>(null);

  const togglePrivacyMode = useCallback(() => {
    const next = !privacyEnabled();
    setPrivacyEnabled(next);
    setToast(next ? 'Privacy screen on — content masked.' : 'Privacy screen off — content visible.');
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Shift+P toggles the privacy screen, except while typing into a field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== 'P' && event.key !== 'p') return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return;
      event.preventDefault();
      togglePrivacyMode();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePrivacyMode]);

  // Public health probe: drives the top-bar indicator, never blocks a screen.
  useEffect(() => {
    let alive = true;
    const probe = () => {
      api
        .health()
        .then((result) => {
          if (alive) setHealth({ status: 'online', version: result.version, features: result.features });
        })
        .catch(() => {
          if (alive) setHealth({ status: 'offline' });
        });
    };
    probe();
    const id = window.setInterval(probe, 20_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (!apiKey) {
      setWorkspace('Default workspace');
      return;
    }
    let alive = true;
    api
      .workspace()
      .then((info) => {
        if (alive && info.name) setWorkspace(info.name);
      })
      .catch(() => {
        /* the workspace name is decoration; a 404 must not break the shell */
      });
    return () => {
      alive = false;
    };
  }, [apiKey]);

  useEffect(() => {
    document.title = `${titleFor(route)} · Reelforge`;
  }, [route]);

  useEffect(() => {
    if (!window.location.hash) navigate('/demos');
  }, []);

  const connect = useCallback((key: string) => {
    setApiKey(key);
    setKey(key);
    markOnboarded();
    setOnboarded(true);
  }, []);

  const skip = useCallback(() => {
    markOnboarded();
    setOnboarded(true);
  }, []);

  if (!apiKey && !onboarded) {
    return <OnboardingScreen health={health} onConnect={connect} onSkip={skip} />;
  }

  return (
    <div className="app">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          // The hash is the router; a real #main jump would navigate away.
          event.preventDefault();
          const main = document.getElementById('main');
          if (main) main.focus();
        }}
      >
        Skip to content
      </a>

      <Sidebar section={sectionOf(route)} />

      <div className="content">
        <TopBar workspace={workspace} health={health} apiKey={apiKey} privacy={privacy} onTogglePrivacy={togglePrivacyMode} />
        {privacy ? <PrivacyBanner /> : null}
        <main id="main" className="main" tabIndex={-1}>
          <RouteBoundary key={routeKey(route)}>
            <Screen route={route} apiKey={apiKey} onKeyChange={connect} />
          </RouteBoundary>
        </main>
      </div>

      {toast ? (
        <div className="toast-stack" role="status" aria-live="polite">
          <div className={`toast ${privacy ? 'toast-ok' : ''}`}>{toast}</div>
        </div>
      ) : null}
    </div>
  );
}

function Screen({ route, apiKey, onKeyChange }: { route: Route; apiKey: string; onKeyChange: (key: string) => void }) {
  switch (route.name) {
    case 'new-demo':
      return <NewDemoScreen />;
    case 'demo':
      return <DemoDetailScreen id={route.id} />;
    case 'graph':
      return <GraphScreen envId={route.envId} flowId={route.flowId} />;
    case 'articles':
      return <ArticlesScreen id={route.id} />;
    case 'guides':
      return <GuidesScreen id={route.id} />;
    case 'environments':
      return <EnvironmentsScreen />;
    case 'settings':
      return <SettingsScreen apiKey={apiKey} onKeyChange={onKeyChange} />;
    case 'demos':
    default:
      return <DemosScreen />;
  }
}

function routeKey(route: Route): string {
  switch (route.name) {
    case 'demo':
      return `demo:${route.id}`;
    case 'graph':
      return `graph:${route.envId ?? ''}:${route.flowId ?? ''}`;
    case 'articles':
      return `articles:${route.id ?? ''}`;
    case 'guides':
      return `guides:${route.id ?? ''}`;
    default:
      return route.name;
  }
}

function titleFor(route: Route): string {
  switch (route.name) {
    case 'new-demo':
      return 'New demo';
    case 'demo':
      return 'Demo';
    case 'graph':
      return 'Product Graph';
    case 'articles':
      return 'Articles';
    case 'guides':
      return 'Guides';
    case 'environments':
      return 'Environments';
    case 'settings':
      return 'Settings';
    default:
      return 'Demos';
  }
}

/**
 * A render error in one screen must never become a white page: the shell,
 * navigation and every other screen stay usable.
 */
class RouteBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[reelforge] screen render error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <Banner
          tone="error"
          title="This screen hit a render error"
          actions={
            <>
              <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
                <Icon name="refresh" size={13} />
                Try again
              </button>
              <a className="btn btn-sm btn-ghost" href="#/demos">
                Back to demos
              </a>
            </>
          }
        >
          <p>{this.state.error.message}</p>
          <p style={{ marginTop: 6 }}>The rest of the dashboard is unaffected — the error is caught per screen.</p>
        </Banner>
      );
    }
    return this.props.children;
  }
}
