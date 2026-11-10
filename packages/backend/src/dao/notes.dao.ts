import type mysql from "mysql2/promise";
import { execute, query, queryOne, transaction } from "../db/db.js";

export interface NoteRow {
  id: number;
  item_id: number;
  body: string;
  rating: number | null;
  /** 我写这条评论的时间（事实），补录时可改 */
  noted_at: string;
  /** 入库时间（系统），不可改 */
  created_at: string;
  updated_at: string;
}

export async function listNotes(itemId: number): Promise<NoteRow[]> {
  return query<NoteRow>(
    `SELECT id, item_id, body, rating, noted_at, created_at, updated_at
     FROM item_notes
     WHERE item_id = ?
     ORDER BY noted_at ASC, id ASC`,
    [itemId],
  );
}

export async function getNote(id: number): Promise<NoteRow | null> {
  return queryOne<NoteRow>(
    `SELECT id, item_id, body, rating, noted_at, created_at, updated_at
     FROM item_notes WHERE id = ?`,
    [id],
  );
}

export async function createNote(input: {
  item_id: number;
  body: string;
  rating?: number | null;
  /** `YYYY-MM-DD HH:mm:ss`；不给就用当前时间 */
  noted_at?: string | null;
}): Promise<number> {
  const res = await execute(
    `INSERT INTO item_notes (item_id, body, rating, noted_at)
     VALUES (?,?,?, COALESCE(?, NOW()))`,
    [input.item_id, input.body, input.rating ?? null, input.noted_at ?? null],
  );
  return res.insertId;
}

export async function updateNote(
  id: number,
  patch: { body?: string; rating?: number | null; noted_at?: string },
): Promise<boolean> {
  const cols: string[] = [];
  const params: unknown[] = [];
  if (patch.body !== undefined) {
    cols.push("body = ?");
    params.push(patch.body);
  }
  if (patch.rating !== undefined) {
    cols.push("rating = ?");
    params.push(patch.rating);
  }
  if (patch.noted_at !== undefined) {
    cols.push("noted_at = ?");
    params.push(patch.noted_at);
  }
  if (!cols.length) return false;
  const res = await execute(`UPDATE item_notes SET ${cols.join(", ")} WHERE id = ?`, [
    ...params,
    id,
  ]);
  return res.affectedRows > 0;
}

export async function deleteNote(id: number): Promise<boolean> {
  return transaction(async (conn: mysql.PoolConnection) => {
    // 挂在评论下的附件会变成孤儿（item_id 还在，note_id 悬空）—— 先把它们退回条目级
    await conn.execute("UPDATE attachments SET note_id = NULL WHERE note_id = ?", [id]);
    const [res] = await conn.execute<mysql.ResultSetHeader>(
      "DELETE FROM item_notes WHERE id = ?",
      [id],
    );
    return res.affectedRows > 0;
  });
}
