import { dbClient, execute, query, transaction, closePool } from "./db.js";
if (!process.argv.includes("--yes") && process.env.CONFIRM !== "yes") {
  console.error("这会清空当前配置的业务数据。确认请加 --yes。");
  process.exit(1);
}
const tables = ["watch_history_entries", "item_tags", "tags", "tag_groups", "attachments", "url_checks", "item_notes", "item_watch_ranges", "item_urls", "items"];
await transaction(async conn => {
  for (const table of tables) await conn.execute(`DELETE FROM ${table}`);
});
if (dbClient() === "sqlite") await execute("DELETE FROM sqlite_sequence");
console.log(await query("SELECT COUNT(*) AS channels FROM channels"));
await closePool();
