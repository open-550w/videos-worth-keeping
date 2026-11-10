import Router from "@koa/router";
import { listChannels } from "../dao/channels.dao.js";
import { ok } from "../http/respond.js";

export const channelsController = new Router();

channelsController.get("/", async (ctx) => {
  const rows = await listChannels();
  ok(
    ctx,
    rows.map((r) => ({
      code: r.code,
      name: r.name,
      defaultContentType: r.default_content_type,
      urlPattern: r.url_pattern,
      sortOrder: r.sort_order,
    })),
  );
});
