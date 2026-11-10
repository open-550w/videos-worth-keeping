import { useState } from "react";
import { Button, Pagination, Tag } from "antd";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, qs } from "../lib/api";
import { formatWeekLabel, isCurrentWeek } from "../lib/format";
import { CHANNEL_COLOR, INK, MUTED, RULE, TONE, TONE_NEUTRAL } from "../lib/theme";
import { EmptyState, ErrorState, LoadingState } from "../components/State";
import type { WeeksResponse } from "../types";

const PAGE_SIZE = 20;

export default function Weeks() {
  const [page, setPage] = useState(1);
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["weeks", page],
    queryFn: () =>
      apiFetch<WeeksResponse>(
        `/api/weeks${qs({ limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })}`,
      ),
  });

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  const weeks = data?.weeks ?? [];
  if (!weeks.length) return <EmptyState />;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>按周看</h1>
        <span style={{ color: MUTED, fontSize: 13 }}>共 {data?.total ?? 0} 周</span>
        <div style={{ flex: 1 }} />
        <Link to="/add">
          <Button type="primary" size="small">
            记一条
          </Button>
        </Link>
      </div>
      <p style={{ color: MUTED, fontSize: 12, margin: "0 0 16px" }}>
        「周」只是展示方式 —— 真源是每条记录的<b>观看日期区间</b>（ISO 8601，周一起算）。
        一段区间跨几周，这条就出现在几周；中间隔了几天（分季看、中间忙）记成两段就行。
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {weeks.map((w) => {
          const current = isCurrentWeek(w.weekKey);
          return (
            <Link
              key={w.weekKey}
              to={`/week/${w.weekKey}`}
              style={{
                display: "block",
                padding: "12px 14px",
                background: "#fff",
                border: `1px solid ${current ? `${TONE.settled.fg}55` : RULE}`,
                borderRadius: 8,
                color: INK,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{formatWeekLabel(w.weekKey)}</span>
                {current && (
                  <Tag
                    style={{
                      color: TONE.settled.fg,
                      background: TONE.settled.bg,
                      border: "none",
                      marginInlineEnd: 0,
                      fontSize: 11,
                    }}
                  >
                    这周
                  </Tag>
                )}
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                  {w.count}
                </span>
                <span style={{ color: MUTED, fontSize: 12 }}>条</span>
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 8,
                  flexWrap: "wrap",
                }}
              >
                {w.channels.map((c) => {
                  const color = CHANNEL_COLOR[c.code] ?? TONE_NEUTRAL.fg;
                  return (
                    <span
                      key={c.code}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 12,
                        color: MUTED,
                      }}
                    >
                      <span
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 999,
                          background: color,
                          display: "inline-block",
                        }}
                      />
                      {c.name}
                      <span className="mono" style={{ opacity: 0.8 }}>
                        {c.n}
                      </span>
                    </span>
                  );
                })}
                <div style={{ flex: 1 }} />
                <span className="mono" style={{ color: MUTED, fontSize: 11 }}>
                  {w.firstOn === w.lastOn ? w.firstOn : `${w.firstOn} ~ ${w.lastOn}`}
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      {(data?.total ?? 0) > PAGE_SIZE && (
        <div style={{ marginTop: 16, textAlign: "center" }}>
          <Pagination
            current={page}
            pageSize={PAGE_SIZE}
            total={data?.total ?? 0}
            showSizeChanger={false}
            onChange={(p) => {
              setPage(p);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />
        </div>
      )}
    </div>
  );
}
