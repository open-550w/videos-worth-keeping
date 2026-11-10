import Router from "@koa/router";
import { z } from "zod";
import { resolveUrl } from "../services/resolvers/index.js";
import { ok } from "../http/respond.js";
import { parseBody } from "../http/validate.js";

export const resolveController = new Router();

/**
 * 粘贴 URL → 识别渠道 + 抓标题/封面。
 *
 * **永远返回 200**，用 `matched` / `resolved` 表达结果 —— 这不是一个会「失败」的接口，
 * 而是一个会「尽力而为」的接口。抓不到是正常情况（渠道不支持、平台改版、网络不通），
 * 前端据此降级为手动填。用 4xx 表达的话，前端就得把「正常的降级」当异常处理。
 */
resolveController.post("/", async (ctx) => {
  const { url } = parseBody(ctx, z.object({ url: z.string().min(1).max(2048) }));
  ok(ctx, await resolveUrl(url));
});

/** 支持哪些渠道 —— 前端用来提示「这个链接我认识」。 */
resolveController.get("/supported", async (ctx) => {
  ok(ctx, {
    channels: [
      { code: "bilibili", name: "Bilibili", hosts: ["bilibili.com", "b23.tv"] },
      { code: "hongguo", name: "红果", hosts: ["hongguoduanju.com"] },
    ],
  });
});
