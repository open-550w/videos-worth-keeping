import type { Context, Next } from "koa";
import { AppError } from "../http/errors.js";
import { logger } from "../logger.js";

/** MySQL 的错误码 → 语义化的 HTTP 状态。 */
function mapMysqlError(err: { code?: string; message?: string }): AppError | null {
  switch (err.code) {
    case "ER_DUP_ENTRY":
      return new AppError(409, "已存在（唯一约束冲突）", 409);
    case "ER_NO_REFERENCED_ROW_2":
      return new AppError(400, "引用了不存在的记录", 400);
    case "ER_ROW_IS_REFERENCED_2":
      return new AppError(409, "还有关联数据，不能删除", 409);
    case "ER_DATA_TOO_LONG":
      return new AppError(400, "字段内容过长", 400);
    default:
      return null;
  }
}

/**
 * 兜底异常处理。
 *
 * 必须在 requestLogger 内层 —— 它先把异常收敛成 status + body，
 * requestLogger 才拿得到最终状态码，失败请求才会留下请求行。
 */
export async function errorHandler(ctx: Context, next: Next): Promise<void> {
  try {
    await next();
  } catch (err) {
    const appErr =
      err instanceof AppError ? err : mapMysqlError(err as { code?: string });

    if (appErr) {
      ctx.status = appErr.status;
      ctx.body = {
        code: appErr.code,
        message: appErr.message,
        data: appErr.data ?? null,
      };
      // 4xx 是调用方的问题，不值得 error 级日志
      if (appErr.status >= 500) logger.error({ err }, appErr.message);
      else logger.warn({ path: ctx.path, msg: appErr.message }, "请求被拒");
      return;
    }

    // 没预料到的错误：记全栈，但不把内部细节漏给客户端
    logger.error({ err, path: ctx.path }, "未处理的异常");
    ctx.status = 500;
    ctx.body = { code: 500, message: "服务器内部错误", data: null };
  }
}
