import { hostOf } from "@likes/shared";
import { decodeEntities, safeFetch, type Resolved, type Resolver } from "./types.js";

const HOST = "hongguoduanju.com";

/**
 * 红果（红果短剧 web 站）。
 *
 * 实测结论（详见 docs/init/06_RESOLVERS.md）：
 *   · URL 形态：`https://hongguoduanju.com/detail?series_id=<19 位数字>`
 *   · **不需要登录**，HTTP 200
 *   · 是 SSR（`x-modernjs-render: server`），数据就在 HTML 里
 *   · 能拿到：剧名 + 剧情简介；**拿不到封面**（封面是客户端渲染后加载的）
 *
 * ⚠️ **这个页面里含 NUL 字节（实测 5 个）。**
 *    后果：`grep` 之类的工具会把它当二进制文件，**静默返回 0** ——
 *    文件开头明明是 `<!doctype html>`，却报「没找到」。
 *    所以下面一律用**整串正则**，绝不做行/二进制嗅探。
 *    信了那个假失败的话，会得出「红果页面没数据，必须上无头浏览器」这个
 *    昂贵且错误的结论。
 */

/** `_高清完整版全集免费观看_红果短剧` 这类固定后缀。 */
export function titleFromTag(raw: string): string | null {
  const t = decodeEntities(raw).trim();
  if (!t) return null;
  // 后缀固定以 `_` 起头；剧名本身不含下划线（5 条样例都成立）
  const cut = t.split("_")[0]?.trim();
  return cut || null;
}

/** 简介模板是 `《剧名》高清在线观看，剧情:…` —— 这里取《》里的剧名做交叉校验。 */
export function titleFromDescription(desc: string): string | null {
  return /《([^》]+)》/.exec(desc)?.[1]?.trim() ?? null;
}

/** 剥掉简介开头的模板话术，留下剧情本身。剥不掉就原样保留。 */
export function stripSummaryBoilerplate(desc: string): string {
  return desc.replace(/^《[^》]*》\s*(?:高清)?(?:在线观看)?\s*[，,]?\s*(?:剧情[:：]\s*)?/, "").trim();
}

/**
 * 从页面 HTML 里抽剧名。
 *
 * **两个独立来源**：`<title>` 去掉后缀，和简介里的 `《…》`。
 * 它们互相独立，所以能交叉验证 —— 一致就放心用，不一致说明平台改了模板。
 * 这比只靠一个来源可靠：两个同时坏的概率远低于一个。
 */
export function extractTitle(html: string, seriesId: string): string | null {
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/.exec(html)?.[1] ?? "";
  const description =
    /<meta[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]*\bcontent=["']([^"']*)["'][^>]*\bname=["']description["']/i.exec(html)?.[1] ??
    "";
  const fromTag = titleFromTag(rawTitle);
  const fromDesc = titleFromDescription(decodeEntities(description));
  if (fromTag && fromDesc && fromTag !== fromDesc) {
    console.warn(
      `[hongguo] 标题两个来源不一致（series_id=${seriesId}）：` +
        `<title>="${fromTag}" vs 简介《》="${fromDesc}" —— 平台模板可能变了`,
    );
  }
  return fromTag ?? fromDesc ?? null;
}

/** 抽简介（剥掉模板话术）。 */
export function extractSummary(html: string): string | undefined {
  const description =
    /<meta[^>]*\bname=["']description["'][^>]*\bcontent=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta[^>]*\bcontent=["']([^"']*)["'][^>]*\bname=["']description["']/i.exec(html)?.[1] ??
    "";
  if (!description) return undefined;
  const s = stripSummaryBoilerplate(decodeEntities(description));
  return s || undefined;
}

export const hongguoResolver: Resolver = {
  code: "hongguo",

  match(url) {
    const h = hostOf(url);
    return h === HOST || !!h?.endsWith(`.${HOST}`);
  },

  async resolve(url): Promise<Resolved | null> {
    let seriesId: string | null = null;
    try {
      seriesId = new URL(url).searchParams.get("series_id");
    } catch {
      return null;
    }
    if (!seriesId) return null;

    const res = await safeFetch(url);
    if (!res?.ok) return null;

    // ⚠️ 整串读入。不要按行切，见文件头的 NUL 字节说明。
    const html = await res.text();

    return {
      channelCode: "hongguo",
      // ⚠️ 19 位数字，超过 Number.MAX_SAFE_INTEGER（约 9e15）——
      // 全程当字符串，任何 Number() 转换都会丢精度。
      platformItemId: seriesId,
      title: extractTitle(html, seriesId) ?? undefined,
      summary: extractSummary(html),
      // 封面抓不到：静态 HTML 里只有站点 logo 和首页图。
      // 留空让用户手动贴 —— 不假装有。
    };
  },
};
