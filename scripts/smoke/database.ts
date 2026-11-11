/** Disposable database/API matrix. Never touches the selected application database. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { query, execute, transaction, closePool } from "../../packages/backend/src/db/db.js";
import { upsertEntries, fillMissingBiliInteractions } from "../../packages/backend/src/dao/watchHistory.dao.js";
import { dueForCheck } from "../../packages/backend/src/dao/urlchecks.dao.js";
import { migrate } from "../../packages/backend/src/db/migrate.js";
import type { WatchRecord } from "../../packages/backend/src/services/bili/types.js";

const root = process.cwd();
const engine = process.argv[2] ?? "sqlite";
assert.ok(["sqlite", "mysql"].includes(engine));
await mkdir(path.join(root, ".data/tests"), { recursive: true });
const dir = await mkdtemp(path.join(root, ".data/tests/matrix-"));
const token = randomBytes(32).toString("hex");
const name = `likes_test_${Date.now()}`;
let admin: any;
let child: ReturnType<typeof spawn> | undefined;
let logs = "";
let assertions = 0;
function check(value: unknown, message: string) { assert.ok(value, message); assertions++; }
const env: NodeJS.ProcessEnv = {
  ...process.env, DB_CLIENT: engine, SQLITE_PATH: path.join(dir, "test.sqlite"),
  ACCESS_TOKEN: token, APP_DATA_DIR: dir, UPLOAD_DIR: path.join(dir, "uploads"),
  BILI_COOKIE_PATH: path.join(dir, "cookies.json"), BILI_CACHE_DIR: path.join(dir, "bili-detail"),
  PROBE_ENABLED: "0", LOG_LEVEL: "error", DB_POOL_SIZE: "1",
};
if (engine === "mysql") {
  const mysql = (await import("../../packages/backend/node_modules/mysql2/promise.js")).default;
  Object.assign(env, { DB_HOST: process.env.TEST_MYSQL_HOST ?? "127.0.0.1", DB_PORT: process.env.TEST_MYSQL_PORT ?? "3306", DB_USER: process.env.TEST_MYSQL_USER ?? "root", DB_PASSWORD: process.env.TEST_MYSQL_PASSWORD ?? "", DB_NAME: name });
  admin = await mysql.createConnection({ host: env.DB_HOST, port: Number(env.DB_PORT), user: env.DB_USER, password: env.DB_PASSWORD });
  await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}
Object.assign(process.env, env);
try {
  const first = await migrate();
  check(first.applied.length === 7, "fresh migration");
  check((await migrate()).applied.length === 0, "idempotent migration");
  // Get a free port without assuming the other worktrees' configuration.
  const reservation = net.createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(r => reservation.close(() => r()));
  child = spawn(process.execPath, ["--import", "tsx", "packages/backend/src/index.ts"], { cwd: root, env: { ...env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", b => { logs += b; }); child.stderr!.on("data", b => { logs += b; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    try { await fetch(base + "/api/health"); break; } catch { await new Promise(r => setTimeout(r, 100)); }
    if (child.exitCode !== null) throw new Error(logs);
  }
  const api = async (method: string, route: string, body?: unknown, auth = true) => {
    const r = await fetch(base + route, { method, headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any, headers: r.headers };
  };
  check((await api("GET", "/api/health", undefined, false)).status === 401, "anonymous API blocked");
  check((await api("GET", "/uploads/items/1/private.png", undefined, false)).status === 401, "anonymous attachments blocked");
  check((await api("GET", `/?token=${token}`, undefined, false)).status === 401, "URL token rejected");
  check((await api("POST", "/api/auth/login", { token: "wrong" }, false)).status === 401, "wrong token rejected");
  const login = await api("POST", "/api/auth/login", { token }, false);
  const cookie = login.headers.get("set-cookie")!;
  check(login.status === 200 && /httponly/i.test(cookie) && /samesite=strict/i.test(cookie), "HttpOnly session");
  check((await fetch(base + "/api/health", { headers: { Cookie: cookie.split(";")[0] } })).status === 200, "cookie authenticates");
  const smoke = spawn(process.execPath, ["--import", "tsx", "scripts/smoke/api.ts"], { cwd: root, env: { ...env, SMOKE_BASE: base, SMOKE_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; smoke.stdout.on("data", b => { output += b; }); smoke.stderr.on("data", b => { output += b; });
  const [code] = await once(smoke, "exit");
  assert.equal(code, 0, output);
  console.log(`${engine}: ${output.match(/通过 \d+ \/ 失败 \d+/)?.[0]}`);
  const health = await api("GET", "/api/health");
  check(health.json.data.database.client === engine, "health reports selected database");
  // Concurrent rollback must never absorb another request's successful write.
  const before = await query<{ n: number }>("SELECT COUNT(*) n FROM items");
  const rollback = transaction(async conn => { await conn.execute("INSERT INTO items (title, collected_on) VALUES (?,?)", ["rollback", "2026-01-01"]); await new Promise(r => setTimeout(r, 40)); throw new Error("intentional rollback"); });
  const concurrent = execute("INSERT INTO items (title, collected_on) VALUES (?,?)", ["committed", "2026-01-01"]);
  await assert.rejects(rollback, /intentional/); await concurrent;
  check(Number((await query<{n:number}>("SELECT COUNT(*) n FROM items"))[0].n) === Number(before[0].n) + 1, "rollback isolation under concurrency");
  const record: WatchRecord = { channelCode: "bilibili", business: "archive", platformItemId: "test-history", watchedAt: 1792588812, url: "https://www.bilibili.com/video/test-history", title: "候选测试", author: "测试作者", coverUrl: null, durationSec: 60, summary: "摘要", progressSec: 60, watchedToEnd: true, biliLiked: null, biliCoins: null, biliFavorited: null, device: "PC", tags: ["测试标签"], publishedOn: null, contentType: "video", detailError: null };
  check((await upsertEntries([record, record, {...record, watchedAt: record.watchedAt + 86400}])).inserted === 2, "batch duplicate event upsert");
  await upsertEntries([{...record, title: "must not overwrite"}]);
  check((await query<{title:string}>("SELECT title FROM watch_history_entries LIMIT 1"))[0].title === record.title, "incremental sync preserves existing metadata");
  await assert.rejects(upsertEntries([{...record, platformItemId: "bad", title: "x".repeat(10000)}])); assertions++;
  await fillMissingBiliInteractions([{platformItemId: record.platformItemId, biliLiked: false, biliCoins: 2, biliFavorited: true}]);
  await fillMissingBiliInteractions([{platformItemId: record.platformItemId, biliLiked: true, biliCoins: 0, biliFavorited: false}]);
  check((await query<{bili_coins:number}>("SELECT bili_coins FROM watch_history_entries LIMIT 1"))[0].bili_coins === 2, "interaction backfill preserves known values");
  const listed = await api("GET", "/api/history?status=pending&tag=" + encodeURIComponent("测试标签"));
  check(listed.json.data.total === 1 && listed.json.data.videos[0].entryIds.length === 2, "video grouping and exact tag filter");
  const ids = (await query<{id:number}>("SELECT id FROM watch_history_entries")).map(r => r.id);
  check((await api("POST", "/api/history/archive-all", { q: "不存在" })).json.data.archived === 0, "archive filter respects empty result");
  check((await api("POST", "/api/history/archive-all", { q: "候选测试" })).json.data.archived === 2, "archive filtered pending events");
  await api("POST", "/api/history/archive", { entryIds: ids, archived: false });
  const imported = await api("POST", "/api/history/import", { entryIds: ids });
  check(imported.status === 200, "import history");
  check((await api("GET", "/api/history?status=collected")).json.data.total === 1, "collected status derived from items");
  check((await api("POST", "/api/history/archive-all", {})).json.data.archived === 0, "archive-all preserves collected entries");
  check((await api("POST", "/api/history/sync", { since: "nonsense" })).status === 400, "invalid sync window is 400");
  check((await api("POST", "/api/history/sync", { since: "2099-01-01" })).status === 400, "future sync rejected");
  await api("POST", "/api/history/sync", {});
  await new Promise(r => setTimeout(r, 50));
  const sync = (await api("GET", "/api/history/sync")).json.data;
  check(sync.phase === "error" && sync.error.includes("刷新登录并同步"), "missing cookies produce actionable error");
  check(!sync.running, "sync lock released after error");
  // Multipart files, protected byte download, dedup and filesystem cleanup.
  const item = (await api("POST", "/api/items", { title: "附件测试", collected_on: "2026-11-01" })).json.data;
  const upload = async () => {
    const form = new FormData(); form.append("file", new Blob(["test attachment"], {type: "text/plain"}), "test.txt");
    const r = await fetch(base + `/api/items/${item.id}/attachments`, { method: "POST", headers: {Authorization: `Bearer ${token}`}, body: form });
    return {status:r.status, json:await r.json() as any};
  };
  const attachment = await upload(); check(attachment.status === 201, "multipart upload");
  const url = attachment.json.data.url;
  check((await fetch(base + url)).status === 401, "actual attachment bytes require authentication");
  const download = await fetch(base + url, {headers: {Authorization:`Bearer ${token}`}});
  check(download.status === 200 && await download.text() === "test attachment", "download exact bytes");
  check((await upload()).json.data.deduped === true, "attachment deduplication");
  await api("DELETE", `/api/items/${item.id}/hard`);
  check((await fetch(base + url, {headers: {Authorization:`Bearer ${token}`}})).status === 404, "hard delete removes stored file");
  check((await dueForCheck(10, 24)).length > 0, "probe date arithmetic query");
  console.log(`${engine}: extended checks ${assertions} passed`);
} catch (err) { console.error(logs.slice(-4000)); throw err; }
finally {
  if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
  await closePool();
  if (admin) { await admin.query(`DROP DATABASE ${name}`); await admin.end(); console.log("Disposable MySQL database removed"); }
  await rm(dir, { recursive: true, force: true });
}
