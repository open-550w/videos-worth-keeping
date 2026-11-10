import * as urlchecksDao from "../dao/urlchecks.dao.js";
import { BROWSER_UA, FETCH_TIMEOUT_MS } from "./resolvers/types.js";
import { logger } from "../logger.js";

/**
 * 链接探活。
 *
 * 自动兜底砍掉之后（需求确认会：「备份……很可能是用户手动填入」），
 * 探活是 M3 唯一的目标：**提醒你「该备份了」**。
 * 它不存内容，但没有它，链接烂了半年你都不会知道。
 *
 * 设计上刻意保持轻：低频、有并发上限、单次只处理一批。
 * 服务器是日常使用的电脑，不能跟 IDE 抢资源。
 */

/** 并发上限。对目标站点礼貌一点，也避免本机开一堆 socket。 */
const CONCURRENCY = 4;

export type LinkVerdict =
  /** 活着 */
  | "ok"
  /** 确定的死链（404 / 410） */
  | "dead"
  /** 被拦了（403 / 405 / 429）—— **不算死**，很可能是反爬或 HEAD 不被允许 */
  | "blocked"
  /** 服务端错误（5xx）—— 可能是临时的 */
  | "server_error"
  /** 网络层失败（DNS / 超时 / 连接被拒） */
  | "network_error";

export function verdictOf(status: number | null): LinkVerdict {
  if (status === null) return "network_error";
  if (status >= 200 && status < 400) return "ok";
  if (status === 404 || status === 410) return "dead";
  if (status === 403 || status === 405 || status === 429 || status === 401) return "blocked";
  if (status >= 500) return "server_error";
  return "network_error";
}

interface ProbeResult {
  itemUrlId: number;
  url: string;
  itemId: number;
  status: number | null;
  latencyMs: number;
  verdict: LinkVerdict;
  error?: string;
}

async function probeOne(row: {
  item_url_id: number;
  url: string;
  item_id: number;
}): Promise<ProbeResult> {
  const started = Date.now();
  const base = { itemUrlId: row.item_url_id, url: row.url, itemId: row.item_id };

  /**
   * 先 HEAD（省流量），被拒再退回 GET。
   *
   * ⚠️ 很多站点对 HEAD 返回 403/405 而对 GET 正常 —— 直接把 HEAD 的 403 当死链
   * 会**制造大量假警报**，而假警报比没有警报更糟：你会开始忽略它。
   */
  const attempt = async (method: "HEAD" | "GET") => {
    try {
      const res = await fetch(row.url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": BROWSER_UA, Accept: "*/*" },
      });
      return { status: res.status, error: undefined };
    } catch (err) {
      return { status: null, error: (err as Error).message.slice(0, 200) };
    }
  };

  let { status, error } = await attempt("HEAD");
  if (status !== null && (status === 403 || status === 405)) {
    ({ status, error } = await attempt("GET"));
  }

  return {
    ...base,
    status,
    latencyMs: Date.now() - started,
    verdict: verdictOf(status),
    error,
  };
}

/** 跑一轮探活。返回这一轮的结果摘要。 */
export async function runProbe(opts: {
  limit?: number;
  /** 超过这个小时数没查过的才查 */
  maxAgeHours?: number;
  /** 只查这些 item_url_id（手动「立刻检查这一条」用） */
  onlyUrlIds?: number[];
} = {}): Promise<{
  checked: number;
  byVerdict: Record<LinkVerdict, number>;
  results: ProbeResult[];
}> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const maxAgeHours = opts.maxAgeHours ?? 24 * 7;

  let targets: Array<{ item_url_id: number; url: string; item_id: number }>;
  if (opts.onlyUrlIds?.length) {
    const all = await urlchecksDao.dueForCheck(10_000, 0);
    const want = new Set(opts.onlyUrlIds);
    targets = all.filter((t) => want.has(t.item_url_id));
  } else {
    targets = await urlchecksDao.dueForCheck(limit, maxAgeHours);
  }

  const byVerdict: Record<LinkVerdict, number> = {
    ok: 0,
    dead: 0,
    blocked: 0,
    server_error: 0,
    network_error: 0,
  };
  const results: ProbeResult[] = [];

  // 简单的并发闸：分批跑，别一次开 50 个 socket
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const done = await Promise.all(batch.map(probeOne));
    for (const r of done) {
      byVerdict[r.verdict]++;
      results.push(r);
      await urlchecksDao.recordCheck({
        item_url_id: r.itemUrlId,
        http_status: r.status,
        error: r.error ?? null,
        latency_ms: r.latencyMs,
      });
    }
  }

  if (results.length) {
    logger.info(
      { checked: results.length, byVerdict },
      "探活完成",
    );
  }
  return { checked: results.length, byVerdict, results };
}

/**
 * 定时探活。
 *
 * **不是常驻 worker** —— 就是主进程里一个 setInterval，低频（默认 6 小时），
 * 没有子进程、没有队列、没有额外依赖。想关掉就把 `PROBE_ENABLED=0`。
 */
export function startProbeLoop(): NodeJS.Timeout | null {
  if (process.env.PROBE_ENABLED === "0") {
    logger.info("探活定时任务已关闭（PROBE_ENABLED=0）");
    return null;
  }
  const hours = Number(process.env.PROBE_INTERVAL_HOURS ?? 6);
  const ms = Math.max(hours, 0.25) * 3600_000;

  const tick = () => {
    runProbe({ limit: 50 }).catch((err) => logger.warn({ err }, "探活出错"));
  };
  // 启动后先等 30 秒再跑第一轮 —— 别和启动期的迁移/建池抢资源
  const bootTimer = setTimeout(tick, 30_000);
  bootTimer.unref();
  const timer = setInterval(tick, ms);
  timer.unref(); // 不阻止进程退出
  logger.info({ everyHours: hours }, "探活定时任务已启动");
  return timer;
}
