import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readEnv = (file: string): NodeJS.ProcessEnv => fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
export function settings({ create = true } = {}) {
  const locator = { ...readEnv(path.join(root, '.env.local')), ...process.env };
  const mode = locator.APP_DATA_MODE ?? 'project';
  if (!['project', 'xdg', 'custom'].includes(mode)) throw new Error('APP_DATA_MODE must be project, xdg or custom');
  if (mode === 'custom' && !locator.APP_DATA_DIR) throw new Error('custom mode requires APP_DATA_DIR');
  const data = path.resolve(mode === 'xdg' ? path.join(os.homedir(), '.local/share/videos-worth-keeping') : locator.APP_DATA_DIR ?? path.join(root, '.data'));
  const profile = locator.APP_PROFILE ?? 'default';
  if (!/^[\w-]+$/.test(profile)) throw new Error('Invalid APP_PROFILE');
  const config = path.join(data, 'config', `${profile}.env`);
  if (!fs.existsSync(config) && create) {
    fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
    fs.writeFileSync(config, `DB_CLIENT=sqlite\nPORT=3050\nWEB_PORT=5190\nACCESS_TOKEN=${randomBytes(32).toString('hex')}\nPROBE_ENABLED=0\n`, { mode: 0o600 });
  }
  const env: NodeJS.ProcessEnv & { APP_DATA_DIR: string; APP_PROFILE: string } = { ...readEnv(config), ...process.env, APP_DATA_DIR: data, APP_PROFILE: profile };
  env.SQLITE_PATH = path.resolve(data, env.SQLITE_PATH ?? `db/${profile}.sqlite`);
  env.UPLOAD_DIR = path.resolve(data, env.UPLOAD_DIR ?? `uploads/${profile}`);
  env.BILI_CACHE_DIR = path.resolve(data, env.BILI_CACHE_DIR ?? `cache/${profile}/bili-detail`);
  env.BILI_COOKIE_PATH = path.resolve(data, env.BILI_COOKIE_PATH ?? `cache/${profile}/bili-cookies.json`);
  env.PORT ??= '3050'; env.WEB_PORT ??= '5190';
  env.VITE_PORT = env.WEB_PORT;
  env.VITE_API_TARGET = `http://localhost:${env.PORT}`;
  env.APP_CONFIG_FILE = config;
  return { env: env as NodeJS.ProcessEnv & Record<'APP_DATA_DIR' | 'APP_PROFILE' | 'SQLITE_PATH' | 'UPLOAD_DIR' | 'BILI_CACHE_DIR' | 'BILI_COOKIE_PATH' | 'PORT' | 'WEB_PORT' | 'ACCESS_TOKEN', string>, data, config, profile };
}
