import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { root } from '../runtime.ts';

async function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/local/manage.ts', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const [code] = await once(child, 'exit');
  return { code, output };
}
async function reserve() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: (server.address() as net.AddressInfo).port };
}
test('lifecycle isolates ports and data, reports detached groups, stops its jobs, and refuses an occupied port', { timeout: 120_000 }, async () => {
  const parent = path.join(root, '.data/tests'); fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'lifecycle-'));
  const backend = await reserve(); const web = await reserve();
  const env: NodeJS.ProcessEnv = { ...process.env, APP_DATA_MODE: 'custom', APP_DATA_DIR: dir, APP_PROFILE: 'test', PORT: String(backend.port), WEB_PORT: String(web.port), DB_CLIENT: 'sqlite', PROBE_ENABLED: '0' };
  await new Promise<void>(resolve => web.server.close(() => resolve()));
  try {
    // Positive control: a known occupied port must be rejected without killing its owner.
    const conflict = await run(env, 'start');
    assert.notEqual(conflict.code, 0); assert.match(conflict.output, /已被其它服务占用/);
    assert.ok(backend.server.listening);
    await new Promise<void>(resolve => backend.server.close(() => resolve()));
    const started = await run(env, 'start'); assert.equal(started.code, 0, started.output);
    const config = fs.readFileSync(path.join(dir, 'config/test.env'), 'utf8');
    const token = /^ACCESS_TOKEN=(.+)$/m.exec(config)![1];
    const health = await fetch(`http://localhost:${backend.port}/api/health`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200); assert.equal((await health.json() as {data:{database:{client:string}}}).data.database.client, 'sqlite');
    const status = await run(env, 'status'); assert.equal(status.code, 0, status.output);
    assert.equal(status.output.match(/已脱离当前会话/g)?.length, 2, status.output);
    assert.equal(fs.statSync(path.join(dir, 'pids/backend.env.json')).mode & 0o777, 0o600);
    const logs = await run(env, 'log', 'backend', '10'); assert.equal(logs.code, 0, logs.output); assert.match(logs.output, /server started/);
    const stopped = await run(env, 'stop'); assert.equal(stopped.code, 0, stopped.output);
    await assert.rejects(fetch(`http://localhost:${backend.port}/api/health`));
    assert.ok(!fs.existsSync(path.join(dir, 'pids/backend.env.json')));
  } finally {
    backend.server.close(); await run(env, 'stop'); fs.rmSync(dir, { recursive: true, force: true });
  }
});
