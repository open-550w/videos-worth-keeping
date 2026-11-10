import type { Context, Next } from "koa";
import { logger } from "../logger.js";

/** 每个请求一行日志。放在 errorHandler 外层，才能记到最终状态码。 */
export async function requestLogger(ctx: Context, next: Next): Promise<void> {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const line = {
    method: ctx.method,
    path: ctx.path,
    status: ctx.status,
    ms,
  };
  if (ctx.status >= 500) logger.error(line, "请求失败");
  else if (ctx.status >= 400) logger.warn(line, "请求异常");
  else logger.info(line, "请求");
}
