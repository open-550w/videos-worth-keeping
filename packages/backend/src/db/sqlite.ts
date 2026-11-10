import Database from "better-sqlite3";
import { weekKeyOf } from "@likes/shared";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type mysql from "mysql2/promise";

let db: Database.Database | undefined;
let pending: Promise<unknown> = Promise.resolve();
const owner = new AsyncLocalStorage<boolean>();
function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  if (owner.getStore()) return Promise.resolve().then(fn);
  const task = pending.then(() => owner.run(true, fn));
  pending = task.catch(() => {});
  return task;
}
export function sqliteDb(): Database.Database {
  if (db) return db;
  const filename = process.env.SQLITE_PATH ?? ".cache/likes.sqlite";
  if (filename !== ":memory:") mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.function("ISO_WEEK", { deterministic: true }, date => weekKeyOf(String(date)));
  db.function("NOW", () => new Date().toISOString().slice(0, 19).replace("T", " "));
  const version = db.prepare("select sqlite_version()").pluck().get();
  db.function("VERSION", () => `SQLite ${version}`);
  db.function("FIND_IN_SET", (needle, haystack) => String(haystack ?? "").split(",").indexOf(String(needle)) + 1);
  return db;
}
/** The DAO SQL subset shared by both engines; dialect differences stay here. */
export function sqliteSql(sql: string): string {
  return sql.replace(/<=>/g, "IS")
    .replace(/INSERT IGNORE INTO/gi, "INSERT INTO")
    .replace(/(INSERT INTO item_tags[\s\S]*)$/i, "$1 ON CONFLICT DO NOTHING")
    .replace(/ON DUPLICATE KEY UPDATE/gi, "ON CONFLICT DO UPDATE SET")
    .replace(/VALUES\((\w+)\)/gi, "excluded.$1")
    .replace(/DATE_SUB\(NOW\(\), INTERVAL \? HOUR\)/gi, "datetime(NOW(), '-' || ? || ' hours')")
    .replace(/UPDATE watch_history_entries whe SET whe\.archived_at/gi, "UPDATE watch_history_entries AS whe SET archived_at");
}
function translateError(err: unknown): never {
  const e = err as Error & { code: string };
  if (/UNIQUE constraint failed/.test(e.message)) e.code = "ER_DUP_ENTRY";
  if (/CHECK constraint failed/.test(e.message)) e.code = "ER_DATA_TOO_LONG";
  throw e;
}
function runQuery(sql: string, params: unknown[]) {
  try { return sqliteDb().prepare(sqliteSql(sql)).all(...params); } catch (e) { return translateError(e); }
}
function runExecute(sql: string, params: unknown[]): mysql.ResultSetHeader {
  try {
    const r = sqliteDb().prepare(sqliteSql(sql)).run(...params);
    return { insertId: Number(r.lastInsertRowid), affectedRows: r.changes } as mysql.ResultSetHeader;
  } catch (e) { return translateError(e); }
}
export const sqliteQuery = (sql: string, params: unknown[]) => locked(() => runQuery(sql, params));
export const sqliteExecute = (sql: string, params: unknown[]) => locked(() => runExecute(sql, params));
export function sqliteTransaction<T>(fn: (conn: mysql.PoolConnection) => Promise<T>): Promise<T> {
  return locked(async () => {
    const db = sqliteDb();
    db.exec("BEGIN IMMEDIATE");
    // Match mysql2's [result, fields] interface used by transactional DAOs.
    const conn = {
      query: async (sql: string, params: unknown[] = []) => [runQuery(sql, params), []],
      execute: async (sql: string, params: unknown[] = []) => [runExecute(sql, params), []],
    } as unknown as mysql.PoolConnection;
    try { const result = await fn(conn); db.exec("COMMIT"); return result; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  });
}
export function closeSqlite() { db?.close(); db = undefined; }

/** Derive SQLite DDL from the versioned schema, avoiding a second schema to maintain. */
export function sqliteMigration(sql: string): string {
  return sql.replace(/--[^\n]*/g, "")
    .replace(/\s+COMMENT\s+'(?:[^']|'')*'/gi, "")
    .replace(/week_key\s+VARCHAR\(8\)\s+AS\s*\([\s\S]*?\) STORED,/, "week_key TEXT AS (ISO_WEEK(collected_on)) STORED,")
    .replace(/id\s+BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,/g, "id INTEGER PRIMARY KEY AUTOINCREMENT,")
    .replace(/,\s*PRIMARY KEY \(id\)/g, "")
    .replace(/UNIQUE KEY \w+\s*\(([^)]+)\)/g, "UNIQUE ($1)")
    .replace(/,\s*KEY \w+\s*\([^)]+\)/g, "")
    .replace(/\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/g, ")")
    .replace(/ ON UPDATE CURRENT_TIMESTAMP/g, "")
    .replace(/BIGINT UNSIGNED/g, "INTEGER")
    .replace(/(\b\w+)\s+((?:VAR)?CHAR)\((\d+)\)/g, "$1 TEXT CHECK ($1 IS NULL OR length($1) <= $3)")
    .replace(/INSERT IGNORE INTO/g, "INSERT OR IGNORE INTO")
    .replace(/AFTER \w+/g, "")
    .replace(/ALTER TABLE (\w+)\s+ADD COLUMN ([\s\S]*?);/g, (_, table, columns) => columns.split(/,\s*ADD COLUMN /).map((c: string) => `ALTER TABLE ${table} ADD COLUMN ${c};`).join("\n"));
}
export async function migrateSqlite() {
  const db = sqliteDb();
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const already = db.prepare("SELECT version FROM schema_migrations ORDER BY version").pluck().all() as string[];
  const applied: string[] = [];
  const dir = new URL("./migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()) {
    const version = file.replace(/\.sql$/, "");
    if (already.includes(version)) continue;
    const sql = sqliteMigration(await readFile(new URL(file, dir), "utf8"));
    db.transaction(() => { db.exec(sql); db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version); })();
    applied.push(version);
  }
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".sql"))) {
    const source = (await readFile(new URL(file, dir), "utf8")).replace(/--[^\n]*/g, "");
    for (const match of source.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)\s*\(([\s\S]*?)\) ENGINE/g)) {
      const [, table, columns] = match;
      for (const index of columns.matchAll(/(?<!UNIQUE )KEY (\w+)\s*\(([^)]+)\)/g)) {
        // week_key was absent in pre-release SQLite files; no business query uses it.
        if (index[2].includes("week_key") && !(db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string }[]).some(c => c.name === "week_key")) continue;
        db.exec(`CREATE INDEX IF NOT EXISTS ${index[1]} ON ${table} (${index[2]})`);
      }
    }
  }
  // Keep MySQL's automatic updated_at behavior for the tables that have it.
  for (const table of ["items", "item_notes", "tag_groups"]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_updated AFTER UPDATE ON ${table}
      FOR EACH ROW WHEN NEW.updated_at = OLD.updated_at BEGIN
      UPDATE ${table} SET updated_at = NOW() WHERE id = NEW.id; END`);
  }
  return { applied, already };
}
