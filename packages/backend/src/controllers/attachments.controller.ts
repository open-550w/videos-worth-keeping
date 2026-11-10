import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import Router from "@koa/router";
import { z } from "zod";
import * as attachmentsDao from "../dao/attachments.dao.js";
import * as itemsDao from "../dao/items.dao.js";
import { getStorage, storageKeyFor, isValidStorageKey } from "../services/storage/index.js";
import { toAttachmentDto } from "../services/items.service.js";
import { ok, created } from "../http/respond.js";
import { parseParams, idParam } from "../http/validate.js";
import { badRequest, notFound } from "../http/errors.js";
import { logger } from "../logger.js";

/**
 * 附件 + 本机存储的静态出口。
 *
 * ⚠️ 这个 controller 里同时有 `/api/*` 和 `/uploads/*` 两种前缀，
 * 所以在 controllers/index.ts 里**挂在根上**，路径写全。
 */
export const attachmentsController = new Router();

/** 允许的附件类型。视频/录屏是「手动备份」的主要形态。 */
const KINDS = ["screenshot", "backup_video", "backup_recording", "backup_image", "other"] as const;

const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB ?? 500) * 1024 * 1024;

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

/** 从原始文件名取扩展名 —— 只在 MIME 认不出来时兜底。 */
function extFromName(name: string): string {
  const ext = path.extname(name).replace(".", "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

interface FormidableFile {
  filepath?: string;
  originalFilename?: string;
  mimetype?: string;
  size?: number;
}

/** koa-body(multipart) 把文件挂在 ctx.request.files 上，可能是对象或数组。 */
function pickFile(files: unknown): { buffer: Buffer; name: string; mime: string; size: number } | null {
  if (!files || typeof files !== "object") return null;
  const map = files as Record<string, unknown>;
  const raw = map.file ?? map.attachment ?? Object.values(map)[0];
  if (!raw) return null;
  const f = (Array.isArray(raw) ? raw[0] : raw) as FormidableFile | undefined;
  if (!f?.filepath) return null;
  const buffer = readFileSync(f.filepath);
  return {
    buffer,
    name: f.originalFilename ?? "unnamed",
    mime: f.mimetype ?? "application/octet-stream",
    size: f.size ?? buffer.length,
  };
}

/**
 * 上传附件（截图 / 手动备份的视频、录屏）。
 *
 * ⚠️ 这里**不做缩略图**。生成缩略图要 sharp（原生依赖，几十 MB 且要编译），
 * 和「服务器是日常用的电脑、要轻」这条约束直接冲突。
 * 个人站几百张截图，前端用 CSS 限尺寸显示原图就够了。
 * 真需要缩略图时再加，那时大概也该顺便上 CDN 了。
 */
attachmentsController.post("/api/items/:id/attachments", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const item = await itemsDao.getItem(id, "all");
  if (!item) throw notFound(`条目 ${id} 不存在`);

  const file = pickFile(ctx.request.files);
  if (!file) throw badRequest("没有收到文件（表单字段名用 file）");
  if (file.size > MAX_BYTES) {
    throw badRequest(`文件超过上限 ${process.env.MAX_UPLOAD_MB ?? 500}MB`);
  }

  const body = (ctx.request.body ?? {}) as Record<string, unknown>;
  const kindRaw = String(body.kind ?? "screenshot");
  const kind = (KINDS as readonly string[]).includes(kindRaw) ? kindRaw : "screenshot";
  const noteId = body.noteId ? Number(body.noteId) : null;

  const sha256 = createHash("sha256").update(file.buffer).digest("hex");

  // 同一个条目里同一个文件不存两份（内容寻址，key 本来就一样）
  const dup = await attachmentsDao.findBySha(id, sha256);
  if (dup) {
    ok(ctx, { ...toAttachmentDto(dup), deduped: true });
    return;
  }

  const ext = EXT_BY_MIME[file.mime] ?? extFromName(file.name);
  const key = storageKeyFor(id, sha256, ext);
  const storage = getStorage();
  await storage.put(key, file.buffer, file.mime);

  const attachmentId = await attachmentsDao.createAttachment({
    item_id: id,
    note_id: Number.isFinite(noteId) ? noteId : null,
    kind,
    storage_provider: storage.name,
    storage_key: key,
    original_name: file.name,
    mime_type: file.mime,
    byte_size: file.size,
    sha256,
  });

  const row = await attachmentsDao.getAttachment(attachmentId);
  created(ctx, toAttachmentDto(row!));
});

attachmentsController.get("/api/items/:id/attachments", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  const rows = await attachmentsDao.listByItem(id);
  ok(ctx, {
    attachments: rows.map(toAttachmentDto),
    totalBytes: await attachmentsDao.totalBytes(id),
  });
});

attachmentsController.delete("/api/attachments/:id", async (ctx) => {
  const { id } = parseParams(ctx, z.object({ id: idParam }));
  // deleteAttachment 会把被删行返回来，里面才有 storage_key ——
  // 数据库行一没，key 就再也查不到了，文件会变成够不着的孤儿
  const row = await attachmentsDao.deleteAttachment(id);
  if (!row) throw notFound(`附件 ${id} 不存在`);

  try {
    await getStorage().delete(row.storage_key);
  } catch (err) {
    // 存储删除失败不阻止记录删除 —— 否则一个坏文件会让这条附件永远删不掉
    logger.warn({ err, key: row.storage_key }, "删除存储文件失败，留下孤儿文件");
  }
  ok(ctx, { id, deleted: true });
});

/**
 * 本机存储的静态出口。
 *
 * ⚠️ key 来自 URL，**必须校验**。不校验的话
 * `GET /uploads/../../../packages/backend/.env.local` 就能把数据库密码读走。
 * 只在写入时校验是不够的 —— 攻击者不会走写入。
 *
 * 路径写成**两段显式参数**而不是通配符 `*key`，有两个好处：
 *   ① 不用依赖 path-to-regexp 的通配符语义（v8 改过语法，是个坑）；
 *   ② 路由本身就把形状限死了 —— 带 `..` 或斜杠的东西根本进不来。
 */
attachmentsController.get("/uploads/items/:itemId/:file", async (ctx) => {
  const key = `items/${ctx.params.itemId}/${ctx.params.file}`;
  if (!isValidStorageKey(key)) {
    ctx.status = 404;
    ctx.body = { code: 404, message: "not found", data: null };
    return;
  }
  const buf = await getStorage().get(key);
  if (!buf) {
    ctx.status = 404;
    ctx.body = { code: 404, message: "not found", data: null };
    return;
  }
  ctx.type = path.extname(key) || "application/octet-stream";
  // key 是内容哈希 → 内容永不变 → 可以永久缓存
  ctx.set("Cache-Control", "public, max-age=31536000, immutable");
  ctx.body = buf;
});
