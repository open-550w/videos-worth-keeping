import { BiliClient, BiliError, type HistoryItem } from "./client.js";
import {
  biliInteractionsOf,
  defaultCacheDir,
  readCachedDetail,
  writeCachedDetail,
  type CachedDetail,
} from "./cache.js";
import { CONTENT_TYPE_BY_BUSINESS, DEVICE_MAP, type FetchWindowOptions, type WatchRecord } from "./types.js";

/**
 * 观看历史的抓取主流程：翻页 → 富化 → 组装成 WatchRecord。
 *
 * 这个文件是 Python 版 `fetch_history.py` 的等价实现。**协议细节都原样保留**，
 * 每处「为什么」都写在注释里 —— 那些是那边实测出来的，不是猜的。
 */

const CHANNEL = "bilibili";

const log = (opts: FetchWindowOptions, line: string) => opts.onLog?.(line);

/** unix 秒 → `YYYY-MM-DD HH:MM:SS`（本地时区）。B 站给的就是本地时间。 */
export function formatTs(sec: number | null | undefined): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** unix 秒 → `YYYY-MM-DD`（给 DATE 列用）。 */
function formatDate(sec: number | null | undefined): string | null {
  const s = formatTs(sec);
  return s ? s.slice(0, 10) : null;
}

/** B 站的图片是 http，升到 https —— 不然前端页面会被浏览器按混合内容拦掉。 */
function https(url: string | undefined | null): string | null {
  if (!url) return null;
  return url.startsWith("http://") ? `https://${url.slice("http://".length)}` : url;
}

/**
 * B 站用 `-` / `--` / `—` 表示「没有简介」。归一成空串，别让一个横杠当成内容显示。
 *
 * ⚠️ 归一化发生在**读接口那一步**（`enrich`），所以写进缓存的就已经是干净的；
 * `buildRecord` 直接信任传进来的值，不再归一化一遍 —— 归一化只该有一处。
 */
export function normDesc(text: string | undefined | null): string {
  const t = (text ?? "").trim();
  return t === "-" || t === "--" || t === "—" ? "" : t;
}

/**
 * `uri` 字段缺失时自己拼。
 *
 * archive / live / pgc / cheese 都有 `uri`，**只有 article 没有** ——
 * 它的 id 在 `oid` 里，对应 cv 号。少这个兜底，专栏那几行的链接就是空的。
 */
function fallbackUrl(business: string, bvid: string, oid: number | undefined): string {
  if (bvid) return `https://www.bilibili.com/video/${bvid}`;
  if (business === "article" && oid) return `https://www.bilibili.com/read/cv${oid}`;
  if (business === "live" && oid) return `https://live.bilibili.com/${oid}`;
  return "";
}

/**
 * 平台内稳定 ID。
 *
 * archive 用 BV 号（全站唯一、稳定）。其余类型**没有 BV 号**，用 `<business>:<oid>`：
 * 直播房间号 / 番剧 ep / 专栏 cv 号 —— 这些在不同 business 之间会撞号，
 * 所以必须带前缀。**不能留空**：候选区的去重键里有它，留空等于每次抓取都插一遍。
 */
function platformIdOf(business: string, bvid: string, oid: number | undefined): string {
  if (bvid) return bvid;
  return `${business}:${oid ?? ""}`;
}

/**
 * 翻页走历史，**新的在前**，一旦越过 `since` 就停。
 *
 * 为什么能提前停：历史严格按时间倒序。某一条的 `view_at < since`，后面的只会更旧 ——
 * 指定近期窗口时不必把整段历史翻完（实测：抓最近 4 天只要 30 次请求，全量要 124 次）。
 */
export async function* walkHistory(
  client: BiliClient,
  opts: FetchWindowOptions,
): AsyncGenerator<HistoryItem> {
  const { since, until, maxPages = 2000, pageSize = 30, business = "", } = opts;
  let max = 0;
  let viewAt = 0;
  let kept = 0;

  for (let page = 1; page <= maxPages; page++) {
    const data = await client.historyPage({
      max,
      viewAt,
      ps: pageSize,
      business: business === "all" ? "" : business,
      pageType: business === "all" ? "all" : "all",
    });
    const items = data?.list ?? [];
    if (!items.length) {
      log(opts, `[*] 第 ${page} 页：空，历史翻完了`);
      return;
    }
    const cursor = data?.cursor ?? {};

    let stop = false;
    for (const it of items) {
      const va = it.view_at ?? 0;
      if (until !== undefined && va > until) continue; // 比窗口新：跳过，继续翻
      if (since !== undefined && va < since) {
        stop = true; // 严格倒序 ⇒ 后面只会更旧
        break;
      }
      kept++;
      yield it;
    }

    log(
      opts,
      `[*] 第 ${page} 页：${items.length} 条（${formatTs(items[0]?.view_at)} .. ` +
        `${formatTs(items[items.length - 1]?.view_at)}），累计 ${kept}`,
    );
    opts.onProgress?.({ phase: "history", pages: page, kept });

    if (stop) {
      log(opts, "[*] 已越过 --since 边界，停");
      return;
    }

    const nextMax = cursor.max;
    const nextViewAt = cursor.view_at;
    if (!nextMax && !nextViewAt) return;
    if (nextMax === max && nextViewAt === viewAt) {
      // 游标没动 = 再翻也是同一页。宁可停，也不要无限循环打接口。
      log(opts, "[!] 游标没有前进，停下以免死循环");
      return;
    }
    max = nextMax ?? 0;
    viewAt = nextViewAt ?? 0;
  }
}

/**
 * 富化一条视频：`view/detail`（元数据 + 标签）+ `archive/relation`（我的互动）。
 *
 * ⚠️ **只有 `detail_ok` 才写缓存。** 否则一次限流失败会被永久冻进缓存，
 * 之后每次都读到那个残缺的结果，而你还以为「这视频就是没简介」。
 */
async function enrich(
  client: BiliClient,
  bvid: string,
  useCache: boolean,
  cacheDir: string,
): Promise<CachedDetail> {
  if (useCache) {
    const hit = await readCachedDetail(cacheDir, bvid);
    if (hit) return hit;
  }

  const out: CachedDetail = {
    bvid,
    detail_ok: false,
    relation_ok: false,
    detail_error: "",
    relation_error: "",
  };

  try {
    const det = (await client.viewDetail(bvid)) ?? {};
    const view = det.View ?? {};
    const stat = view.stat ?? {};
    const owner = view.owner ?? {};
    out.detail_ok = true;
    out.title = view.title ?? "";
    out.desc = normDesc(view.desc);
    out.cover = https(view.pic) ?? undefined;
    out.duration = view.duration ?? null;
    out.pubdate = view.pubdate ?? null;
    out.pubdate_str = formatTs(view.pubdate);
    out.tname = view.tname ?? "";
    out.tags = (det.Tags ?? []).map((t) => t.tag_name).filter((x): x is string => !!x);
    out.up_name = owner.name ?? "";
    out.up_mid = owner.mid ?? null;
    out.stat_view = stat.view ?? null;
    out.stat_like = stat.like ?? null;
    out.stat_coin = stat.coin ?? null;
    out.stat_favorite = stat.favorite ?? null;
    out.stat_reply = stat.reply ?? null;
    out.stat_danmaku = stat.danmaku ?? null;
    out.stat_share = stat.share ?? null;
  } catch (err) {
    out.detail_error = err instanceof BiliError ? `${err.code}: ${err.message}` : String(err);
  }

  try {
    const rel = (await client.relation(bvid)) ?? {};
    out.relation_ok = true;
    out.me_liked = Boolean(rel.like);
    out.me_favorited = Boolean(rel.favorite);
    out.me_coined = Number(rel.coin ?? 0);
    out.me_followed_up = Boolean(rel.attention);
    out.me_disliked = Boolean(rel.dislike);
  } catch (err) {
    out.relation_error = err instanceof BiliError ? `${err.code}: ${err.message}` : String(err);
  }

  if (out.detail_ok) await writeCachedDetail(cacheDir, bvid, out);
  return out;
}

/** 一条历史 → 一条 WatchRecord。`extra` 只有 archive 类型才有。 */
export function buildRecord(item: HistoryItem, extra: CachedDetail | null): WatchRecord {
  const h = item.history ?? {};
  const bvid = h.bvid ?? "";
  const business = h.business ?? "";
  const oid = h.oid;
  const watchedAt = item.view_at ?? 0;
  const duration = item.duration ?? 0;

  /**
   * `progress` 用 **-1 表示「这个客户端没上报播放位置」**（实测约 30% 的记录）。
   * 负数一律当未知，**绝不能当成 0 秒** —— 那会得出「点开就关了」的错误结论。
   */
  const rawProgress = item.progress;
  const progress = typeof rawProgress === "number" && rawProgress >= 0 ? rawProgress : null;

  /**
   * 看完没看完：进度 ≥ 时长 × 95%。
   *
   * ⚠️ 两个坑都在这个判断里：
   *   · B 站自带的 `is_finish` **实测恒为 0**（1315 条里没有一条是 1），已失效 ——
   *     用它的话会得出「一条都没看完」的结论。所以自己推。
   *   · 时长取**历史接口**的 `duration`，不是详情接口的 `View.duration`。
   *     这是照搬 Python 版的行为：两边在 archive 上基本一致，但派生判断依赖它，
   *     换一个来源就可能让边界上的记录翻转 —— 移植时不该顺手改这种地方。
   *     `duration` 为 0（直播 / 专栏）时整个判断为假，也是刻意的。
   */
  const watchedToEnd = Boolean(progress && duration && progress >= duration * 0.95);

  const url = item.uri || fallbackUrl(business, bvid, oid);
  const contentType = CONTENT_TYPE_BY_BUSINESS[business] ?? "video";

  return {
    channelCode: CHANNEL,
    business,
    platformItemId: platformIdOf(business, bvid, oid),
    watchedAt,
    url: https(url) ?? "",
    // extra 的标题更完整（历史里的标题可能被截断），有就用它
    title: (extra?.title || item.title || "").trim(),
    author: extra?.up_name || item.author_name || null,
    coverUrl: https(extra?.cover) ?? https(item.cover),
    // 0 = 这类内容没有时长（直播 / 专栏），存 null 而不是 0 —— 0 秒是个会被误读的数
    durationSec: duration > 0 ? duration : null,
    summary: extra?.desc ? extra.desc : null,
    progressSec: progress,
    watchedToEnd,
    ...biliInteractionsOf(extra),
    device: DEVICE_MAP[h.dt ?? -1] ?? `未知(dt=${h.dt})`,
    tags: extra?.tags ?? [],
    publishedOn: formatDate(extra?.pubdate),
    contentType,
    detailError: extra?.detail_error || null,
  };
}

/** 有并发上限的 map —— 和 Python 版的 ThreadPoolExecutor 等价。 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return out;
}

export interface FetchResult {
  records: WatchRecord[];
  apiCalls: number;
  account: { uname: string; mid: number };
}

/**
 * 抓一个时间窗的观看历史。
 *
 * 两趟：先把窗口内的历史翻完（便宜），再对 archive 类型逐视频富化（贵）。
 * 只富化 archive —— 直播 / 番剧 / 专栏没有 BV 号，走不了 `view/detail`。
 */
export async function fetchWatchHistory(
  client: BiliClient,
  opts: FetchWindowOptions,
): Promise<FetchResult> {
  const nav = await client.nav();
  if (!nav?.isLogin) {
    throw new Error("cookie 不是登录态 —— 在 Chrome 里打开 bilibili.com 登录一次，再 --refresh-cookies");
  }
  log(opts, `[*] 账号：${nav.uname}（mid ${nav.mid}）`);

  const raw: HistoryItem[] = [];
  for await (const it of walkHistory(client, opts)) raw.push(it);
  log(opts, `[*] 窗口内 ${raw.length} 条历史`);

  const extras = new Map<string, CachedDetail>();
  const allTargets = [
    ...new Set(
      raw
        .filter((it) => it.history?.bvid && it.history?.business === "archive")
        .map((it) => it.history!.bvid!),
    ),
  ];
  // 增量同步：已经抓过的视频不再富化。省下的是**绝大多数**请求 ——
  // 一个 7 天窗口里通常只有个位数是新的，剩下的标题/封面/标签都不会变。
  const targets = opts.skipDetailFor
    ? allTargets.filter((bvid) => !opts.skipDetailFor!.has(bvid))
    : allTargets;
  const skipped = allTargets.length - targets.length;

  if (opts.noDetail) {
    log(opts, "[*] --no-detail：跳过元数据富化");
  } else if (targets.length) {
    const workers = opts.workers ?? 4;
    const cacheDir = defaultCacheDir();
    log(
      opts,
      `[*] 富化 ${targets.length} 个视频（${workers} 并发，间隔 ${opts.delaySec ?? 0.35}s）` +
        (skipped ? `，跳过已有 ${skipped} 个` : "") +
        "…",
    );
    let done = 0;
    const results = await mapPool(targets, workers, async (bvid) => {
      const r = await enrich(client, bvid, !opts.noCache, cacheDir);
      done++;
      if (done % 25 === 0 || done === targets.length) log(opts, `    ${done}/${targets.length}`);
      opts.onProgress?.({ phase: "enrich", enriched: done, enrichTotal: targets.length });
      return r;
    });
    targets.forEach((bvid, i) => extras.set(bvid, results[i]));
  } else if (skipped) {
    log(opts, `[*] ${skipped} 个视频都已经抓过了，无需富化`);
  }

  // 已有视频不打详情接口，但新的观看事件仍需继承本地缓存的互动快照。
  if (!opts.noDetail && skipped) {
    await mapPool(allTargets.filter((id) => !extras.has(id)), 4, async (id) => {
      const cached = await readCachedDetail(defaultCacheDir(), id);
      if (cached) extras.set(id, cached);
    });
  }

  const records = raw.map((it) =>
    buildRecord(it, it.history?.bvid ? (extras.get(it.history.bvid) ?? null) : null),
  );

  return { records, apiCalls: client.calls.n, account: { uname: nav.uname, mid: nav.mid } };
}

/** 解析 `--since` / `--until`：`YYYY-MM-DD[ HH:MM[:SS]]`、ISO-8601、epoch 秒、或 `7d`/`12h`/`30m`。 */
export function parseTimeArg(input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  const s = String(input).trim();
  if (!s) return undefined;

  const rel = /^(\d+(?:\.\d+)?)\s*([dhms])$/.exec(s);
  if (rel) {
    const unit = { d: 86400, h: 3600, m: 60, s: 1 }[rel[2] as "d" | "h" | "m" | "s"];
    return Date.now() / 1000 - Number(rel[1]) * unit;
  }

  if (/^\d{9,11}$/.test(s)) return Number(s);

  // `2026-10-18 00:00:00` 这种没有时区标记，按**本地时间**解释（用户说的就是本地时间）
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) {
    const d = new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
    );
    if (!Number.isNaN(d.getTime())) return d.getTime() / 1000;
  }

  const iso = Date.parse(s);
  if (!Number.isNaN(iso)) return iso / 1000;

  throw new Error(
    `认不出这个时间：${s}。可以用 '2026-10-18'、'2026-10-18 09:30:00'、'7d'、或 epoch 秒`,
  );
}
