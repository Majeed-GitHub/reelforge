import http from 'node:http';
import { DEMO_SITE_PORT } from '../../packages/core/src/config.ts';

/**
 * A tiny but *real* SaaS to demo against: sign in -> dashboard -> create a
 * project -> invite a teammate -> upgrade the plan. Deliberately built from
 * plain HTML forms and `data-testid` hooks so the browser agent has stable
 * targets, and so the flow survives full page navigations (not just a SPA).
 *
 * State is in memory: restart the server and it resets with the seeded project.
 */

type Project = { id: string; name: string; owner: string; createdAt: string };
type Member = { email: string; role: string };
type State = {
  authed: boolean;
  projects: Project[];
  members: Member[];
  plan: 'Free' | 'Team';
};

function newState(): State {
  return {
    authed: false,
    projects: [
      { id: 'p_acme', name: 'Acme Launch', owner: 'Ada', createdAt: '2026-10-02' },
      { id: 'p_docs', name: 'Docs Rewrite', owner: 'Ada', createdAt: '2026-09-14' }
    ],
    members: [{ email: 'ada@example.com', role: 'Owner' }],
    plan: 'Free'
  };
}

let state = newState();

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Northwind</title>
<style>
  :root{--bg:#0b0d10;--panel:#14171c;--line:#232830;--text:#e8eaed;--muted:#9aa3b2;--accent:#5b8cff;--good:#39c07a}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  header{display:flex;align-items:center;gap:16px;padding:14px 28px;border-bottom:1px solid var(--line);background:#0f1216}
  .logo{font-weight:700;letter-spacing:-.02em;font-size:16px}
  .logo span{color:var(--accent)}
  nav{display:flex;gap:6px;margin-left:12px}
  nav a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:8px;font-size:14px}
  nav a:hover{background:#1b2027;color:var(--text)}
  nav a.active{background:#1b2027;color:#fff}
  main{max-width:880px;margin:36px auto;padding:0 24px}
  h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px}
  h2{font-size:17px;margin:28px 0 10px}
  p.sub{color:var(--muted);margin:0 0 22px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:12px}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px}
  .btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:9px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;text-decoration:none}
  .btn.secondary{background:#1e242c;color:var(--text);border:1px solid var(--line)}
  .btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
  input{width:100%;background:#0e1116;border:1px solid var(--line);border-radius:9px;color:var(--text);padding:10px 12px;font-size:14px;margin:6px 0 14px}
  label{font-size:13px;color:var(--muted);font-weight:600}
  table{width:100%;border-collapse:collapse}
  td,th{text-align:left;padding:10px 4px;border-bottom:1px solid var(--line);font-size:14px}
  th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .badge{display:inline-block;padding:2px 9px;border-radius:999px;background:#1e242c;color:var(--muted);font-size:12px;font-weight:600}
  .badge.good{background:rgba(57,192,122,.14);color:var(--good)}
  .muted{color:var(--muted)}
  .empty{padding:26px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:12px}
  .toast{background:rgba(57,192,122,.12);border:1px solid rgba(57,192,122,.35);color:#bff0d4;padding:10px 14px;border-radius:10px;margin-bottom:16px;font-size:14px}
</style></head>
<body>${body}</body></html>`;
}

function nav(active: string): string {
  const item = (href: string, label: string) => {
    const testId = href === '/app' ? 'nav-projects' : `nav-${href.split('/').pop()}`;
    return `<a href="${href}" data-testid="${testId}" class="${active === href ? 'active' : ''}">${label}</a>`;
  };
  return `<header>
    <div class="logo">north<span>wind</span></div>
    <nav>${item('/app', 'Projects')}${item('/app/team', 'Team')}${item('/app/billing', 'Billing')}</nav>
    <div style="margin-left:auto"><a class="btn ghost" href="/logout" data-testid="logout">Sign out</a></div>
  </header>`;
}

function landing(): string {
  return layout('Welcome', `<main>
    <h1>Northwind</h1>
    <p class="sub">Projects, teammates and plans for small teams.</p>
    <div class="card row">
      <div><strong>Start your workspace</strong><div class="muted">Two seeded projects, one owner.</div></div>
      <a class="btn" href="/login" data-testid="signin-link">Sign in</a>
    </div>
  </main>`);
}

function loginPage(error?: string): string {
  return layout('Sign in', `<main>
    <h1>Sign in</h1>
    <p class="sub">Use the demo account: <code>ada@example.com</code> / <code>northwind</code></p>
    ${error ? `<div class="card" style="border-color:#7a2d2d;color:#ffb4b4">${error}</div>` : ''}
    <form method="post" action="/login" class="card">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" value="ada@example.com" data-testid="email" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" value="northwind" data-testid="password" required>
      <button class="btn" type="submit" data-testid="login-submit">Sign in</button>
    </form>
  </main>`);
}

function projectsPage(created?: string, invited?: string): string {
  const cards = state.projects
    .map(
      (p) => `<div class="card row" data-testid="project-card">
        <div><strong>${p.name}</strong><div class="muted">Owner ${p.owner} · created ${p.createdAt}</div></div>
        <span class="badge good">Active</span>
      </div>`
    )
    .join('');
  return layout('Projects', `${nav('/app')}<main>
    <div class="row"><div><h1>Projects</h1><p class="sub">${state.projects.length} project(s) in this workspace</p></div>
      <a class="btn" href="/app/projects/new" data-testid="new-project">New project</a></div>
    ${created ? `<div class="toast">Project “${created}” created.</div>` : ''}
    ${invited ? `<div class="toast">Invitation sent to ${invited}.</div>` : ''}
    ${cards}
  </main>`);
}

function newProjectPage(): string {
  return layout('New project', `${nav('/app')}<main>
    <h1>New project</h1>
    <p class="sub">Give it a name. You can rename it later.</p>
    <form method="post" action="/app/projects" class="card">
      <label for="name">Project name</label>
      <input id="name" name="name" data-testid="project-name" placeholder="Q4 Launch" required>
      <button class="btn" type="submit" data-testid="create-project">Create project</button>
    </form>
  </main>`);
}

function teamPage(invited?: string): string {
  const rows = state.members
    .map((m) => `<tr><td>${m.email}</td><td class="muted">${m.role}</td></tr>`)
    .join('');
  return layout('Team', `${nav('/app/team')}<main>
    <h1>Team</h1>
    <p class="sub">${state.members.length} member(s)</p>
    ${invited ? `<div class="toast">Invitation sent to ${invited}.</div>` : ''}
    <div class="card">
      <h2 style="margin-top:0">Invite a teammate</h2>
      <form method="post" action="/app/team/invite">
        <label for="invite">Email address</label>
        <input id="invite" name="email" type="email" data-testid="invite-email" placeholder="sam@example.com" required>
        <button class="btn" type="submit" data-testid="invite-submit">Send invite</button>
      </form>
    </div>
    <table><thead><tr><th>Member</th><th>Role</th></tr></thead><tbody>${rows}</tbody></table>
  </main>`);
}

function billingPage(upgraded?: boolean): string {
  return layout('Billing', `${nav('/app/billing')}<main>
    <h1>Billing</h1>
    <p class="sub">You're on the <strong data-testid="current-plan">${state.plan}</strong> plan.</p>
    ${upgraded ? `<div class="toast">Upgraded to Team. Nice.</div>` : ''}
    <div class="card row">
      <div><strong>Team</strong><div class="muted">$29/month · unlimited members · 75 minutes of demo video</div></div>
      ${state.plan === 'Team'
        ? '<span class="badge good">Current plan</span>'
        : '<form method="post" action="/app/billing/upgrade"><button class="btn" type="submit" data-testid="upgrade-team">Upgrade to Team</button></form>'}
    </div>
    <div class="card row">
      <div><strong>Free</strong><div class="muted">$0 · 5 minutes of video · 1 seat</div></div>
      ${state.plan === 'Free' ? '<span class="badge">Current plan</span>' : ''}
    </div>
  </main>`);
}

function readForm(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const out: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(body)) out[k] = v;
      resolve(out);
    });
  });
}

function redirect(res: http.ServerResponse, location: string, headers: Record<string, string> = {}): void {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

function html(res: http.ServerResponse, body: string, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${DEMO_SITE_PORT}`);
  const path = url.pathname;
  const cookie = req.headers.cookie ?? '';
  if (cookie.includes('nw_session=1')) state.authed = true;

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/' ) {
    html(res, landing());
    return;
  }

  if (path === '/reset') {
    state = newState();
    redirect(res, '/');
    return;
  }

  if (path === '/login' && req.method === 'GET') {
    html(res, loginPage());
    return;
  }

  if (path === '/login' && req.method === 'POST') {
    const form = await readForm(req);
    if (form.email && form.password) {
      state.authed = true;
      // Headers must go out with writeHead: calling res.setHeader() after
      // redirect() has already ended the response throws ERR_HTTP_HEADERS_SENT
      // inside an async handler, which takes the whole process down.
      redirect(res, '/app?welcome=1', { 'Set-Cookie': 'nw_session=1; Path=/; SameSite=Lax' });
      return;
    }
    html(res, loginPage('Enter an email and a password.'), 400);
    return;
  }

  if (path === '/logout') {
    state.authed = false;
    res.writeHead(303, { Location: '/', 'Set-Cookie': 'nw_session=0; Path=/; Max-Age=0' });
    res.end();
    return;
  }

  // Everything under /app requires the session cookie.
  if (!path.startsWith('/app')) {
    html(res, layout('Not found', `<main><h1>404</h1><p class="sub">No page at ${path}</p></main>`), 404);
    return;
  }
  if (!state.authed) {
    redirect(res, '/login');
    return;
  }

  if (path === '/app' && req.method === 'GET') {
    html(res, projectsPage(url.searchParams.get('created') ?? undefined, url.searchParams.get('invited') ?? undefined));
    return;
  }

  if (path === '/app/projects/new' && req.method === 'GET') {
    html(res, newProjectPage());
    return;
  }

  if (path === '/app/projects' && req.method === 'POST') {
    const form = await readForm(req);
    const name = (form.name ?? '').trim();
    if (name) {
      state.projects.unshift({
        id: `p_${Date.now().toString(36)}`,
        name,
        owner: 'Ada',
        createdAt: new Date().toISOString().slice(0, 10)
      });
    }
    redirect(res, `/app?created=${encodeURIComponent(name)}`);
    return;
  }

  if (path === '/app/team' && req.method === 'GET') {
    html(res, teamPage(url.searchParams.get('invited') ?? undefined));
    return;
  }

  if (path === '/app/team/invite' && req.method === 'POST') {
    const form = await readForm(req);
    const email = (form.email ?? '').trim();
    if (email && !state.members.some((m) => m.email === email)) {
      state.members.push({ email, role: 'Member' });
    }
    redirect(res, `/app/team?invited=${encodeURIComponent(email)}`);
    return;
  }

  if (path === '/app/billing' && req.method === 'GET') {
    html(res, billingPage(url.searchParams.get('upgraded') === '1'));
    return;
  }

  if (path === '/app/billing/upgrade' && req.method === 'POST') {
    state.plan = 'Team';
    redirect(res, '/app/billing?upgraded=1');
    return;
  }

  html(res, layout('Not found', `<main><h1>404</h1><p class="sub">No page at ${path}</p></main>`), 404);
});

server.listen(DEMO_SITE_PORT, '127.0.0.1', () => {
  console.log(`[demo-site] Northwind running at http://127.0.0.1:${DEMO_SITE_PORT}`);
});
