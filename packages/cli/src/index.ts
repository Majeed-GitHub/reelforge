#!/usr/bin/env node
/**
 * Reelforge CLI.
 *
 *   reelforge session DIR-XXXX-XXXX-XXXX   capture a signed-in browser session
 *   reelforge mcp                          wire the MCP server into your agent
 *   reelforge init                         install Playwright Chromium
 *   reelforge doctor                       check this machine
 *
 * The session command is the one thing an API key cannot do for you: it logs
 * into *your* product in a real browser (SSO, 2FA, magic link) and uploads the
 * resulting session, never your password. Same model as Director's CLI.
 */
import { runSession } from './session.ts';
import { runMcp } from './mcp.ts';
import { runDoctor } from './doctor.ts';
import { runInit } from './init.ts';

const HELP = `
Reelforge CLI

  reelforge session [code]        capture a signed-in browser session
      DIR-XXXX-XXXX-XXXX            login code from the dashboard
      --environment <id>            attach to a saved environment (with --api-key)
      --name <name> --base-url <url> create an environment inline
      --start-url <url>             page to open for signing in
      --timeout <minutes>           how long to leave the browser open (default 10)
      --api-url <url>               API base (or $REELFORGE_API_URL)
      --api-key <key>               API key (or $REELFORGE_API_KEY)

  reelforge mcp                   connect the MCP server to a coding agent
      --api-key <key>               API key (or $REELFORGE_API_KEY)
      --agent <name>                claude-code | cursor | claude-desktop (repeatable)
      -g, --global                  write the agent's global config
      -y, --yes                     skip confirmation

  reelforge init [--with-deps]    install Playwright Chromium
  reelforge doctor                check Node, Chromium, API and credentials
  reelforge --help

Environment:
  REELFORGE_API_URL   default http://127.0.0.1:4400/api
  REELFORGE_API_KEY   rg_… key from the dashboard
`.trim();

function parse(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      flags.help = true;
      continue;
    }
    if (token === '-g' || token === '--global') {
      flags.global = true;
      continue;
    }
    if (token === '-y' || token === '--yes') {
      flags.yes = true;
      continue;
    }
    if (token === '--with-deps') {
      flags['with-deps'] = true;
      continue;
    }
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=');
      if (inline !== undefined) {
        flags[name] = inline;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[name] = next;
          i++;
        } else {
          flags[name] = true;
        }
      }
      continue;
    }
    positional.push(token);
  }
  return { command: positional.shift() ?? '', args: positional, flags };
}

async function main(): Promise<void> {
  const { command, args, flags } = parse(process.argv.slice(2));

  if (!command || flags.help || command === 'help') {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'session':
      await runSession(args, flags);
      return;
    case 'mcp':
      await runMcp(flags);
      return;
    case 'doctor':
      await runDoctor(flags);
      return;
    case 'init':
      await runInit(flags);
      return;
    case 'update':
      console.log('Reelforge is installed from source in this repository — `git pull` to update.');
      return;
    default:
      console.error(`\n✖ Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\n✖ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
