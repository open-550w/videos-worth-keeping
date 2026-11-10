import Router from "@koa/router";
import { z } from "zod";
import * as tagsDao from "../dao/tags.dao.js";
import { ok, created } from "../http/respond.js";
import { parseBody, parseParams, idParam } from "../http/validate.js";
import { notFound, badRequest } from "../http/errors.js";

export const tagsController = new Router();

/**
 * 标签组 + 标签。
 *
 * 关键在 `selection`：
 *   single   → UI 上是**分类**（一个组里只能选一个）
 *   multiple → UI 上是**标签**（可多选）
 *
 * 需求确认会「标签和分类都想要，不确定哪个更好」的解法就是这一列 ——
 * 不用二选一，而且**随时能把某个组从单选改成多选**（放宽约束不用改数据）。
 */

const selectionSchema = z.enum(["single", "multiple"]);

tagsController.get("/", async (ctx) => {
  const [groups, tags] = await Promise.all([tagsDao.listGroups(), tagsDao.listTags()]);
  ok(ctx, {
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      selection: g.selection,
      sortOrder: g.sort_order,
      tags: tags
        .filter((t) => t.group_id === g.id)
        .map((t) => ({ id: t.id, name: t.name, color: t.color, sortOrder: t.sort_order })),
    })),
  });
});

tagsController.post("/groups", async (ctx) => {
  const body = parseBody(
    ctx,
    z.object({
      name: z.string().min(1).max(64),
      selection: selectionSchema,
      sortOrder: z.number().int().optional(),
    }),
  );
  const id = await tagsDao.createGroup({
    name: body.name,
    selection: body.selection,
    sort_order: body.sortOrder,
  });
  created(ctx, await tagsDao.getGroup(id));
});

tagsController.patch("/groups/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const body = parseBody(
    ctx,
    z.object({
      name: z.string().min(1).max(64).optional(),
      // 从 multiple 改成 single 时，已有的多选数据不会自动收敛 ——
      // 这是**放宽还是收紧**的区别：single→multiple 是放宽（不用动数据），
      // multiple→single 是收紧（历史数据可能违反新约束）。这里不自动清理，
      // 只在下次保存该条目时由 setItemTags 收敛。
      selection: selectionSchema.optional(),
      sortOrder: z.number().int().optional(),
    }),
  );
  const okUpdated = await tagsDao.updateGroup(id, {
    name: body.name,
    selection: body.selection,
    sort_order: body.sortOrder,
  });
  if (!okUpdated) throw notFound(`标签组 ${id} 不存在`);
  ok(ctx, await tagsDao.getGroup(id));
});

tagsController.delete("/groups/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const n = await tagsDao.countTagsByGroup(id);
  const group = await tagsDao.getGroup(id);
  if (!group) throw notFound(`标签组 ${id} 不存在`);
  // 级联删组里的标签与关联 —— 破坏性操作，让前端先确认过
  await tagsDao.deleteGroup(id);
  ok(ctx, { id, deletedTags: n });
});

tagsController.post("/", async (ctx) => {
  const body = parseBody(
    ctx,
    z.object({
      groupId: idParam,
      name: z.string().min(1).max(64),
      color: z.string().max(16).optional().nullable(),
      sortOrder: z.number().int().optional(),
    }),
  );
  const group = await tagsDao.getGroup(body.groupId);
  if (!group) throw badRequest(`标签组 ${body.groupId} 不存在`);
  const id = await tagsDao.createTag({
    group_id: body.groupId,
    name: body.name,
    color: body.color ?? null,
    sort_order: body.sortOrder,
  });
  created(ctx, await tagsDao.getTag(id));
});

tagsController.patch("/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const body = parseBody(
    ctx,
    z.object({
      name: z.string().min(1).max(64).optional(),
      color: z.string().max(16).optional().nullable(),
      sortOrder: z.number().int().optional(),
      groupId: idParam.optional(),
    }),
  );
  const okUpdated = await tagsDao.updateTag(id, {
    name: body.name,
    color: body.color,
    sort_order: body.sortOrder,
    group_id: body.groupId,
  });
  if (!okUpdated) throw notFound(`标签 ${id} 不存在`);
  ok(ctx, await tagsDao.getTag(id));
});

tagsController.delete("/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const okDeleted = await tagsDao.deleteTag(id);
  if (!okDeleted) throw notFound(`标签 ${id} 不存在`);
  ok(ctx, { id, deleted: true });
});
