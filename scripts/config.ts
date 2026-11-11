import fs from 'node:fs';
import path from 'node:path';
import { settings, root } from './runtime.ts';
const [cmd = 'show', value] = process.argv.slice(2);
if (cmd === 'use') {
  if (!value || !/^[\w-]+$/.test(value)) throw new Error('Usage: pnpm app:config use <profile>');
  const locator = path.join(root, '.env.local');
  let text = fs.existsSync(locator) ? fs.readFileSync(locator, 'utf8') : '';
  text = text.replace(/^APP_PROFILE=.*\n?/m, '');
  fs.writeFileSync(locator, `${text.trim()}\nAPP_PROFILE=${value}\n`, { mode: 0o600 });
}
if (!['show', 'use'].includes(cmd)) throw new Error('Usage: pnpm app:config [use <profile>]');
const { config, data, profile } = settings();
console.log(`Profile: ${profile}\nConfig: ${config}\nData: ${data}\nRestart after changing configuration: pnpm stop && pnpm start`);
