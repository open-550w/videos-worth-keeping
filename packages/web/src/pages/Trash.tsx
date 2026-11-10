import { App as AntApp, Button, Pagination, Popconfirm, Alert } from "antd";
import { Link } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { apiFetch, apiJson, ApiError, qs } from "../lib/api";
import { formatDateShort, formatRanges } from "../lib/format";
import { INK, MUTED, RULE, TONE } from "../lib/theme";
import { ChannelTag } from "../components/ChannelTag";
import { EmptyState, ErrorState, LoadingState } from "../components/State";
import type { Item, Paged } from "../types";

const PAGE_SIZE = 50;

/**
 * 回收站。
 *
 * 需求确认会：「删除是软删除吧，但网页上就要有能看软删除的方式/地方，
 * 并且支持最终的硬删除/恢复软删除。」
 *
 * 这一页就是那个「地方」。两个操作的性质完全不同，所以视觉上也要分开：
 *   · 恢复 —— 安全，随手点
 *   · 彻底删除 —— **不可逆，会连存储里的文件一起清掉**，所以二次确认里写清楚
 */
export default function Trash() {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [page, setPage] = useState(1);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["items", "trash", page],
    queryFn: () =>
      apiFetch<Paged<Item>>(
        `/api/items${qs({ scope: "trashed", limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE })}`,
      ),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["items"] });
    qc.invalidateQueries({ queryKey: ["weeks"] });
  };

  const restoreMut = useMutation({
    mutationFn: (id: number) => apiJson(`/api/items/${id}/restore`, "POST"),
    onSuccess: () => {
      message.success("已恢复");
      invalidate();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  const hardMut = useMutation({
    mutationFn: (id: number) => apiJson<{ deletedFiles: number }>(`/api/items/${id}/hard`, "DELETE"),
    onSuccess: (r) => {
      message.success(`已彻底删除（同时清了 ${r.deletedFiles} 个文件）`);
      invalidate();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  const emptyMut = useMutation({
    mutationFn: () => apiJson<{ deleted: number }>("/api/items/empty-trash", "POST"),
    onSuccess: (r) => {
      message.success(`已清空 ${r.deleted} 条`);
      invalidate();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;

  const items = data?.items ?? [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>回收站</h1>
        <span style={{ color: MUTED, fontSize: 13 }}>{data?.total ?? 0} 条</span>
        <div style={{ flex: 1 }} />
        {items.length > 0 && (
          <Popconfirm
            title="清空回收站？"
            description="所有条目连同截图、备份文件一起删掉，不可恢复。"
            okText="清空"
            okButtonProps={{ danger: true }}
            cancelText="算了"
            onConfirm={() => emptyMut.mutate()}
          >
            <Button size="small" danger icon={<Trash2 size={13} />} loading={emptyMut.isPending}>
              清空
            </Button>
          </Popconfirm>
        )}
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16, fontSize: 12 }}
        message="这里的条目只是标记为删除，随时可以恢复。只有「彻底删除」才真的清掉数据。"
      />

      {!items.length ? (
        <EmptyState>回收站是空的。</EmptyState>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((it) => (
            <div
              key={it.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: 12,
                background: "#fff",
                border: `1px solid ${RULE}`,
                borderRadius: 8,
                opacity: 0.85,
              }}
            >
              {it.coverUrl && (
                <img
                  src={it.coverUrl}
                  alt=""
                  style={{ width: 48, height: 64, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
                />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <Link
                  to={`/item/${it.id}`}
                  style={{
                    color: INK,
                    fontWeight: 500,
                    fontSize: 14,
                    display: "block",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {it.title || "（无标题）"}
                </Link>
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    marginTop: 4,
                    fontSize: 12,
                    color: MUTED,
                    flexWrap: "wrap",
                  }}
                >
                  <ChannelTag code={it.channelCode} name={it.channelName} />
                  <span className="mono" style={{ opacity: 0.8 }}>
                    观看 {formatRanges(it.watchedRanges)}
                  </span>
                  <span className="mono" style={{ opacity: 0.6 }}>
                    记于 {formatDateShort(it.collectedOn)}
                  </span>
                  {it.attachmentCount > 0 && (
                    <span style={{ color: TONE.negative.fg }}>
                      含 {it.attachmentCount} 个附件
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                <Button
                  size="small"
                  icon={<RotateCcw size={12} />}
                  loading={restoreMut.isPending}
                  onClick={() => restoreMut.mutate(it.id)}
                >
                  恢复
                </Button>
                <Popconfirm
                  title="彻底删除？"
                  description="连同附件文件一起删掉，不可恢复。"
                  okText="彻底删除"
                  okButtonProps={{ danger: true }}
                  cancelText="算了"
                  onConfirm={() => hardMut.mutate(it.id)}
                >
                  <Button size="small" danger icon={<Trash2 size={12} />} />
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      )}

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
