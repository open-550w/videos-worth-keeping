import { execute, query, queryOne, transaction } from "../db/db.js";
import { cached } from "../util/cache.js";

export interface TagGroupRow {
  id: number;
  name: string;
  /** single = 分类（互斥单选）| multiple = 标签（多选） */
  selection: "single" | "multiple";
  sort_order: number;
}

export interface TagRow {
  id: number;
  group_id: number;
  name: string;
  color: string | null;
  sort_order: number;
}

export interface TagWithGroup extends TagRow {
  group_name: string;
  selection: "single" | "multiple";
}

export async function listGroups(): Promise<TagGroupRow[]> {
  return cached("tags:groups", () =>
    query<TagGroupRow>(
      "SELECT id, name, selection, sort_order FROM tag_groups ORDER BY sort_order, id",
    ),
  );
}

export async function listTags(): Promise<TagWithGroup[]> {
  return cached("tags:all", () =>
    query<TagWithGroup>(
      `SELECT t.id, t.group_id, t.name, t.color, t.sort_order,
              g.name AS group_name, g.selection
       FROM tags t JOIN tag_groups g ON g.id = t.group_id
       ORDER BY g.sort_order, g.id, t.sort_order, t.id`,
    ),
  );
}

export async function createGroup(input: {
  name: string;
  selection: "single" | "multiple";
  sort_order?: number;
}): Promise<number> {
  const res = await execute(
    "INSERT INTO tag_groups (name, selection, sort_order) VALUES (?,?,?)",
    [input.name, input.selection, input.sort_order ?? 100],
  );
  return res.insertId;
}

export async function updateGroup(
  id: number,
  patch: { name?: string; selection?: "single" | "multiple"; sort_order?: number },
): Promise<boolean> {
  const cols: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    cols.push("name = ?");
    params.push(patch.name);
  }
  if (patch.selection !== undefined) {
    cols.push("selection = ?");
    params.push(patch.selection);
  }
  if (patch.sort_order !== undefined) {
    cols.push("sort_order = ?");
    params.push(patch.sort_order);
  }
  if (!cols.length) return false;
  const res = await execute(`UPDATE tag_groups SET ${cols.join(", ")} WHERE id = ?`, [
    ...params,
    id,
  ]);
  return res.affectedRows > 0;
}

export async function deleteGroup(id: number): Promise<boolean> {
  return transaction(async (conn) => {
    await conn.execute(
      "DELETE it FROM item_tags it JOIN tags t ON t.id = it.tag_id WHERE t.group_id = ?",
      [id],
    );
    await conn.execute("DELETE FROM tags WHERE group_id = ?", [id]);
    const [res] = await conn.execute<import("mysql2/promise").ResultSetHeader>(
      "DELETE FROM tag_groups WHERE id = ?",
      [id],
    );
    return res.affectedRows > 0;
  });
}

export async function createTag(input: {
  group_id: number;
  name: string;
  color?: string | null;
  sort_order?: number;
}): Promise<number> {
  const res = await execute(
    "INSERT INTO tags (group_id, name, color, sort_order) VALUES (?,?,?,?)",
    [input.group_id, input.name, input.color ?? null, input.sort_order ?? 100],
  );
  return res.insertId;
}

export async function updateTag(
  id: number,
  patch: { name?: string; color?: string | null; sort_order?: number; group_id?: number },
): Promise<boolean> {
  const cols: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    cols.push("name = ?");
    params.push(patch.name);
  }
  if (patch.color !== undefined) {
    cols.push("color = ?");
    params.push(patch.color);
  }
  if (patch.sort_order !== undefined) {
    cols.push("sort_order = ?");
    params.push(patch.sort_order);
  }
  if (patch.group_id !== undefined) {
    cols.push("group_id = ?");
    params.push(patch.group_id);
  }
  if (!cols.length) return false;
  const res = await execute(`UPDATE tags SET ${cols.join(", ")} WHERE id = ?`, [...params, id]);
  return res.affectedRows > 0;
}

export async function deleteTag(id: number): Promise<boolean> {
  return transaction(async (conn) => {
    await conn.execute("DELETE FROM item_tags WHERE tag_id = ?", [id]);
    const [res] = await conn.execute<import("mysql2/promise").ResultSetHeader>(
      "DELETE FROM tags WHERE id = ?",
      [id],
    );
    return res.affectedRows > 0;
  });
}

/** 某个条目上的标签。 */
export async function tagsOfItem(itemId: number): Promise<TagWithGroup[]> {
  return query<TagWithGroup>(
    `SELECT t.id, t.group_id, t.name, t.color, t.sort_order,
            g.name AS group_name, g.selection
     FROM item_tags it
     JOIN tags t ON t.id = it.tag_id
     JOIN tag_groups g ON g.id = t.group_id
     WHERE it.item_id = ?
     ORDER BY g.sort_order, t.sort_order`,
    [itemId],
  );
}

/**
 * 批量取多个条目的标签 —— 列表页用。
 *
 * ⚠️ 不能在列表里逐条调 tagsOfItem：库在远程，50 个条目就是 50 次网络往返。
 * 一次 IN 查询拿回来，在应用层按 item_id 分组。
 */
export async function tagsOfItems(itemIds: number[]): Promise<Map<number, TagWithGroup[]>> {
  const out = new Map<number, TagWithGroup[]>();
  if (!itemIds.length) return out;
  const placeholders = itemIds.map(() => "?").join(",");
  const rows = await query<TagWithGroup & { item_id: number }>(
    `SELECT it.item_id, t.id, t.group_id, t.name, t.color, t.sort_order,
            g.name AS group_name, g.selection
     FROM item_tags it
     JOIN tags t ON t.id = it.tag_id
     JOIN tag_groups g ON g.id = t.group_id
     WHERE it.item_id IN (${placeholders})
     ORDER BY g.sort_order, t.sort_order`,
    itemIds,
  );
  for (const r of rows) {
    const list = out.get(r.item_id) ?? [];
    list.push(r);
    out.set(r.item_id, list);
  }
  return out;
}

/**
 * 给条目设置标签（全量替换）。
 *
 * 单选组（分类）在这里强制只留一个 —— 客户端可以发多个，但服务端说了算。
 * **约束放在服务端**，否则将来别处再写一遍这个逻辑时就会漏。
 */
export async function setItemTags(itemId: number, tagIds: number[]): Promise<void> {
  await transaction(async (conn) => {
    if (!tagIds.length) {
      await conn.execute("DELETE FROM item_tags WHERE item_id = ?", [itemId]);
      return;
    }
    const placeholders = tagIds.map(() => "?").join(",");
    // 一次查出 id / group_id / selection —— 别在循环里逐条查（远程库上是 N+1）
    const [rows] = await conn.query(
      `SELECT t.id, t.group_id, g.selection
       FROM tags t JOIN tag_groups g ON g.id = t.group_id
       WHERE t.id IN (${placeholders})`,
      tagIds,
    );
    const byId = new Map(
      (rows as Array<{ id: number; group_id: number; selection: string }>).map((r) => [r.id, r]),
    );

    const seenSingle = new Set<number>();
    const keep: number[] = [];
    // 按客户端给的顺序走，同一个单选组里**先出现的胜出**
    for (const id of tagIds) {
      const r = byId.get(id);
      if (!r) continue; // 不存在的 tag id 静默跳过
      if (r.selection === "single") {
        if (seenSingle.has(r.group_id)) continue;
        seenSingle.add(r.group_id);
      }
      keep.push(id);
    }

    await conn.execute("DELETE FROM item_tags WHERE item_id = ?", [itemId]);
    for (const tid of keep) {
      await conn.execute("INSERT IGNORE INTO item_tags (item_id, tag_id) VALUES (?,?)", [
        itemId,
        tid,
      ]);
    }
  });
}

export async function getGroup(id: number): Promise<TagGroupRow | null> {
  return queryOne<TagGroupRow>(
    "SELECT id, name, selection, sort_order FROM tag_groups WHERE id = ?",
    [id],
  );
}

export async function getTag(id: number): Promise<TagRow | null> {
  return queryOne<TagRow>(
    "SELECT id, group_id, name, color, sort_order FROM tags WHERE id = ?",
    [id],
  );
}

export async function countTagsByGroup(groupId: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tags WHERE group_id = ?",
    [groupId],
  );
  return row?.n ?? 0;
}
