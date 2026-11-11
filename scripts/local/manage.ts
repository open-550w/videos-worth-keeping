/** Service lifecycle in TypeScript. macOS uses launchd; Linux uses detached groups. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { settings, root } from '../runtime.ts';

const { env, data } = settings();
const pidDir = path.join(data, 'pids');
const logDir = path.join(data, 'logs');
const tsx = fileURLToPath(import.meta.resolve('tsx'));
const runner = path.join(root, 'scripts/run.ts');
const prefix = `com.videos-worth-keeping.local.${createHash('sha1').update(root + '\0' + data).digest('hex').slice(0, 12)}`;
type Service = 'backend' | 'web';
interface ServiceRecord { listenerPid: number; launcherPid?: number }
const ports: { [K in Service]: number } = { backend: Number(env.PORT), web: Number(env.WEB_PORT) };
const services: Service[] = ['backend', 'web'];
for (const port of Object.values(ports)) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535 的整数');
fs.mkdirSync(pidDir, { recursive: true }); fs.mkdirSync(logDir, { recursive: true });

function command(program: string, args: string[]) {
  const result = spawnSync(program, args, { cwd: root, encoding: 'utf8', env });
  if (result.error) throw result.error;
  return result;
}
function checked(program: string, args: string[]) {
  const result = command(program, args);
  if (result.status !== 0) throw new Error(`${program} 失败 (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}
function listeners(port: number): number[] {
  const result = command('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN']);
  // lsof exits 1 for an empty result. Errors must never look like a free port.
  if (result.status === 1 && !result.stdout && !result.stderr) return [];
  if (result.status !== 0) throw new Error(`无法检查端口 ${port}: ${result.stderr}`);
  return [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
}
function readRecord(name: Service): ServiceRecord | null {
  const file = path.join(pidDir, `${name}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as ServiceRecord;
  const legacy = path.join(pidDir, `${name}.pid`);
  return fs.existsSync(legacy) ? { listenerPid: Number(fs.readFileSync(legacy, 'utf8')) } : null;
}
function group(pid: number): number | null {
  const result = command('ps', ['-o', 'pgid=', '-p', String(pid)]);
  if (result.status === 1 && !result.stdout.trim()) return null;
  if (result.status !== 0) throw new Error(`无法读取 PID ${pid} 的进程组: ${result.stderr}`);
  return Number(result.stdout.trim());
}
function signal(pid: number, sig: NodeJS.Signals) {
  try { process.kill(pid, sig); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
function logTail(name: Service, count: number): string {
  const file = path.join(logDir, `${name}.log`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-count).join('\n') : '（日志为空）';
}
async function stopService(name: Service) {
  const saved = readRecord(name);
  if (process.platform === 'darwin') {
    const result = command('launchctl', ['remove', `${prefix}.${name}`]);
    if (result.status !== 0 && !/could not find|no such process|not found/i.test(result.stderr)) {
      // launchctl uses varying exit codes for an absent submitted job; verify the label.
      const exists = command('launchctl', ['list', `${prefix}.${name}`]);
      if (exists.status === 0) throw new Error(result.stderr || 'launchctl remove failed');
    }
  } else if (saved?.launcherPid && group(saved.launcherPid) === saved.launcherPid) {
    const cmd = command('ps', ['-o', 'command=', '-p', String(saved.launcherPid)]).stdout;
    if (cmd.includes(runner)) signal(-saved.launcherPid, 'SIGTERM');
  }
  for (let i = 0; i < 20 && listeners(ports[name]).includes(saved?.listenerPid ?? -1); i++) await delay(100);
  const active = listeners(ports[name]);
  if (active.length) {
    if (!saved || active.some(pid => pid !== saved.listenerPid)) {
      console.log(`  ${name}: 端口 ${ports[name]} 属于其它进程，未停止该进程`);
      return;
    }
    signal(saved.listenerPid, 'SIGTERM'); await delay(300);
    if (listeners(ports[name]).includes(saved.listenerPid)) signal(saved.listenerPid, 'SIGKILL');
  }
  for (const extension of ['pid', 'json', 'env.json']) fs.rmSync(path.join(pidDir, `${name}.${extension}`), { force: true });
  console.log(`  ${name} 已停止`);
}
async function ping(attempts = 1) {
  if (!Number.isInteger(attempts) || attempts < 1) throw new Error('DB_CHECK_ATTEMPTS 必须为正整数');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = command(process.execPath, ['--import', tsx, runner, 'ping']);
    if (result.status === 0) { console.log(result.stdout.trim().split('\n').at(-1)); return; }
    if (attempt === attempts) throw new Error(result.stderr || result.stdout || '数据库连接失败');
    await delay(1500);
  }
}
function ensureDependencies() {
  if (!['packages/web/node_modules/vite', 'packages/backend/node_modules/koa'].every(p => fs.existsSync(path.join(root, p)))) {
    const cli = process.env.npm_execpath;
    if (!cli) throw new Error('请先运行 pnpm install');
    checked(process.execPath, [cli, 'install', '--frozen-lockfile']);
  }
}
async function launch(name: Service) {
  const environmentFile = path.join(pidDir, `${name}.env.json`);
  const serviceEnv = Object.fromEntries(Object.entries(env).filter(([key]) => /^(?:APP_|DB_|BILI_|CACHE_|PROBE_|PORT$|WEB_PORT$|ACCESS_TOKEN$|UPLOAD_DIR$|LOG_LEVEL$|CORS_ORIGIN$|NODE_ENV$|STORAGE_PROVIDER$|MAX_UPLOAD_MB$|PATH$|HOME$|TMPDIR$)/.test(key)));
  fs.writeFileSync(environmentFile, JSON.stringify(serviceEnv), { mode: 0o600 });
  const args = ['--import', tsx, runner, name === 'backend' ? 'dev' : 'web', `--service-env=${environmentFile}`];
  let launcherPid: number | undefined;
  let exited = false;
  if (process.platform === 'darwin') {
    checked('launchctl', ['submit', '-l', `${prefix}.${name}`, '-o', path.join(logDir, `${name}.log`), '-e', path.join(logDir, `${name}.log`), '--', process.execPath, ...args]);
  } else {
    const output = fs.openSync(path.join(logDir, `${name}.log`), 'a');
    try {
      const child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ['ignore', output, output] });
      child.on('error', () => { exited = true; }); child.on('exit', () => { exited = true; });
      launcherPid = child.pid; child.unref();
    } finally { fs.closeSync(output); }
  }
  for (let i = 0; i < 120; i++) {
    const active = listeners(ports[name]);
    if (active.length === 1) {
      const cwd = checked('lsof', ['-a', '-p', String(active[0]), '-d', 'cwd', '-Fn']).split('\n').find(line => line.startsWith('n'))?.slice(1);
      const expected = fs.realpathSync(path.join(root, 'packages', name === 'backend' ? 'backend' : 'web'));
      if (!cwd || fs.realpathSync(cwd) !== expected) {
        if (process.platform === 'darwin') command('launchctl', ['remove', `${prefix}.${name}`]);
        else if (launcherPid) signal(-launcherPid, 'SIGTERM');
        throw new Error(`端口 ${ports[name]} 的监听进程不属于当前服务`);
      }
      const record: ServiceRecord = { listenerPid: active[0], launcherPid };
      fs.writeFileSync(path.join(pidDir, `${name}.json`), JSON.stringify(record));
      fs.writeFileSync(path.join(pidDir, `${name}.pid`), String(record.listenerPid));
      console.log(`  ${name}: http://localhost:${ports[name]} (PID=${record.listenerPid})`); return;
    }
    if (exited) break;
    await delay(500);
  }
  // A timed-out watcher must not come alive later after start already reported failure.
  if (process.platform === 'darwin') command('launchctl', ['remove', `${prefix}.${name}`]);
  else if (launcherPid) signal(-launcherPid, 'SIGTERM');
  throw new Error(`${name} 启动失败\n${logTail(name, 20)}`);
}
async function start() {
  ensureDependencies();
  for (const name of services) {
    const saved = readRecord(name);
    if (listeners(ports[name]).some(pid => pid !== saved?.listenerPid)) throw new Error(`端口 ${ports[name]} 已被其它服务占用，未停止该服务`);
  }
  await ping(Number(env.DB_CHECK_ATTEMPTS ?? 3));
  for (const name of services) await stopService(name);
  try { for (const name of services) await launch(name); }
  catch (error) { for (const name of services) await stopService(name); throw error; }
  const lan = Object.values(os.networkInterfaces()).flat().find(i => i?.family === 'IPv4' && !i.internal);
  if (lan) console.log(`同一 WiFi: http://${lan.address}:${ports.web}`);
}
async function status() {
  const callerGroup = group(process.pid);
  for (const name of services) {
    const pid = listeners(ports[name])[0];
    if (!pid) { console.log(`${name}: 未运行 (端口 ${ports[name]})`); continue; }
    const pgid = group(pid);
    console.log(`${name}: PID=${pid}, 端口=${ports[name]}, pgid=${pgid}, ${pgid === null ? '进程组未知' : pgid === callerGroup ? '和当前会话同组' : '已脱离当前会话'}`);
  }
  await ping();
}
async function dev() {
  const children = services.map(name => spawn(process.execPath, ['--import', tsx, runner, name === 'backend' ? 'dev' : 'web'], { cwd: root, env, stdio: 'inherit' }));
  const stop = () => children.forEach(child => child.kill('SIGTERM'));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  for (const child of children) child.on('exit', code => { stop(); if (!process.exitCode) process.exitCode = code ?? 1; });
}
try {
  const [action, name, lines = '30'] = process.argv.slice(2);
  switch (action) {
    case 'start': await start(); break;
    case 'stop': for (const service of services) await stopService(service); break;
    case 'status': await status(); break;
    case 'dev': await dev(); break;
    case 'log': {
      const count = Number(lines);
      if (!Number.isInteger(count) || count < 1) throw new Error('日志行数必须是正整数');
      for (const service of services.filter(s => !name || name === 'both' || name === s)) console.log(`── ${service} ──\n${logTail(service, count)}`);
      break;
    }
    default: throw new Error('Usage: pnpm start | stop | status | log [backend|web] [lines] | dev');
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
