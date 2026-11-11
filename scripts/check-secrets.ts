import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
import { settings, root } from './runtime.ts';
const git = (args: string[]) => execFileSync('git', args, { cwd: root });
const { config, env, data } = settings();
const needles = [randomBytes(32).toString('hex')];
for (const file of [...fs.readdirSync(path.join(data, 'config')).filter(f => f.endsWith('.env')).map(f => path.join(data, 'config', f)), path.join(root, 'packages/backend/.env.local')]) {
  if (!fs.existsSync(file)) continue;
  for (const [key, val] of Object.entries(parseEnv(fs.readFileSync(file, 'utf8'))))
    if (/PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE/.test(key) && val && val.length >= 8) needles.push(val);
}
for (const file of [env.BILI_COOKIE_PATH, path.join(root, 'packages/backend/.cache/bili-cookies.json')]) {
  if (fs.existsSync(file)) for (const c of JSON.parse(fs.readFileSync(file, 'utf8'))) if (c.value?.length >= 16) needles.push(c.value);
}
const scan = (blob: Buffer) => needles.some(n => blob.includes(Buffer.from(n)));
// Positive control uses an isolated index, never changes the user's staging area.
fs.mkdirSync(path.join(root, '.data'), { recursive: true });
const temporary = fs.mkdtempSync(path.join(root, '.data/secret-check-'));
try {
  const index = path.join(temporary, 'index');
  const canary = path.join(temporary, 'canary');
  fs.writeFileSync(canary, needles[0], { mode: 0o600 });
  const opts = { cwd: root, env: { ...process.env, GIT_INDEX_FILE: index } };
  execFileSync('git', ['read-tree', '--empty'], opts);
  execFileSync('git', ['add', '-f', canary], opts);
  if (!scan(execFileSync('git', ['show', ':' + path.relative(root, canary)], opts))) throw new Error('Positive control failed');
  console.log('正控通过：能识别暂存内容里的秘密');
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
let failures = 0;
// Scan the complete index, including unchanged files, with exact staged bytes.
for (const file of git(['ls-files', '-z']).toString().split('\0').filter(Boolean)) {
  const blob = git(['show', ':' + file]);
  if (scan(blob)) { console.error(`秘密出现在暂存文件: ${file}`); failures++; }
}
if (failures) process.exit(1);
console.log('整个暂存树未匹配到已配置的秘密');
