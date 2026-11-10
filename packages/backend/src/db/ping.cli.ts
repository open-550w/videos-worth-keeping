import { dbClient, ping, closePool } from "./db.js";
import { appliedVersions } from "./migrate.js";

/**
 * 连通性自检 —— 启动脚本在拉起服务**之前**调它。
 *
 * 库在远程，比本地 SQLite 多了一整类失败模式：网络不通 / 密码错 / 防火墙 /
 * 账号被限。这类失败拖到第一次请求才暴露，排查成本高得多。
 * **在启动期失败，比在请求期失败便宜。**
 */
try {
  const { version, now } = await ping();
  const migrations = await appliedVersions();
  console.log(`${dbClient()} ${version}｜库时间 ${now}｜迁移 ${migrations.length ? migrations.join(",") : "未执行"}`);
  await closePool();
  process.exit(0);
} catch (err) {
  const e = err as { code?: string; message?: string };
  console.error(`连不上数据库：${e.code ?? ""} ${e.message ?? ""}`);
  // 密码错是最容易误判的一类 —— 提示一下最常见的原因
  if (e.code === "ER_ACCESS_DENIED_ERROR") {
    console.error(
      "  → 检查 packages/backend/.env.local 里的 DB_PASSWORD 是否**加了引号**。" +
        "密码含 # 时建议加引号（shell source 两种写法都对，但 node --env-file 不加会截断）。",
    );
  }
  if (e.code === "ETIMEDOUT" || e.code === "ECONNREFUSED") {
    console.error("  → 网络不通。确认能访问 " + process.env.DB_HOST + "，以及 3306 没被防火墙挡。");
  }
  process.exit(1);
}
