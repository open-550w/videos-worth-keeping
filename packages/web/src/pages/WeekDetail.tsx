import { Button, Pagination } from "antd";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { apiFetch, qs } from "../lib/api";
import {
  clipRanges,
  formatDateShort,
  formatWeekLabel,
  isCurrentWeek,
  parseWeekKey,
  shiftWeek,
  today,
  weekKeyOf,
  weekRange,
} from "../lib/format";
import { INK, MUTED, RULE } from "../lib/theme";
import { EmptyState, ErrorState, LoadingState } from "../components/State";
import { ItemCard } from "../components/ItemCard";
import type { Item, Paged } from "../types";

const PAGE_SIZE = 50;

export default function WeekDetail() {
  const { weekKey = "" } = useParams();
  const nav = useNavigate();
  const [page, setPage] = useState(1);

  const parsed = parseWeekKey(weekKey);
  const range = parsed ? weekRange(weekKey) : null;

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["items", "week", weekKey, page],
    enabled: !!range,
    queryFn: () =>
      apiFetch<Paged<Item>>(
        // `watchedFrom`/`watchedTo` 的语义是「观看区间和这一周**有交集**」，
        // 不是「收藏日期落在这周」—— 一段 10-17~11-30 的区间在每一周里都该出现
        `/api/items${qs({
          watchedFrom: range!.from,
          watchedTo: range!.to,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        })}`,
      ),
  });

  if (!parsed || !range) {
    return (
      <EmptyState>
        周键「{weekKey}」形状不对，应该是 <span className="mono">2026-W42</span> 这样。
        <div style={{ marginTop: 12 }}>
          <Link to="/weeks">
            <Button size="small">回到周列表</Button>
          </Link>
        </div>
      </EmptyState>
    );
  }

  const prev = shiftWeek(weekKey, -1);
  const next = shiftWeek(weekKey, 1);
  const current = isCurrentWeek(weekKey);
  const items = data?.items ?? [];

  // 按天分组 —— 一周里的「哪天开始看的」比条目顺序更有信息量。
  //
  // 分组依据是**观看区间在这一周里覆盖到的第一天**，不是 collectedOn：
  // collectedOn 是「哪天记的」（补录时是今天），拿它分组会把补录的记录全堆到今天。
  // 接口只返回「区间和这一周有交集」的条目，所以这里必有覆盖（兜底分支只是防御）。
  const byDay = new Map<string, Item[]>();
  for (const it of items) {
    const inWeek = range ? clipRanges(it.watchedRanges, range.from, range.to) : [];
    const day = inWeek[0]?.from ?? it.collectedOn;
    const list = byDay.get(day) ?? [];
    list.push(it);
    byDay.set(day, list);
  }
  const days = [...byDay.keys()].sort((a, b) => b.localeCompare(a));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <Button size="small" icon={<ChevronLeft size={14} />} onClick={() => nav(`/week/${prev}`)}>
          上一周
        </Button>
        <Button
          size="small"
          disabled={current}
          onClick={() => nav(`/week/${weekKeyOf(today())}`)}
        >
          这周
        </Button>
        <Button
          size="small"
          onClick={() => nav(`/week/${next}`)}
          disabled={next > weekKeyOf(today())}
        >
          下一周
          <ChevronRight size={14} />
        </Button>
        <div style={{ flex: 1 }} />
        <Link to="/weeks" style={{ fontSize: 12, color: MUTED }}>
          全部周
        </Link>
      </div>

      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "8px 0 2px" }}>
        {formatWeekLabel(weekKey)}
      </h1>
      <p style={{ color: MUTED, fontSize: 12, margin: "0 0 16px" }}>
        <span className="mono">{range.from} ~ {range.to}</span>
        {data ? ` · 共 ${data.total} 条` : ""}
      </p>

      {isLoading && <LoadingState />}
      {isError && <ErrorState error={error} onRetry={() => refetch()} />}

      {!isLoading && !isError && !items.length && (
        <EmptyState>
          这一周还没有记录。
          <div style={{ marginTop: 12 }}>
            <Link to="/add">
              <Button size="small" type="primary">
                记一条
              </Button>
            </Link>
          </div>
        </EmptyState>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {days.map((day) => (
          <div key={day}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
                paddingBottom: 6,
                borderBottom: `1px solid ${RULE}`,
              }}
            >
              <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: INK }}>
                {formatDateShort(day)}
              </span>
              <span style={{ fontSize: 12, color: MUTED }}>
                {byDay.get(day)!.length} 条
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {byDay.get(day)!.map((it) => (
                <ItemCard key={it.id} item={it} week={range} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {(data?.total ?? 0) > PAGE_SIZE && (
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            showSizeChanger={false}
            onChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
