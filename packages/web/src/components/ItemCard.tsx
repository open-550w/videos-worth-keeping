import { Link } from "react-router";
import { Tooltip } from "antd";
import { Paperclip, MessageSquare, Link2, Clock } from "lucide-react";
import { ChannelTag, TagChip } from "./ChannelTag";
import { Cover } from "./Cover";
import { INK, MONO, MUTED, RULE, TONE } from "../lib/theme";
import { clipRanges, formatDateShort, formatDuration, formatRanges, type DateRange } from "../lib/format";
import type { Item } from "../types";

/**
 * 条目卡片。列表页与周详情页共用。
 *
 * 布局按**手机优先**排：封面在左固定宽，右侧自适应 —— 375px 下也读得下去。
 * 需求确认会明确「手机上用得不少」，所以这不是「以后再说」的事。
 *
 * `week`：在周视图里用时传当前这一周，卡片会补一句「本周 X~Y」——
 * 一段跨月的区间在这周只该显示它覆盖到的那几天，不然会让人以为这周看了整部剧。
 */
export function ItemCard({
  item,
  compact,
  week,
}: {
  item: Item;
  compact?: boolean;
  week?: DateRange;
}) {
  const inWeek = week ? clipRanges(item.watchedRanges, week.from, week.to) : [];
  // 这段在本周只覆盖了一部分（跨出去过）—— 只有这时才值得单独说「本周」
  const partial =
    inWeek.length > 0 &&
    (inWeek.length !== item.watchedRanges.length ||
      inWeek.some((r, i) => r.from !== item.watchedRanges[i].from || r.to !== item.watchedRanges[i].to));

  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        padding: 12,
        background: "#fff",
        border: `1px solid ${RULE}`,
        borderRadius: 8,
        alignItems: "flex-start",
      }}
    >
      {/* 封面：没有就留一个占位，不要让它塌掉 —— 塌了之后每张卡的高度都不一样 */}
      <Link to={`/item/${item.id}`} style={{ flexShrink: 0, lineHeight: 0 }}>
        <Cover
          src={item.coverUrl}
          width={compact ? 72 : 96}
          height={compact ? 96 : 128}
        />
      </Link>

      <div style={{ flex: 1, minWidth: 0 }}>
        <Link
          to={`/item/${item.id}`}
          style={{
            color: INK,
            fontWeight: 600,
            fontSize: 15,
            lineHeight: 1.4,
            marginBottom: 4,
            // 标题可能很长 —— 两行截断，别让它把卡片撑成一条
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {item.title || <span style={{ color: MUTED }}>（无标题）</span>}
        </Link>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <ChannelTag code={item.channelCode} name={item.channelName} />
          {item.tags.map((t) => (
            <TagChip key={t.id} tag={t} />
          ))}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 10,
            fontSize: 12,
            color: MUTED,
            alignItems: "center",
          }}
        >
          <span className="mono">{formatRanges(item.watchedRanges)}</span>
          {partial && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span style={{ color: TONE.settled.fg }}>本周 {formatRanges(inWeek)}</span>
            </>
          )}
          {!compact && <span style={{ opacity: 0.5 }}>·</span>}
          {!compact && (
            <span style={{ opacity: 0.7 }}>
              记于 <span className="mono">{formatDateShort(item.collectedOn)}</span>
            </span>
          )}
          {item.author && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
                {item.author}
              </span>
            </>
          )}
          {formatDuration(item.durationSec) && (
            <>
              <span style={{ opacity: 0.5 }}>·</span>
              <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <Clock size={11} />
                {formatDuration(item.durationSec)}
              </span>
            </>
          )}
        </div>

        {!compact && item.summary && (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: MUTED,
              lineHeight: 1.6,
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {item.summary}
          </div>
        )}

        <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 12, color: MUTED }}>
          <Tooltip title="我的评论">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <MessageSquare size={12} />
              {item.noteCount}
            </span>
          </Tooltip>
          <Tooltip title="截图 / 备份">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <Paperclip size={12} />
              {item.attachmentCount}
            </span>
          </Tooltip>
          {item.primaryUrl && (
            <Tooltip title={item.primaryUrl}>
              <a
                href={item.primaryUrl}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(e) => e.stopPropagation()}
                style={{ display: "inline-flex", alignItems: "center", gap: 4, color: TONE.settled.fg }}
              >
                <Link2 size={12} />
                原链接
              </a>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
}
