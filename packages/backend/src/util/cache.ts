/**
 * 进程内读缓存。
 *
 * **为什么需要它**：数据库在远程，实测单次往返中位 237ms、p90 1970ms、p99 3571ms
 * （见 docs/init/03_TECH_STACK.md §1.3），而**每个页面要 2 次往返**。
 * 更糟的是这条链路偶尔会卡到几十秒。
 *
 * 这个站的形状**非常适合缓存**：
 *   · 写者只有一个人（你）
 *   · 所有写都经过本进程的 HTTP 接口 —— 所以失效可以做到精确
 *   · 数据量小（几百到几千行），全放内存也就几百 KB
 *
 * 所以策略很简单也很安全：**读缓存，任何成功的写就把整个缓存清掉。**
 * 粗粒度，但单用户站不会有「A 改了 B 却看到旧数据」的问题 ——
 * 唯一会看到数据的人就是改它的那个人。
 *
 * ⚠️ **不做细粒度失效是刻意的**：细粒度要靠人在每个写路径上记得调对应的 key，
 * 漏一个就是「改了看不到」，而且很难查。粗粒度不可能漏。
 *
 * ── 配置（都在 packages/backend/.env.local，见 .env.example）──
 *
 *   CACHE_ENABLED=1        总开关。=0 时 cached() 直接透传，不存不查
 *   CACHE_TTL_MS=300000    兜底 TTL，默认 5 分钟
 *   CACHE_MAX_ENTRIES=500  内存上限，满了整个清空（正常用不到）
 *
 * ⚠️ **改了这些必须重启后端**（见下）—— 环境变量在进程启动时由 shell
 * `source .env.local` 注入，运行中改文件不会生效。
 */
interface Entry {
  value: unknown;
  expires: number;
}

const store = new Map<string, Entry>();

/**
 * 配置在**每次调用时**读，不是模块加载时读一次。
 *
 * 两者在运行期其实等价（环境变量要重启才会变），但读在调用点有两个好处：
 *   · 单测里能直接改 process.env 验证开关行为，不用重新 import 模块
 *   · 以后真要做「运行时热改配置」时不用动这里
 * 代价是每次读几个环境变量 —— 可以忽略。
 */
function config() {
  return {
    enabled: (process.env.CACHE_ENABLED ?? "1") !== "0",
    ttlMs: Number(process.env.CACHE_TTL_MS ?? 5 * 60_000),
    maxEntries: Number(process.env.CACHE_MAX_ENTRIES ?? 500),
  };
}

export interface CacheStats {
  enabled: boolean;
  entries: number;
  hits: number;
  misses: number;
  /** 当前生效的配置 —— 露出来才好在 /api/health 上确认改没改对 */
  ttlMs: number;
  maxEntries: number;
}

const counters = { hits: 0, misses: 0 };

/**
 * 读缓存包装。key 要能唯一标识这次查询（把参数都编进去）。
 */
export async function cached<T>(
  key: string,
  load: () => Promise<T>,
  ttlMs?: number,
): Promise<T> {
  const cfg = config();
  if (!cfg.enabled) {
    // 关掉时**完全透传**：不查、不存、不计数。
    // 只是「TTL 设成 0」的话仍会写入 Map，白占内存还让命中率统计变得没法看。
    return load();
  }

  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) {
    counters.hits++;
    return hit.value as T;
  }

  counters.misses++;
  const value = await load();
  if (store.size >= cfg.maxEntries) {
    // 简单粗暴：满了就整个清空。单用户站不会真的走到这里。
    store.clear();
  }
  store.set(key, { value, expires: Date.now() + (ttlMs ?? cfg.ttlMs) });
  return value;
}

/** 任何成功的写之后调用。粗粒度，但不可能漏。 */
export function invalidateAll(): void {
  store.clear();
}

export function cacheStats(): CacheStats {
  const cfg = config();
  return {
    enabled: cfg.enabled,
    entries: store.size,
    ttlMs: cfg.ttlMs,
    maxEntries: cfg.maxEntries,
    ...counters,
  };
}

/** 把查询参数编成一个稳定的 key。 */
export function cacheKey(parts: Record<string, unknown>): string {
  return Object.keys(parts)
    .sort()
    .map((k) => `${k}=${JSON.stringify(parts[k] ?? null)}`)
    .join("&");
}
