import mysql from "mysql2/promise";
import { logger } from "../logger.js";

import { sqliteQuery, sqliteExecute, sqliteTransaction, closeSqlite } from "./sqlite.js";

export function dbClient(): "sqlite" | "mysql" {
  const value = process.env.DB_CLIENT ?? "sqlite";
  if (value !== "sqlite" && value !== "mysql") throw new Error(`不支持的 DB_CLIENT: ${value}`);
  return value;
}

let pool: mysql.Pool | null = null;

/**
 * 连接池单例。
 *
 * ⚠️ `dateStrings: true` 是必需的，不是优化：
 * 不加的话 mysql2 会把 DATE / DATETIME 解析成 JS Date，按**本机时区**反解。
 * 实测 `collected_on`（值 2026-10-17）会变成 "2026-10-16T16:00:00.000Z" ——
 * 对「只表示哪一天」的字段来说这是纯粹的麻烦。开着它，日期原样以字符串返回。
 *
 * ⚠️ `charset` 必须是 5.7 有的排序规则 —— `utf8mb4_0900_ai_ci` 是 8.0 的，
 * 用了会直接 ER_UNKNOWN_COLLATION（实测）。
 *
 * ⚠️ **这个库的建连成本极高（实测 1–8 秒），所以池的行为是刻意调过的**：
 * 见下面 IDLE_MS / enableKeepAlive 的注释。默认配置会让连接闲置 60 秒后被回收，
 * 于是「隔一会儿再用」的每个请求都要重付一次建连成本 —— 表现为页面转 10 秒然后 500。
 */
export function getPool(): mysql.Pool {
  if (pool) return pool;
  const missing = (["DB_HOST", "DB_USER", "DB_NAME"] as const).filter(
    (k) => !process.env[k],
  );
  if (missing.length) {
    throw new Error(`缺少环境变量: ${missing.join(", ")}（检查 packages/backend/.env.local）`);
  }
  const limit = Number(process.env.DB_POOL_SIZE ?? 5);
  pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: "UTF8MB4_UNICODE_CI",
    dateStrings: true,
    timezone: "Z",
    connectionLimit: limit,
    maxIdle: limit,
    waitForConnections: true,
    /**
     * **默认是 60 秒，必须调大。**
     *
     * 这个库建一次连接要 1–8 秒（实测）。默认 60 秒回收意味着：
     * 你去干点别的、回来刷新页面 → 池是空的 → 重新建连 → 转 10 秒 → 超时报 500。
     * 把闲置回收时间拉长，连接就一直是热的。
     */
    idleTimeout: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 3_600_000),
    /**
     * TCP keepalive。长连接经过 NAT / 防火墙时，空闲久了会被中间设备悄悄丢弃，
     * 而客户端不知道 —— 下一次查询才发现连接已死，又要重连。
     * 开着它，内核会定期发探测包把链路保活。
     */
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    /**
     * 建连超时。默认 10 秒在这个库上**不够** —— 实测见过 8.2 秒的建连，
     * 偶尔更久，撞上就直接 ETIMEDOUT。
     */
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 30_000),
  });
  logger.info(
    { host: process.env.DB_HOST, db: process.env.DB_NAME, poolSize: limit },
    "MySQL 连接池就绪",
  );
  return pool;
}

/** 查询并返回行数组。 */
export async function query<T = mysql.RowDataPacket>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (dbClient() === "sqlite") return await sqliteQuery(sql, params) as T[];
  const [rows] = await getPool().query(sql, params as never);
  return rows as T[];
}

/** 查询单行，没有则返回 null。 */
export async function queryOne<T = mysql.RowDataPacket>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** 写操作，返回 insertId / affectedRows。 */
export async function execute(
  sql: string,
  params: unknown[] = [],
): Promise<mysql.ResultSetHeader> {
  if (dbClient() === "sqlite") return sqliteExecute(sql, params);
  const [result] = await getPool().execute(sql, params as never);
  return result as mysql.ResultSetHeader;
}

/**
 * 事务。回调里用传进来的 conn 做查询 —— 别用上面的 query()，
 * 那个走的是池里**另一条**连接，不在事务里。
 */
export async function transaction<T>(
  fn: (conn: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  if (dbClient() === "sqlite") return sqliteTransaction(fn);
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** 连通性自检 —— 启动脚本和 /api/health 都用它。 */
export async function ping(): Promise<{ version: string; now: string }> {
  const row = await queryOne<{ version: string; now: string }>(
    "SELECT VERSION() AS version, NOW() AS now",
  );
  if (!row) throw new Error("SELECT VERSION() 没有返回行");
  return row;
}

export async function closePool(): Promise<void> {
  closeSqlite();
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * 保活心跳。
 *
 * 为什么需要它（不是可有可无的优化）：这个库**建一次连接要 1–8 秒**（实测）。
 * 池里的连接如果被 NAT / 防火墙悄悄掐掉、或闲置太久被回收，
 * 下一个请求就要重付一次建连成本 —— 表现是「页面转十秒然后报错」。
 *
 * 每 60 秒发一条 `SELECT 1` 极其便宜（单次往返 ~250ms 的空闲时间，不是 CPU），
 * 换来的是连接一直是热的。
 */
export function startDbKeepalive(): NodeJS.Timeout {
  const everyMs = Number(process.env.DB_KEEPALIVE_MS ?? 60_000);
  const tick = () => {
    query("SELECT 1").catch((err) =>
      logger.warn({ err: (err as Error).message }, "保活心跳失败（下次请求会重连）"),
    );
  };
  const timer = setInterval(tick, Math.max(everyMs, 10_000));
  timer.unref(); // 不阻止进程退出
  return timer;
}
