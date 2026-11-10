import { execute, query, queryOne } from "../db/db.js";

export interface AttachmentRow {
  id: number;
  item_id: number | null;
  note_id: number | null;
  kind: string;
  storage_provider: string;
  storage_key: string;
  public_url: string | null;
  original_name: string | null;
  mime_type: string | null;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  duration_sec: number | null;
  sha256: string | null;
  created_at: string;
}

export async function listByItem(itemId: number): Promise<AttachmentRow[]> {
  return query<AttachmentRow>(
    `SELECT * FROM attachments WHERE item_id = ? ORDER BY created_at ASC, id ASC`,
    [itemId],
  );
}

export async function getAttachment(id: number): Promise<AttachmentRow | null> {
  return queryOne<AttachmentRow>("SELECT * FROM attachments WHERE id = ?", [id]);
}

export async function findBySha(itemId: number, sha256: string): Promise<AttachmentRow | null> {
  return queryOne<AttachmentRow>(
    "SELECT * FROM attachments WHERE item_id = ? AND sha256 = ? LIMIT 1",
    [itemId, sha256],
  );
}

export async function createAttachment(input: {
  item_id: number;
  note_id?: number | null;
  kind: string;
  storage_provider: string;
  storage_key: string;
  original_name?: string | null;
  mime_type?: string | null;
  byte_size?: number | null;
  width?: number | null;
  height?: number | null;
  duration_sec?: number | null;
  sha256?: string | null;
}): Promise<number> {
  const res = await execute(
    `INSERT INTO attachments
       (item_id, note_id, kind, storage_provider, storage_key, original_name,
        mime_type, byte_size, width, height, duration_sec, sha256)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      input.item_id,
      input.note_id ?? null,
      input.kind,
      input.storage_provider,
      input.storage_key,
      input.original_name ?? null,
      input.mime_type ?? null,
      input.byte_size ?? null,
      input.width ?? null,
      input.height ?? null,
      input.duration_sec ?? null,
      input.sha256 ?? null,
    ],
  );
  return res.insertId;
}

/**
 * 删附件行。
 *
 * ⚠️ **返回被删行的 storage_key** —— 对象存储里的文件不会自己消失。
 * 调用方必须拿这个 key 去存储层删文件，否则文件会变成永远够不着的孤儿
 * （数据库行没了，就再也查不到它的 key 了）。
 */
export async function deleteAttachment(id: number): Promise<AttachmentRow | null> {
  const row = await getAttachment(id);
  if (!row) return null;
  await execute("DELETE FROM attachments WHERE id = ?", [id]);
  return row;
}

/** 某个条目下所有附件的 storage_key —— 硬删条目时用来清理存储。 */
export async function storageKeysOfItem(itemId: number): Promise<string[]> {
  const rows = await query<{ storage_key: string }>(
    "SELECT storage_key FROM attachments WHERE item_id = ?",
    [itemId],
  );
  return rows.map((r) => r.storage_key);
}

export async function totalBytes(itemId: number): Promise<number> {
  const row = await queryOne<{ n: number | null }>(
    "SELECT SUM(byte_size) AS n FROM attachments WHERE item_id = ?",
    [itemId],
  );
  return Number(row?.n ?? 0);
}
