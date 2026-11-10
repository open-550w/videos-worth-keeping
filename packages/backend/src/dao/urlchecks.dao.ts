import { execute, query, queryOne } from "../db/db.js";

export interface UrlCheckRow {
  id: number;
  item_url_id: number;
  http_status: number | null;
  error: string | null;
  latency_ms: number | null;
  checked_at: string;
}

export async function recordCheck(input: {
  item_url_id: number;
  http_status: number | null;
  error?: string | null;
  latency_ms?: number | null;
}): Promise<void> {
  await execute(
    "INSERT INTO url_checks (item_url_id, http_status, error, latency_ms) VALUES (?,?,?,?)",
    [input.item_url_id, input.http_status, input.error ?? null, input.latency_ms ?? null],
  );
  // 顺手更新 item_urls 上的「最近一次」快照 —— 列表页只看这一列，不用去翻历史
  await execute("UPDATE item_urls SET http_status = ?, checked_at = NOW() WHERE id = ?", [
    input.http_status,
    input.item_url_id,
  ]);
}

export async function historyOf(itemUrlId: number, limit = 20): Promise<UrlCheckRow[]> {
  return query<UrlCheckRow>(
    `SELECT id, item_url_id, http_status, error, latency_ms, checked_at
     FROM url_checks WHERE item_url_id = ?
     ORDER BY checked_at DESC, id DESC LIMIT ?`,
    [itemUrlId, limit],
  );
}

/** 最近 N 次里有几次失败 —— 用来判「连续失效」。 */
export async function recentFailures(itemUrlId: number, sample = 3): Promise<number> {
  const rows = await query<{ http_status: number | null }>(
    `SELECT http_status FROM url_checks WHERE item_url_id = ?
     ORDER BY checked_at DESC, id DESC LIMIT ?`,
    [itemUrlId, sample],
  );
  return rows.filter((r) => r.http_status === null || r.http_status >= 400).length;
}

/**
 * 待探活的链接：从没查过的排最前，其次是最久没查的。
 *
 * 单次只取一批（探活是低频轮询，不做常驻 worker —— 服务器是日常用的电脑，要轻）。
 */
export async function dueForCheck(limit: number, maxAgeHours: number): Promise<
  Array<{ item_url_id: number; url: string; item_id: number; http_status: number | null }>
> {
  return query(
    `SELECT u.id AS item_url_id, u.url, u.item_id, u.http_status
     FROM item_urls u
     JOIN items i ON i.id = u.item_id
     WHERE i.deleted_at IS NULL
       AND (u.checked_at IS NULL OR u.checked_at < DATE_SUB(NOW(), INTERVAL ? HOUR))
     ORDER BY u.checked_at IS NOT NULL, u.checked_at ASC
     LIMIT ?`,
    [maxAgeHours, limit],
  );
}

export interface LinkHealth {
  item_id: number;
  url: string;
  http_status: number | null;
  checked_at: string | null;
}

/** 有问题的链接（失效或从没探过）—— 「待备份」视图用。 */
export async function unhealthyLinks(): Promise<LinkHealth[]> {
  return query<LinkHealth>(
    `SELECT i.id AS item_id, u.url, u.http_status, u.checked_at
     FROM items i
     JOIN item_urls u ON u.item_id = i.id
     WHERE i.deleted_at IS NULL
       AND (u.http_status IS NULL OR u.http_status >= 400)
     ORDER BY u.http_status DESC, i.collected_on DESC`,
  );
}

export async function countUnhealthy(): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT COUNT(DISTINCT i.id) AS n
     FROM items i JOIN item_urls u ON u.item_id = i.id
     WHERE i.deleted_at IS NULL AND (u.http_status IS NULL OR u.http_status >= 400)`,
  );
  return row?.n ?? 0;
}
