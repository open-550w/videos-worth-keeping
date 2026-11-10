// 全站共用的视觉常量。
//
// 核心是一条**三档语义刻度**：落定（青碧）/ 中间态（琥珀）/ 否定（红）。
// 本项目的语义落点：
//   链接与备份：「链接正常 + 已备份」= 落定、「未探活 / 待备份」= 中间态、「链接失效」= 否定
// 新页面往这三档上靠，别再造第四种配色。

/** 纸面：近白，不是奶油色 —— 后者是生成式设计的头号特征。 */
export const PAPER = "#fcfcfb";
export const INK = "#14161a";
export const MUTED = "#6a707c";
export const RULE = "#e3e5e9";

/** 标识符、路径、时间戳用等宽 —— 它们是需要逐字辨认的内容。 */
export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export interface Tone {
  fg: string;
  bg: string;
}

/** 三档语义刻度。 */
export const TONE: Record<"settled" | "pending" | "negative", Tone> = {
  settled: { fg: "#115e59", bg: "#ccfbf1" },
  pending: { fg: "#92400e", bg: "#fef3c7" },
  negative: { fg: "#b91c1c", bg: "#fee2e2" },
};

/** 没有语义时的中性档。 */
export const TONE_NEUTRAL: Tone = { fg: MUTED, bg: "#f1f2f4" };

/** 渠道标识色 —— 只用来区分来源，不承载「好坏」，所以不走上面那三档。 */
export const CHANNEL_COLOR: Record<string, string> = {
  hongguo: "#d4380d",
  bilibili: "#00a1d6",
  zhihu: "#0066ff",
  xhs: "#ff2442",
  weread: "#2f9e44",
  manual: MUTED,
};
