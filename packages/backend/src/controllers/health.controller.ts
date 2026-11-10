import Router from "@koa/router";
import { dbClient, ping } from "../db/db.js";
import { appliedVersions } from "../db/migrate.js";
import { cacheStats } from "../util/cache.js";
import { ok } from "../http/respond.js";

export const healthController = new Router();

/**
 * 证明「真的连上了远程库」—— 返回服务端版本和已应用的迁移。
 *
 * 这条路径的价值在启动期：库在远程，比本地 SQLite 多了一整类失败模式
 * （网络不通 / 密码错 / 防火墙 / 账号被限）。早失败比晚失败便宜。
 *
 * ⚠️ 这里**只做一次查询**（ping）。之前它还会去查迁移表，而且是**新建一条连接**
 * 再查 —— 前端每 60 秒轮询一次，等于每分钟在后台开一条新连接。
 * 现在迁移版本在启动时缓存，缓存命中率也在这里露出来（不然没法验证缓存有没有在工作）。
 */
healthController.get("/", async (ctx) => {
  const [{ version, now }, migrations] = await Promise.all([ping(), appliedVersions()]);
  const cache = cacheStats();
  const total = cache.hits + cache.misses;
  ok(ctx, {
    ok: true,
    database: { client: dbClient(), version },
    mysql: dbClient() === "mysql" ? version : null,
    serverTime: now,
    migrations,
    cache: {
      ...cache,
      hitRate: total === 0 ? null : Number((cache.hits / total).toFixed(3)),
    },
  });
});
