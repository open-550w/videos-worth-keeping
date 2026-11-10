import { Button, DatePicker, Tooltip } from "antd";
import { Plus, Trash2 } from "lucide-react";
import dayjs from "dayjs";
import { MUTED, RULE, TONE } from "../lib/theme";
import { normalizeRanges, type DateRange } from "../lib/format";

const { RangePicker } = DatePicker;

/**
 * 「观看日期区间」编辑器 —— 快速录入页和详情页共用一份。
 *
 * 为什么抽出来而不是各写一遍：这个控件承载的是一条**领域规则**
 * （可以有好几段不相连的区间，比如第一季看完隔几天再看第二季），
 * 两处各写一遍的话，早晚会有一处先长出别的行为 —— 那就成了两套规则。
 *
 * 关于「30 秒记一条」这条成功判据（01_REQUIREMENTS.md §4）：
 * 这个控件**默认就是「今天」一段**，什么都不动也能直接存。
 * 加段是可选动作，不是必经步骤 —— 抓取失败都不许挡住录入，日期更不该。
 */
export function WatchRangesEditor({
  value,
  onChange,
}: {
  value: DateRange[];
  onChange: (next: DateRange[]) => void;
}) {
  const setAt = (i: number, next: DateRange) => {
    const out = value.slice();
    out[i] = next;
    onChange(out);
  };

  const removeAt = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  // 归一化会合并重叠的段 —— 保存时服务端也会做。这里提前说一声，
  // 免得用户填了两段重叠的、存完发现只剩一段，以为丢数据了。
  const willMerge = normalizeRanges(value).length < value.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {value.map((r, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <RangePicker
            // dateStrings 直接用 `YYYY-MM-DD`，不经过 Dayjs 格式化 ——
            // 时区在这一层没有介入的机会
            value={[dayjs(r.from), dayjs(r.to)]}
            allowClear={false}
            style={{ flex: "1 1 auto", maxWidth: 300 }}
            onChange={(_, strings) => {
              const [from, to] = strings;
              // 只选了一头（正在选）时 strings 里可能有空串，保持原样别写坏
              if (from && to) setAt(i, { from, to });
            }}
          />
          <Tooltip title={value.length === 1 ? "删掉这段 = 这条记录不出现在任何一周" : "删掉这段"}>
            <Button
              type="text"
              size="small"
              danger={value.length === 1}
              icon={<Trash2 size={13} />}
              onClick={() => removeAt(i)}
              aria-label="删掉这段"
            />
          </Tooltip>
        </div>
      ))}

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Button
          size="small"
          icon={<Plus size={13} />}
          onClick={() => {
            // 新段默认接着最后一段的**后一天** —— 常见的输入是「又接着看了几天」，
            // 默认给一个不重叠的起点，比默认又给今天要少改一步
            const last = value[value.length - 1];
            const start = last
              ? dayjs(last.to).add(1, "day").format("YYYY-MM-DD")
              : dayjs().format("YYYY-MM-DD");
            onChange([...value, { from: start, to: start }]);
          }}
        >
          加一段
        </Button>
        <span style={{ fontSize: 11, color: MUTED }}>
          只看了一天就选同一天。中间隔了几天、或者分两季看的，就加两段。
        </span>
      </div>

      {willMerge && (
        <div style={{ fontSize: 11, color: TONE.pending.fg }}>
          有重叠的段，保存时会合并成一段（同一段时间记两遍没有意义）。
        </div>
      )}

      {!value.length && (
        <div
          style={{
            fontSize: 11,
            color: TONE.negative.fg,
            border: `1px solid ${RULE}`,
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          没有区间 = 这条记录<b>不会出现在任何一周</b>里，只能在搜索和标签里找到它。
        </div>
      )}
    </div>
  );
}
