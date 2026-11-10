import Router from "@koa/router";
import { z } from "zod";
import { listWeeks } from "../services/items.service.js";
import { ok } from "../http/respond.js";
import { parseQuery } from "../http/validate.js";

export const weeksController = new Router();

/**
 * 按周聚合。
 *
 * ⚠️ 这是**展示用的聚合**，不代表「周」是个领域实体 ——
 * 需求确认会：「周其实目前就是一个前端展示/设计的概念而已」。
 *
 * 所以按日期区间取条目走的是 `GET /api/items?from=&to=`，
 * 而这里只回答「有哪些周、每周几条」这个问题。
 * 将来想加月视图 / 年视图，是**纯前端改动**（换个聚合接口或前端自己算）。
 */
weeksController.get("/", async (ctx) => {
  const q = parseQuery(
    ctx,
    z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  );
  ok(ctx, await listWeeks(q.limit ?? 30, q.offset ?? 0));
});
