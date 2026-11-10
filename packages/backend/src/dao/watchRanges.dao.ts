import type mysql from "mysql2/promise";
import { query, transaction } from "../db/db.js";
import type { DateRange } from "@likes/shared";

export interface WatchRangeRow {
  id: number;
  item_id: number;
  /** `YYYY-MM-DD` —— 连接池开了 `dateStrings: true`，DATE 原样是字符串 */
  started_on: string;
  ended_on: string;
}

/** 周视图聚合用的一行：区间 + 它所属条目的渠道（渠道分布要按周统计）。 */
export interface WatchRangeForWeekRow {
  item_id: number;
  started_on: string;
  ended_on: string;
  channel_code: string | null;
}

function toDateRange(r: WatchRangeRow): DateRange {
  return { from: r.started_on, to: r.ended_on };
}

export async function rangesOfItem(itemId: number): Promise<DateRange[]> {
  const rows = await query<WatchRangeRow>(
    "SELECT id, item_id, started_on, ended_on FROM item_watch_ranges WHERE item_id = ? ORDER BY started_on, ended_on",
    [itemId],
  );
  return rows.map(toDateRange);
}

/**
 * 批量取多个条目的区间。
 *
 * **一次 IN 查完，不要在循环里逐条查。** 库在远程，每个 await 是一次真实往返
 * （实测中位 237ms）；列表页 50 条就是 12 秒。这是 tagsOfItems 的同一条理由。
 */
export async function rangesOfItems(itemIds: number[]): Promise<Map<number, DateRange[]>> {
  const out = new Map<number, DateRange[]>();
  if (!itemIds.length) return out;
  const placeholders = itemIds.map(() => "?").join(",");
  const rows = await query<WatchRangeRow>(
    `SELECT id, item_id, started_on, ended_on FROM item_watch_ranges
     WHERE item_id IN (${placeholders})
     ORDER BY item_id, started_on, ended_on`,
    itemIds,
  );
  for (const r of rows) {
    const list = out.get(r.item_id) ?? [];
    list.push(toDateRange(r));
    out.set(r.item_id, list);
  }
  return out;
}

/** 传入的区间必须是**已经归一化**的（见 shared/ranges.ts normalizeRanges）。 */
async function replaceRanges(
  conn: mysql.PoolConnection | null,
  itemId: number,
  ranges: readonly DateRange[],
): Promise<void> {
  const del = "DELETE FROM item_watch_ranges WHERE item_id = ?";
  const ins = `INSERT INTO item_watch_ranges (item_id, started_on, ended_on) VALUES (?,?,?)`;

  if (conn) {
    await conn.execute(del, [itemId]);
    for (const r of ranges) await conn.execute(ins, [itemId, r.from, r.to]);
    return;
  }
  await transaction(async (c) => {
    await c.execute(del, [itemId]);
    for (const r of ranges) await c.execute(ins, [itemId, r.from, r.to]);
  });
}

/**
 * 全量替换某个条目的区间。
 *
 * **全量替换**而不是逐条增删改：区间是一个整体（它们共同回答「什么时候看的」），
 * 而且写入前要经过归一化（排序 + 合并重叠）—— 逐条改的话归一化的结果没法表达
 * （「这两段合并成一段」用增删改要说三句话，还容易说错）。
 */
export async function setItemRanges(itemId: number, ranges: readonly DateRange[]): Promise<void> {
  await replaceRanges(null, itemId, ranges);
}

/** 建条目时用：和 items / item_urls 的插入在**同一个事务**里。 */
export async function insertRangesInTx(
  conn: mysql.PoolConnection,
  itemId: number,
  ranges: readonly DateRange[],
): Promise<void> {
  await replaceRanges(conn, itemId, ranges);
}

/**
 * 周视图聚合的取数：所有未删条目的全部区间。
 *
 * ⚠️ 这是**一次全量取数**，但只有**一次往返**。周列表要给出「一共有多少周」
 * （分页总数），所以必须看全。聚合在应用层做 —— MySQL 5.7 没有 CTE / 递归 /
 * 窗口函数，**SQL 里造不出「周序列」**，而 ISO 周的算法只该有一份
 * （shared/week.ts，和 MySQL 的 YEARWEEK(x,3) 对拍过 15000 天）。
 *
 * 规矩「聚合要在一条 SQL 里算完」（AGENTS.md §四）的真正理由是**别在循环里查库**
 * —— 库在远程，往返才是贵的。这里正是照那个理由做的：一次往返，其余在内存里。
 */
export async function listForWeekAggregation(): Promise<WatchRangeForWeekRow[]> {
  return query<WatchRangeForWeekRow>(
    `SELECT r.item_id, r.started_on, r.ended_on, i.channel_code
     FROM item_watch_ranges r
     JOIN items i ON i.id = r.item_id
     WHERE i.deleted_at IS NULL`,
  );
}
