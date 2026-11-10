import { useEffect, useState } from "react";
import {
  App as AntApp,
  Button,
  DatePicker,
  Descriptions,
  Divider,
  Input,
  Popconfirm,
  Select,
  Space,
  Tag as AntTag,
} from "antd";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Pencil, RotateCcw, Save, Trash2, X } from "lucide-react";
import dayjs from "dayjs";
import { apiFetch, apiJson, ApiError } from "../lib/api";
import { formatDateShort, formatDuration, formatRanges, weekKeysCoveredBy } from "../lib/format";
import { ChannelTag } from "../components/ChannelTag";
import { Cover } from "../components/Cover";
import { WatchRangesEditor } from "../components/WatchRangesEditor";
import { NotesPanel } from "../components/NotesPanel";
import { AttachmentsPanel } from "../components/AttachmentsPanel";
import { ErrorState, LoadingState } from "../components/State";
import { INK, MONO, MUTED, RULE, TONE } from "../lib/theme";
import type { Channel, DateRange, ItemDetail as ItemDetailModel, TagGroup } from "../types";

export default function ItemDetail() {
  const { id = "" } = useParams();
  const itemId = Number(id);
  const nav = useNavigate();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const [editing, setEditing] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["item", itemId],
    enabled: Number.isInteger(itemId) && itemId > 0,
    queryFn: () => apiFetch<ItemDetailModel>(`/api/items/${itemId}`),
  });

  const { data: channels } = useQuery({
    queryKey: ["channels"],
    queryFn: () => apiFetch<Channel[]>("/api/channels"),
  });
  const { data: tagData } = useQuery({
    queryKey: ["tags"],
    queryFn: () => apiFetch<{ groups: TagGroup[] }>("/api/tags"),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["item", itemId] });
    qc.invalidateQueries({ queryKey: ["items"] });
    qc.invalidateQueries({ queryKey: ["weeks"] });
  };

  const softDeleteMut = useMutation({
    mutationFn: () => apiJson(`/api/items/${itemId}`, "DELETE"),
    onSuccess: () => {
      message.success("已移入回收站（可以恢复）");
      invalidate();
      nav("/weeks");
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  const restoreMut = useMutation({
    mutationFn: () => apiJson(`/api/items/${itemId}/restore`, "POST"),
    onSuccess: () => {
      message.success("已恢复");
      invalidate();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  const hardDeleteMut = useMutation({
    mutationFn: () => apiJson(`/api/items/${itemId}/hard`, "DELETE"),
    onSuccess: (r) => {
      message.success(`已彻底删除（同时清了 ${(r as { deletedFiles: number }).deletedFiles} 个文件）`);
      qc.invalidateQueries({ queryKey: ["items"] });
      qc.invalidateQueries({ queryKey: ["weeks"] });
      nav("/trash");
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  if (!Number.isInteger(itemId) || itemId <= 0) {
    return <ErrorState error={new Error(`条目 id「${id}」不合法`)} />;
  }
  if (isLoading) return <LoadingState />;
  if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
  if (!data) return null;

  const deleted = data.deletedAt !== null;
  // 周由**观看区间**派生（后端不返回 weekKey）—— 跨几周就有几个链接
  const watchedWeeks = weekKeysCoveredBy(data.watchedRanges);

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <Button size="small" icon={<ArrowLeft size={14} />} onClick={() => nav(-1)}>
          返回
        </Button>
        {watchedWeeks.length > 0 ? (
          <span style={{ fontSize: 12, color: MUTED }}>
            观看周：
            {watchedWeeks.slice(0, 4).map((k, i) => (
              <span key={k}>
                {i > 0 && "、"}
                <Link to={`/week/${k}`} className="mono" style={{ color: TONE.settled.fg }}>
                  {k}
                </Link>
              </span>
            ))}
            {watchedWeeks.length > 4 && (
              <span> 等 {watchedWeeks.length} 周</span>
            )}
          </span>
        ) : (
          <span style={{ fontSize: 12, color: TONE.negative.fg }}>
            没有观看区间 —— 它不在任何一周里
          </span>
        )}
        <div style={{ flex: 1 }} />
        {deleted ? (
          <>
            <AntTag
              style={{ color: TONE.negative.fg, background: TONE.negative.bg, border: "none", marginInlineEnd: 0 }}
            >
              已在回收站
            </AntTag>
            <Button size="small" icon={<RotateCcw size={13} />} loading={restoreMut.isPending} onClick={() => restoreMut.mutate()}>
              恢复
            </Button>
            <Popconfirm
              title="彻底删除？"
              description="连同截图、备份文件一起删掉，不可恢复。"
              okText="彻底删除"
              okButtonProps={{ danger: true }}
              cancelText="算了"
              onConfirm={() => hardDeleteMut.mutate()}
            >
              <Button size="small" danger icon={<Trash2 size={13} />}>
                彻底删除
              </Button>
            </Popconfirm>
          </>
        ) : (
          <>
            <Button size="small" icon={<Pencil size={13} />} onClick={() => setEditing((v) => !v)}>
              {editing ? "收起编辑" : "编辑"}
            </Button>
            <Popconfirm
              title="移入回收站？"
              description="可以恢复，不会真的删掉。"
              okText="移入"
              cancelText="算了"
              onConfirm={() => softDeleteMut.mutate()}
            >
              <Button size="small" icon={<Trash2 size={13} />}>
                删除
              </Button>
            </Popconfirm>
          </>
        )}
      </div>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        {data.coverUrl && (
          <div style={{ flexShrink: 0, border: `1px solid ${RULE}`, borderRadius: 8, lineHeight: 0 }}>
            {/* 用 Cover 而不是裸 <img>：B 站图床按 Referer 防盗链，裸 img 会 403（见 Cover.tsx） */}
            <Cover src={data.coverUrl} width={160} height={214} radius={8} />
          </div>
        )}
        <div style={{ flex: "1 1 320px", minWidth: 0 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px", lineHeight: 1.4 }}>
            {data.title || <span style={{ color: MUTED }}>（无标题）</span>}
          </h1>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
            <ChannelTag code={data.channelCode} name={data.channelName} />
            {data.tags.map((t) => (
              <AntTag key={t.id} style={{ marginInlineEnd: 0, fontSize: 12 }}>
                {t.groupName} / {t.name}
              </AntTag>
            ))}
          </div>
          {data.summary && (
            <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.7, margin: "0 0 10px" }}>
              {data.summary}
            </p>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: MUTED }}>
            <span>
              观看 <span className="mono">{formatRanges(data.watchedRanges)}</span>
            </span>
            <span>
              收藏于 <span className="mono">{data.collectedOn}</span>
            </span>
            {data.publishedOn && (
              <span>
                发布 <span className="mono">{data.publishedOn}</span>
              </span>
            )}
            {data.author && <span>{data.author}</span>}
            {formatDuration(data.durationSec) && (
              <span className="mono">{formatDuration(data.durationSec)}</span>
            )}
          </div>
          {data.primaryUrl && (
            <div style={{ marginTop: 10 }}>
              <a
                href={data.primaryUrl}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  fontSize: 12,
                  color: TONE.settled.fg,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  wordBreak: "break-all",
                }}
              >
                <ExternalLink size={12} />
                {data.primaryUrl}
              </a>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <EditForm
          item={data}
          channels={channels ?? []}
          tagGroups={tagData?.groups ?? []}
          onDone={() => {
            setEditing(false);
            invalidate();
          }}
        />
      )}

      <Divider />

      <NotesPanel itemId={data.id} notes={data.notes} />

      <Divider />

      <AttachmentsPanel itemId={data.id} attachments={data.attachments} />

      {!editing && (
        <div style={{ marginTop: 24, fontSize: 11, color: MUTED }}>
          <span className="mono">id={data.id}</span>
          {data.platformItemId && (
            <>
              {" · "}平台 ID <span className="mono">{data.platformItemId}</span>
            </>
          )}
          {" · "}录入 <span className="mono">{data.createdAt}</span>
        </div>
      )}
    </div>
  );
}

function EditForm({
  item,
  channels,
  tagGroups,
  onDone,
}: {
  item: ItemDetailModel;
  channels: Channel[];
  tagGroups: TagGroup[];
  onDone: () => void;
}) {
  const { message } = AntApp.useApp();
  const [title, setTitle] = useState(item.title);
  const [author, setAuthor] = useState(item.author ?? "");
  const [url, setUrl] = useState(item.primaryUrl ?? "");
  const [collectedOn, setCollectedOn] = useState(item.collectedOn);
  const [watchedRanges, setWatchedRanges] = useState<DateRange[]>(item.watchedRanges);
  const [channelCode, setChannelCode] = useState<string | null>(item.channelCode);
  const [tagIds, setTagIds] = useState<number[]>(item.tags.map((t) => t.id));

  // 条目被外部改过（比如别处恢复了）时同步回来
  useEffect(() => {
    setTitle(item.title);
    setAuthor(item.author ?? "");
    setUrl(item.primaryUrl ?? "");
    setCollectedOn(item.collectedOn);
    setWatchedRanges(item.watchedRanges);
    setChannelCode(item.channelCode);
    setTagIds(item.tags.map((t) => t.id));
  }, [item]);

  const saveMut = useMutation({
    mutationFn: () =>
      apiJson(`/api/items/${item.id}`, "PATCH", {
        title: title.trim(),
        author: author.trim() || null,
        url: url.trim() || undefined,
        collected_on: collectedOn,
        watched_ranges: watchedRanges,
        channel_code: channelCode,
        tag_ids: tagIds,
      }),
    onSuccess: () => {
      message.success("已保存");
      onDone();
    },
    onError: (e: ApiError) => message.error(e.message),
  });

  return (
    <div
      style={{
        marginTop: 16,
        padding: 14,
        background: "#fff",
        border: `1px solid ${TONE.pending.fg}55`,
        borderRadius: 8,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <label style={label}>标题</label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "2 1 260px", minWidth: 0 }}>
            <label style={label}>链接</label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="留空表示没有链接" />
          </div>
          <div style={{ flex: "1 1 150px", minWidth: 0 }}>
            <label style={label}>收藏日期</label>
            <DatePicker
              style={{ width: "100%" }}
              value={dayjs(collectedOn)}
              allowClear={false}
              onChange={(d) => setCollectedOn(d ? d.format("YYYY-MM-DD") : collectedOn)}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 150px", minWidth: 0 }}>
            <label style={label}>渠道</label>
            <Select
              style={{ width: "100%" }}
              value={channelCode}
              onChange={setChannelCode}
              allowClear
              placeholder="未分类"
              options={channels.map((c) => ({ value: c.code, label: c.name }))}
            />
          </div>
          <div style={{ flex: "1 1 200px", minWidth: 0 }}>
            <label style={label}>作者 / UP 主</label>
            <Input value={author} onChange={(e) => setAuthor(e.target.value)} />
          </div>
        </div>
        {tagGroups.length > 0 && (
          <div>
            <label style={label}>标签</label>
            <Select
              mode="multiple"
              style={{ width: "100%" }}
              value={tagIds}
              onChange={setTagIds}
              options={tagGroups.flatMap((g) =>
                g.tags.map((t) => ({
                  value: t.id,
                  label: `${g.name}（${g.selection === "single" ? "分类·单选" : "标签·多选"}） / ${t.name}`,
                })),
              )}
            />
          </div>
        )}
        <div>
          <label style={label}>观看日期</label>
          <WatchRangesEditor value={watchedRanges} onChange={setWatchedRanges} />
        </div>
        <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.7 }}>
          <b>改观看日期才会把它挪到别的周</b> —— 周是从区间派生的，没有单独的「周」字段。
          <br />
          收藏日期是「我什么时候记的」，它不影响这条出现在哪几周。
        </div>
        <Space>
          <Button
            type="primary"
            size="small"
            icon={<Save size={13} />}
            loading={saveMut.isPending}
            onClick={() => saveMut.mutate()}
          >
            保存
          </Button>
          <Button size="small" icon={<X size={13} />} onClick={onDone}>
            取消
          </Button>
        </Space>
      </div>
    </div>
  );
}

const label: React.CSSProperties = { display: "block", fontSize: 12, color: MUTED, marginBottom: 4 };
