/** `reelforge init` — install the one thing `session` needs: Playwright Chromium. */
import { spawnSync } from 'node:child_process';

export async function runInit(flags: Record<string, string | boolean>): Promise<void> {
  const args = ['playwright', 'install', 'chromium'];
  if (flags['with-deps']) args.push('--with-deps');

  console.log(`\nInstalling Playwright Chromium…\n  npx ${args.join(' ')}\n`);
  const result = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });

  if (result.status !== 0) {
    console.error(
      '\n✖ Chromium install failed.\n' +
        (process.platform === 'linux'
          ? '  On Linux this is usually a missing OS library — retry with `reelforge init --with-deps` (may need sudo).\n'
          : '  Check your network and retry.\n')
    );
    process.exit(1);
  }
  console.log('\n✔ Chromium installed. `reelforge session <code>` is ready.\n');
}
