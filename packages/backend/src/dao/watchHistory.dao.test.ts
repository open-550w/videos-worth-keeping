import { test } from "node:test";
import assert from "node:assert/strict";
import { closePool, getPool, query } from "../db/db.js";
import { upsertEntries, listVideoPage, fillMissingBiliInteractions } from "./watchHistory.dao.js";
import type { WatchRecord } from "../services/bili/types.js";

// 显式启用的真库回归；临时表遮蔽同名业务表，连接关闭后自动消失。
// 从 backend 目录加载 .env.local 后运行 BILI_DB_TEST=1 tsx --test src/dao/watchHistory.dao.test.ts。
test("批内重复事件不触发自增冲突，重跑不覆盖内容和归档，refresh 仍可更新", {
  skip: process.env.BILI_DB_TEST !== "1",
}, async () => {
  process.env.DB_POOL_SIZE = "1"; // 确保 DAO 的所有查询都使用临时表所在连接
  const pool = getPool();
  try {
    const [schema] = await query<{ "Create Table": string }>("SHOW CREATE TABLE watch_history_entries");
    await pool.query(schema["Create Table"].replace("CREATE TABLE", "CREATE TEMPORARY TABLE"));
    const record: WatchRecord = {
      channelCode: "bilibili", business: "archive", platformItemId: "test-event",
      watchedAt: 1792588812, url: "https://www.bilibili.com/video/test-event",
      title: "首次标题", author: null, coverUrl: null, durationSec: null, summary: null,
      progressSec: null, watchedToEnd: false, biliLiked: null, biliCoins: null, biliFavorited: null, device: null, tags: [],
      publishedOn: null, contentType: "video", detailError: null,
    };
    const batch = [record, { ...record, title: "重复标题" },
      { ...record, platformItemId: "test-other" }];
    assert.deepEqual(await upsertEntries(batch), { received: 3, inserted: 2, updated: 1 });
    await pool.query("UPDATE watch_history_entries SET archived_at = '2026-11-01 00:00:00'");
    const before = await query("SELECT * FROM watch_history_entries ORDER BY id");
    assert.equal((before[0] as { title: string }).title, "首次标题");
    assert.deepEqual(await upsertEntries(batch.map(r => ({ ...r, title: "覆盖尝试" }))),
      { received: 3, inserted: 0, updated: 3 });
    assert.deepEqual(await query("SELECT * FROM watch_history_entries ORDER BY id"), before);
    await upsertEntries([{ ...record, title: "主动刷新" }], { updateExisting: true });
    const [row] = await query<{ title: string; archived_at: string }>(
      "SELECT title, archived_at FROM watch_history_entries WHERE platform_item_id = ?", [record.platformItemId]);
    assert.equal(row.title, "主动刷新");
    assert.equal(row.archived_at, "2026-11-01 00:00:00");
    const archivedBefore = await query("SELECT id, title, watched_at, archived_at FROM watch_history_entries ORDER BY id");
    await fillMissingBiliInteractions([{ platformItemId: record.platformItemId, biliLiked: false, biliCoins: 2, biliFavorited: true }]);
    const [interaction] = await query<{ bili_liked: number; bili_coins: number; bili_favorited: number }>(
      "SELECT bili_liked, bili_coins, bili_favorited FROM watch_history_entries WHERE platform_item_id = ?", [record.platformItemId]);
    assert.deepEqual(interaction, { bili_liked: 0, bili_coins: 2, bili_favorited: 1 });
    await fillMissingBiliInteractions([{ platformItemId: record.platformItemId, biliLiked: true, biliCoins: 0, biliFavorited: false }]);
    assert.deepEqual((await query("SELECT bili_liked, bili_coins, bili_favorited FROM watch_history_entries WHERE platform_item_id = ?", [record.platformItemId]))[0], interaction);
    assert.deepEqual(await query("SELECT id, title, watched_at, archived_at FROM watch_history_entries ORDER BY id"), archivedBefore);
    // 模拟收藏后：默认「未归档」仍显示，待选则排除，不往真实 items 写测试数据。
    await pool.query("CREATE TEMPORARY TABLE items (id BIGINT PRIMARY KEY, channel_code VARCHAR(32), platform_item_id VARCHAR(128), deleted_at DATETIME NULL)");
    await pool.query("INSERT INTO items VALUES (1, 'bilibili', 'test-event', NULL)");
    await pool.query("UPDATE watch_history_entries SET archived_at = NULL");
    assert.equal((await listVideoPage({ status: "active" }, 24, 0)).total, 2);
    assert.equal((await listVideoPage({ status: "pending" }, 24, 0)).total, 1);
    assert.equal((await listVideoPage({ status: "collected" }, 24, 0)).total, 1);
    // 正控：严格模式的数据错误仍需抛出，不能像 INSERT IGNORE 那样吞掉。
    await assert.rejects(upsertEntries([{ ...record, platformItemId: "bad", title: "x".repeat(10000) }]),
      (err: { code?: string }) => err.code === "ER_DATA_TOO_LONG");
  } finally {
    await closePool();
  }
});
