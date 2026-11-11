import { spawn } from 'node:child_process';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { settings, root } from './runtime.ts';
const environmentArg = process.argv.find(arg => arg.startsWith('--service-env='));
if (environmentArg) {
  Object.assign(process.env, JSON.parse(readFileSync(environmentArg.slice('--service-env='.length), 'utf8')));
  process.argv = process.argv.filter(arg => arg !== environmentArg);
}
const { env } = settings();
const [command, ...args] = process.argv.slice(2);
const entry: Record<string, string[]> = { dev: ['watch', 'src/index.ts'], migrate: ['src/db/migrate.cli.ts'], reset: ['src/db/reset.cli.ts'], ping: ['src/db/ping.cli.ts'], 'fetch:bili': ['src/services/bili/fetch.cli.ts'], 'backfill:bili-interactions': ['src/services/bili/backfill-interactions.cli.ts'] };
if (!command || (command !== 'web' && !entry[command])) throw new Error(`Unknown command ${command}`);
const child = spawn(process.execPath, command === 'web'
  ? [path.join(root, 'packages/web/node_modules/vite/bin/vite.js'), ...args]
  : [fileURLToPath(import.meta.resolve('tsx/cli')), ...entry[command], ...args],
  { cwd: path.join(root, 'packages', command === 'web' ? 'web' : 'backend'), env, stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
child.on('exit', code => process.exit(code ?? 1));
