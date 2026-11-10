// 与后端 DTO 一一对应。后端一律返回 camelCase（数据库列名是实现细节）。

/** 观看日期区间（闭区间）。定义在 @likes/shared —— 前后端同一份，见 ranges.ts */
import type { DateRange } from "@likes/shared";
export type { DateRange };

export interface Health {
  ok: boolean;
  mysql: string | null;
  database: { client: "sqlite" | "mysql"; version: string };
  serverTime: string;
  migrations: string[];
  /**
   * 进程内读缓存的命中情况。数据库在远程，缓存是「不卡」的主要手段。
   * 带上当前生效的配置，是为了能一眼确认 .env.local 改没改对。
   */
  cache?: {
    enabled: boolean;
    entries: number;
    hits: number;
    misses: number;
    hitRate: number | null;
    ttlMs: number;
    maxEntries: number;
  };
}

export interface Channel {
  code: string;
  name: string;
  defaultContentType: string;
  urlPattern: string | null;
  sortOrder: number;
}

export interface Tag {
  id: number;
  groupId: number;
  groupName: string;
  selection: "single" | "multiple";
  name: string;
  color: string | null;
}

export interface TagGroup {
  id: number;
  name: string;
  selection: "single" | "multiple";
  sortOrder: number;
  tags: Array<{ id: number; name: string; color: string | null; sortOrder: number }>;
}

export interface Item {
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
  /** 我把它**记下来**的日期（补录时是今天，不是看的那天） */
  collectedOn: string;
  /**
   * 我**看 / 读它**的日期区间，升序、已归一化。
   *
   * 「按周看」的真源就是它：某段区间和某一周有交集，这条就出现在那一周。
   * 周键在前端派生（`weekKeysCoveredBy`），后端**不返回** weekKey ——
   * 返回了就等于把服务端变成「周」的权威，见 items.service.ts 的注释。
   */
  watchedRanges: DateRange[];
  primaryUrl: string | null;
  noteCount: number;
  attachmentCount: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
}

export interface Attachment {
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
  deduped?: boolean;
}

export interface Note {
  id: number;
  itemId: number;
  body: string;
  rating: number | null;
  /** 我写这条评论的时间（事实），补录时可改 */
  notedAt: string;
  /** 入库时间（系统），不可改 */
  createdAt: string;
  updatedAt: string;
  attachments: Attachment[];
}

export interface ItemDetail extends Item {
  notes: Note[];
  attachments: Attachment[];
}

export interface Paged<T> {
  total: number;
  limit: number;
  offset: number;
  items: T[];
}

export interface WeekSummary {
  weekKey: string;
  count: number;
  firstOn: string;
  lastOn: string;
  channels: Array<{ code: string; name: string; n: number }>;
}

export interface WeeksResponse {
  weeks: WeekSummary[];
  total: number;
  limit: number;
  offset: number;
}

// ============ 观看历史候选区（B 站抓回来的）============

/**
 * 一条候选：**一个视频**（不是一次观看）。
 *
 * 同一条视频看好几次 → 一个候选 + 多个 `watchedAt`；导入时那几次会变成
 * items 上的多个观看区间。
 */
export interface HistoryVideo {
  platformItemId: string;
  channelCode: string;
  /** archive | live | pgc | article | cheese */
  business: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
  durationSec: number | null;
  summary: string | null;
  contentType: string;
  url: string;
  /** 观看时刻，最近的在前 */
  watchedAt: string[];
  /** 最近一次的播放位置（秒）。`null` = 那个客户端没上报，不是 0 */
  progressSec: number | null;
  /** 最近这一次看完没看完（推导值 —— B 站自带的 is_finish 实测恒为 0） */
  watchedToEnd: boolean;
  /** B 站互动快照：null 为未知，与本站收藏无关。 */
  biliLiked: boolean | null;
  biliCoins: number | null;
  biliFavorited: boolean | null;
  device: string | null;
  tags: string[];
  /** 已经在收藏里了 → 导入时**补观看时间**而不是新建 */
  existingItemId: number | null;
  /** 候选行的 id，导入 / 忽略时传这些 */
  entryIds: number[];
}

export interface HistoryListResponse {
  videos: HistoryVideo[];
  total: number;
  /** `collected` 是**算出来的**（items 里有没有它），不是存下来的状态 */
  counts: { active: number; pending: number; collected: number; archived: number };
  limit: number;
  offset: number;
}

/**
 * 「同步」这个后台任务的状态。
 *
 * 语义是「**只拿新的，不改已有的**」：候选区里已经有的视频连详情都不再拉，
 * 写库也只插不改 —— 我归档过、收藏过的东西一个字都不动。
 */
export interface SyncState {
  running: boolean;
  phase: "idle" | "cookies" | "history" | "enrich" | "save" | "done" | "error";
  startedAt: string | null;
  finishedAt: string | null;
  since: string | null;
  until: string | null;
  pages: number;
  kept: number;
  enriched: number;
  enrichTotal: number;
  last: {
    finishedAt: string;
    windowFrom: string;
    windowTo: string;
    fetched: number;
    inserted: number;
    existing: number;
    apiCalls: number;
  } | null;
  error: string | null;
}

/** 筛选面板的选项。**不随当前筛选变化**（让选项稳定，不然选一个别的会跳走）。 */
export interface HistoryFacets {
  authors: Array<{ name: string; n: number }>;
  tags: Array<{ name: string; n: number }>;
  /** 候选覆盖的观看日期范围，给筛选面板当提示用 */
  dateFrom: string | null;
  dateTo: string | null;
}

/** 搜索范围。不传 = 只搜标题。 */
export type HistorySearchField = "title" | "tags" | "summary" | "author";

export interface ImportResult {
  created: number;
  /** 已经收藏过、只把观看时间补进去的 */
  merged: number;
  entriesProcessed: number;
  skipped: Array<{ platformItemId: string; title: string; reason: string }>;
}

/** 解析结果。`matched=false` 表示渠道不认识 —— 两种情况对用户是同一件事：手填。 */
export interface ResolveOutcome {
  matched: boolean;
  resolved: {
    channelCode: string;
    platformItemId: string;
    title?: string;
    author?: string;
    coverUrl?: string;
    summary?: string;
    durationSec?: number;
    publishedOn?: string;
  } | null;
  resolverCode: string | null;
  reason?: string;
}

/** 409 重复收藏时后端带回来的信息 —— 用来给「去看看已收藏的那条」按钮做跳转。 */
export interface DuplicateInfo {
  reason: "platform_item_id" | "url";
  existingItemId: number;
  existingTitle: string;
  existingCollectedOn: string;
}

export type LinkVerdict =
  | "ok"
  | "dead"
  | "blocked"
  | "server_error"
  | "network_error"
  | "never_checked";

export interface UnhealthyLink {
  itemId: number;
  url: string;
  httpStatus: number | null;
  checkedAt: string | null;
  verdict: LinkVerdict;
}
