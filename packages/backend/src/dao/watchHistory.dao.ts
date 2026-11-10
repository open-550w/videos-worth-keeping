import { dbClient, execute, query, queryOne } from "../db/db.js";
import type { WatchRecord } from "../services/bili/types.js";

export interface WatchHistoryRow {
  id: number;
  channel_code: string;
  business: string;
  platform_item_id: string;
  /** DATETIME，连接池开了 `dateStrings`，原样是字符串 */
  watched_at: string;
  url: string;
  title: string;
  author: string | null;
  cover_url: string | null;
  duration_sec: number | null;
  summary: string | null;
  progress_sec: number | null;
  /** TINYINT(1) —— 0/1，不是 boolean */
  watched_to_end: number;
  bili_liked: number | null;
  bili_coins: number | null;
  bili_favorited: number | null;
  device: string | null;
  tags: string | null;
  published_on: string | null;
  content_type: string;
  archived_at: string | null;
  fetched_at: string;
}

/**
 * 候选区的状态。
 *
 * ⚠️ **「已收藏」是算出来的，不是存下来的** —— 判据是 `items` 里有没有
 * `(channel_code, platform_item_id)` 这一行。存一份状态列的话两处会漂移：
 * 用户把导入的条目删掉之后，候选区会永远显示「已导入」而它其实不在收藏里了。
 * 详见 migrations/006 的注释。
 */
export type HistoryStatus = "active" | "pending" | "collected" | "archived" | "all";

/** 搜索范围。空 = 只搜标题（最常用、也最不容易一下搜出一大片）。 */
export type SearchField = "title" | "tags" | "summary" | "author";
export const SEARCH_FIELDS: SearchField[] = ["title", "tags", "summary", "author"];

export interface HistoryFilter {
  status: HistoryStatus;
  /** 关键词 */
  q?: string;
  /** 搜哪几个字段；不传 = 只搜标题 */
  fields?: SearchField[];
  /** 观看日期窗口，`YYYY-MM-DD`，闭区间 */
  from?: string;
  to?: string;
  /** 话题标签，**精确匹配**（B 站标签存在逗号分隔的一列里，用 FIND_IN_SET） */
  tag?: string;
  /** UP 主，精确匹配（筛选面板给的是下拉，不是手输） */
  up?: string;
}

/** 「这条内容已经在收藏里了吗」—— `items.uk_items_platform` 保证最多一条。 */
function collectedSql(alias: string): string {
  return `EXISTS (SELECT 1 FROM items i
            WHERE i.channel_code = ${alias}.channel_code
              AND i.platform_item_id = ${alias}.platform_item_id
              AND i.deleted_at IS NULL)`;
}

/**
 * 拼 WHERE 与参数。
 *
 * ⚠️ **列表、计数、归档三处共用这一个函数**，口径必须一致 ——
 * 否则会出现「筛出来 12 条，点归档却动了几百条」这种最坏的情况
 * （这正是「一键归档」这类批量操作最危险的地方）。
 * 和 items.dao 的 buildWhere 是同一条理由。
 */
function whereConditions(f: HistoryFilter, alias = "whe"): { conds: string[]; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];

  switch (f.status) {
    case "active":
      conds.push(`${alias}.archived_at IS NULL`);
      break;
    case "pending":
      conds.push(`${alias}.archived_at IS NULL AND NOT ${collectedSql(alias)}`);
      break;
    case "collected":
      conds.push(collectedSql(alias));
      break;
    case "archived":
      conds.push(`${alias}.archived_at IS NOT NULL AND NOT ${collectedSql(alias)}`);
      break;
    case "all":
      break;
  }

  if (f.q) {
    // 没有全文检索（Q12 明确不要，也为了轻）—— 几千行内 LIKE 够用
    const fields = f.fields?.length ? f.fields : (["title"] as SearchField[]);
    const cols: Record<SearchField, string> = {
      title: `${alias}.title`,
      tags: `${alias}.tags`,
      summary: `${alias}.summary`,
      author: `${alias}.author`,
    };
    conds.push(`(${fields.map((fld) => `${cols[fld]} LIKE ?`).join(" OR ")})`);
    for (let i = 0; i < fields.length; i++) params.push(`%${f.q}%`);
  }

  if (f.from) {
    conds.push(`${alias}.watched_at >= ?`);
    params.push(`${f.from} 00:00:00`);
  }
  if (f.to) {
    conds.push(`${alias}.watched_at <= ?`);
    params.push(`${f.to} 23:59:59`);
  }
  if (f.tag) {
    // FIND_IN_SET 是给「逗号分隔的列表」用的精确匹配 —— 比 LIKE '%x%' 准
    // （LIKE 会把「炉石」匹配到「炉石传说」上，那不是用户点这个标签的意思）
    conds.push(`FIND_IN_SET(?, ${alias}.tags) > 0`);
    params.push(f.tag);
  }
  if (f.up) {
    conds.push(`${alias}.author = ?`);
    params.push(f.up);
  }

  return { conds, params };
}

function buildWhere(f: HistoryFilter, alias = "whe"): { sql: string; params: unknown[] } {
  const { conds, params } = whereConditions(f, alias);
  return { sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

/** 一次插入多少行。库在远程，但**一条多值 INSERT 只算一次往返** —— 越大越快。 */
const INSERT_CHUNK = 200;

export interface UpsertResult {
  received: number;
  /** 新插进来的条数（靠前后的 COUNT 差算出来，见下） */
  inserted: number;
  updated: number;
}

/**
 * 把抓取结果写进候选区。**幂等**：抓取窗口重叠是常态（今天抓 7 天、明天再抓 7 天）。
 *
 * 两条关键决定：
 *
 * ① 用 `INSERT ... ON DUPLICATE KEY UPDATE`，靠 `uk_whe_event
 *    (channel_code, platform_item_id, watched_at)` 去重 —— 同一条内容、
 *    同一个观看时刻就是同一次观看。
 *
 * ② ⚠️ **默认不覆盖已有的行**（`updateExisting: false`，用 `ON DUPLICATE KEY UPDATE channel_code = channel_code`
 *    这个空操作实现）。「同步只拿新的、不改已有的」—— 页面上那个同步按钮就是这个语义。
 *    理由不只是省事：候选区里已经有的是**我已经看过、挑过、归档过**的东西，
 *    让一次抓取去改写它们，就是在动我的工作结果。
 *
 *    要重抓（比如上次富化失败、想把封面补上）就显式传 `updateExisting: true`
 *    —— CLI 的 `--refresh` 走这条。
 *
 * ③ 就算 `updateExisting: true`，也**不碰 `archived_at`**。那一列是**我做过的决定**
 *    （「这条确定不要」）。重新抓一遍就把它抹掉的话，用户归档过的东西会全部复活成待选 ——
 *    这是「抓取覆盖了人的判断」，比抓失败更糟。
 *
 * 为什么用 COUNT 前后差算「新增」：MySQL 的 `affectedRows` 在 ON DUPLICATE KEY
 * UPDATE 下是 1（插入）+ 2（更新）+ 0（值没变）的混合值，**推不出各自多少条**。
 * 两条 COUNT 是明确的，而且只在 CLI 里跑一次，不值当为它省一个往返。
 */
export async function upsertEntries(
  records: WatchRecord[],
  opts: { updateExisting?: boolean } = {},
): Promise<UpsertResult> {
  if (!records.length) return { received: 0, inserted: 0, updated: 0 };

  const before = await countAll();

  const cols = [
    "channel_code", "business", "platform_item_id", "watched_at", "url", "title",
    "author", "cover_url", "duration_sec", "summary", "progress_sec", "watched_to_end",
    "device", "tags", "published_on", "content_type", "bili_liked", "bili_coins", "bili_favorited",
  ];
  /**
   * 不覆盖已有行时用 `channel_code = channel_code` 这个**空操作**，而不是 `INSERT IGNORE`。
   *
   * ⚠️ 别换成 `INSERT IGNORE`：它会把**所有**错误都吞掉（数据超长被截断、
   * 枚举值不合法……），于是「这条没写进去」会表现成「写成功了，只是查不到」。
   * `ON DUPLICATE KEY UPDATE channel_code = channel_code` 只忽略唯一键冲突这一件事，其余照常报错。
   * 不要用自增列 `id = id`：MySQL 5.7 同一批内有重复事件时会报
   * ER_AUTO_INCREMENT_CONFLICT (1869)，即使 id 实际没有改变。
   */
  const updates = opts.updateExisting
    ? cols
        .filter((c) => c !== "channel_code" && c !== "platform_item_id" && c !== "watched_at")
        .map((c) => `${c} = VALUES(${c})`)
        .join(", ")
    : "channel_code = channel_code";

  for (let i = 0; i < records.length; i += INSERT_CHUNK) {
    const chunk = records.slice(i, i + INSERT_CHUNK);
    const values = chunk.map(() => `(${cols.map(() => "?").join(",")})`).join(",");
    const params = chunk.flatMap((r) => [
      r.channelCode,
      r.business,
      r.platformItemId,
      toMysqlDateTime(r.watchedAt),
      r.url,
      r.title,
      r.author,
      r.coverUrl,
      r.durationSec,
      r.summary,
      r.progressSec,
      r.watchedToEnd ? 1 : 0,
      r.device,
      r.tags.length ? r.tags.join(",") : null,
      r.publishedOn,
      r.contentType,
      r.biliLiked === null ? null : Number(r.biliLiked),
      r.biliCoins,
      r.biliFavorited === null ? null : Number(r.biliFavorited),
    ]);
    await execute(
      `INSERT INTO watch_history_entries (${cols.join(",")}) VALUES ${values}
       ON DUPLICATE KEY UPDATE ${updates}`,
      params,
    );
  }

  const after = await countAll();
  const inserted = Math.max(0, after - before);
  return { received: records.length, inserted, updated: records.length - inserted };
}

function toMysqlDateTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

async function countAll(): Promise<number> {
  const row = await queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM watch_history_entries");
  return Number(row?.n ?? 0);
}

export async function countByStatus(): Promise<
  Record<"active" | "pending" | "collected" | "archived", number>
> {
  // 各状态共用 whereConditions，口径和列表页完全一致 —— 页签上的数字和点进去的条数
  // 对不上是最容易被发现、也最伤信任的那种 bug
  const active = whereConditions({ status: "active" }).conds[0];
  const pending = whereConditions({ status: "pending" }).conds[0];
  const collected = whereConditions({ status: "collected" }).conds[0];
  const archived = whereConditions({ status: "archived" }).conds[0];

  const rows = await query<{ active: number; pending: number; collected: number; archived: number }>(
    `SELECT
       COUNT(DISTINCT CASE WHEN ${active} THEN whe.platform_item_id END) AS active,
       SUM(${pending})   AS pending,
       SUM(${collected}) AS collected,
       SUM(${archived})  AS archived
     FROM watch_history_entries whe`,
  );
  const r = rows[0];
  return {
    active: Number(r?.active ?? 0),
    pending: Number(r?.pending ?? 0),
    collected: Number(r?.collected ?? 0),
    archived: Number(r?.archived ?? 0),
  };
}

/**
 * 按**视频**分页（不是按观看事件）。
 *
 * 分页单位必须是视频：页面上一行是一个视频，一条视频看了三次也只该占一行。
 * 所以先在 SQL 里 GROUP BY 出一页 platform_item_id，再把它们的行取回来 ——
 * 两步、两次往返，但每次只取这一页的数据。
 */
export async function listVideoPage(
  f: HistoryFilter,
  limit: number,
  offset: number,
): Promise<{ platformItemIds: string[]; total: number }> {
  const { sql, params } = buildWhere(f);

  const [grouped, totalRow] = await Promise.all([
    query<{ platform_item_id: string }>(
      `SELECT whe.platform_item_id, MAX(whe.watched_at) AS last_at
       FROM watch_history_entries whe
       ${sql}
       GROUP BY whe.platform_item_id
       ORDER BY last_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    queryOne<{ n: number }>(
      `SELECT COUNT(DISTINCT whe.platform_item_id) AS n
       FROM watch_history_entries whe ${sql}`,
      params,
    ),
  ]);

  return {
    platformItemIds: grouped.map((g) => g.platform_item_id),
    total: Number(totalRow?.n ?? 0),
  };
}

/** 取这些视频在**同一筛选条件**下的所有观看事件（一行一个事件）。 */
export async function rowsOfVideos(
  f: HistoryFilter,
  platformItemIds: string[],
): Promise<WatchHistoryRow[]> {
  if (!platformItemIds.length) return [];
  const { sql, params } = buildWhere(f);
  const placeholders = platformItemIds.map(() => "?").join(",");
  return query<WatchHistoryRow>(
    `SELECT whe.* FROM watch_history_entries whe
     ${sql ? `${sql} AND` : "WHERE"} whe.platform_item_id IN (${placeholders})
     ORDER BY whe.watched_at DESC`,
    [...params, ...platformItemIds],
  );
}

export async function rowsByIds(ids: number[]): Promise<WatchHistoryRow[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return query<WatchHistoryRow>(
    `SELECT * FROM watch_history_entries WHERE id IN (${placeholders}) ORDER BY watched_at`,
    ids,
  );
}

export interface Facets {
  /** UP 主，按条数降序 */
  authors: Array<{ name: string; n: number }>;
  /** 话题标签，按出现次数降序 */
  tags: Array<{ name: string; n: number }>;
  /** 候选覆盖的观看日期范围，给筛选面板当提示用 */
  dateFrom: string | null;
  dateTo: string | null;
}

/**
 * 筛选面板要用的选项。
 *
 * ⚠️ **选项不随当前筛选变化**（只统计整个候选区）。这是刻意的：
 * 让选项稳定，不然你选了一个 UP 主之后，标签选项会跟着跳走 ——
 * 想换个标签就得先清掉 UP 主，很难用。
 */
export async function facets(): Promise<Facets> {
  const [authorRows, tagRows, spanRow] = await Promise.all([
    query<{ author: string; n: number }>(
      `SELECT author, COUNT(DISTINCT platform_item_id) AS n
       FROM watch_history_entries
       WHERE author IS NOT NULL AND author <> ''
       GROUP BY author ORDER BY n DESC LIMIT 40`,
    ),
    // 标签存在逗号分隔的一列里，SQL 里拆不开（5.7 没有 JSON_TABLE / 递归）——
    // 取回来在应用层拆。个人量级（几百行 × 几个标签）完全够。
    query<{ tags: string }>(
      "SELECT tags FROM watch_history_entries WHERE tags IS NOT NULL AND tags <> ''",
    ),
    queryOne<{ lo: string | null; hi: string | null }>(
      "SELECT MIN(watched_at) AS lo, MAX(watched_at) AS hi FROM watch_history_entries",
    ),
  ]);

  const tagCount = new Map<string, number>();
  for (const r of tagRows) {
    for (const t of r.tags.split(",")) {
      const name = t.trim();
      if (name) tagCount.set(name, (tagCount.get(name) ?? 0) + 1);
    }
  }

  return {
    authors: authorRows.map((r) => ({ name: r.author, n: Number(r.n) })),
    tags: [...tagCount.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
      .slice(0, 60),
    dateFrom: spanRow?.lo ? String(spanRow.lo).slice(0, 10) : null,
    dateTo: spanRow?.hi ? String(spanRow.hi).slice(0, 10) : null,
  };
}

/**
 * 归档 / 取消归档（按 id）。
 *
 * 「归档」= 确定不要，之后不再出现在待选里。**不是删除** —— 留痕、可恢复
 * （「已归档」页签里能看见、能恢复）。所以这里不需要任何「确认」逻辑，
 * 代价是零的：点错了再点回来。
 */
export async function archiveByIds(ids: number[], archived: boolean): Promise<number> {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const res = await execute(
    `UPDATE watch_history_entries SET archived_at = ${archived ? "NOW()" : "NULL"}
     WHERE id IN (${placeholders})`,
    ids,
  );
  return res.affectedRows;
}

/**
 * 一键归档**当前筛选下的所有「待选」**。
 *
 * ⚠️ 两条安全性质，都是刻意的：
 *
 * ① **只动待选的**（`archived_at IS NULL AND NOT EXISTS(items…)` 写死在 SQL 里，
 *    不接受调用方传 status）。所以这个按钮**永远不会**碰你已经收藏的东西 ——
 *    哪怕筛选条件写错了。一个批量操作最怕的就是「手一滑动了几百条不该动的」。
 *
 * ② **筛选条件和列表页共用同一个 buildWhere** —— 你在页面上看到 12 条，
 *    这一下就只动那 12 条。
 */
export async function archiveAllPending(f: Omit<HistoryFilter, "status">): Promise<number> {
  const { sql, params } = buildWhere({ ...f, status: "pending" });
  const res = await execute(
    `UPDATE watch_history_entries whe SET whe.archived_at = NOW() ${sql}`,
    params,
  );
  return res.affectedRows;
}

/**
 * 这些平台 ID 里，哪些**已经收藏过了**。
 *
 * 一次 IN 查完，不要在循环里查 —— 库在远程，一页 20 个视频就是 20 次往返。
 */
export async function existingItemIds(
  channelCode: string,
  platformItemIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!platformItemIds.length) return out;
  const placeholders = platformItemIds.map(() => "?").join(",");
  const rows = await query<{ id: number; platform_item_id: string }>(
    `SELECT id, platform_item_id FROM items
     WHERE channel_code = ? AND deleted_at IS NULL AND platform_item_id IN (${placeholders})`,
    [channelCode, ...platformItemIds],
  );
  for (const r of rows) out.set(r.platform_item_id, r.id);
  return out;
}

/**
 * 候选区里已经有哪些视频（平台 ID）。
 *
 * 增量同步靠它：已有的视频**连详情都不用再拉** —— 一条视频的标题/封面/标签/统计数
 * 基本不变，重抓纯属白打接口。一次查完（几百上千个小字符串），别在循环里查。
 */
export async function knownPlatformIds(channelCode: string): Promise<Set<string>> {
  const rows = await query<{ platform_item_id: string }>(
    "SELECT DISTINCT platform_item_id FROM watch_history_entries WHERE channel_code = ?",
    [channelCode],
  );
  return new Set(rows.map((r) => r.platform_item_id));
}

/** 清空候选区。给 `--purge` 用（想从干净状态重来一次）。 */
export async function purgeAll(): Promise<number> {
  const res = await execute("DELETE FROM watch_history_entries");
  return res.affectedRows;
}

/** 只填历史行缺失的互动快照，不改标题、观看事件、归档或已有互动。每批一次往返。 */
export async function fillMissingBiliInteractions(
  snapshots: Array<import("../services/bili/types.js").BiliInteractions & { platformItemId: string }>,
): Promise<void> {
  for (let i = 0; i < snapshots.length; i += INSERT_CHUNK) {
    const chunk = snapshots.slice(i, i + INSERT_CHUNK);
    const source = chunk.map(() => "SELECT ? AS platform_item_id, ? AS liked, ? AS coins, ? AS favorited").join(" UNION ALL ");
    const assignments = `bili_liked = COALESCE(w.bili_liked, s.liked),
          bili_coins = COALESCE(w.bili_coins, s.coins),
          bili_favorited = COALESCE(w.bili_favorited, s.favorited)`;
    const sql = dbClient() === "sqlite"
      ? `UPDATE watch_history_entries AS w SET ${assignments} FROM (${source}) s
         WHERE w.platform_item_id = s.platform_item_id AND w.channel_code = 'bilibili' AND w.business = 'archive'`
      : `UPDATE watch_history_entries w JOIN (${source}) s ON w.platform_item_id = s.platform_item_id
         SET ${assignments.replace(/(?<![.\w])(bili_liked|bili_coins|bili_favorited) =/g, 'w.$1 =')}
         WHERE w.channel_code = 'bilibili' AND w.business = 'archive'`;
    await execute(sql, chunk.flatMap(r => [r.platformItemId, r.biliLiked === null ? null : Number(r.biliLiked), r.biliCoins, r.biliFavorited === null ? null : Number(r.biliFavorited)]));
  }
}
