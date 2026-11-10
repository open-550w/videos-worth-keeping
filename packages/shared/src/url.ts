/**
 * URL 规范化 —— **前后端共用同一份实现**。
 *
 * 为什么需要它：`item_urls.url_hash` 是 `SHA-256(规范化后的 url)`，
 * 用来给「同一个内容」去重。如果直接哈希原始 URL，同一条 B 站视频会因为
 * `?spm_id_from=...`、末尾斜杠、`http` vs `https`、大小写 host 而哈希出**不同的值**
 * —— 去重就形同虚设。
 *
 * 分两个函数，因为它们的**目的不同**：
 *   · `canonicalizeUrl`  —— 激进，只为哈希。可以丢掉一切不影响内容的东西。
 *   · `cleanUrlForDisplay` —— 保守，要存库、要给用户点。不能改坏。
 * 两者不一致是正常的：存的是 display，哈希的是 canonical。
 */

/**
 * 明确属于「跟踪 / 会话」的 query 参数，去重时丢掉。
 *
 * ⚠️ **必须用精确列表，不能用宽泛的前缀模式。**
 * 反面例子：B 站的 `?p=2` 表示「多 P 视频的第 2 P」—— 那是**内容的一部分**。
 * 如果写个 `^p` 之类的模式把它丢了，第 1 P 和第 2 P 会被哈希成同一条，
 * 于是第二条永远存不进去（撞唯一约束），而且报的是「已收藏过」——
 * 一个看起来完全合理的提示，掩盖了一个真 bug。
 */
const TRACKING_PARAMS = new Set([
  // 通用
  "fbclid", "gclid", "dclid", "msclkid", "yclid", "igshid", "mc_eid", "mc_cid",
  "ref", "referrer", "referer", "source", "src",
  // 微信 / 小红书
  "wxfid", "wxfrom", "scene", "xsec_source", "xsec_token",
  // B 站
  "spm_id_from", "vd_source", "from_source", "from_spmid", "share_source",
  "share_medium", "share_plat", "share_session_id", "share_tag", "share_times",
  "unique_k", "buvid", "buvid3", "buvid4", "up_id", "timestamp", "seid",
  "msource", "bbid", "ts", "launch_id", "plat_id", "broadcast_type", "is_room_feed",
]);

/** 前缀匹配的跟踪参数（这类平台用前缀成组出现）。 */
const TRACKING_PREFIXES = ["utm_", "spm_", "share_", "_"];

function isTracking(key: string): boolean {
  const k = key.toLowerCase();
  return TRACKING_PARAMS.has(k) || TRACKING_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * 激进规范化，**只用于计算哈希**。解析失败返回 null（调用方决定怎么办）。
 */
export function canonicalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;

  // http / https 视为同一条内容
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  // 默认端口去掉
  if (u.port === "80" || u.port === "443") u.port = "";
  // fragment 是纯客户端的，不影响内容
  u.hash = "";

  // 丢跟踪参数；剩下的按 key 排序，让参数顺序不影响哈希
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTracking(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // 末尾斜杠：路径不是根时才去
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "");
  u.pathname = path;

  return u.toString();
}

/**
 * 保守清理，**用于存库与展示**。只做不会改变指向的改动：
 * 去空白、host 小写、去 fragment。
 *
 * 故意**不做** http→https、不删参数 —— 那可能改坏一个能打开的链接。
 */
export function cleanUrlForDisplay(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    return u.toString();
  } catch {
    return trimmed;
  }
}

/** 取域名（去掉 www.），失败返回 null。用来匹配渠道。 */
export function hostOf(raw: string): string | null {
  try {
    return new URL(raw.trim()).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** 看起来是不是一个 http(s) URL —— 录入时用它决定要不要走解析器。 */
export function looksLikeUrl(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}
