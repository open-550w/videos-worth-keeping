import type mysql from "mysql2/promise";
import type { DateRange } from "@likes/shared";
import { execute, query, queryOne, transaction } from "../db/db.js";
import { insertRangesInTx } from "./watchRanges.dao.js";

export interface ItemRow {
  id: number;
  content_type: string;
  channel_code: string | null;
  title: string;
  author: string | null;
  platform_item_id: string | null;
  cover_url: string | null;
  summary: string | null;
  duration_sec: number | null;
  published_on: string | null;
  collected_on: string;
  meta_json: unknown;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 列表行 = 条目 + 聚合出来的展示字段。 */
export interface ItemListRow extends ItemRow {
  primary_url: string | null;
  note_count: number;
  attachment_count: number;
}

export interface ItemFilters {
  /**
   * **观看区间**的筛选窗口，`YYYY-MM-DD`，闭区间。
   *
   * 语义是「和这个窗口**有交集**」而不是「落在这个窗口里」——
   * 因为一条记录的真源是**一组**观看区间（见 shared/ranges.ts）：
   * 10-17~11-30 那一段，在 10-19 那一周里也该被看到。
   *
   * ⚠️ 名字带 `watched` 是刻意的：以前这两个参数叫 `from`/`to`，筛的是 `collected_on`。
   * 换了含义还叫同一个名字，调用方会**静默**地拿到不一样的结果 ——
   * 这正是这个仓库最讨厌的那类 bug（见 AGENTS.md §二）。
   */
  watchedFrom?: string;
  watchedTo?: string;
  channel?: string;
  contentType?: string;
  /** 标题/作者/简介/URL 的模糊匹配 */
  q?: string;
  /** 按标签筛（tag id 列表，需全部命中） */
  tagIds?: number[];
  /** 'active'（默认）| 'trashed' | 'all' */
  scope?: "active" | "trashed" | "all";
}

export interface ItemInput {
  content_type: string;
  channel_code: string | null;
  title: string;
  author?: string | null;
  platform_item_id?: string | null;
  cover_url?: string | null;
  summary?: string | null;
  duration_sec?: number | null;
  published_on?: string | null;
  collected_on: string;
  meta_json?: unknown;
}

/**
 * 列表查询用的列。
 *
 * ⚠️ `primary_url` / `note_count` / `attachment_count` 用**相关子查询**而不是
 * LEFT JOIN + GROUP BY，有两个原因：
 *   1. LEFT JOIN 到一对多的表会让每个条目重复出多行，得再 GROUP BY 收回来，
 *      而 MySQL 5.7 没有窗口函数，「每组取最新一条」写起来很别扭；
 *   2. 子查询保证**每个条目恰好一行**，不用在应用层去重。
 *
 * 更重要的是：**这些必须在一条 SQL 里算完。** 库在远程，每次查询要走网络，
 * 在循环里逐条查「这个条目有几条评论」会从 0.5ms 变成 2.5 秒 ——
 * 本地 SQLite 上写错了看不出来，在这里会直接变成卡顿。
 *
 * ⚠️ 观看区间（item_watch_ranges）**不在这里**，由调用方 `rangesOfItems(ids)` 批量补。
 * 理由和上面相反又一致：它是**一对多**，相关子查询只能吐出一个值 ——
 * 要么 GROUP_CONCAT 再在应用层拆字符串（等于制造第二种格式），
 * 要么让每条区间复制一行条目（列表就重复了，还得去重）。
 * 一次 IN 批量取更直白，而且**只有一次往返** —— 和 tags 一样，不是 N+1。
 */
const LIST_COLUMNS = `
  i.id, i.content_type, i.channel_code, i.title, i.author, i.platform_item_id,
  i.cover_url, i.summary, i.duration_sec, i.published_on, i.collected_on,
  i.meta_json, i.deleted_at, i.created_at, i.updated_at,
  (SELECT u.url FROM item_urls u WHERE u.item_id = i.id
     ORDER BY u.is_primary DESC, u.id ASC LIMIT 1) AS primary_url,
  (SELECT COUNT(*) FROM item_notes n WHERE n.item_id = i.id) AS note_count,
  (SELECT COUNT(*) FROM attachments a WHERE a.item_id = i.id) AS attachment_count
`;

/** 拼 WHERE 与参数。list 和 count 共用，保证两者口径一致。 */
function buildWhere(f: ItemFilters): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  const scope = f.scope ?? "active";
  if (scope === "active") where.push("i.deleted_at IS NULL");
  else if (scope === "trashed") where.push("i.deleted_at IS NOT NULL");

  if (f.watchedFrom || f.watchedTo) {
    // 闭区间求交：区间的**任一天**落进窗口就算命中。
    // 只给一头也能筛（只看 from = 「这天之后看过的」）。
    const conds = ["r.item_id = i.id"];
    const args: unknown[] = [];
    if (f.watchedFrom) {
      conds.push("r.ended_on >= ?"); // 区间结束得比窗口开始还早 → 不相交
      args.push(f.watchedFrom);
    }
    if (f.watchedTo) {
      conds.push("r.started_on <= ?"); // 区间开始得比窗口结束还晚 → 不相交
      args.push(f.watchedTo);
    }
    where.push(`EXISTS (SELECT 1 FROM item_watch_ranges r WHERE ${conds.join(" AND ")})`);
    params.push(...args);
  }
  if (f.channel) {
    where.push("i.channel_code = ?");
    params.push(f.channel);
  }
  if (f.contentType) {
    where.push("i.content_type = ?");
    params.push(f.contentType);
  }
  if (f.q) {
    // 没有全文检索（Q12 明确不要，也为了轻）——几千行内 LIKE 够用
    where.push(
      "(i.title LIKE ? OR i.author LIKE ? OR i.summary LIKE ? OR i.platform_item_id LIKE ?" +
        " OR EXISTS (SELECT 1 FROM item_urls u2 WHERE u2.item_id = i.id AND u2.url LIKE ?))",
    );
    const like = `%${f.q}%`;
    params.push(like, like, like, like, like);
  }
  if (f.tagIds?.length) {
    // 要求**全部命中**：按 tag_id 分组计数 = 要求的个数
    const placeholders = f.tagIds.map(() => "?").join(",");
    where.push(
      `(SELECT COUNT(DISTINCT it.tag_id) FROM item_tags it
          WHERE it.item_id = i.id AND it.tag_id IN (${placeholders})) = ?`,
    );
    params.push(...f.tagIds, f.tagIds.length);
  }

  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export async function listItems(
  f: ItemFilters,
  limit: number,
  offset: number,
): Promise<ItemListRow[]> {
  const { sql, params } = buildWhere(f);
  return query<ItemListRow>(
    `SELECT ${LIST_COLUMNS}
     FROM items i
     ${sql}
     ORDER BY i.collected_on DESC, i.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
}

export async function countItems(f: ItemFilters): Promise<number> {
  const { sql, params } = buildWhere(f);
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM items i ${sql}`,
    params,
  );
  return row?.n ?? 0;
}

export async function getItem(id: number, scope: ItemFilters["scope"] = "all"): Promise<ItemListRow | null> {
  const { sql, params } = buildWhere({ scope });
  return queryOne<ItemListRow>(
    `SELECT ${LIST_COLUMNS} FROM items i ${sql ? `${sql} AND` : "WHERE"} i.id = ?`,
    [...params, id],
  );
}

/**
 * 按「渠道 + 平台 ID」找已有条目 —— 重复收藏时给用户一个跳转目标。
 * MySQL 的唯一索引允许多个 NULL，所以没有平台 ID 的条目查不到，符合预期。
 */
export async function findByPlatformId(
  channelCode: string | null,
  platformItemId: string | null,
): Promise<ItemRow | null> {
  if (!channelCode || !platformItemId) return null;
  return queryOne<ItemRow>(
    `SELECT * FROM items
     WHERE channel_code <=> ? AND platform_item_id = ? AND deleted_at IS NULL
     LIMIT 1`,
    [channelCode, platformItemId],
  );
}

/** 这个 URL 是否已经被某个条目占用了（跨条目的链接去重）。 */
export async function findItemIdByUrlHash(
  conn: mysql.PoolConnection | null,
  urlHash: string,
): Promise<number | null> {
  const sql = "SELECT item_id FROM item_urls WHERE url_hash = ? LIMIT 1";
  if (conn) {
    const [rows] = await conn.query(sql, [urlHash]);
    return (rows as Array<{ item_id: number }>)[0]?.item_id ?? null;
  }
  const row = await queryOne<{ item_id: number }>(sql, [urlHash]);
  return row?.item_id ?? null;
}

/**
 * 建条目：items + item_urls + item_watch_ranges 在**同一个事务**里。
 *
 * 区间必须一起进来，不能建完再单独写 —— 中间失败会留下一个「不属于任何一周」的条目：
 * 它在周视图里看不见（周视图按区间取数），只能靠搜索找到，而且用户不知道为什么。
 */
export async function insertItem(
  input: ItemInput,
  urls: Array<{ url: string; url_hash: string; url_type?: string; is_primary?: boolean }>,
  ranges: readonly DateRange[],
): Promise<number> {
  return transaction(async (conn) => {
    const [res] = await conn.execute<mysql.ResultSetHeader>(
      `INSERT INTO items
         (content_type, channel_code, title, author, platform_item_id,
          cover_url, summary, duration_sec, published_on, collected_on, meta_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.content_type,
        input.channel_code,
        input.title,
        input.author ?? null,
        input.platform_item_id ?? null,
        input.cover_url ?? null,
        input.summary ?? null,
        input.duration_sec ?? null,
        input.published_on ?? null,
        input.collected_on,
        input.meta_json === undefined ? null : JSON.stringify(input.meta_json),
      ],
    );
    const itemId = res.insertId;
    for (const u of urls) {
      await conn.execute(
        `INSERT INTO item_urls (item_id, url, url_hash, url_type, is_primary)
         VALUES (?,?,?,?,?)`,
        [itemId, u.url, u.url_hash, u.url_type ?? "canonical", u.is_primary ? 1 : 0],
      );
    }
    await insertRangesInTx(conn, itemId, ranges);
    return itemId;
  });
}

export async function updateItem(
  id: number,
  patch: Partial<ItemInput>,
): Promise<boolean> {
  const cols: string[] = [];
  const params: unknown[] = [];
  const assign = (col: string, val: unknown) => {
    cols.push(`${col} = ?`);
    params.push(val);
  };

  if (patch.content_type !== undefined) assign("content_type", patch.content_type);
  if (patch.channel_code !== undefined) assign("channel_code", patch.channel_code);
  if (patch.title !== undefined) assign("title", patch.title);
  if (patch.author !== undefined) assign("author", patch.author);
  if (patch.platform_item_id !== undefined) assign("platform_item_id", patch.platform_item_id);
  if (patch.cover_url !== undefined) assign("cover_url", patch.cover_url);
  if (patch.summary !== undefined) assign("summary", patch.summary);
  if (patch.duration_sec !== undefined) assign("duration_sec", patch.duration_sec);
  if (patch.published_on !== undefined) assign("published_on", patch.published_on);
  if (patch.collected_on !== undefined) assign("collected_on", patch.collected_on);
  if (patch.meta_json !== undefined) assign("meta_json", JSON.stringify(patch.meta_json));

  if (!cols.length) return false;
  const res = await execute(`UPDATE items SET ${cols.join(", ")} WHERE id = ?`, [...params, id]);
  return res.affectedRows > 0;
}

/** 换掉条目的链接（保留一个主链接）。 */
export async function replacePrimaryUrl(
  itemId: number,
  url: string,
  urlHash: string,
): Promise<void> {
  await transaction(async (conn) => {
    await conn.execute("DELETE FROM item_urls WHERE item_id = ?", [itemId]);
    await conn.execute(
      `INSERT INTO item_urls (item_id, url, url_hash, url_type, is_primary)
       VALUES (?,?,?,'canonical',1)`,
      [itemId, url, urlHash],
    );
  });
}

/** 软删。`deleted_at` 一置，所有 active 查询就看不到它了。 */
export async function softDeleteItem(id: number): Promise<boolean> {
  const res = await execute(
    "UPDATE items SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL",
    [id],
  );
  return res.affectedRows > 0;
}

export async function restoreItem(id: number): Promise<boolean> {
  const res = await execute(
    "UPDATE items SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
    [id],
  );
  return res.affectedRows > 0;
}

/**
 * 硬删 —— **真的会丢东西**。
 *
 * ⚠️ 附件在对象存储里的文件**不在这里删**。数据库行删掉之后就再也查不到
 * `storage_key` 了，文件会变成永远够不着的孤儿。所以调用方必须**先**把
 * 附件的 storage_key 取出来交给存储层删，再调这个。
 * 见 services/items.service.ts 的 hardDeleteItem。
 */
export async function hardDeleteItem(id: number): Promise<boolean> {
  return transaction(async (conn) => {
    await conn.execute("DELETE FROM item_watch_ranges WHERE item_id = ?", [id]);
    await conn.execute("DELETE FROM item_tags WHERE item_id = ?", [id]);
    await conn.execute("DELETE FROM attachments WHERE item_id = ?", [id]);
    await conn.execute("DELETE FROM item_notes WHERE item_id = ?", [id]);
    await conn.execute("DELETE FROM item_urls WHERE item_id = ?", [id]);
    const [res] = await conn.execute<mysql.ResultSetHeader>(
      "DELETE FROM items WHERE id = ?",
      [id],
    );
    return res.affectedRows > 0;
  });
}

// ============ 周视图 ============
//
// 这里**没有**按周聚合的查询了 —— 它搬到了 services/items.service.ts 的 listWeeks。
//
// 为什么：周视图的真源从 `items.collected_on` 换成了 `item_watch_ranges`（观看区间）。
// 一段区间跨几周是**算出来**的，而 MySQL 5.7 没有 CTE / 递归 / 窗口函数，
// **SQL 里造不出「周序列」** —— 没法再写一个 GROUP BY 就出结果。
// 所以取数（watchRanges.dao.listForWeekAggregation）和聚合（内存里）分开了：
// 仍然只有**一次往返**，ISO 周算法仍然只有一份（shared/week.ts）。
