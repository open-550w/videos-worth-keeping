import {
  canonicalizeUrl,
  cleanUrlForDisplay,
  clipRanges,
  normalizeRanges,
  weekKeysCoveredBy,
  weekRange,
  type DateRange,
} from "@likes/shared";
import { createHash } from "node:crypto";
import * as itemsDao from "../dao/items.dao.js";
import * as notesDao from "../dao/notes.dao.js";
import * as tagsDao from "../dao/tags.dao.js";
import * as attachmentsDao from "../dao/attachments.dao.js";
import * as watchRangesDao from "../dao/watchRanges.dao.js";
import { storageKeysOfItem } from "../dao/attachments.dao.js";
import { channelNameMap } from "../dao/channels.dao.js";
import { getStorage } from "./storage/index.js";
import { cached, cacheKey } from "../util/cache.js";
import { badRequest, conflict, notFound } from "../http/errors.js";
import { logger } from "../logger.js";

export function urlHashOf(url: string): string {
  const canonical = canonicalizeUrl(url);
  if (!canonical) throw badRequest(`无法解析这个链接: ${url}`);
  return createHash("sha256").update(canonical).digest("hex");
}

// ============ DTO ============
// 对外一律 camelCase。数据库列名是我们的实现细节，不该漏到 API 上 ——
// 否则改个列名就变成破坏性变更。

export interface TagDto {
  id: number;
  groupId: number;
  groupName: string;
  selection: "single" | "multiple";
  name: string;
  color: string | null;
}

export interface ItemDto {
  id: number;
  contentType: string;
  channelCode: string | null;
  channelName: string | null;
  title: string;
  author: string | null;
  platformItemId: string | null;
  coverUrl: string | null;
  summary: string | null;
  durationSec: number | null;
  publishedOn: string | null;
  /** 我**把它记下来**的日期（补录时是今天，不是看的那天） */
  collectedOn: string;
  /**
   * 我**看 / 读它**的日期区间，升序、已归一化（重叠的并过段）。
   *
   * 这是「按周看」的唯一真源：某段区间和某一周有交集，这条就出现在那一周
   * （跨几周就出现几次）。周键由前端从它派生 —— 和 collectedOn 一样，
   * 服务端不返回 weekKey（见下面 toItemDto 的注释）。
   */
  watchedRanges: DateRange[];
  primaryUrl: string | null;
  noteCount: number;
  attachmentCount: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: TagDto[];
}

export interface NoteDto {
  id: number;
  itemId: number;
  body: string;
  rating: number | null;
  notedAt: string;
  createdAt: string;
  updatedAt: string;
  attachments: AttachmentDto[];
}

export interface AttachmentDto {
  id: number;
  itemId: number | null;
  noteId: number | null;
  kind: string;
  originalName: string | null;
  mimeType: string | null;
  byteSize: number | null;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  url: string;
  createdAt: string;
}

export function toAttachmentDto(row: attachmentsDao.AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    itemId: row.item_id,
    noteId: row.note_id,
    kind: row.kind,
    originalName: row.original_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    width: row.width,
    height: row.height,
    durationSec: row.duration_sec,
    url: row.public_url ?? getStorage().url(row.storage_key),
    createdAt: row.created_at,
  };
}

function toTagDto(t: tagsDao.TagWithGroup): TagDto {
  return {
    id: t.id,
    groupId: t.group_id,
    groupName: t.group_name,
    selection: t.selection,
    name: t.name,
    color: t.color,
  };
}

function toItemDto(
  row: itemsDao.ItemListRow,
  channelNames: Map<string, string>,
  tags: TagDto[],
  watchedRanges: DateRange[],
): ItemDto {
  return {
    id: row.id,
    contentType: row.content_type,
    channelCode: row.channel_code,
    channelName: row.channel_code ? (channelNames.get(row.channel_code) ?? row.channel_code) : null,
    title: row.title,
    author: row.author,
    platformItemId: row.platform_item_id,
    coverUrl: row.cover_url,
    summary: row.summary,
    durationSec: row.duration_sec,
    publishedOn: row.published_on,
    collectedOn: row.collected_on,
    // ⚠️ **故意不返回 weekKey。**
    // 需求确认会：「周其实目前就是一个前端展示/设计的概念而已」——
    // 真源是 watchedRanges（以前是 collectedOn），周由它派生（前端用 @likes/shared
    // 的 weekKeysCoveredBy 算，那份 ISO 周实现和 MySQL 的 YEARWEEK(x,3) 逐日对拍过 15000 天）。
    // 返回 weekKey 会让服务端变成「周」的权威，等于把展示概念又焊回了 API ——
    // 那样将来加月视图就不只是前端改动了。
    watchedRanges,
    primaryUrl: row.primary_url,
    noteCount: Number(row.note_count),
    attachmentCount: Number(row.attachment_count),
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags,
  };
}

// ============ 列表 ============

export interface ListOptions extends itemsDao.ItemFilters {
  limit?: number;
  offset?: number;
}

export async function listItems(
  opts: ListOptions,
): Promise<{ items: ItemDto[]; total: number; limit: number; offset: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  // 缓存 key 要把所有影响结果的参数都编进去 —— 漏一个就会串结果
  return cached(cacheKey({ r: "items", ...opts, limit, offset }), async () => {
    // 两条查询并行 —— 都走网络，串行就是白等一个 RTT
    const [rows, total, channelNames] = await Promise.all([
      itemsDao.listItems(opts, limit, offset),
      itemsDao.countItems(opts),
      channelNameMap(),
    ]);

    // 标签和观看区间都一次批量取，别在循环里逐条查。
    // 两条互不依赖 → 并行发，不然是白等一个 RTT（库在远程，实测中位 237ms）。
    const ids = rows.map((r) => r.id);
    const [tagMap, rangeMap] = await Promise.all([
      tagsDao.tagsOfItems(ids),
      watchRangesDao.rangesOfItems(ids),
    ]);

    return {
      items: rows.map((r) =>
        toItemDto(r, channelNames, (tagMap.get(r.id) ?? []).map(toTagDto), rangeMap.get(r.id) ?? []),
      ),
      total,
      limit,
      offset,
    };
  });
}

/**
 * 按周聚合 —— 「有哪些周、每周几条、每条在哪几天」。
 *
 * ⚠️ 真源是**观看区间**（item_watch_ranges），不是 items.collected_on。
 * 一条记录可以在不相连的几段时间里被看（10/17–10/19 第一季、10/21–10/24 第二季），
 * 所以它出现在**每一段覆盖到的周**里，跨几周就出现几次。
 *
 * 为什么聚合在应用层做，而不是一条 SQL 的 GROUP BY：
 *   一段区间覆盖哪几周是**算出来**的，而 MySQL 5.7 没有 CTE / 递归 / 窗口函数，
 *   **SQL 里造不出「周序列」**（8.0 的递归 CTE 可以，5.7 不行）。
 *   而且 ISO 周的算法只该有一份 —— shared/week.ts，和 YEARWEEK(x,3) 对拍过。
 *
 * 这不是「在循环里查库」：区间**一次全量取回**（一次往返），后面全在内存里。
 * AGENTS.md §四 那条规矩的真正理由是往返贵，不是不许内存聚合。
 */
export async function listWeeks(limit = 30, offset = 0) {
  const size = Math.min(Math.max(limit, 1), 200);
  const from = Math.max(offset, 0);

  return cached(cacheKey({ r: "weeks", limit: size, offset: from }), async () => {
    const [rows, channelNames] = await Promise.all([
      watchRangesDao.listForWeekAggregation(),
      channelNameMap(),
    ]);

    /**
     * 周键 → 条目 id → 这条记录在**这一周里**覆盖到的天数。
     *
     * 按条目去重是必须的：同一条目的两段区间可以落在同一周里却不重叠
     * （10-13~10-14 与 10-16~10-17 都在 W42），逐段计数会把它算成 2 条。
     */
    const perWeek = new Map<
      string,
      Map<number, { firstOn: string; lastOn: string; channel: string | null }>
    >();

    for (const r of rows) {
      const range = { from: r.started_on, to: r.ended_on };
      for (const key of weekKeysCoveredBy([range])) {
        const { from: wFrom, to: wTo } = weekRange(key);
        // 只算落在这周里的那几天：10-17~11-30 那段在 W42 只覆盖 10-17~10-18
        const [clip] = clipRanges([range], wFrom, wTo);
        if (!clip) continue; // weekKeysCoveredBy 保证了不会走到这

        let items = perWeek.get(key);
        if (!items) {
          items = new Map();
          perWeek.set(key, items);
        }
        const seen = items.get(r.item_id);
        if (seen) {
          if (clip.from < seen.firstOn) seen.firstOn = clip.from;
          if (clip.to > seen.lastOn) seen.lastOn = clip.to;
        } else {
          items.set(r.item_id, { firstOn: clip.from, lastOn: clip.to, channel: r.channel_code });
        }
      }
    }

    // 周键是定长 `YYYY-Www`（周号补零），**字典序就是时间序**，跨年也对
    const allKeys = [...perWeek.keys()].sort().reverse();
    const page = allKeys.slice(from, from + size);

    return {
      weeks: page.map((weekKey) => {
        const items = perWeek.get(weekKey)!;
        const channelCount = new Map<string, number>();
        let firstOn = "";
        let lastOn = "";
        for (const it of items.values()) {
          if (!firstOn || it.firstOn < firstOn) firstOn = it.firstOn;
          if (it.lastOn > lastOn) lastOn = it.lastOn;
          const code = it.channel ?? "unknown";
          channelCount.set(code, (channelCount.get(code) ?? 0) + 1);
        }
        return {
          weekKey,
          count: items.size,
          firstOn,
          lastOn,
          channels: [...channelCount.entries()]
            .map(([code, n]) => ({
              code,
              name: code === "unknown" ? "未知" : (channelNames.get(code) ?? code),
              n,
            }))
            .sort((a, b) => b.n - a.n),
        };
      }),
      total: allKeys.length,
      limit: size,
      offset: from,
    };
  });
}

// ============ 详情 ============

export interface ItemDetail extends ItemDto {
  notes: NoteDto[];
  attachments: AttachmentDto[];
}

export async function getItemDetail(id: number): Promise<ItemDetail> {
  // 详情页是最常回访的页面（看完一条再点回去），缓存收益最大。
  // 抛 notFound 的情况也会被缓存吗？不会 —— cached() 只在 load() 成功返回后才写入，
  // 抛异常就直接冒泡，不会留下空条目。
  return cached(cacheKey({ r: "item", id }), async () => {
    const row = await itemsDao.getItem(id, "all");
    if (!row) throw notFound(`条目 ${id} 不存在`);

    // 五条查询并行
    const [notes, attachments, tags, watchedRanges, channelNames] = await Promise.all([
      notesDao.listNotes(id),
      attachmentsDao.listByItem(id),
      tagsDao.tagsOfItem(id),
      watchRangesDao.rangesOfItem(id),
      channelNameMap(),
    ]);

    const attByNote = new Map<number, AttachmentDto[]>();
    const itemLevel: AttachmentDto[] = [];
    for (const a of attachments) {
      const dto = toAttachmentDto(a);
      if (a.note_id === null) itemLevel.push(dto);
      else {
        const list = attByNote.get(a.note_id) ?? [];
        list.push(dto);
        attByNote.set(a.note_id, list);
      }
    }

    return {
      ...toItemDto(row, channelNames, tags.map(toTagDto), watchedRanges),
      notes: notes.map((n) => ({
        id: n.id,
        itemId: n.item_id,
        body: n.body,
        rating: n.rating,
        notedAt: n.noted_at,
        createdAt: n.created_at,
        updatedAt: n.updated_at,
        attachments: attByNote.get(n.id) ?? [],
      })),
      attachments: itemLevel,
    };
  });
}

// ============ 创建 ============

export interface CreateItemInput {
  url?: string | null;
  title?: string;
  content_type?: string;
  channel_code?: string | null;
  author?: string | null;
  platform_item_id?: string | null;
  cover_url?: string | null;
  summary?: string | null;
  duration_sec?: number | null;
  published_on?: string | null;
  collected_on: string;
  /** 观看日期区间。**不传** = 默认「收藏当天」；显式传 `[]` = 就是不知道哪天看的 */
  watched_ranges?: Array<{ from: string; to: string }>;
  meta_json?: unknown;
  /** 顺带写的第一条评论 */
  note?: string;
  tag_ids?: number[];
}

/**
 * 创建条目。
 *
 * 重复的两道闸（需求确认会：「不允许（重复收藏），这种情况弹出提示即可」）：
 *   ① 同渠道 + 同平台 ID —— 这是**真正的身份**，链接换个写法也拦得住
 *   ② 同 URL 规范化后的哈希 —— 没有平台 ID 时（手动录入）的兜底
 *
 * 两道都给出**已有条目的 id 和标题**，让前端能直接跳过去追加评论，
 * 而不是只弹一句「已收藏过」让人自己去翻。
 */
export async function createItem(input: CreateItemInput): Promise<ItemDto> {
  const collectedOn = input.collected_on;

  // ① 平台 ID 去重
  if (input.channel_code && input.platform_item_id) {
    const existing = await itemsDao.findByPlatformId(
      input.channel_code,
      input.platform_item_id,
    );
    if (existing) {
      throw conflict(`已经收藏过了：${existing.title || "(无标题)"}`, {
        reason: "platform_item_id",
        existingItemId: existing.id,
        existingTitle: existing.title,
        existingCollectedOn: existing.collected_on,
      });
    }
  }

  // ② URL 去重
  let hash: string | null = null;
  let displayUrl: string | null = null;
  if (input.url) {
    hash = urlHashOf(input.url);
    displayUrl = cleanUrlForDisplay(input.url);
    const ownerId = await itemsDao.findItemIdByUrlHash(null, hash);
    if (ownerId !== null) {
      const owner = await itemsDao.getItem(ownerId, "all");
      throw conflict(`这个链接已经收藏过了：${owner?.title || "(无标题)"}`, {
        reason: "url",
        existingItemId: ownerId,
        existingTitle: owner?.title ?? "",
        existingCollectedOn: owner?.collected_on ?? "",
      });
    }
  }

  /**
   * 观看区间：**不传就默认「收藏当天」**，归一化后写进去。
   *
   * ⚠️ 默认值不能是空。周视图按区间取数，一个没有任何区间的条目
   * **从周视图里整体消失** —— 而它明明刚存上，用户会以为没存住。
   * 显式传 `[]` 是允许的（「我就是不知道哪天看的」），那是用户自己的选择，
   * 这时它只在搜索/标签里出现，不出现在任何一周。
   */
  const watchedRanges = normalizeRanges(
    input.watched_ranges ?? [{ from: collectedOn, to: collectedOn }],
  );

  const id = await itemsDao.insertItem(
    {
      content_type: input.content_type ?? "video",
      channel_code: input.channel_code ?? null,
      title: input.title?.trim() ?? "",
      author: input.author ?? null,
      platform_item_id: input.platform_item_id ?? null,
      cover_url: input.cover_url ?? null,
      summary: input.summary ?? null,
      duration_sec: input.duration_sec ?? null,
      published_on: input.published_on ?? null,
      collected_on: collectedOn,
      meta_json: input.meta_json,
    },
    displayUrl && hash
      ? [{ url: displayUrl, url_hash: hash, url_type: "canonical", is_primary: true }]
      : [],
    watchedRanges,
  );

  if (input.note?.trim()) {
    await notesDao.createNote({ item_id: id, body: input.note.trim() });
  }
  if (input.tag_ids?.length) {
    await tagsDao.setItemTags(id, input.tag_ids);
  }

  const created = await itemsDao.getItem(id, "all");
  if (!created) throw new Error("插入后读不回来 —— 不应该发生");
  const channelNames = await channelNameMap();
  const tags = await tagsDao.tagsOfItem(id);
  // 用刚归一化好的那份，不再查一次 —— 省一个 RTT，也不会读到别的东西
  return toItemDto(created, channelNames, tags.map(toTagDto), watchedRanges);
}

// ============ 更新 ============

export async function updateItem(
  id: number,
  patch: {
    title?: string;
    author?: string | null;
    content_type?: string;
    channel_code?: string | null;
    platform_item_id?: string | null;
    cover_url?: string | null;
    summary?: string | null;
    collected_on?: string;
    /** 观看区间。传了就**全量替换**；传 `[]` = 清空（这条就不再出现在任何一周） */
    watched_ranges?: Array<{ from: string; to: string }>;
    url?: string;
    tag_ids?: number[];
    meta_json?: unknown;
  },
): Promise<ItemDto> {
  const existing = await itemsDao.getItem(id, "all");
  if (!existing) throw notFound(`条目 ${id} 不存在`);

  if (patch.url !== undefined) {
    const hash = urlHashOf(patch.url);
    const ownerId = await itemsDao.findItemIdByUrlHash(null, hash);
    if (ownerId !== null && ownerId !== id) {
      throw conflict("这个链接已经被别的条目用了", { existingItemId: ownerId });
    }
    await itemsDao.replacePrimaryUrl(id, cleanUrlForDisplay(patch.url), hash);
  }

  await itemsDao.updateItem(id, {
    content_type: patch.content_type,
    channel_code: patch.channel_code,
    title: patch.title,
    author: patch.author,
    platform_item_id: patch.platform_item_id,
    cover_url: patch.cover_url,
    summary: patch.summary,
    collected_on: patch.collected_on,
    meta_json: patch.meta_json,
  });

  // 注意 `undefined` 与 `[]` 的区别：前者是「没提到这个字段」，后者是「清空」。
  // 用 `!== undefined` 判，不要写成 `if (ranges?.length)` —— 那样清空就静默失败了。
  const watchedRanges =
    patch.watched_ranges === undefined ? undefined : normalizeRanges(patch.watched_ranges);
  if (watchedRanges !== undefined) {
    await watchRangesDao.setItemRanges(id, watchedRanges);
  }

  if (patch.tag_ids !== undefined) {
    await tagsDao.setItemTags(id, patch.tag_ids);
  }

  const updated = await itemsDao.getItem(id, "all");
  if (!updated) throw notFound(`条目 ${id} 不存在`);
  const [channelNames, tags, ranges] = await Promise.all([
    channelNameMap(),
    tagsDao.tagsOfItem(id),
    watchedRanges === undefined ? watchRangesDao.rangesOfItem(id) : Promise.resolve(watchedRanges),
  ]);
  return toItemDto(updated, channelNames, tags.map(toTagDto), ranges);
}

// ============ 删除 ============

export async function softDeleteItem(id: number): Promise<void> {
  const ok = await itemsDao.softDeleteItem(id);
  if (!ok) throw notFound(`条目 ${id} 不存在或已经删过了`);
}

export async function restoreItem(id: number): Promise<void> {
  const ok = await itemsDao.restoreItem(id);
  if (!ok) throw notFound(`条目 ${id} 不在回收站里`);
}

/**
 * 硬删 —— **真的会丢东西**，所以顺序不能反。
 *
 * 必须**先**把附件的 storage_key 取出来、把存储里的文件删掉，**再**删数据库行。
 * 反过来的话行没了，就再也查不到那些 key，文件会变成永远够不着的孤儿
 * （占着空间、又没有任何线索指向它）。
 *
 * 存储删除失败**不阻止**数据库删除 —— 否则一个删不掉的坏文件会让整个条目删不掉。
 * 失败只记日志，宁可留个孤儿也不要让用户卡住。
 */
export async function hardDeleteItem(id: number): Promise<{ deletedFiles: number }> {
  const existing = await itemsDao.getItem(id, "all");
  if (!existing) throw notFound(`条目 ${id} 不存在`);

  const keys = await storageKeysOfItem(id);
  const storage = getStorage();
  let deletedFiles = 0;
  for (const key of keys) {
    try {
      await storage.delete(key);
      deletedFiles++;
    } catch (err) {
      logger.warn({ err, key, itemId: id }, "删除存储文件失败，留下孤儿文件");
    }
  }

  await itemsDao.hardDeleteItem(id);
  return { deletedFiles };
}

/** 清空回收站（硬删所有软删的条目）。 */
export async function emptyTrash(): Promise<{ deleted: number }> {
  const { items } = await listItems({ scope: "trashed", limit: 200, offset: 0 });
  let deleted = 0;
  for (const it of items) {
    await hardDeleteItem(it.id);
    deleted++;
  }
  return { deleted };
}
