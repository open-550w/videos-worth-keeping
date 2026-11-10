import { BILI_API, UA } from "./types.js";

/**
 * B 站 web API 客户端。
 *
 * 三条实测出来的规矩（都不是可选优化，去掉就会出问题）：
 *
 * ① **Referer / Origin 必须带。** 缺了 B 站的 WAF 直接返回 `-412 请求被拦截`，
 *    而不是报 401 之类的 —— 看起来像「接口坏了」。
 * ② **限流真实存在**（`-412` 拦截 / `-509` 太频繁）。所以每个请求都要排队发，
 *    而且退避重试。多 worker 共享**同一个**发号器，请求在时间上均匀铺开，
 *    而不是 N 个 worker 同时打过去。
 * ③ **非重试错误要立刻抛**（比如 `62002 稿件不可见` = 视频被删）。
 *    把它当限流那样重试，只会白等四轮然后报一个更模糊的错。
 */

export class BiliError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly url = "",
  ) {
    super(`[${code}] ${message}${url ? `  (${url})` : ""}`);
    this.name = "BiliError";
  }
}

/** 被 WAF 拦了 —— 退避重试。其余非 0 码一律直接抛。 */
const RETRYABLE_CODES = new Set([-412, -509]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BiliClientOptions {
  cookieHeader: string;
  /** 全局最小请求间隔（秒） */
  delaySec?: number;
  retries?: number;
  verbose?: boolean;
  log?: (line: string) => void;
}

export class BiliClient {
  private nextSlotAt = 0;
  readonly calls = { n: 0 };

  constructor(private readonly opts: BiliClientOptions) {}

  /**
   * 领一个发送时刻。
   *
   * 关键：从「读 nextSlotAt」到「写 nextSlotAt」之间**不能有 await** ——
   * JS 是单线程的，所以这段同步代码天然是原子的，等价于 Python 版那把锁。
   * 中间插一个 await，两个 worker 就会领到同一个时刻，节流当场失效。
   */
  private async takeTurn(): Promise<void> {
    const delayMs = (this.opts.delaySec ?? 0.35) * 1000;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlotAt) + delayMs;
    this.nextSlotAt = slot;
    const wait = slot - now;
    if (wait > 0) await sleep(wait);
  }

  async get<T>(
    path: string,
    params: Record<string, string | number> = {},
    referer = "https://www.bilibili.com/",
  ): Promise<T> {
    const url = new URL(path.startsWith("http") ? path : BILI_API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const retries = this.opts.retries ?? 4;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < retries; attempt++) {
      await this.takeTurn();
      let data: { code?: number; message?: string; data?: unknown };
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent": UA,
            Referer: referer,
            Origin: "https://www.bilibili.com",
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            Cookie: this.opts.cookieHeader,
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          lastErr = new BiliError(res.status, `HTTP ${res.statusText}`, url.toString());
          await sleep(1500 * (attempt + 1));
          continue;
        }
        data = (await res.json()) as typeof data;
        this.calls.n++;
      } catch (err) {
        // 网络抖动（含超时）——重试
        lastErr = new BiliError(-1, String(err), url.toString());
        await sleep(1500 * (attempt + 1));
        continue;
      }

      const code = data.code ?? 0;
      if (code === 0) return data.data as T;

      if (RETRYABLE_CODES.has(code)) {
        const backoffMs = 2000 * (attempt + 1);
        if (this.opts.verbose) {
          this.opts.log?.(`    ! 被限流了（${code}），等 ${(backoffMs / 1000).toFixed(1)}s`);
        }
        await sleep(backoffMs);
        lastErr = new BiliError(code, data.message ?? "", url.toString());
        continue;
      }

      // 不重试：交给调用方判断（例如视频被删 → 保留历史行本身的信息）
      throw new BiliError(code, data.message ?? "", url.toString());
    }

    throw lastErr ?? new BiliError(-1, "重试次数用尽", url.toString());
  }

  /** 当前登录的是谁 —— 用来确认手里这份 cookie 是哪个账号的。 */
  nav(): Promise<{ isLogin: boolean; uname: string; mid: number }> {
    return this.get("/x/web-interface/nav");
  }

  /**
   * 一页观看历史。
   *
   * ⚠️ 游标是一**对**值，必须原样回传上一页响应里的 `cursor`：
   *   · `max`     = 打包值（约 `view_at << 16`）
   *   · `view_at` = 已返回的最旧一条的 unix 时间
   * **把同一个值同时传给两个参数**（很容易犯）会让接口静默地一直返回第一页 ——
   * HTTP 200、不报错、数据看着也对，只是永远翻不动。这是这份实现里最阴的一个坑。
   */
  historyPage(p: {
    max?: number;
    viewAt?: number;
    ps?: number;
    business?: string;
    pageType?: string;
  }): Promise<{
    list?: HistoryItem[];
    cursor?: { max?: number; view_at?: number };
  }> {
    return this.get(
      "/x/web-interface/history/cursor",
      {
        ps: p.ps ?? 30,
        max: p.max ?? 0,
        view_at: p.viewAt ?? 0,
        business: p.business ?? "",
        type: p.pageType ?? "all",
      },
      "https://www.bilibili.com/account/history",
    );
  }

  /** 视频详情 + 标签 + UP 主名片，一个来回拿全。 */
  viewDetail(bvid: string): Promise<BiliViewDetail> {
    return this.get("/x/web-interface/view/detail", { bvid }, `https://www.bilibili.com/video/${bvid}`);
  }

  /** 我对这条视频的互动状态（点赞 / 收藏 / 投币 / 关注 UP）。 */
  relation(bvid: string): Promise<Record<string, unknown>> {
    return this.get(
      "/x/web-interface/archive/relation",
      { bvid },
      `https://www.bilibili.com/video/${bvid}`,
    );
  }
}

/** 历史接口返回的一条。字段名保持 B 站原样，方便和接口文档对照。 */
export interface HistoryItem {
  title?: string;
  cover?: string;
  uri?: string;
  view_at?: number;
  duration?: number;
  progress?: number;
  is_finish?: number;
  tag_name?: string;
  author_name?: string;
  author_mid?: number;
  is_fav?: number;
  history?: {
    bvid?: string;
    business?: string;
    oid?: number;
    cid?: number;
    dt?: number;
    part?: string;
  };
}

export interface BiliViewDetail {
  View?: {
    title?: string;
    desc?: string;
    pic?: string;
    duration?: number;
    pubdate?: number;
    tname?: string;
    owner?: { name?: string; mid?: number };
    stat?: Record<string, number>;
  };
  Tags?: Array<{ tag_name?: string }>;
}
