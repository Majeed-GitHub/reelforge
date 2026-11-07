import type { NavSection } from '../router.ts';
import { href } from '../router.ts';
import { BrandMark, Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';

type NavItem = {
  section: NavSection;
  label: string;
  icon: IconName;
  to: string;
  count?: number;
};

export function Sidebar({ section, counts }: { section: NavSection; counts?: Partial<Record<NavSection, number>> }) {
  const groups: Array<{ label: string; items: NavItem[] }> = [
    {
      label: 'Record',
      items: [
        { section: 'demos', label: 'Demos', icon: 'demos', to: href.demos(), count: counts?.demos },
        { section: 'graph', label: 'Product Graph', icon: 'graph', to: href.graph() }
      ]
    },
    {
      label: 'Publish',
      items: [
        { section: 'articles', label: 'Articles', icon: 'articles', to: href.articles(), count: counts?.articles },
        { section: 'guides', label: 'Guides', icon: 'guides', to: href.guides(), count: counts?.guides }
      ]
    },
    {
      label: 'Configure',
      items: [
        { section: 'environments', label: 'Environments', icon: 'environments', to: href.environments() },
        { section: 'settings', label: 'Settings', icon: 'settings', to: href.settings() }
      ]
    }
  ];

  return (
    <nav className="sidebar" aria-label="Main">
      <a className="brand" href={href.demos()} aria-label="Reelforge — go to demos">
        <BrandMark />
        <span>
          <span className="brand-name">Reelforge</span>
          <span className="brand-tag">Director</span>
        </span>
      </a>

      <div>
        {groups.map((group) => (
          <div key={group.label} style={{ marginBottom: 8 }}>
            <p className="nav-label">{group.label}</p>
            <div className="nav">
              {group.items.map((item) => (
                <a
                  key={item.section}
                  className={`nav-item ${section === item.section ? 'active' : ''}`}
                  href={item.to}
                  aria-current={section === item.section ? 'page' : undefined}
                >
                  <Icon name={item.icon} size={15} />
                  <span>{item.label}</span>
                  {typeof item.count === 'number' && item.count > 0 ? <span className="nav-count">{item.count}</span> : null}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <p className="side-note">
          One Product Graph.
          <br />
          Video, article, training doc, in-app guide.
        </p>
        <a className="side-note" href="#/settings" style={{ color: 'var(--text-2)' }}>
          API &amp; MCP snippets →
        </a>
      </div>
    </nav>
  );
}
