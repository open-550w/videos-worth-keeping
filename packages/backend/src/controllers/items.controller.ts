import Router from "@koa/router";
import { z } from "zod";
import * as service from "../services/items.service.js";
import * as notesDao from "../dao/notes.dao.js";
import { ok, created } from "../http/respond.js";
import { parseBody, parseQuery, parseParams, dateString, dateTimeString, idParam } from "../http/validate.js";
import { toAttachmentDto } from "../services/items.service.js";
import * as attachmentsDao from "../dao/attachments.dao.js";

export const itemsController = new Router();

const scopeSchema = z.enum(["active", "trashed", "all"]).optional();

const listQuery = z.object({
  /**
   * **观看区间**的筛选窗口，闭区间，语义是「有交集」而不是「落在里面」。
   *
   * ⚠️ 以前这两个参数叫 `from` / `to`，筛的是 `collected_on`。
   * 换了含义就换名字 —— 同名不同义会让调用方**静默**拿到不一样的结果，
   * 那是这个仓库最讨厌的一类 bug（见 AGENTS.md §二）。
   */
  watchedFrom: dateString.optional(),
  watchedTo: dateString.optional(),
  channel: z.string().max(32).optional(),
  contentType: z.string().max(16).optional(),
  q: z.string().max(200).optional(),
  /** 逗号分隔的 tag id */
  tagIds: z.string().max(400).optional(),
  scope: scopeSchema,
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

itemsController.get("/", async (ctx) => {
  const q = parseQuery(ctx, listQuery);
  const tagIds = q.tagIds
    ? q.tagIds
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
    : undefined;
  ok(
    ctx,
    await service.listItems({
      watchedFrom: q.watchedFrom,
      watchedTo: q.watchedTo,
      channel: q.channel,
      contentType: q.contentType,
      q: q.q,
      tagIds,
      scope: q.scope ?? "active",
      limit: q.limit,
      offset: q.offset,
    }),
  );
});

/** 回收站条数 —— header 上挂角标用。 */
itemsController.get("/trash-count", async (ctx) => {
  const n = await service.listItems({ scope: "trashed", limit: 1, offset: 0 });
  ok(ctx, { count: n.total });
});

/**
 * 观看日期区间：`[{ from, to }]`，闭区间，单日就 `from === to`。
 *
 * 上限 50 段是防呆 —— 一个人看一部剧不会分成 50 段；真到了那个数量，
 * 说明是脚本灌进来的，不该让它在渲染和展开时无限膨胀。
 *
 * 这里只校验**形状**（合法日期、起止顺序）。排序、合并重叠、去重是
 * `normalizeRanges` 的事，放在 service 里做 —— 那样不管从哪个入口进来
 * （API / 导入 / 脚本）都会经过同一道归一化。
 */
const watchRangesSchema = z
  .array(
    z
      .object({ from: dateString, to: dateString })
      .refine((r) => r.from <= r.to, { message: "结束日不能早于开始日" }),
  )
  .max(50);

const createBody = z.object({
  url: z.string().max(2048).optional().nullable(),
  title: z.string().max(512).optional(),
  content_type: z.string().max(16).optional(),
  channel_code: z.string().max(32).optional().nullable(),
  author: z.string().max(255).optional().nullable(),
  platform_item_id: z.string().max(128).optional().nullable(),
  cover_url: z.string().max(1024).optional().nullable(),
  summary: z.string().max(20000).optional().nullable(),
  duration_sec: z.number().int().min(0).optional().nullable(),
  published_on: dateString.optional().nullable(),
  collected_on: dateString,
  watched_ranges: watchRangesSchema.optional(),
  meta_json: z.unknown().optional(),
  note: z.string().max(20000).optional(),
  tag_ids: z.array(z.number().int().positive()).max(50).optional(),
});

itemsController.post("/", async (ctx) => {
  created(ctx, await service.createItem(parseBody(ctx, createBody)));
});

itemsController.get("/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  ok(ctx, await service.getItemDetail(id));
});

const patchBody = z.object({
  title: z.string().max(512).optional(),
  author: z.string().max(255).optional().nullable(),
  content_type: z.string().max(16).optional(),
  channel_code: z.string().max(32).optional().nullable(),
  platform_item_id: z.string().max(128).optional().nullable(),
  cover_url: z.string().max(1024).optional().nullable(),
  summary: z.string().max(20000).optional().nullable(),
  collected_on: dateString.optional(),
  watched_ranges: watchRangesSchema.optional(),
  url: z.string().max(2048).optional(),
  tag_ids: z.array(z.number().int().positive()).max(50).optional(),
  meta_json: z.unknown().optional(),
});

itemsController.patch("/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  ok(ctx, await service.updateItem(id, parseBody(ctx, patchBody)));
});

/** 软删 —— 进回收站，可恢复。 */
itemsController.delete("/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  await service.softDeleteItem(id);
  ok(ctx, { id, deleted: true });
});

itemsController.post("/:id/restore", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  await service.restoreItem(id);
  ok(ctx, { id, restored: true });
});

/** 硬删 —— 不可逆，连存储里的文件一起清。 */
itemsController.delete("/:id/hard", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  ok(ctx, { id, ...(await service.hardDeleteItem(id)) });
});

itemsController.post("/empty-trash", async (ctx) => {
  ok(ctx, await service.emptyTrash());
});

// ============ 评论 ============

itemsController.post("/:id/notes", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const body = parseBody(
    ctx,
    z.object({
      body: z.string().min(1).max(20000),
      rating: z.number().int().min(1).max(5).optional().nullable(),
      /** 补录时用：`YYYY-MM-DD HH:mm` 或 `YYYY-MM-DD HH:mm:ss` */
      noted_at: dateTimeString.optional().nullable(),
    }),
  );
  // 条目得存在（软删的也算存在，但提示一下）
  const detail = await service.getItemDetail(id);
  const noteId = await notesDao.createNote({
    item_id: id,
    body: body.body,
    rating: body.rating ?? null,
    noted_at: body.noted_at ?? null,
  });
  const note = await notesDao.getNote(noteId);
  created(ctx, { ...note, itemDeletedAt: detail.deletedAt });
});

itemsController.get("/:id/notes", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  ok(ctx, await notesDao.listNotes(id));
});

/** 条目的附件（含评论下的）—— 详情接口已经带了，这个是给单独刷新用。 */
itemsController.get("/:id/attachments", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const rows = await attachmentsDao.listByItem(id);
  ok(ctx, rows.map(toAttachmentDto));
});
