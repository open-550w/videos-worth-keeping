/** 解析器抓回来的东西。字段都可选 —— 抓不到就让用户手填，不挡录入。 */
export interface Resolved {
  channelCode: string;
  /** 平台内稳定 ID。红果 series_id 是 19 位数字，超过 JS 安全整数范围，**一律字符串**。 */
  platformItemId: string;
  title?: string;
  author?: string;
  coverUrl?: string;
  summary?: string;
  durationSec?: number;
  /** `YYYY-MM-DD` */
  publishedOn?: string;
}

export interface Resolver {
  code: string;
  /** 这个 URL 归不归我管。 */
  match(url: string): boolean;
  /**
   * 抓取。
   *
   * **失败一律返回 null，不抛。** 抓取是录入的**加速**，不是**前置条件** ——
   * 平台改版、网络不通、视频被删，都不该让人记不下来。
   * 抛出去的话，「30 秒记一条」这个判据会在平台改版的当天就不成立。
   */
  resolve(url: string): Promise<Resolved | null>;
}

/** 统一的抓取超时。不设的话一条慢请求能把录入卡到用户放弃。 */
export const FETCH_TIMEOUT_MS = 8_000;

export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * 带超时的 fetch。网络层的任何异常都收敛成 null，交给调用方降级。
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
): Promise<Response | null> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "User-Agent": BROWSER_UA, ...(init.headers ?? {}) },
    });
  } catch {
    return null;
  }
}

/** 把 HTML 实体解回来。标题里 `&amp;` 之类的很常见。 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)));
}
