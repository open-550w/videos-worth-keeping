import type { Context } from "koa";
import { z } from "zod";
import { badRequest } from "./errors.js";

/** 解析并校验请求体；失败抛 400，附带字段级信息。 */
export function parseBody<T extends z.ZodTypeAny>(ctx: Context, schema: T): z.infer<T> {
  const result = schema.safeParse(ctx.request.body);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw badRequest(`请求体不合法 —— ${detail}`);
  }
  return result.data;
}

/** 解析并校验 query（值都是字符串，交给 schema 去 coerce）。 */
export function parseQuery<T extends z.ZodTypeAny>(ctx: Context, schema: T): z.infer<T> {
  const result = schema.safeParse(ctx.query);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw badRequest(`查询参数不合法 —— ${detail}`);
  }
  return result.data;
}

/** 解析并校验路径参数。 */
export function parseParams<T extends z.ZodTypeAny>(ctx: Context, schema: T): z.infer<T> {
  const result = schema.safeParse(ctx.params);
  if (!result.success) {
    throw badRequest(`路径参数不合法 —— ${result.error.issues[0]?.message ?? "unknown"}`);
  }
  return result.data;
}

/** `YYYY-MM-DD`，且必须是真实存在的日期（挡掉 2026-02-30 这种）。 */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "需要 YYYY-MM-DD 格式")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "不是一个真实存在的日期");

/** `YYYY-MM-DD HH:mm:ss`（MySQL DATETIME 的字面形状）。 */
export const dateTimeString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/, "需要 YYYY-MM-DD HH:mm 格式");

/** 正整数 id。BIGINT UNSIGNED 但在个人站的量级内，JS number 安全。 */
export const idParam = z.coerce.number().int().positive();
