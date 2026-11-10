import { spawn } from 'node:child_process';
import path from 'node:path';
import { settings, root } from './runtime.mjs';
const { env } = settings();
const [command, ...args] = process.argv.slice(2);
const entry = { dev: ['watch', 'src/index.ts'], migrate: ['src/db/migrate.cli.ts'], reset: ['src/db/reset.cli.ts'], ping: ['src/db/ping.cli.ts'], 'fetch:bili': ['src/services/bili/fetch.cli.ts'], 'backfill:bili-interactions': ['src/services/bili/backfill-interactions.cli.ts'] };
if (command !== 'web' && !entry[command]) throw new Error(`Unknown command ${command}`);
const child = spawn(process.execPath, command === 'web'
  ? [path.join(root, 'packages/web/node_modules/vite/bin/vite.js'), ...args]
  : [path.join(root, 'node_modules/tsx/dist/cli.mjs'), ...entry[command], ...args],
  { cwd: path.join(root, 'packages', command === 'web' ? 'web' : 'backend'), env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', code => process.exit(code ?? 1));
