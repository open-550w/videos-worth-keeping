import Router from "@koa/router";
import { z } from "zod";
import * as notesDao from "../dao/notes.dao.js";
import { ok } from "../http/respond.js";
import { parseBody, parseParams, dateTimeString, idParam } from "../http/validate.js";
import { notFound } from "../http/errors.js";

export const notesController = new Router();

notesController.patch("/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const body = parseBody(
    ctx,
    z.object({
      body: z.string().min(1).max(20000).optional(),
      rating: z.number().int().min(1).max(5).optional().nullable(),
      /** 补录：把 `noted_at` 改到当时，而不是现在 */
      noted_at: dateTimeString.optional(),
    }),
  );
  const okUpdated = await notesDao.updateNote(id, body);
  if (!okUpdated) throw notFound(`评论 ${id} 不存在`);
  ok(ctx, await notesDao.getNote(id));
});

notesController.delete("/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const deleted = await notesDao.deleteNote(id);
  if (!deleted) throw notFound(`评论 ${id} 不存在`);
  ok(ctx, { id, deleted: true });
});
