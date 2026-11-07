import { useEffect, useState } from 'react';

/**
 * Hash router.
 *
 * Hash routing keeps the dashboard trivially mountable behind the API's static
 * file handler (no history fallback needed on the server), and makes every
 * screen deep-linkable from a log line or a Slack message.
 */
export type Route =
  | { name: 'demos' }
  | { name: 'new-demo' }
  | { name: 'demo'; id: string }
  | { name: 'graph'; envId?: string; flowId?: string }
  | { name: 'articles'; id?: string }
  | { name: 'guides'; id?: string }
  | { name: 'environments' }
  | { name: 'settings' };

export const NAV_SECTIONS = [
  'demos',
  'graph',
  'articles',
  'guides',
  'environments',
  'settings'
] as const;

export type NavSection = (typeof NAV_SECTIONS)[number];

export function parseHash(hash: string): Route {
  const parts = (hash || '').replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'demos' };
  switch (parts[0]) {
    case 'demos':
      if (parts[1] === 'new') return { name: 'new-demo' };
      if (parts[1]) return { name: 'demo', id: decodeURIComponent(parts[1]) };
      return { name: 'demos' };
    case 'graph':
      return { name: 'graph', envId: parts[1], flowId: parts[2] };
    case 'articles':
      return { name: 'articles', id: parts[1] };
    case 'guides':
      return { name: 'guides', id: parts[1] };
    case 'environments':
      return { name: 'environments' };
    case 'settings':
      return { name: 'settings' };
    default:
      return { name: 'demos' };
  }
}

/** Which sidebar entry owns the current route. */
export function sectionOf(route: Route): NavSection {
  if (route.name === 'new-demo' || route.name === 'demo') return 'demos';
  return route.name;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigate(to: string): void {
  const next = to.startsWith('#') ? to : `#${to}`;
  if (window.location.hash === next) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  window.location.hash = next;
}

export const href = {
  demos: () => '#/demos',
  newDemo: () => '#/demos/new',
  demo: (id: string) => `#/demos/${encodeURIComponent(id)}`,
  graph: (envId?: string, flowId?: string) =>
    envId ? `#/graph/${encodeURIComponent(envId)}${flowId ? `/${encodeURIComponent(flowId)}` : ''}` : '#/graph',
  articles: (id?: string) => (id ? `#/articles/${encodeURIComponent(id)}` : '#/articles'),
  guides: (id?: string) => (id ? `#/guides/${encodeURIComponent(id)}` : '#/guides'),
  environments: () => '#/environments',
  settings: () => '#/settings'
};
