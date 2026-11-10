import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "koa";

function matches(value: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(value).digest(), createHash("sha256").update(expected).digest());
}
/** Protect API data and attachment bytes alike. Tokens never travel in URLs. */
export async function optionalAuth(ctx: Context, next: Next): Promise<void> {
  const expected = process.env.ACCESS_TOKEN;
  if (!expected || expected.length < 24) {
    ctx.status = 503;
    ctx.body = { code: 503, message: "请配置至少 24 位 ACCESS_TOKEN", data: null };
    return;
  }
  if (ctx.path === "/api/auth/login" && ctx.method === "POST") {
    const token = (ctx.request.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || !matches(token, expected)) {
      ctx.status = 401;
      ctx.body = { code: 401, message: "访问口令不正确", data: null };
      return;
    }
    ctx.cookies.set("lc_session", expected, { httpOnly: true, sameSite: "strict", secure: ctx.secure, overwrite: true, path: "/", maxAge: 7 * 86400_000 });
    ctx.body = { code: 0, message: "ok", data: { authenticated: true } };
    return;
  }
  const bearer = ctx.get("authorization").replace(/^Bearer /i, "");
  const token = bearer || ctx.cookies.get("lc_session") || "";
  if (!matches(token, expected)) {
    ctx.status = 401;
    ctx.body = { code: 401, message: "请输入访问口令", data: null };
    return;
  }
  if (ctx.path === "/api/auth/logout" && ctx.method === "POST") {
    ctx.cookies.set("lc_session", null, { path: "/", overwrite: true });
    ctx.body = { code: 0, message: "ok", data: null };
    return;
  }
  await next();
}
