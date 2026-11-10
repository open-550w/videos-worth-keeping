import Router from "@koa/router";
import { z } from "zod";
import * as service from "../services/history.service.js";
import * as dao from "../dao/watchHistory.dao.js";
import { getSyncState, startSync, SyncBusyError } from "../services/bili/sync.service.js";
import { parseTimeArg } from "../services/bili/history.js";
import { badRequest, conflict } from "../http/errors.js";
import { ok } from "../http/respond.js";
import { parseBody, parseQuery, dateString } from "../http/validate.js";

export const historyController = new Router();

/**
 * 候选区：B 站观看历史抓回来之后、还没决定要不要收藏的东西。
 *
 * ⚠️ 抓取**不在这里** —— 它是 `pnpm fetch:bili` 这个 CLI 干的
 * （见 services/bili/fetch.cli.ts）。理由是抓一次要几十秒到几分钟、要打外部接口、
 * 还要在限流时退避重试：这些都不该塞进一个 HTTP 请求里。
 * 页面只负责「从已经抓回来的里面挑」。
 */

const statusSchema = z.enum(["active", "pending", "collected", "archived", "all"]);
const searchFieldSchema = z.enum(dao.SEARCH_FIELDS as [dao.SearchField, ...dao.SearchField[]]);

/**
 * 搜索范围：query 里是逗号分隔的串，body 里是数组 —— 两种写法都收。
 *
 * ⚠️ 不认识的字段**报 400，不静默忽略**。悄悄丢掉它的话，
 * `?fields=title,titel` 会变成「只搜标题」，用户以为搜的是两个字段 ——
 * 拿到的是**看起来正常但少了结果**的答案。这个仓库最讨厌这类 bug（AGENTS.md §二）。
 */
const fieldsQuerySchema = z
  .string()
  .max(80)
  .optional()
  .refine(
    (s) =>
      s === undefined ||
      s.split(",").every((x) => (dao.SEARCH_FIELDS as string[]).includes(x.trim())),
    { message: `搜索范围只能是 ${dao.SEARCH_FIELDS.join(" / ")}（逗号分隔）` },
  );

function parseFields(v: string | string[] | undefined): dao.SearchField[] | undefined {
  const raw = Array.isArray(v) ? v : (v ?? "").split(",");
  const out = raw
    .map((s) => String(s).trim())
    .filter((s): s is dao.SearchField => (dao.SEARCH_FIELDS as string[]).includes(s));
  return out.length ? out : undefined;
}

/** 筛选条件（不含状态、不含分页）—— 列表和「一键归档」共用，口径必须一致。 */
const filterFields = {
  /** 关键词 */
  q: z.string().max(200).optional(),
  /** 搜哪几个字段；不传 = 只搜标题 */
  fields: fieldsQuerySchema,
  /** 观看日期窗口 */
  from: dateString.optional(),
  to: dateString.optional(),
  /** 话题标签，精确匹配 */
  tag: z.string().max(64).optional(),
  /** UP 主，精确匹配 */
  up: z.string().max(255).optional(),
};

/** 「一键归档」的 body：筛选条件和上面一样，只是 `fields` 用数组写法。 */
const archiveAllBody = z.object({
  q: z.string().max(200).optional(),
  fields: z.array(searchFieldSchema).max(4).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  tag: z.string().max(64).optional(),
  up: z.string().max(255).optional(),
});

const listQuery = z.object({
  /** collected = 已经在收藏里了（**算出来的**，不是存下来的状态） */
  status: statusSchema.optional(),
  ...filterFields,
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

historyController.get("/", async (ctx) => {
  const q = parseQuery(ctx, listQuery);
  ok(
    ctx,
    await service.listHistory({
      status: q.status ?? "pending",
      q: q.q,
      fields: parseFields(q.fields),
      from: q.from,
      to: q.to,
      tag: q.tag,
      up: q.up,
      limit: q.limit,
      offset: q.offset,
    }),
  );
});

/** 筛选面板的选项（UP 主 / 话题标签 / 候选覆盖的日期范围）。 */
historyController.get("/facets", async (ctx) => {
  ok(ctx, await service.facets());
});

/**
 * 同步：从 B 站**增量**拉新的观看历史。
 *
 * ⚠️ 语义是「**只拿新的，不改已有的**」——
 *   ① 候选区里已经有的视频，**连详情都不再拉**（标题/封面/标签不会变，重抓是白打接口）
 *   ② 写库只插不改（`ON DUPLICATE KEY UPDATE id = id`）
 *   ③ 我归档过的、收藏过的，一个字都不动
 *
 * 这是**后台任务**：POST 立刻返回，页面轮询 GET 看进度。
 * 抓一次几十秒到几分钟、还要退避重试 —— 做成同步请求就是「必然超时，
 * 但服务端还在打接口」。
 */
historyController.post("/sync", async (ctx) => {
  const body = parseBody(
    ctx,
    z.object({
      /** 可选的窗口起点，`YYYY-MM-DD` 或相对写法（`7d`）。不传 = 至少最近 7 天 */
      since: z.string().max(32).optional(),
      refreshCookies: z.boolean().optional(),
    }),
  );
  let since: number | undefined;
  try { since = body.since ? parseTimeArg(body.since) : undefined; }
  catch (err) { throw badRequest((err as Error).message); }
  if (since !== undefined && since > Date.now() / 1000) throw badRequest("同步起点不能晚于现在");
  try {
    ok(ctx, startSync({ since, refreshCookies: body.refreshCookies }));
  } catch (err) {
    if (err instanceof SyncBusyError) throw conflict(err.message);
    throw err;
  }
});

historyController.get("/sync", async (ctx) => {
  ok(ctx, getSyncState());
});

const idsBody = z.object({
  /** 候选行的 id（页面上一个视频可能对应多行 —— 看几次就有几行） */
  entryIds: z.array(z.number().int().positive()).min(1).max(500),
});

historyController.post("/import", async (ctx) => {
  const { entryIds } = parseBody(ctx, idsBody);
  ok(ctx, await service.importEntries(entryIds));
});

/** 归档 / 取消归档选中的那些。 */
historyController.post("/archive", async (ctx) => {
  const body = parseBody(ctx, idsBody.extend({ archived: z.boolean().default(true) }));
  ok(ctx, await service.archiveEntries(body.entryIds, body.archived));
});

/**
 * 一键归档当前筛选下的**所有待选**。
 *
 * ⚠️ 服务端把状态**写死成 pending**（见 dao.archiveAllPending），
 * 所以这个接口**不可能**动到已经收藏的东西 —— 哪怕筛选条件传错了。
 */
historyController.post("/archive-all", async (ctx) => {
  const body = parseBody(ctx, archiveAllBody);
  ok(
    ctx,
    await service.archiveAllMatching({
      q: body.q,
      fields: parseFields(body.fields),
      from: body.from,
      to: body.to,
      tag: body.tag,
      up: body.up,
    }),
  );
});
