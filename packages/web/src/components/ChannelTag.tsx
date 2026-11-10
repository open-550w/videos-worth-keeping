import { Tag } from "antd";
import { CHANNEL_COLOR, TONE_NEUTRAL } from "../lib/theme";
import type { Tag as TagModel } from "../types";

/**
 * 渠道标签。颜色只用来区分来源，不承载「好坏」—— 所以不走三档语义刻度。
 */
export function ChannelTag({ code, name }: { code: string | null; name: string | null }) {
  if (!code) {
    return (
      <Tag style={{ color: TONE_NEUTRAL.fg, background: TONE_NEUTRAL.bg, border: "none", marginInlineEnd: 0 }}>
        未分类渠道
      </Tag>
    );
  }
  const color = CHANNEL_COLOR[code] ?? TONE_NEUTRAL.fg;
  return (
    <Tag
      style={{
        color,
        background: `${color}14`,
        border: "none",
        marginInlineEnd: 0,
        fontWeight: 500,
      }}
    >
      {name ?? code}
    </Tag>
  );
}

/** 标签胶囊。单选组（分类）用实心描边，多选组（标签）用浅底，一眼能分出两种。 */
export function TagChip({ tag, onClick, active }: { tag: TagModel; onClick?: () => void; active?: boolean }) {
  const color = tag.color ?? "#6a707c";
  const isCategory = tag.selection === "single";
  return (
    <span
      onClick={onClick}
      title={`${tag.groupName}${isCategory ? "（分类）" : "（标签）"}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 8px",
        borderRadius: 999,
        fontSize: 12,
        lineHeight: "18px",
        cursor: onClick ? "pointer" : "default",
        color: active === false ? "#9aa0aa" : color,
        background: active === false ? "transparent" : `${color}14`,
        border: `1px solid ${active === false ? "#dcdee3" : `${color}55`}`,
        whiteSpace: "nowrap",
      }}
    >
      {isCategory && <span style={{ opacity: 0.6 }}>#</span>}
      {tag.name}
    </span>
  );
}
