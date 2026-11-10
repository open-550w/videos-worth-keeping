/** 用已有详情缓存补齐旧卡片的互动快照，不访问 B 站、不覆盖已有字段。 */
import { closePool, query } from "../../db/db.js";
import { fillMissingBiliInteractions, knownPlatformIds } from "../../dao/watchHistory.dao.js";
import { biliInteractionsOf, defaultCacheDir, readCachedDetail } from "./cache.js";

try {
  const ids = await knownPlatformIds("bilibili");
  const snapshots = [];
  for (const platformItemId of ids) {
    const detail = await readCachedDetail(defaultCacheDir(), platformItemId);
    if (detail?.relation_ok) snapshots.push({ platformItemId, ...biliInteractionsOf(detail) });
  }
  await fillMissingBiliInteractions(snapshots);
  const [coverage] = await query("SELECT COUNT(DISTINCT platform_item_id) AS videos, COUNT(DISTINCT CASE WHEN bili_liked IS NOT NULL AND bili_coins IS NOT NULL AND bili_favorited IS NOT NULL THEN platform_item_id END) AS known FROM watch_history_entries WHERE channel_code = 'bilibili'");
  console.log({ cachedSnapshots: snapshots.length, coverage });
} finally {
  await closePool();
}
