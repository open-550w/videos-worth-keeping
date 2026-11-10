import type { Context, Next } from "koa";
import { invalidateAll } from "../util/cache.js";
import { logger } from "../logger.js";

/**
 * 写操作成功后清空读缓存。
 *
 * 放在中间件里而不是各个 service 里，是为了**不可能漏**：
 * 新增一个写接口时，不需要记得去调失效 —— 它是按 HTTP 方法自动生效的。
 *
 * 只清「成功的写」（status < 400）：失败的写没有改变任何东西。
 *
 * ⚠️ 探活（probe）不经过 HTTP，它直接写 DAO。它只改 `item_urls.http_status`，
 * 而那个字段不在任何对外 DTO 里（ItemDto 用的是 primaryUrl），
 * 所以不需要为它失效缓存。
 */
export async function cacheInvalidation(ctx: Context, next: Next): Promise<void> {
  await next();
  if (ctx.method !== "GET" && ctx.method !== "HEAD" && ctx.status < 400) {
    invalidateAll();
    logger.debug({ method: ctx.method, path: ctx.path }, "写操作，已清空读缓存");
  }
}
