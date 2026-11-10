import { BiliClient } from "./client.js";
import { cookieHeaderOf, defaultCookiePath, loadCachedCookies, refreshCookiesFromChrome } from "./cookies.js";
import { fetchWatchHistory, formatTs } from "./history.js";
import { knownPlatformIds, upsertEntries } from "../../dao/watchHistory.dao.js";
import { logger } from "../../logger.js";

/**
 * 页面上的「同步」—— **增量**拉取，只拿新的、不改已有的。
 *
 * 为什么是后台任务而不是一个直接的 HTTP 接口：抓一次要几十秒到几分钟，
 * 还要在限流时退避重试。做成同步的 HTTP 请求就是「必然超时，但服务端还在打接口」。
 * 所以：`POST /api/history/sync` 立刻返回，页面轮询 `GET /api/history/sync` 看进度。
 *
 * 这不是「常驻 worker」（01_REQUIREMENTS.md §3 明确不做那个）——
 * 它是被请求触发、跑完就结束的一段异步工作，进程里没有常驻循环。
 */

export type SyncPhase = "idle" | "cookies" | "history" | "enrich" | "save" | "done" | "error";

export interface SyncState {
  running: boolean;
  phase: SyncPhase;
  startedAt: string | null;
  finishedAt: string | null;
  /** 这次同步的时间窗 */
  since: string | null;
  until: string | null;
  /** 翻历史翻到第几页、累计多少条 */
  pages: number;
  kept: number;
  /** 富化进度（跳过已有的，所以总数通常很小） */
  enriched: number;
  enrichTotal: number;
  /** 上一次成功同步的结果 —— 页面拿它显示「上次同步 +N 条」 */
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

const state: SyncState = {
  running: false,
  phase: "idle",
  startedAt: null,
  finishedAt: null,
  since: null,
  until: null,
  pages: 0,
  kept: 0,
  enriched: 0,
  enrichTotal: 0,
  last: null,
  error: null,
};

/** 上次成功同步的时刻（unix 秒）。**只在内存里** —— 见 defaultSince() 的注释。 */
let lastSuccessAt: number | null = null;

export function getSyncState(): SyncState {
  return { ...state };
}

/**
 * 默认的时间窗起点。
 *
 * 「至少最近 7 天；如果上次同步是更早以前，就补到那之后」——
 * 也就是 `min(now - 7d, lastSuccess - 1d)`。
 *
 * ⚠️ **`lastSuccessAt` 只在内存里，重启就丢。** 这是刻意的取舍：
 * 为它加一张表/一列不值得，而丢了之后的代价是「多翻几页历史」——
 * 因为写库是**只插不改**的，重叠的窗口不会灌水、也不会覆盖任何东西。
 * 代价这么小，就不该为它引入一处要维护的状态。
 */
function defaultSince(): number {
  const week = Date.now() / 1000 - 7 * 86400;
  if (lastSuccessAt === null) return week;
  return Math.min(week, lastSuccessAt - 86400);
}

export class SyncBusyError extends Error {
  constructor() {
    super("已经有一个同步在跑了");
    this.name = "SyncBusyError";
  }
}

/** 起一次同步。**立刻返回**，工作在后台跑。 */
export function startSync(opts: { since?: number; until?: number; refreshCookies?: boolean } = {}): SyncState {
  if (state.running) throw new SyncBusyError();

  const until = opts.until ?? Date.now() / 1000;
  const since = opts.since ?? defaultSince();

  Object.assign(state, {
    running: true,
    phase: "cookies" as SyncPhase,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    since: formatTs(since),
    until: formatTs(until),
    pages: 0,
    kept: 0,
    enriched: 0,
    enrichTotal: 0,
    error: null,
  });

  // 不 await：调用方（HTTP 请求）要立刻拿到响应
  void run(since, until, opts.refreshCookies ?? false).catch((err) => {
    // run 内部已经把错误写进 state 了，这里只是兜底，别让 unhandled rejection 冒出来
    logger.error({ err }, "同步任务意外抛出");
  });

  return getSyncState();
}

async function run(since: number, until: number, refreshCookies: boolean): Promise<void> {
  try {
    const cookiePath = defaultCookiePath();
    const cookies = refreshCookies
      ? await refreshCookiesFromChrome(cookiePath)
      : await loadCachedCookies(cookiePath);
    if (!cookies) {
      throw new Error("还没有 B 站登录信息。请先在本机 Chrome 登录 bilibili.com，再点击「刷新登录并同步」。远程部署请配置 BILI_COOKIE_PATH。若 Chrome 弹出调试授权，请点击允许。");
    }

    const client = new BiliClient({
      cookieHeader: cookieHeaderOf(cookies),
      verbose: false,
    });

    // ② 候选区里已经有哪些视频 —— 这些连详情都不再拉
    const known = await knownPlatformIds("bilibili");

    state.phase = "history";
    const { records, apiCalls } = await fetchWatchHistory(client, {
      since,
      until,
      skipDetailFor: known,
      onProgress: (p) => {
        if (p.phase === "history") {
          state.phase = "history";
          state.pages = p.pages ?? 0;
          state.kept = p.kept ?? 0;
        } else {
          state.phase = "enrich";
          state.enriched = p.enriched ?? 0;
          state.enrichTotal = p.enrichTotal ?? 0;
        }
      },
    });

    // ③ 写库：**只插不改**（同步的语义就是「只拿新的」）
    state.phase = "save";
    const r = await upsertEntries(records, { updateExisting: false });

    lastSuccessAt = until;
    state.phase = "done";
    state.last = {
      finishedAt: formatTs(until),
      windowFrom: formatTs(since),
      windowTo: formatTs(until),
      fetched: r.received,
      inserted: r.inserted,
      existing: r.updated,
      apiCalls,
    };
    logger.info(
      { inserted: r.inserted, existing: r.updated, apiCalls },
      "观看历史同步完成",
    );
  } catch (err) {
    state.phase = "error";
    state.error = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "观看历史同步失败");
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}
