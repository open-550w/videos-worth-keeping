import { query } from "../db/db.js";
import { cached } from "../util/cache.js";

export interface ChannelRow {
  code: string;
  name: string;
  default_content_type: string;
  url_pattern: string | null;
  sort_order: number;
  enabled: number;
}

export async function listChannels(includeDisabled = false): Promise<ChannelRow[]> {
  return cached(`channels:${includeDisabled ? "all" : "enabled"}`, () =>
    query<ChannelRow>(
      `SELECT code, name, default_content_type, url_pattern, sort_order, enabled
       FROM channels
       ${includeDisabled ? "" : "WHERE enabled = 1"}
       ORDER BY sort_order, code`,
    ),
  );
}

/**
 * 渠道 code → 展示名。列表页要给每个条目挂渠道标签，一次查全避免 N+1。
 *
 * 缓存：渠道由迁移 seed，运行期不会变（加渠道要改代码 + 跑迁移），
 * 所以这是**最安全的一类缓存** —— 没有失效问题。
 */
export async function channelNameMap(): Promise<Map<string, string>> {
  const rows = await cached("channels:nameMap", () =>
    query<{ code: string; name: string }>("SELECT code, name FROM channels"),
  );
  return new Map(rows.map((r) => [r.code, r.name]));
}

export async function channelExists(code: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM channels WHERE code = ?",
    [code],
  );
  return (rows[0]?.n ?? 0) > 0;
}
