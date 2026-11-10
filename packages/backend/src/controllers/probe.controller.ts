import Router from "@koa/router";
import { z } from "zod";
import { runProbe, verdictOf } from "../services/probe.service.js";
import * as urlchecksDao from "../dao/urlchecks.dao.js";
import { ok } from "../http/respond.js";
import { parseBody, parseParams, idParam } from "../http/validate.js";

export const probeController = new Router();

/** 手动跑一轮探活。 */
probeController.post("/run", async (ctx) => {
  const body = parseBody(
    ctx,
    z.object({
      limit: z.number().int().min(1).max(200).optional(),
      maxAgeHours: z.number().int().min(0).max(24 * 365).optional(),
      /** 只查这些链接（「立刻检查这一条」） */
      onlyUrlIds: z.array(z.number().int().positive()).max(100).optional(),
    }),
  );
  const out = await runProbe(body);
  ok(ctx, {
    checked: out.checked,
    byVerdict: out.byVerdict,
    results: out.results.map((r) => ({ ...r, verdict: verdictOf(r.status) })),
  });
});

/** 「待备份」视图：链接失效、或被拦住的。 */
probeController.get("/unhealthy", async (ctx) => {
  const links = await urlchecksDao.unhealthyLinks();
  ok(
    ctx,
    links.map((l) => ({
      itemId: l.item_id,
      url: l.url,
      httpStatus: l.http_status,
      checkedAt: l.checked_at,
      verdict: l.checked_at === null ? "never_checked" : verdictOf(l.http_status),
    })),
  );
});

/** 某条链接的探活历史。 */
probeController.get("/history/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  ok(ctx, await urlchecksDao.historyOf(id, 20));
});
