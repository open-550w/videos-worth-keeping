import Koa from "koa";
import { mkdirSync } from "node:fs";
import path from "node:path";
import cors from "@koa/cors";
import { koaBody } from "koa-body";
import { dbClient, getPool, startDbKeepalive } from "./db/db.js";
import { migrate } from "./db/migrate.js";
import { logger } from "./logger.js";
import { errorHandler } from "./middleware/error.js";
import { requestLogger } from "./middleware/logger.js";
import { optionalAuth } from "./middleware/auth.js";
import { cacheInvalidation } from "./middleware/cacheInvalidation.js";
import { router } from "./controllers/index.js";
import { startProbeLoop } from "./services/probe.service.js";

// 启动期先把迁移跑掉 —— 否则第一次请求会在「表不存在」上失败。
// 迁移失败不该让服务起不来（health 还能告诉你哪不对），但要响亮地记下来。
try {
  const { applied, already } = await migrate();
  if (applied.length) logger.info({ applied }, "迁移完成");
  else logger.info({ already: already.length }, "迁移已是最新");
  if (dbClient() === "mysql") getPool();
} catch (err) {
  logger.error({ err }, "启动期初始化失败 —— 服务照起，但接口大概率不可用");
}

const app = new Koa();
app.proxy = true;

// requestLogger 在 errorHandler 外层：errorHandler 收敛异常并写好 status 之后，
// requestLogger 才拿得到最终状态码，失败请求才会留下请求行。
app.use(requestLogger);
app.use(errorHandler);

const corsOrigin = process.env.CORS_ORIGIN;
app.use(cors(corsOrigin ? { origin: corsOrigin, credentials: true } : undefined));

const loginBody = koaBody({ jsonLimit: "4kb" });
app.use(async (ctx, next) => {
  if (ctx.path === "/api/auth/login" && ctx.method === "POST") await loginBody(ctx, next);
  else await next();
});

// 鉴权接缝：现在是空实现。传函数本身，不要调用它 ——
// `optionalAuth()` 返回的是 Promise，不是中间件。
app.use(optionalAuth);
const uploadTemp = path.join(process.env.APP_DATA_DIR ?? ".cache", "tmp");
mkdirSync(uploadTemp, { recursive: true });
const bodyParser = koaBody({ jsonLimit: "2mb", multipart: true, formidable: { uploadDir: uploadTemp } });
app.use(async (ctx, next) => {
  try { await bodyParser(ctx, next); }
  finally {
    const { rm } = await import("node:fs/promises");
    for (const value of Object.values(ctx.request.files ?? {})) {
      for (const file of Array.isArray(value) ? value : [value]) {
        if (file && typeof file === "object" && "filepath" in file) await rm(String(file.filepath), { force: true });
      }
    }
  }
});

// 写操作成功后清空读缓存。放在业务路由**之前**，这样它能包住所有写请求。
app.use(cacheInvalidation);

app.use(router.routes());
app.use(router.allowedMethods());

// 兜底 404
app.use((ctx) => {
  ctx.status = 404;
  ctx.body = { code: 404, message: "not found", data: null };
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3050;
app.listen(PORT, () => logger.info({ port: PORT }, "server started"));

// 低频探活（默认 6 小时一轮）。不是常驻 worker —— 主进程里一个 setInterval，
// timer 已 unref，不阻止进程退出。PROBE_ENABLED=0 可关。
startProbeLoop();

// 数据库保活心跳。这个库建连要 1–8 秒，连接凉了就变成「页面转十秒然后报错」。
startDbKeepalive();
