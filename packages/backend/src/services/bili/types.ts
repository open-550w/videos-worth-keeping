/**
 * B 站观看历史抓取 —— 类型与常量。
 *
 * 这一层是**从 `/path/to/optional-history-tool`（Python）搬过来的**。
 * 搬的是**协议细节**，不是代码风格 —— 那些细节都是那边实测出来的，见各自注释里的引用。
 * 搬过来而不是起子进程调 Python，是因为本仓库是单运行时（pnpm workspace + TS），
 * 为了一个命令再引一套 Python + venv 不划算；而且这些细节写在 TS 里同样能保留，
 * 实测对拍过（同一时间窗，两边输出逐字段一致）。
 */

export const BILI_API = "https://api.bilibili.com";

/** 伪装成那个正在用的 Chrome。B 站的 WAF 看这个。 */
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

/**
 * `dt` = 这条观看是从哪个客户端发生的。
 *
 * 映射表来自实测；未知值原样保留成 `未知(dt=N)`，**不要**硬塞成「其他」——
 * 那样以后新增客户端类型时就再也发现不了了。
 */
export const DEVICE_MAP: Record<number, string> = {
  1: "安卓",
  2: "iPhone",
  3: "PC/Web",
  4: "iPad",
  5: "安卓平板",
  6: "Windows 客户端",
  7: "安卓HD",
  8: "Mac 客户端",
  9: "iOS HD",
  33: "TV/投影",
};

/** B 站 `business` → 本站 `content_type`。 */
export const CONTENT_TYPE_BY_BUSINESS: Record<string, string> = {
  archive: "video",
  live: "video",
  pgc: "video",
  cheese: "video",
  article: "note",
};

export interface BiliInteractions {
  /** NULL = 未获取，不能当成未点赞/未投币/未收藏。均为抓取快照。 */
  biliLiked: boolean | null;
  biliCoins: number | null;
  biliFavorited: boolean | null;
}

/** 抓取层的一条观看记录（还没入库）。 */
export interface WatchRecord extends BiliInteractions {
  channelCode: string;
  /** archive | live | pgc | article | cheese */
  business: string;
  /**
   * 平台内稳定 ID。archive 是 BV 号；其余类型没有 BV 号，用 `<business>:<oid>`。
   * 见 migrations/006 的注释（唯一键靠它，不能留空）。
   */
  platformItemId: string;
  /** unix 秒 */
  watchedAt: number;
  url: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
  durationSec: number | null;
  summary: string | null;
  /** 播放位置（秒）。`null` = 客户端没上报，**不是 0** */
  progressSec: number | null;
  /**
   * 看完了没（进度 ≥ 时长 × 95%，自己推的 —— B 站自带的 `is_finish` 实测恒为 0）。
   *
   * 抓取时就定下来、存进候选区，而不是让页面拿 progress/duration 自己算：
   * 这是**挑选时最主要的信号**（实测 1315 条里只有 22 条看完），
   * 而且「95%」这条规则只该有一份。
   */
  watchedToEnd: boolean;
  device: string | null;
  tags: string[];
  publishedOn: string | null;
  contentType: string;
  /** 富化失败的原因（视频被删 / 限流），只用于排查，不影响这条记录入库 */
  detailError: string | null;
}

export interface FetchWindowOptions {
  /** unix 秒，闭区间 */
  since?: number;
  until?: number;
  /** all | archive | live | article | pgc */
  business?: string;
  /** 跳过逐视频元数据（快很多：1300 条约 30 秒 → 几秒） */
  noDetail?: boolean;
  /** 忽略详情缓存 */
  noCache?: boolean;
  workers?: number;
  /** 全局最小请求间隔（秒），多 worker 共享同一个节流器 */
  delaySec?: number;
  maxPages?: number;
  pageSize?: number;
  /**
   * 这些视频**不用再富化**（候选区里已经有了）。
   *
   * 省的是逐视频的详情请求（`view/detail` + `relation`，每个视频两次）——
   * **冷缓存时是几百次**；热缓存时那些请求本来也被磁盘缓存挡住了，
   * 这时省下的是读几百个缓存文件的时间。
   *
   * ⚠️ 别把这条说成「省下绝大多数请求」：实测一个 7 天窗口总共 37 次接口调用，
   * 其中 26 次是**翻历史**本身（751 条 / 每页 30）—— 那部分是省不掉的。
   * 真正的收益在别处：**不覆盖已有的行**（见 dao.upsertEntries）。
   */
  skipDetailFor?: ReadonlySet<string>;
  /** 给人看的日志（CLI 用） */
  onLog?: (line: string) => void;
  /** 给程序看的进度（页面上的同步按钮用）—— 不要去解析上面的日志文本 */
  onProgress?: (p: FetchProgress) => void;
}

/** 结构化进度。页面据此显示「正在富化 25/48」，不用去正则解析人话日志。 */
export interface FetchProgress {
  phase: "history" | "enrich";
  /** 历史翻到第几页 */
  pages?: number;
  /** 窗口内累计拿到多少条历史 */
  kept?: number;
  /** 富化进度 */
  enriched?: number;
  enrichTotal?: number;
}
