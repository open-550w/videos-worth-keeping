import { readdir, readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { dbClient, query } from "./db.js";
import { logger } from "../logger.js";

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

/**
 * 版本化迁移执行器。
 *
 * 为什么不用参考项目那套「CREATE TABLE IF NOT EXISTS + 手维护的补列数组」：
 *   1. 它靠人记得登记 —— 忘了加，新列在已有库上永远不出现，
 *      而且**本地全新建库是好的**，所以这个 bug 只在别人的库上复现；
 *   2. 它只能加列，不能改列 / 删列 / 改类型。
 *
 * 这里的幂等性由「执行过就不再执行」保证，而不是由 SQL 写法保证。
 * 但 MySQL 的 DDL **不是事务性的** —— 一个迁移文件跑到一半失败，
 * 前面几条语句已经生效而版本没记上，重跑会撞「表已存在」。
 * 所以迁移文件里的 DDL **尽量写成 `IF NOT EXISTS`**，让重跑安全。
 *
 * ⚠️ 用**独立连接**开 `multipleStatements` —— 池上不开。
 * 池开着它会把任何一处 SQL 注入放大成任意语句执行。
 */
export async function migrate(): Promise<{ applied: string[]; already: string[] }> {
  if (dbClient() === "sqlite") {
    const { migrateSqlite } = await import("./sqlite.js");
    const result = await migrateSqlite();
    cachedVersions = [...result.applied, ...result.already].sort();
    return result;
  }
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: "UTF8MB4_UNICODE_CI",
    multipleStatements: true,
    connectTimeout: 10_000,
  });

  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    VARCHAR(64) NOT NULL,
        applied_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [doneRows] = await conn.query("SELECT version FROM schema_migrations");
    const done = new Set((doneRows as Array<{ version: string }>).map((r) => r.version));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const applied: string[] = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
      logger.info({ version }, "执行迁移");
      await conn.query(sql);
      await conn.query("INSERT INTO schema_migrations (version) VALUES (?)", [version]);
      applied.push(version);
    }
    // 顺手把缓存填上 —— /api/health 之后就不用再查库了
    cachedVersions = [...done, ...applied].sort();
    return { applied, already: [...done] };
  } finally {
    await conn.end();
  }
}

/**
 * 已应用的迁移版本。
 *
 * ⚠️ **内存缓存，不再每次查库。**
 *
 * 原来这里每次都 `createConnection` 建一条**新连接**再查。在这条网络上
 * （见 docs/init/03_TECH_STACK.md §1.3）建连要 1–11 秒，而前端**每 60 秒**
 * 调一次 `/api/health` —— 于是每分钟都在后台开一条新连接，
 * 还和真正的请求抢那 5 个池名额。这是「页面慢」的一个直接来源。
 *
 * 迁移在**启动时**跑完，运行期不可能变，所以缓存是安全的。
 * `migrate()` 跑完会填这个缓存；进程内没跑过迁移时（比如 CLI）才回落到查库。
 */
let cachedVersions: string[] | null = null;

export async function appliedVersions(): Promise<string[]> {
  if (cachedVersions) return cachedVersions;
  const rows = await query<{ version: string }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  ).catch(() => [] as Array<{ version: string }>);
  cachedVersions = rows.map((r) => r.version);
  return cachedVersions;
}
