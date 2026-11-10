import type { Context } from "koa";

/** 统一响应包：{ code, message, data }。前端 lib/api.ts 解的就是这个形状。 */
export function ok<T>(ctx: Context, data: T): void {
  ctx.status = 200;
  ctx.body = { code: 0, message: "ok", data };
}

export function created<T>(ctx: Context, data: T): void {
  ctx.status = 201;
  ctx.body = { code: 0, message: "ok", data };
}

export function noContent(ctx: Context): void {
  ctx.status = 204;
  ctx.body = null;
}
