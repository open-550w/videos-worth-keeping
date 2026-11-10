import { normalizeRanges, today, type DateRange } from "@likes/shared";
import * as dao from "../dao/watchHistory.dao.js";
import * as itemsDao from "../dao/items.dao.js";
import * as watchRangesDao from "../dao/watchRanges.dao.js";
import { createItem } from "./items.service.js";
import { AppError, badRequest, notFound } from "../http/errors.js";
import { logger } from "../logger.js";
import type { WatchHistoryRow } from "../dao/watchHistory.dao.js";

/**
 * 候选区（B 站观看历史）→ 收藏。
 *
 * 这一层只做两件事：**列出来给人挑**，以及**把挑中的写进 items**。
 * 抓取本身在 services/bili/ 下，只往候选区写，从不碰 items —— 分界线在这里。
 */

export interface HistoryVideoDto {
  platformItemId: string;
  channelCode: string;
  business: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
  durationSec: number | null;
  summary: string | null;
  contentType: string;
  url: string;
  /** 这条视频的观看时刻，**最近的在前** */
  watchedAt: string[];
  /** 最近一次的播放位置（秒）。`null` = 那个客户端没上报，不是 0 */
  progressSec: number | null;
  /** 最近这一次看完没看完（推导值，见 services/bili/history.ts） */
  watchedToEnd: boolean;
  /** B 站互动快照：null 为未知，与本站收藏无关。 */
  biliLiked: boolean | null;
  biliCoins: number | null;
  biliFavorited: boolean | null;
  device: string | null;
  tags: string[];
  /**
   * 已经收藏过了 → 页面上标「已收藏」，导入时**补观看时间**而不是新建。
   * 这和 items 上的 `uk_items_platform` 唯一键是同一件事的两种说法。
   */
  existingItemId: number | null;
  /** 这个视频在候选区里的行 id（导入 / 忽略时传这些） */
  entryIds: number[];
}

export interface HistoryListResult {
  videos: HistoryVideoDto[];
  total: number;
  /** ⚠️ `collected` 是**算出来的**（items 里有没有它），不是存下来的状态 —— 见 migrations/006 */
  counts: { active: number; pending: number; collected: number; archived: number };
  limit: number;
  offset: number;
}

/**
 * 候选列表，按视频分页。
 *
 * 筛选、搜索、分页**全部下推到 SQL**（见 dao.buildWhere），不在这里过滤 ——
 * 分页的单位是「视频」，在应用层过滤会让每页条数变得不确定，
 * 而且「一键归档」必须和列表用**同一个** WHERE，口径才不会错位。
 *
 * ⚠️ **刻意没有走 `cached()`。** 别的读接口都走了，这个不行，理由是：
 * 写候选区的是 **CLI（另一个进程）**，它清不掉服务进程里的内存缓存 ——
 * 用户 `pnpm fetch:bili` 之后打开页面，会看到**上一次的旧列表**（甚至空列表），
 * 然后以为抓取失败了。这种「缓存把新数据挡住了、还不报错」正是最难查的一类。
 *
 * 将来真要提速，正确的做法是**跨进程的失效机制**（比如一张版本号表），
 * 而不是把 TTL 调大 —— 那只会让错误窗口更长。
 */
export async function listHistory(
  opts: dao.HistoryFilter & { limit?: number; offset?: number },
): Promise<HistoryListResult> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  const [{ platformItemIds, total }, counts] = await Promise.all([
    dao.listVideoPage(opts, limit, offset),
    dao.countByStatus(),
  ]);

  const rows = await dao.rowsOfVideos(opts, platformItemIds);
  const byVideo = new Map<string, WatchHistoryRow[]>();
  for (const r of rows) {
    const list = byVideo.get(r.platform_item_id) ?? [];
    list.push(r);
    byVideo.set(r.platform_item_id, list);
  }

  // 已收藏的判定一次查完（库在远程，别在循环里查）
  const existing = await dao.existingItemIds(
    rows[0]?.channel_code ?? "bilibili",
    platformItemIds,
  );

  return {
    videos: platformItemIds.map((id) => toVideoDto(byVideo.get(id) ?? [], existing)),
    total,
    counts,
    limit,
    offset,
  };
}

/** 筛选面板的选项（UP 主 / 话题标签 / 候选覆盖的日期范围）。 */
export async function facets(): Promise<dao.Facets> {
  return dao.facets();
}

/** 一组行 → 一个视频。`rows` 是同一个 platform_item_id 的观看事件，已按时间倒序。 */
function toVideoDto(rows: WatchHistoryRow[], existing: Map<string, number>): HistoryVideoDto {
  const head = rows[0];
  return {
    platformItemId: head.platform_item_id,
    channelCode: head.channel_code,
    business: head.business,
    title: head.title,
    author: head.author,
    coverUrl: head.cover_url,
    durationSec: head.duration_sec,
    summary: head.summary,
    contentType: head.content_type,
    url: head.url,
    watchedAt: rows.map((r) => r.watched_at),
    progressSec: head.progress_sec,
    watchedToEnd: head.watched_to_end === 1,
    biliLiked: head.bili_liked == null ? null : head.bili_liked === 1,
    biliCoins: head.bili_coins ?? null,
    biliFavorited: head.bili_favorited == null ? null : head.bili_favorited === 1,
    device: head.device,
    tags: head.tags ? head.tags.split(",").filter(Boolean) : [],
    existingItemId: existing.get(head.platform_item_id) ?? null,
    entryIds: rows.map((r) => r.id),
  };
}

export interface ImportResult {
  created: number;
  /** 已经收藏过、这次只把观看时间补进去的 */
  merged: number;
  /** 处理了多少条观看事件（一个视频可能对应好几条） */
  entriesProcessed: number;
  skipped: Array<{ platformItemId: string; title: string; reason: string }>;
}

/**
 * 把勾选的候选写进收藏。
 *
 * 两种走法，按「这条内容是否已经在收藏里」分：
 *
 * · **没收藏过** → 建条目。`collected_on` = **今天**（我什么时候记的），
 *   观看区间 = 平台给的观看日期（我什么时候看的）—— 这两个是不同的东西，
 *   见 docs/init/08_WATCH_RANGES.md。
 * · **收藏过了** → **只把这次观看的时间补进 watchedRanges**，不动别的字段。
 *   为什么不新建：`uk_items_platform (channel_code, platform_item_id)` 本来就不允许
 *   同一条内容收藏两次（Q4），而且用户可能已经给它写了评论、打了标签 ——
 *   再建一条会把这些留在旧的那条上，看起来就像「收藏丢了」。
 *
 * ⚠️ 这里**不需要**写任何「已导入」状态：那个状态是派生的（items 里有没有它）。
 * 于是这个函数天然**幂等** —— 重复导入只是把同一段观看时间再并一次，
 * normalizeRanges 会把它去掉。而用户删掉条目之后，候选会自动回到待选。
 *
 * 逐条处理、单条失败不影响其余：一条坏数据不该让整批导入失败，
 * 失败的原因要**带回来给用户看**（skip 列表），而不是吞掉。
 */
export async function importEntries(entryIds: number[]): Promise<ImportResult> {
  if (!entryIds.length) throw badRequest("没有选中任何条目");

  const rows = await dao.rowsByIds(entryIds);
  if (!rows.length) throw notFound("选中的条目都不存在了");

  const result: ImportResult = {
    created: 0,
    merged: 0,
    entriesProcessed: 0,
    skipped: [],
  };

  // 按「视频」分组 —— 同一条视频的多个观看事件要合并成一条 items 的多个区间
  const groups = new Map<string, WatchHistoryRow[]>();
  for (const r of rows) {
    const list = groups.get(r.platform_item_id) ?? [];
    list.push(r);
    groups.set(r.platform_item_id, list);
  }

  for (const [platformItemId, group] of groups) {
    const head = group[0];
    // 观看日期 → 单日区间；同一天看两次会被 normalizeRanges 并成一段
    const ranges: DateRange[] = group.map((r) => ({
      from: r.watched_at.slice(0, 10),
      to: r.watched_at.slice(0, 10),
    }));

    try {
      const existingItem = await itemsDao.findByPlatformId(head.channel_code, platformItemId);

      if (existingItem) {
        // 已经在收藏里 —— 补观看时间，别的一律不动
        const current = await watchRangesDao.rangesOfItem(existingItem.id);
        await watchRangesDao.setItemRanges(
          existingItem.id,
          normalizeRanges([...current, ...ranges]),
        );
        result.merged++;
        result.entriesProcessed += group.length;
        continue;
      }

      await createItem({
        url: head.url || null,
        title: head.title,
        content_type: head.content_type,
        channel_code: head.channel_code,
        platform_item_id: platformItemId,
        author: head.author,
        cover_url: head.cover_url,
        summary: head.summary,
        duration_sec: head.duration_sec,
        published_on: head.published_on,
        collected_on: today(),
        watched_ranges: ranges,
      });

      result.created++;
      result.entriesProcessed += group.length;
    } catch (err) {
      // 单条失败不拖垮整批。最常见的两种：链接已被**别的**条目占用（409），
      // 或者内容本身不合法。原因原样带回去，不吞。
      const reason =
        err instanceof AppError ? err.message : err instanceof Error ? err.message : String(err);
      logger.warn({ err, platformItemId }, "导入候选失败");
      result.skipped.push({ platformItemId, title: head.title, reason });
    }
  }

  return result;
}

/**
 * 归档 / 取消归档（按 id）。
 *
 * 「归档」= **确定不要**，之后不再出现在待选里。它不是删除：留痕、可恢复
 * （「已归档」页签里看得见、能点回来）。所以这里不需要二次确认的逻辑，
 * 代价本来就是零的 —— 点错了再点回来。
 */
export async function archiveEntries(
  entryIds: number[],
  archived: boolean,
): Promise<{ updated: number }> {
  if (!entryIds.length) throw badRequest("没有选中任何条目");
  return { updated: await dao.archiveByIds(entryIds, archived) };
}

/**
 * 一键归档**当前筛选下的所有「待选」**。
 *
 * 这是页面上那个「把剩下的都归档」按钮。两条安全性质见 dao.archiveAllPending：
 * 只动待选的（永远碰不到已收藏的），筛选条件和列表页共用同一个 WHERE。
 */
export async function archiveAllMatching(
  filter: Omit<dao.HistoryFilter, "status">,
): Promise<{ archived: number }> {
  return { archived: await dao.archiveAllPending(filter) };
}
