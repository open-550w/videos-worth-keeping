import fs from 'node:fs';
import path from 'node:path';
import { settings, root } from './runtime.mjs';
const [cmd = 'show', value] = process.argv.slice(2);
if (cmd === 'use') {
  if (!value || !/^[\w-]+$/.test(value)) throw new Error('Usage: pnpm app:config use <profile>');
  const locator = path.join(root, '.env.local');
  let text = fs.existsSync(locator) ? fs.readFileSync(locator, 'utf8') : '';
  text = text.replace(/^APP_PROFILE=.*\n?/m, '');
  fs.writeFileSync(locator, `${text.trim()}\nAPP_PROFILE=${value}\n`, { mode: 0o600 });
}
if (cmd === 'shell') {
  const { env, data } = settings();
  const values = { BACKEND_PORT: env.PORT, WEB_PORT: env.WEB_PORT, PID_DIR: path.join(data, 'pids'), LOG_DIR: path.join(data, 'logs') };
  for (const [key, v] of Object.entries(values)) console.log(`${key}='${v.replaceAll("'", "'\\''")}'`);
} else {
  const { config, data, profile } = settings();
  console.log(`Profile: ${profile}\nConfig: ${config}\nData: ${data}\nRestart after changing configuration: pnpm stop && pnpm start`);
}
